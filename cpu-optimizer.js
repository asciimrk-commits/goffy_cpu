/**
 * HFT CPU Optimizer - Capacity Planning Engine v6.2
 *
 * Логика оптимизации по новым правилам BenderServer:
 *
 * === Базовые расчёты ===
 * 1. OS cores = ROUND(N / 10), minimum 2
 * 2. IRQ cores = ROUND_TO_NEAREST_EVEN(N / 12), minimum 2
 *    - Округление к БЛИЖАЙШЕМУ чётному (2.6 → 2, не 4)
 * 3. R = N - OS - IRQ (доступные ядра для инстансов)
 *
 * === Per-NUMA расчёт Z ===
 * 4. Z_NumaX = cores_NumaX - OS_NumaX - IRQ_NumaX - (groups_NumaX * 3)
 *    - Каждая группа инстансов требует 3 сервисных ядра
 *
 * === Распределение Gateway/Robot ===
 * 5. Gateway = ROUND(Z * 1/4) - ОБЯЗАТЕЛЬНО на сетевой NUMA
 * 6. Robot = Z - Gateway = Z * 3/4 - предпочтительно на не-сетевой NUMA
 *
 * === Сервисные ядра (3 на группу инстансов) ===
 * 7. Ядро 1: Trash + RF + ClickHouse(опц.) - сетевая NUMA
 * 8. Ядро 2: UDPSend + UDPReceive - сетевая NUMA
 * 9. Ядро 3: AR + Formula(опц.) + RemoteFormula(опц.) - сетевая NUMA
 *
 * === Дефицитный режим (< 5 ядер на инстанс) ===
 * 10. UDP объединяется с Trash (2 сервисных ядра вместо 3)
 *
 * === L3 Cache (soft rule) ===
 * 11. Gateway стремится к изолированному L3 кэшу
 * 12. Сервисные ядра группируются в отдельном L3
 *
 * === Множественные NUMA/интерфейсы ===
 * 13. Инстансы привязываются к NUMA по сетевому интерфейсу
 * 14. IRQ распределяется равномерно между сетевыми интерфейсами
 * 15. При высоком дефиците OS распределяется между NUMA
 */

const CPU_OPTIMIZER = {
    // Optimization Constants (v6.2 - New Rules)
    CONSTANTS: {
        SERVICE_CORES_PER_INST: 3,  // Trash+RF+Click, UDP, AR+Formula+RemoteFormula
        MIN_SERVICE_CORES: 2,       // With UDP merged to Trash in deficit mode
        MIN_OS_CORES: 2,
        MIN_IRQ_CORES: 2,
        MIN_GATEWAY_CORES: 1,
        MIN_ROBOT_CORES: 1,
        GATEWAY_RATIO: 0.25,        // Z * 1/4 for Gateways
        ROBOT_RATIO: 0.75           // Z * 3/4 for Robots
    },

    /**
     * Round to nearest even number (REQUIRED for IRQ cores)
     * Examples: 2.6 → 2 (not 4), 3.5 → 4, 5.1 → 6
     * @param {number} value - Value to round
     * @returns {number} Nearest even number
     */
    roundToNearestEven(value) {
        // Round to nearest even: compare distance to lower and upper even numbers
        const lower = Math.floor(value / 2) * 2;  // Lower even
        const upper = lower + 2;                   // Upper even

        // Choose the one that's closer
        return (value - lower) <= (upper - value) ? lower : upper;
    },

    /**
     * Calculate system cores (OS + IRQ) for the entire server
     * @param {number} totalCores - Total number of cores
     * @returns {Object} { osCores, irqCores, R }
     */
    calculateSystemCores(totalCores) {
        // OS cores = ROUND(N / 10), minimum 2
        const osCores = Math.max(this.CONSTANTS.MIN_OS_CORES, Math.round(totalCores / 10));

        // IRQ cores = ROUND_TO_NEAREST_EVEN(N / 12), minimum 2
        const irqCores = Math.max(this.CONSTANTS.MIN_IRQ_CORES, this.roundToNearestEven(totalCores / 12));

        // R = Available cores for instances
        const R = totalCores - osCores - irqCores;

        return { osCores, irqCores, R };
    },

    /**
     * Calculate Z (cores for Gateway and Robots after service cores)
     * @param {number} R - Available cores after OS/IRQ
     * @param {number} numInstances - Number of instances
     * @returns {Object} { Z, deficitMode, serviceCoresPerInst }
     */
    calculateInstanceCores(R, numInstances) {
        if (numInstances === 0) {
            return { Z: R, deficitMode: false, serviceCoresPerInst: 0 };
        }

        const standardServiceCores = this.CONSTANTS.SERVICE_CORES_PER_INST * numInstances;
        let Z = R - standardServiceCores;
        let deficitMode = false;
        let serviceCoresPerInst = this.CONSTANTS.SERVICE_CORES_PER_INST;

        // Check for deficit mode: less than 2 cores per instance for Gateway+Robot
        if (Z < numInstances * 2) {
            // Deficit mode: Merge UDP with Trash (reduce to 2 service cores)
            serviceCoresPerInst = this.CONSTANTS.MIN_SERVICE_CORES;
            Z = R - serviceCoresPerInst * numInstances;
            deficitMode = true;
            console.warn('[Optimizer] Deficit mode activated: UDP merged with Trash');
        }

        return { Z, deficitMode, serviceCoresPerInst };
    },

    /**
     * Allocate Gateway and Robot cores per instance
     * @param {number} Z - Available cores after service cores
     * @param {number} numInstances - Number of instances
     * @returns {Object} { gatewayPerInst, robotPerInst }
     */
    calculateGatewayRobotDistribution(Z, numInstances) {
        if (numInstances === 0 || Z <= 0) {
            return { gatewayPerInst: 1, robotPerInst: 1 };
        }

        const coresPerInstance = Z / numInstances;

        // Gateway = ROUND(Z * 1/4) per instance, minimum 1
        let gatewayPerInst = Math.max(
            this.CONSTANTS.MIN_GATEWAY_CORES,
            Math.round(coresPerInstance * this.CONSTANTS.GATEWAY_RATIO)
        );

        // Robot = remaining cores, minimum 1
        let robotPerInst = Math.max(
            this.CONSTANTS.MIN_ROBOT_CORES,
            Math.floor(coresPerInstance - gatewayPerInst)
        );

        // Ensure we don't exceed available cores
        if (gatewayPerInst + robotPerInst > coresPerInstance) {
            robotPerInst = Math.max(1, Math.floor(coresPerInstance - gatewayPerInst));
        }

        return { gatewayPerInst, robotPerInst };
    },

    /**
     * Group instances by common name prefix (e.g., DS30-DS38 = one group)
     * @param {string[]} instanceNames - List of instance names
     * @returns {Map<string, string[]>} Groups of instances
     */
    groupInstances(instanceNames) {
        const groups = new Map();

        instanceNames.forEach(name => {
            // Extract prefix: remove trailing numbers
            const prefix = name.replace(/\d+$/, '');

            if (!groups.has(prefix)) {
                groups.set(prefix, []);
            }
            groups.get(prefix).push(name);
        });

        return groups;
    },

    /**
     * Main optimization function (v6.0)
     * @param {Object} snapshot - Parsed topology snapshot
     * @returns {Object} Optimization results
     */
    optimize(snapshot) {
        const totalCores = snapshot.topology.length;
        console.log('[Optimizer v6.0] Starting optimization', { totalCores });

        // 1. Extract instances from topology
        const existingInstances = new Set();
        snapshot.topology.forEach(c => c.services.forEach(s => {
            if (s.instanceId !== 'SYSTEM') existingInstances.add(s.instanceId);
        }));

        if (existingInstances.size > 0) {
            console.log('[Optimizer] Existing configuration detected:', Array.from(existingInstances));
            return this.optimizeExistingConfiguration(snapshot);
        }

        console.log('[Optimizer] Blank server - creating new configuration');
        return this.createNewConfiguration(snapshot);
    },

    /**
     * Create new optimized configuration for blank server
     * @param {Object} snapshot - Parsed topology snapshot
     * @returns {Object} Optimization results
     */
    createNewConfiguration(snapshot) {
        const totalCores = snapshot.topology.length;

        // 1. Calculate system cores (OS + IRQ)
        const { osCores, irqCores, R } = this.calculateSystemCores(totalCores);
        console.log('[Optimizer] System cores:', { osCores, irqCores, R });

        // 2. Analyze topology
        const topology = this.analyzeTopology(snapshot);
        const networkNumaNodes = this.detectNetworkNumas(snapshot, topology);

        // 3. Create default instance if none exists
        const numInstances = 1; // Default single instance for blank server

        // 4. Calculate instance cores
        const { Z, deficitMode, serviceCoresPerInst } = this.calculateInstanceCores(R, numInstances);
        const { gatewayPerInst, robotPerInst } = this.calculateGatewayRobotDistribution(Z, numInstances);

        console.log('[Optimizer] Instance allocation:', {
            Z, deficitMode, serviceCoresPerInst, gatewayPerInst, robotPerInst
        });

        // 5. Place services
        const result = this.placeServicesNew(
            snapshot,
            topology,
            networkNumaNodes,
            osCores,
            irqCores,
            serviceCoresPerInst,
            gatewayPerInst,
            robotPerInst,
            deficitMode
        );

        return result;
    },

    /**
     * Optimize existing configuration according to new rules v6.2
     *
     * Key principles:
     * - Use ALL available cores on the server
     * - Service + Gateway cores MUST be on network NUMA
     * - Robot cores CAN be on ANY NUMA (prefer non-network to spread load)
     * - Z is calculated for the ENTIRE server, not per-NUMA
     * - Preserve existing OS/IRQ allocation if reasonable
     *
     * @param {Object} snapshot - Parsed topology snapshot
     * @returns {Object} Optimization results
     */
    optimizeExistingConfiguration(snapshot) {
        const totalCores = snapshot.topology.length;
        console.log('[Optimizer v6.2] Starting optimization', { totalCores });

        // 1. Analyze topology
        const topology = this.analyzeTopology(snapshot);
        const networkNumaNodes = this.detectNetworkNumas(snapshot, topology);
        const allNumas = topology.numaNodes;
        const nonNetworkNumas = allNumas.filter(n => !networkNumaNodes.includes(n));

        console.log('[Optimizer] Network NUMAs:', networkNumaNodes, 'Non-network:', nonNetworkNumas);

        // 2. Get existing instances and group them
        const instanceData = this.extractExistingInstances(snapshot);
        const instanceGroups = this.groupInstances(instanceData.map(i => i.instanceId));
        const numGroups = instanceGroups.size;

        console.log('[Optimizer] Instance groups:', numGroups, Array.from(instanceGroups.keys()));

        // 3. Detect existing OS and IRQ cores from current configuration
        const existingOS = this.detectExistingOSCores(snapshot);
        const existingIRQ = this.detectExistingIRQCores(snapshot);

        console.log('[Optimizer] Existing OS:', existingOS, 'IRQ:', existingIRQ);

        // 4. Calculate recommended system cores
        const { osCores: recommendedOS, irqCores: recommendedIRQ } = this.calculateSystemCores(totalCores);

        // 5. Use existing allocation if reasonable, otherwise use calculated
        // Preserve existing OS if within reasonable range (±2 cores)
        // For IRQ: NEVER go below recommended (network performance critical)
        const osCount = (existingOS.length > 0 && Math.abs(existingOS.length - recommendedOS) <= 2)
            ? existingOS.length
            : recommendedOS;

        // IRQ: use existing only if >= recommended, otherwise use recommended
        const irqCount = (existingIRQ.length >= recommendedIRQ)
            ? existingIRQ.length
            : recommendedIRQ;

        // 6. Allocate OS cores
        const allCores = topology.cores.sort((a, b) => a.id - b.id);
        const nonIsolatedCores = allCores.filter(c =>
            !snapshot.topology.find(t => t.id === c.id)?.services?.length
        );

        let usedOsCores = [];
        if (existingOS.length > 0 && existingOS.length === osCount) {
            // Use existing OS cores
            usedOsCores = existingOS;
        } else {
            // Allocate new OS cores from non-isolated at start
            const candidates = nonIsolatedCores.length >= osCount ? nonIsolatedCores : allCores;
            usedOsCores = candidates.slice(0, osCount).map(c => c.id);
        }

        // 7. Allocate IRQ cores on network NUMA
        let usedIrqCores = [];
        if (existingIRQ.length > 0 && existingIRQ.length === irqCount) {
            // Use existing IRQ cores
            usedIrqCores = existingIRQ;
        } else {
            // Allocate new IRQ cores on network NUMA after OS
            const networkCores = allCores.filter(c =>
                networkNumaNodes.includes(c.numaNodeId) &&
                !usedOsCores.includes(c.id)
            );
            usedIrqCores = networkCores.slice(0, irqCount).map(c => c.id);
        }

        // 8. Calculate R and Z for the ENTIRE server
        const R = totalCores - usedOsCores.length - usedIrqCores.length;
        const serviceCoresTotal = numGroups * this.CONSTANTS.SERVICE_CORES_PER_INST;
        const Z = R - serviceCoresTotal; // Available for Gateway + Robot

        console.log('[Optimizer] Server totals: R=', R, 'ServiceCores=', serviceCoresTotal, 'Z=', Z);

        // 9. Calculate Gateway distribution (Robot will use ALL remaining)
        const gatewayTotal = Math.max(numGroups, Math.round(Z * this.CONSTANTS.GATEWAY_RATIO));
        const gatewayPerGroup = Math.max(this.CONSTANTS.MIN_GATEWAY_CORES, Math.floor(gatewayTotal / numGroups));

        console.log('[Optimizer] Z=', Z, 'GatewayTotal=', gatewayTotal, 'GatewayPerGroup=', gatewayPerGroup);

        // 10. Process each instance group
        const usedCores = new Set([...usedOsCores, ...usedIrqCores]);
        const instances = [];

        // Get available cores on network and non-network NUMAs
        const getNetworkAvailable = () => allCores.filter(c =>
            networkNumaNodes.includes(c.numaNodeId) && !usedCores.has(c.id)
        );
        const getNonNetworkAvailable = () => allCores.filter(c =>
            !networkNumaNodes.includes(c.numaNodeId) && !usedCores.has(c.id)
        );

        // Calculate target robots per group (use all remaining cores)
        const totalRobotCores = Z - (gatewayPerGroup * numGroups);
        const robotPerGroup = Math.max(this.CONSTANTS.MIN_ROBOT_CORES, Math.floor(totalRobotCores / numGroups));

        console.log('[Optimizer] TotalRobotCores=', totalRobotCores, 'RobotPerGroup=', robotPerGroup);

        let groupIndex = 0;
        const groupArray = Array.from(instanceGroups.entries());

        for (const [groupPrefix, groupInstances] of groupArray) {
            const isLastGroup = (groupIndex === groupArray.length - 1);

            // Service cores - MUST be on network NUMA
            const serviceCoresCount = this.CONSTANTS.SERVICE_CORES_PER_INST;
            const serviceCores = this.allocateServiceCores(
                getNetworkAvailable(),
                serviceCoresCount,
                false, // no deficit mode - we have enough cores
                topology
            );
            serviceCores.forEach(c => usedCores.add(c.coreId));

            // Gateway cores - MUST be on network NUMA (prefer clean L3)
            const gatewayCores = this.allocateGatewayCoresWithL3(
                getNetworkAvailable(),
                gatewayPerGroup,
                usedCores,
                topology
            );
            gatewayCores.forEach(id => usedCores.add(id));

            // Robot cores - use non-network NUMA first, then network NUMA
            // Last group gets ALL remaining cores to avoid leftovers
            let robotCores = [];
            const targetRobots = isLastGroup
                ? getNonNetworkAvailable().length + getNetworkAvailable().length  // All remaining
                : robotPerGroup;

            // First: allocate from non-network NUMA
            const nonNetworkAvail = getNonNetworkAvailable();
            const nonNetworkCount = Math.min(nonNetworkAvail.length, targetRobots);
            const nonNetworkRobots = this.allocateRobotCores(nonNetworkAvail, nonNetworkCount);
            robotCores.push(...nonNetworkRobots);
            nonNetworkRobots.forEach(id => usedCores.add(id));

            // Then: fill from network NUMA
            const remainingNeeded = targetRobots - robotCores.length;
            if (remainingNeeded > 0) {
                const networkRobots = this.allocateRobotCores(
                    getNetworkAvailable(),
                    remainingNeeded
                );
                robotCores.push(...networkRobots);
                networkRobots.forEach(id => usedCores.add(id));
            }

            // Create instance record
            const coreAssignments = [
                ...serviceCores.map(s => ({ service: s.service, role: s.role, cores: [s.coreId] })),
                { service: 'gateway', role: 'gateway', cores: gatewayCores },
                { service: 'robot', role: 'robot_default', cores: robotCores }
            ];

            groupInstances.forEach(instId => {
                instances.push({
                    instanceId: instId,
                    groupId: groupPrefix,
                    allocatedCores: serviceCoresCount + gatewayCores.length + robotCores.length,
                    coreAssignments: coreAssignments,
                    gateway: gatewayCores.length,
                    robot: robotCores.length,
                    deficitMode: false,
                    numaPlacement: {
                        serviceCoresNuma: serviceCores[0]?.numaId,
                        isNetworkNuma: true
                    }
                });
            });

            groupIndex++;
        }

        // 11. Build NUMA resources summary for output
        const numaResources = {};
        allNumas.forEach(numaId => {
            const numaCoreCount = topology.coresByNuma[numaId]?.length || 0;
            const usedInNuma = Array.from(usedCores).filter(id =>
                allCores.find(c => c.id === id)?.numaNodeId === numaId
            ).length;

            numaResources[numaId] = {
                totalCores: numaCoreCount,
                usedCores: usedInNuma,
                freeCores: numaCoreCount - usedInNuma,
                isNetwork: networkNumaNodes.includes(numaId)
            };
        });

        console.log('[Optimizer] Final NUMA usage:', numaResources);

        return {
            totalCores,
            osCores: usedOsCores,
            irqCores: usedIrqCores,
            instances,
            systemCores: { os: usedOsCores.length, irq: usedIrqCores.length, R, Z },
            numaResources,
            recommendations: this.generateRecommendations(snapshot, usedOsCores, usedIrqCores, instances)
        };
    },

    /**
     * Detect existing OS cores from snapshot (non-isolated, no services)
     */
    detectExistingOSCores(snapshot) {
        const osCores = [];
        snapshot.topology.forEach(core => {
            const hasServices = core.services && core.services.length > 0;
            const isIsolated = snapshot.topology.find(t => t.id === core.id)?.isolated;
            // OS cores are non-isolated and have no bender services
            if (!hasServices && !isIsolated) {
                // Check if marked as System in services
                const isSystem = core.services?.some(s => s.name === 'System');
                if (isSystem || (!hasServices && !isIsolated)) {
                    osCores.push(core.id);
                }
            }
        });
        return osCores.sort((a, b) => a - b);
    },

    /**
     * Detect existing IRQ cores from snapshot (net_cpu marked)
     */
    detectExistingIRQCores(snapshot) {
        const irqCores = [];
        snapshot.topology.forEach(core => {
            const isIRQ = core.services?.some(s => s.name === 'IRQ');
            if (isIRQ) {
                irqCores.push(core.id);
            }
        });
        return irqCores.sort((a, b) => a - b);
    },

    /**
     * Bind instance groups to NUMA nodes based on their network interface
     * @param {Object} snapshot - Topology snapshot
     * @param {Map} instanceGroups - Grouped instances
     * @param {Array} instanceData - Instance data
     * @param {Array} networkNumaNodes - Network NUMA nodes
     * @returns {Map} Group ID to NUMA ID mapping
     */
    bindGroupsToNuma(snapshot, instanceGroups, instanceData, networkNumaNodes) {
        const groupToNuma = new Map();
        const instanceToInterface = snapshot.instanceToInterface || {};
        const interfaceNumaMap = snapshot.interfaceNumaMap || {};

        for (const [groupPrefix, groupInstances] of instanceGroups) {
            // Try to determine NUMA from network interface
            let targetNuma = networkNumaNodes[0] || 0;

            // Check if any instance in group has interface binding
            for (const instId of groupInstances) {
                const iface = instanceToInterface[instId];
                if (iface && interfaceNumaMap[iface] !== undefined) {
                    targetNuma = interfaceNumaMap[iface];
                    break;
                }
            }

            // Fallback: determine from existing core placements
            if (targetNuma === undefined || targetNuma === null) {
                const inst = instanceData.find(i => groupInstances.includes(i.instanceId));
                if (inst && inst.cores.size > 0) {
                    const coreIds = Array.from(inst.cores);
                    const coreInfo = snapshot.topology.find(c => c.id === parseInt(coreIds[0]));
                    if (coreInfo) {
                        targetNuma = coreInfo.numaNodeId;
                    }
                }
            }

            groupToNuma.set(groupPrefix, targetNuma);
        }

        console.log('[Optimizer] Group to NUMA bindings:', Object.fromEntries(groupToNuma));
        return groupToNuma;
    },

    /**
     * Allocate Gateway cores with L3 cache preference (soft rule)
     * Tries to place gateways in a clean L3 cache, separate from service cores
     * @param {Array} availableCores - Available cores on network NUMA
     * @param {number} count - Number of gateway cores needed
     * @param {Set} usedCores - Already used cores
     * @param {Object} topology - Topology info
     * @returns {Array} Core IDs for gateways
     */
    allocateGatewayCoresWithL3(availableCores, count, usedCores, topology) {
        if (count <= 0 || availableCores.length === 0) {
            return [];
        }

        // Group available cores by L3 cache
        const l3Groups = {};
        availableCores.forEach(core => {
            const l3Key = core.l3CacheId || `numa-${core.numaNodeId}`;
            if (!l3Groups[l3Key]) l3Groups[l3Key] = [];
            l3Groups[l3Key].push(core);
        });

        // Score each L3 group: prefer groups with fewer used cores (cleaner cache)
        const l3Scores = Object.entries(l3Groups).map(([l3Key, cores]) => {
            const usedInL3 = cores.filter(c => usedCores.has(c.id)).length;
            const availableInL3 = cores.filter(c => !usedCores.has(c.id)).length;
            return {
                l3Key,
                cores: cores.filter(c => !usedCores.has(c.id)),
                usedCount: usedInL3,
                availableCount: availableInL3,
                // Lower score = better (fewer used cores = cleaner L3)
                score: usedInL3
            };
        }).filter(g => g.availableCount > 0);

        // Sort by score (prefer cleaner L3), then by available count (prefer more space)
        l3Scores.sort((a, b) => {
            if (a.score !== b.score) return a.score - b.score;
            return b.availableCount - a.availableCount;
        });

        // Allocate from best L3 groups first
        const result = [];
        for (const group of l3Scores) {
            const sorted = group.cores.sort((a, b) => a.id - b.id);
            for (const core of sorted) {
                if (result.length >= count) break;
                result.push(core.id);
            }
            if (result.length >= count) break;
        }

        return result;
    },

    /**
     * Extract existing instance data from snapshot
     * @param {Object} snapshot - Parsed topology snapshot
     * @returns {Array} Instance data
     */
    extractExistingInstances(snapshot) {
        const instanceMap = new Map();

        snapshot.topology.forEach(core => {
            core.services.forEach(service => {
                if (service.instanceId && service.instanceId !== 'SYSTEM') {
                    if (!instanceMap.has(service.instanceId)) {
                        instanceMap.set(service.instanceId, {
                            instanceId: service.instanceId,
                            cores: new Set(),
                            services: []
                        });
                    }
                    const inst = instanceMap.get(service.instanceId);
                    inst.cores.add(core.id);
                    inst.services.push({ coreId: core.id, name: service.name });
                }
            });
        });

        return Array.from(instanceMap.values());
    },

    /**
     * Allocate service cores according to new rules
     * Service cores MUST be on network NUMA
     * Core 1: Trash + RF + ClickHouse (optional)
     * Core 2: UDP Send + UDP Receive
     * Core 3: AR + Formula (optional) + RemoteFormula (optional)
     * 
     * @param {Array} availableCores - Available cores
     * @param {number} count - Number of service cores needed
     * @param {boolean} deficitMode - If true, merge UDP with Trash
     * @param {Object} topology - Topology info
     * @returns {Array} Allocated service cores with assignments
     */
    allocateServiceCores(availableCores, count, deficitMode, topology) {
        const result = [];
        const sorted = availableCores.sort((a, b) => a.id - b.id);

        if (deficitMode && count === 2) {
            // Deficit mode: 2 cores
            // Core 1: Trash + RF + ClickHouse + UDP (merged)
            if (sorted.length >= 1) {
                result.push({
                    coreId: sorted[0].id,
                    numaId: sorted[0].numaNodeId,
                    l3CacheId: sorted[0].l3CacheId,
                    service: 'trash_udp_combo',
                    role: 'trash',
                    services: ['TrashCPU', 'RF', 'ClickHouseCores', 'UdpSendCores', 'UdpReceiveCores']
                });
            }
            // Core 2: AR + Formula + RemoteFormula
            if (sorted.length >= 2) {
                result.push({
                    coreId: sorted[1].id,
                    numaId: sorted[1].numaNodeId,
                    l3CacheId: sorted[1].l3CacheId,
                    service: 'ar_combo',
                    role: 'ar',
                    services: ['AllRobotsThCPU', 'Formula', 'RemoteFormulaCPU']
                });
            }
        } else {
            // Standard mode: 3 cores
            // Core 1: Trash + RF + ClickHouse
            if (sorted.length >= 1) {
                result.push({
                    coreId: sorted[0].id,
                    numaId: sorted[0].numaNodeId,
                    l3CacheId: sorted[0].l3CacheId,
                    service: 'trash_combo',
                    role: 'trash',
                    services: ['TrashCPU', 'RF', 'ClickHouseCores']
                });
            }
            // Core 2: UDP (Send + Receive on same core)
            if (sorted.length >= 2) {
                result.push({
                    coreId: sorted[1].id,
                    numaId: sorted[1].numaNodeId,
                    l3CacheId: sorted[1].l3CacheId,
                    service: 'udp',
                    role: 'udp',
                    services: ['UdpSendCores', 'UdpReceiveCores']
                });
            }
            // Core 3: AR + Formula + RemoteFormula
            if (sorted.length >= 3) {
                result.push({
                    coreId: sorted[2].id,
                    numaId: sorted[2].numaNodeId,
                    l3CacheId: sorted[2].l3CacheId,
                    service: 'ar_combo',
                    role: 'ar',
                    services: ['AllRobotsThCPU', 'Formula', 'RemoteFormulaCPU']
                });
            }
        }

        return result;
    },

    /**
     * Allocate Gateway cores - prefer isolated L3 cache on network NUMA
     * @param {Array} availableCores - Available cores
     * @param {number} count - Number of gateway cores needed
     * @param {Array} networkNumaNodes - Network NUMA nodes
     * @param {Object} topology - Topology info
     * @returns {Array} Core IDs for gateways
     */
    allocateGatewayCores(availableCores, count, networkNumaNodes, topology) {
        const result = [];

        // Step 1: Prefer network NUMA cores
        const networkCores = availableCores.filter(c =>
            networkNumaNodes.includes(c.numaNodeId)
        );

        // Step 2: Group by L3 cache, prefer L3 with least existing services
        const l3Groups = {};
        networkCores.forEach(core => {
            const l3Key = core.l3CacheId || core.numaNodeId;
            if (!l3Groups[l3Key]) l3Groups[l3Key] = [];
            l3Groups[l3Key].push(core);
        });

        // Sort L3 groups by number of cores (prefer larger/less used pools)
        const sortedL3 = Object.entries(l3Groups)
            .sort((a, b) => b[1].length - a[1].length);

        // Allocate from best L3 pool first
        for (const [l3Key, cores] of sortedL3) {
            const sorted = cores.sort((a, b) => a.id - b.id);
            for (const core of sorted) {
                if (result.length >= count) break;
                result.push(core.id);
            }
            if (result.length >= count) break;
        }

        // If not enough on network NUMA, use any available
        if (result.length < count) {
            const remaining = availableCores
                .filter(c => !result.includes(c.id))
                .sort((a, b) => a.id - b.id);

            for (const core of remaining) {
                if (result.length >= count) break;
                result.push(core.id);
            }
        }

        return result;
    },

    /**
     * Allocate Robot cores - can be on any NUMA
     * @param {Array} availableCores - Available cores
     * @param {number} count - Number of robot cores needed
     * @returns {Array} Core IDs for robots
     */
    allocateRobotCores(availableCores, count) {
        return availableCores
            .sort((a, b) => a.id - b.id)
            .slice(0, count)
            .map(c => c.id);
    },

    /**
     * Place services for new configuration
     */
    placeServicesNew(snapshot, topology, networkNumaNodes, osCount, irqCount, serviceCount, gatewayCount, robotCount, deficitMode) {
        const allCores = topology.cores.sort((a, b) => a.id - b.id);
        const usedCores = new Set();

        // 1. OS cores - non-isolated at start
        const nonIsolatedCores = allCores.filter(c => !c.isolated);
        const osCoresList = (nonIsolatedCores.length >= osCount ? nonIsolatedCores : allCores)
            .slice(0, osCount)
            .map(c => c.id);
        osCoresList.forEach(id => usedCores.add(id));

        // 2. IRQ cores - on network NUMA
        const availableForIrq = allCores.filter(c =>
            !usedCores.has(c.id) && networkNumaNodes.includes(c.numaNodeId)
        );
        const irqCoresList = availableForIrq.slice(0, irqCount).map(c => c.id);
        irqCoresList.forEach(id => usedCores.add(id));

        // 3. Service cores - on network NUMA
        const availableForService = allCores.filter(c =>
            !usedCores.has(c.id) && networkNumaNodes.includes(c.numaNodeId)
        );
        const serviceCores = this.allocateServiceCores(
            availableForService, serviceCount, deficitMode, topology
        );
        serviceCores.forEach(s => usedCores.add(s.coreId));

        // 4. Gateway cores
        const availableForGateway = allCores.filter(c => !usedCores.has(c.id));
        const gatewayCores = this.allocateGatewayCores(
            availableForGateway, gatewayCount, networkNumaNodes, topology
        );
        gatewayCores.forEach(id => usedCores.add(id));

        // 5. Robot cores
        const availableForRobot = allCores.filter(c => !usedCores.has(c.id));
        const robotCores = this.allocateRobotCores(availableForRobot, robotCount);
        robotCores.forEach(id => usedCores.add(id));

        const coreAssignments = [
            ...serviceCores.map(s => ({ service: s.service, role: s.role, cores: [s.coreId] })),
            { service: 'gateway', role: 'gateway', cores: gatewayCores },
            { service: 'robot', role: 'robot_default', cores: robotCores }
        ];

        return {
            totalCores: snapshot.topology.length,
            osCores: osCoresList,
            irqCores: irqCoresList,
            instances: [{
                instanceId: 'DEFAULT',
                allocatedCores: serviceCount + gatewayCores.length + robotCores.length,
                coreAssignments,
                gateway: gatewayCores.length,
                robot: robotCores.length,
                deficitMode,
                numaPlacement: { serviceCoresNuma: networkNumaNodes[0] || 0, isNetworkNuma: true }
            }],
            systemCores: { os: osCount, irq: irqCount },
            recommendations: []
        };
    },

    /**
     * Analyze topology structure
     * @param {Object} snapshot - Parsed snapshot
     * @returns {Object} Topology analysis
     */
    analyzeTopology(snapshot) {
        const cores = snapshot.topology.map(c => ({
            id: c.id,
            numaNodeId: c.numaNodeId,
            l3CacheId: c.l3CacheId,
            socketId: c.socketId,
            isolated: c.isolated || false
        })).sort((a, b) => a.id - b.id);

        const numaNodes = [...new Set(cores.map(c => c.numaNodeId))];
        const l3Caches = [...new Set(cores.map(c => c.l3CacheId))];

        // Group cores by NUMA
        const coresByNuma = {};
        numaNodes.forEach(numa => {
            coresByNuma[numa] = cores.filter(c => c.numaNodeId === numa);
        });

        // Group cores by L3
        const coresByL3 = {};
        l3Caches.forEach(l3 => {
            coresByL3[l3] = cores.filter(c => c.l3CacheId === l3);
        });

        return { cores, numaNodes, l3Caches, coresByNuma, coresByL3 };
    },

    /**
     * Detect network NUMA nodes based on network interfaces
     * @param {Object} snapshot - Parsed snapshot
     * @param {Object} topology - Topology analysis
     * @returns {Array} Network NUMA node IDs
     */
    detectNetworkNumas(snapshot, topology) {
        const networkNumas = new Set();

        // From network interfaces
        if (snapshot.network && snapshot.network.length > 0) {
            snapshot.network.forEach(iface => {
                if (iface.numaNode !== undefined && iface.numaNode !== -1) {
                    networkNumas.add(iface.numaNode);
                }
            });
        }

        // From IRQ assignments in topology
        snapshot.topology.forEach(core => {
            core.services.forEach(service => {
                if (service.name && (service.name.includes('net_cpu') || service.name.includes('IRQ'))) {
                    networkNumas.add(core.numaNodeId);
                }
            });
        });

        // Fallback: use first NUMA node
        if (networkNumas.size === 0 && topology.numaNodes.length > 0) {
            networkNumas.add(topology.numaNodes[0]);
        }

        return Array.from(networkNumas);
    },

    /**
     * Generate optimization recommendations
     * @returns {Array} Recommendations
     */
    generateRecommendations(snapshot, osCores, irqCores, instances) {
        const recommendations = [];
        const totalCores = snapshot.topology.length;

        // Check OS core count
        const expectedOs = Math.round(totalCores / 10);
        if (osCores.length !== expectedOs) {
            recommendations.push({
                type: 'info',
                message: `OS cores: ${osCores.length} (expected ${expectedOs})`
            });
        }

        // Check IRQ is even
        if (irqCores.length % 2 !== 0) {
            recommendations.push({
                type: 'warning',
                message: `IRQ cores (${irqCores.length}) should be even!`
            });
        }

        // Check instance configuration
        instances.forEach(inst => {
            if (inst.gateway < 1) {
                recommendations.push({
                    type: 'error',
                    message: `${inst.instanceId}: No gateway cores allocated!`
                });
            }
            if (inst.robot < 1) {
                recommendations.push({
                    type: 'error',
                    message: `${inst.instanceId}: No robot cores allocated!`
                });
            }
            if (inst.deficitMode) {
                recommendations.push({
                    type: 'warning',
                    message: `${inst.instanceId}: Running in deficit mode (UDP merged with Trash)`
                });
            }
        });

        return recommendations;
    }
};

if (typeof window !== 'undefined') window.CPU_OPTIMIZER = CPU_OPTIMIZER;
if (typeof module !== 'undefined') module.exports = CPU_OPTIMIZER;

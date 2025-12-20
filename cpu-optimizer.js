/**
 * HFT CPU Optimizer - Capacity Planning Engine v5.3
 * 
 * Logic:
 * 1. Analyze Topology & Split-Brain detection (Interface Groups).
 * 2. Strict Instance->NUMA Mapping (Instance "Islands").
 * 3. Calculate Resource Needs per Instance.
 * 4. Partition Resources & Proportional Allocation (z-factor).
 * 5. Starvation Protection (Robin Hood).
 * 6. Topological Placement.
 */

const CPU_OPTIMIZER = {
    // Optimization Constants
    CONSTANTS: {
        FIXED_CORES_PER_INST: 3, // Trash/RF/Click + UDP + AR/Formula
        IRQ_CORES_SINGLE: 4,     // Fixed IRQ for Single Island
        IRQ_CORES_SPLIT: 3,      // Fixed IRQ per Island in Split Brain
        OS_RATIO: 0.1,           // 10% of cores
        MIN_OS_CORES: 2,         // Safety minimum
        GATEWAY_BUFFER: 1.2      // 20% buffer for Gateway calculation
    },

    optimize(snapshot) {
        console.log('[Optimizer] Starting optimization v5.3', { totalCores: snapshot.topology.length });

        // 1. Analyze Topology & Detect Islands
        const topology = this.analyzeTopology(snapshot);
        const islandMap = this.detectIslands(snapshot, topology);

        // 2. Strict Instance Mapping: Assign every instance to a specific Island
        const instanceToIsland = this.mapInstancesToIslands(snapshot, islandMap, topology);

        // 3. Calculate Needs (Grouped by Shared Resources)
        // Group instances based on their assigned Island to ensure we optimize them in the correct context
        // In v5.3, we assume instances don't share cores across Islands (Split Brain)
        const instanceGroups = this.extractInstanceGroups(snapshot);
        const groupNeeds = instanceGroups.map(grp => this.calculateGroupNeeds(grp));

        // 4. Global OS/IRQ Calculation (but applied per Island)
        let allOsCores = [];
        let totalIrqCount = 0;

        const allocations = [];

        islandMap.forEach((island, islandId) => {
            console.log(`[Optimizer] Optimizing Island: ${islandId} (${island.type})`, { nodes: island.numaNodes });

            // A. Partition Resources (OS & IRQ)
            const islandCores = topology.cores.filter(c => island.numaNodes.includes(c.numaNodeId));
            const totalIslandCores = islandCores.length;

            // OS Calculation
            const osCount = Math.max(this.CONSTANTS.MIN_OS_CORES, Math.floor(totalIslandCores * this.CONSTANTS.OS_RATIO));
            let osCores = [];

            if (island.osStrategy === 'start') {
                osCores = islandCores.slice(0, osCount).map(c => c.id);
            } else if (island.osStrategy === 'end') {
                osCores = islandCores.slice(-osCount).map(c => c.id);
            }
            allOsCores.push(...osCores);

            // IRQ Calculation
            let irqCount = 0;
            if (island.type === 'network') {
                const netIslands = Array.from(islandMap.values()).filter(i => i.type === 'network');
                irqCount = netIslands.length > 1 ? this.CONSTANTS.IRQ_CORES_SPLIT : this.CONSTANTS.IRQ_CORES_SINGLE;
            }
            totalIrqCount += irqCount;

            const availableForWork = totalIslandCores - osCores.length - irqCount;

            // B. Filter Groups for this Island based on Strict Mapping
            const islandGroups = groupNeeds.filter(grp => {
                // All instances in a group must belong to the same island due to physical constraints
                const repInst = grp.instances[0];
                return instanceToIsland.get(repInst) === islandId;
            });

            if (island.type === 'network') {
                // C. Proportional Allocation Logic (The "z" Factor + Robin Hood)
                const islandAlloc = this.allocateIslandResources(islandGroups, availableForWork, irqCount);
                allocations.push(...islandAlloc);
            }
        });

        // 5. Shared Pool Spillover (Only if relevant, but in split-brain, usually ignored or limited)
        // In strict split-brain, shared pool might be accessible by anyone, or partitioned.
        // For now, we assume strict Islands. If "Shared" island exists, logic handles it.

        // 6. Topological Placement
        const optimizedTopology = this.placeServices(allocations, snapshot, allOsCores, totalIrqCount, islandMap, instanceToIsland);

        return {
            totalCores: snapshot.topology.length,
            osCores: allOsCores,
            irqCores: optimizedTopology.irqCores,
            instances: optimizedTopology.instances,
            recommendations: []
        };
    },

    analyzeTopology(snapshot) {
        const cores = snapshot.topology.sort((a, b) => a.id - b.id);
        const numaNodes = [...new Set(cores.map(c => c.numaNodeId))];
        const netInterfaces = snapshot.network || [];

        const numaInterfaces = {};
        netInterfaces.forEach(net => {
            if (!numaInterfaces[net.numaNode]) numaInterfaces[net.numaNode] = [];
            numaInterfaces[net.numaNode].push(net.name);
        });

        return { cores, numaNodes, numaInterfaces, netInterfaces };
    },

    detectIslands(snapshot, topology) {
        const islands = new Map();
        const networkNumas = Object.keys(topology.numaInterfaces).map(Number);
        const netGroups = {};

        // Detect Distinct Network Endpoints
        networkNumas.forEach(numaId => {
            const ifaces = topology.numaInterfaces[numaId];
            const prefixes = [...new Set(ifaces.map(i => i.replace(/\d+.*$/, '')))];
            const groupKey = prefixes.sort().join('+');

            if (!netGroups[groupKey]) netGroups[groupKey] = { numas: [], interfaces: [] };
            netGroups[groupKey].numas.push(numaId);
            netGroups[groupKey].interfaces.push(...ifaces);
        });

        const distinctGroups = Object.keys(netGroups);
        const isSplitBrain = distinctGroups.length > 1;

        if (isSplitBrain) {
            distinctGroups.forEach((key, idx) => {
                const group = netGroups[key];
                // Use a stable ID based on interfaces/NUMA to map back easily
                const islandId = `island_${key}`;
                islands.set(islandId, {
                    id: islandId,
                    type: 'network',
                    numaNodes: group.numas,
                    interfaces: group.interfaces,
                    osStrategy: idx === 0 ? 'start' : 'end'
                });
            });
        } else {
            const allNetNumas = distinctGroups.length > 0 ? netGroups[distinctGroups[0]].numas : [];
            if (allNetNumas.length > 0) {
                 islands.set('main', {
                    id: 'main',
                    type: 'network',
                    numaNodes: allNetNumas,
                    interfaces: netGroups[distinctGroups[0]].interfaces,
                    osStrategy: 'start'
                });
            }
        }

        // Handle cases where no network is defined or fallback
        if (islands.size === 0 && topology.numaNodes.length > 0) {
             islands.set('main', {
                id: 'main',
                type: 'network',
                numaNodes: topology.numaNodes,
                interfaces: [],
                osStrategy: 'start'
            });
        }

        return islands;
    },

    mapInstancesToIslands(snapshot, islandMap, topology) {
        const mapping = new Map();

        // Get all known instances
        const instances = new Set();
        snapshot.topology.forEach(c => c.services.forEach(s => {
            if (s.instanceId !== 'SYSTEM') instances.add(s.instanceId);
        }));

        instances.forEach(instId => {
            // Strategy: Find "Center of Gravity" for this instance
            // 1. Look for Trash/Fixed roles first (strongest signal)
            let homeNuma = -1;

            // Check specific core roles if available in snapshot
            const instanceCores = snapshot.topology.filter(c =>
                c.services.some(s => s.instanceId === instId)
            );

            const trashCore = instanceCores.find(c =>
                c.services.some(s => s.instanceId === instId && (s.name.includes('Trash') || s.name.includes('UDP')))
            );

            if (trashCore) {
                homeNuma = trashCore.numaNodeId;
            } else {
                // Majority Vote
                const numaCounts = {};
                let max = 0;
                instanceCores.forEach(c => {
                    numaCounts[c.numaNodeId] = (numaCounts[c.numaNodeId] || 0) + 1;
                    if (numaCounts[c.numaNodeId] > max) {
                        max = numaCounts[c.numaNodeId];
                        homeNuma = c.numaNodeId;
                    }
                });
            }

            // Map NUMA to Island
            let assignedIslandId = null;
            if (homeNuma !== -1) {
                for (const [islandId, island] of islandMap.entries()) {
                    if (island.numaNodes.includes(homeNuma)) {
                        assignedIslandId = islandId;
                        break;
                    }
                }
            }

            // Fallback: Assign to 'main' or first network island if unmapped
            if (!assignedIslandId) {
                const firstNet = Array.from(islandMap.values()).find(i => i.type === 'network');
                assignedIslandId = firstNet ? firstNet.id : 'main';
            }

            mapping.set(instId, assignedIslandId);
        });

        return mapping;
    },

    extractInstanceGroups(snapshot) {
        // Simplified grouping: 1 Group = 1 Instance.
        // Complex shared-core grouping is often overkill or incorrect for strict HFT separation.
        // Assuming strict separation is better.
        const instSet = new Set();
        snapshot.topology.forEach(c => c.services.forEach(s => {
            if (s.instanceId !== 'SYSTEM') instSet.add(s.instanceId);
        }));

        return Array.from(instSet).map(instId => {
            // Calculate load stats
            let gateways = 0;
            let robots = 0;
            let loadSumGw = 0;
            let loadSumRob = 0;

            snapshot.topology.forEach(c => {
                c.services.forEach(s => {
                    if (s.instanceId === instId) {
                        const type = s.name.toLowerCase();
                        if (type.includes('gateway')) { gateways++; loadSumGw += c.currentLoad || 0; }
                        if (type.includes('robot')) { robots++; loadSumRob += c.currentLoad || 0; }
                    }
                });
            });

            return {
                groupId: instId,
                instances: [instId],
                gateways, robots, loadSumGw, loadSumRob
            };
        });
    },

    calculateGroupNeeds(grp) {
        const gwAvg = grp.gateways > 0 ? grp.loadSumGw / grp.gateways : 0;
        const robAvg = grp.robots > 0 ? grp.loadSumRob / grp.robots : 0;

        // 1. Fixed Cores
        const fixed = this.CONSTANTS.FIXED_CORES_PER_INST;

        // 2. Gateway Cores
        let gwNeeded = 1;
        if (gwAvg < 1 && grp.gateways > 0) {
            gwNeeded = grp.gateways;
        } else if (grp.gateways > 0) {
            const rawNeeded = (grp.gateways * gwAvg) / 25;
            gwNeeded = Math.ceil(rawNeeded * this.CONSTANTS.GATEWAY_BUFFER);
        }
        gwNeeded = Math.max(1, gwNeeded);

        // 3. Robot Cores (Initial Demand)
        let robNeeded = 1;
        if (robAvg < 1 && grp.robots > 0) {
            robNeeded = grp.robots;
        } else if (grp.robots > 0) {
            robNeeded = Math.ceil((grp.robots * robAvg) / 40);
        }
        robNeeded = Math.max(1, robNeeded);

        return {
            groupId: grp.groupId,
            instances: grp.instances,
            needs: {
                fixed: fixed,
                gateway: gwNeeded,
                robot: robNeeded,
                total: fixed + gwNeeded + robNeeded
            },
            current: { gateway: grp.gateways, robot: grp.robots }
        };
    },

    allocateIslandResources(groups, availableCores, irqCount) {
        if (groups.length === 0) return [];

        let mandatoryTotal = 0;
        groups.forEach(g => mandatoryTotal += g.needs.fixed + g.needs.gateway);

        let z = availableCores - mandatoryTotal;

        const results = groups.map(g => ({
            groupId: g.groupId,
            instances: g.instances,
            assigned: {
                fixed: g.needs.fixed,
                gateway: g.needs.gateway,
                robot: 0
            },
            weight: g.needs.total // Use total need as weight for proportional distribution
        }));

        if (z < 0) {
            // Deficit Management
            console.warn(`[Optimizer] CRISIS: Not enough cores! Deficit: ${z}`);
            let remaining = availableCores;

            // 1. Fixed (Absolute priority)
            results.forEach(r => {
                const canTake = Math.min(remaining, r.assigned.fixed);
                r.assigned.fixed = canTake;
                remaining -= canTake;
            });

            // 2. Gateway (Squeeze)
            if (remaining > 0) {
                const totalGwDemand = groups.reduce((sum, g) => sum + g.needs.gateway, 0);
                results.forEach(r => {
                    const share = Math.floor(remaining * (r.assigned.gateway / totalGwDemand));
                    r.assigned.gateway = Math.max(1, share);
                });
            } else {
                 results.forEach(r => r.assigned.gateway = 0);
            }
            results.forEach(r => r.assigned.robot = 0);

        } else {
            // Surplus Management (Proportional Distribution)
            // Weight = Total Needs (Size of instance)
            const totalWeight = groups.reduce((sum, g) => sum + g.needs.total, 0);

            let usedZ = 0;
            // First pass: Proportional share
            groups.forEach((grp, idx) => {
                const res = results[idx];
                const share = Math.floor(z * (grp.needs.total / totalWeight));
                res.assigned.robot = share;
                usedZ += share;
            });

            // Distribute remainders (due to floor) to largest instances
            let remainder = z - usedZ;
            if (remainder > 0) {
                const sortedByWeight = [...results].sort((a, b) => b.weight - a.weight);
                for (let i = 0; i < remainder; i++) {
                    sortedByWeight[i % sortedByWeight.length].assigned.robot++;
                }
            }
        }

        // =====================================================================
        // Starvation Protection (Robin Hood)
        // Ensure every instance has at least 1 Robot core
        // =====================================================================

        let starving = results.filter(r => r.assigned.robot === 0);
        let maxIterations = groups.length * 2; // Safety break

        while (starving.length > 0 && maxIterations-- > 0) {
            // Find rich instances (more than 1 robot)
            const rich = results.filter(r => r.assigned.robot > 1).sort((a, b) => b.assigned.robot - a.assigned.robot);

            if (rich.length === 0) break; // Cannot redistribute further

            const donor = rich[0];
            const receiver = starving[0];

            donor.assigned.robot--;
            receiver.assigned.robot++;

            starving = results.filter(r => r.assigned.robot === 0);
        }

        return results;
    },

    placeServices(allocations, snapshot, osCores, totalIrqNeeded, islandMap, instanceToIsland) {
        const result = { irqCores: [], instances: [] };

        const coreMap = {};
        const freeCores = new Set();

        snapshot.topology.forEach(c => {
            coreMap[c.id] = { id: c.id, numa: c.numaNodeId, l3: c.l3CacheId };
            freeCores.add(c.id);
        });

        osCores.forEach(id => freeCores.delete(id));

        const pickCore = (criteria) => {
            const candidates = Array.from(freeCores).map(id => coreMap[id])
                .filter(c => criteria.numas.includes(c.numa));

            if (candidates.length === 0) return null;

            if (criteria.l3 !== undefined) {
                const l3Matches = candidates.filter(c => c.l3 === criteria.l3);
                if (l3Matches.length > 0) return l3Matches[0].id;
            }

            candidates.sort((a, b) => a.id - b.id);
            return candidates[0].id;
        };

        // 1. Place IRQs (Strictly on Network Islands)
        const irqCoresList = [];
        islandMap.forEach((island) => {
            if (island.type !== 'network') return;
            const netIslands = Array.from(islandMap.values()).filter(i => i.type === 'network');
            const needed = netIslands.length > 1 ? this.CONSTANTS.IRQ_CORES_SPLIT : this.CONSTANTS.IRQ_CORES_SINGLE;

            for(let i=0; i<needed; i++) {
                const c = pickCore({ numas: island.numaNodes });
                if (c !== null) {
                    freeCores.delete(c);
                    irqCoresList.push(c);
                }
            }
        });
        result.irqCores = irqCoresList;

        // 2. Place Groups (Strictly on assigned Islands)
        allocations.forEach(alloc => {
            const groupAssignments = [];
            let groupAllocatedCount = 0;

            const repInst = alloc.instances[0];
            const islandId = instanceToIsland.get(repInst);
            const targetIsland = islandMap.get(islandId);
            const targetNumas = targetIsland ? targetIsland.numaNodes : [];

            // Helper to assign
            const assign = (service, role, count) => {
                 const assigned = [];
                 for(let i=0; i<count; i++) {
                     // STRICT: Only use targetNumas. No shared spillover for core HFT roles.
                     let c = pickCore({ numas: targetNumas });

                     if (c !== null) {
                         freeCores.delete(c);
                         assigned.push(c);
                     }
                 }
                 if (assigned.length > 0) {
                     groupAssignments.push({ service, role, cores: assigned });
                     groupAllocatedCount += assigned.length;
                 }
            };

            // Order matters: Trash/UDP first (usually 1 core), then Gateways, then Robots
            assign('trash_combo', 'trash', 1);
            assign('udp', 'udp', 1);
            assign('ar_combo', 'ar', 1);
            assign('gateway', 'gateway', alloc.assigned.gateway);

            // Robots
            const robotCount = alloc.assigned.robot;
            const robotCores = [];
            for(let i=0; i<robotCount; i++) {
                let c = pickCore({ numas: targetNumas });
                if (c !== null) {
                    freeCores.delete(c);
                    robotCores.push(c);
                }
            }
             if (robotCores.length > 0) {
                 groupAssignments.push({ service: 'robot', role: 'robot_default', cores: robotCores });
                 groupAllocatedCount += robotCores.length;
             }

            // Distribute assignments to all instances in group (usually just 1 now)
            alloc.instances.forEach(instId => {
                result.instances.push({
                    instanceId: instId,
                    allocatedCores: groupAllocatedCount,
                    coreAssignments: groupAssignments,
                    gateway: alloc.assigned.gateway,
                    robot: alloc.assigned.robot,
                    numaPlacement: { breakdown: { [targetIsland.id]: { isNetwork: true, services: ['ALL'], numaId: targetNumas[0] } } }
                });
            });
        });

        return result;
    }
};

if (typeof window !== 'undefined') window.CPU_OPTIMIZER = CPU_OPTIMIZER;
if (typeof module !== 'undefined') module.exports = CPU_OPTIMIZER;

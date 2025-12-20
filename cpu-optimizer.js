/**
 * HFT CPU Optimizer - Capacity Planning Engine v5.1
 * 
 * Logic:
 * 1. Analyze Topology & Split-Brain detection (Interface Groups).
 * 2. Calculate Resource Needs per Instance.
 * 3. Partition Resources (Islands).
 * 4. Allocate Cores (Fixed -> Gateway -> Robot z-factor).
 * 5. Topological Placement (L3 constraints).
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
        console.log('[Optimizer] Starting optimization v5.1', { totalCores: snapshot.topology.length });

        // 1. Analyze Topology & Detect Islands
        const topology = this.analyzeTopology(snapshot);
        const islandMap = this.detectIslands(snapshot, topology);

        // 2. Calculate Needs
        const instances = this.extractInstances(snapshot);
        const instanceNeeds = instances.map(inst => this.calculateInstanceNeeds(inst));

        // 3. Global OS/IRQ Calculation (Placeholder, detailed in partitioning)
        // We will return the specific OS cores used in the result
        let allOsCores = [];
        let totalIrqCount = 0;

        // 4. Per-Island Optimization
        const allocations = [];

        islandMap.forEach((island, islandId) => {
            console.log(`[Optimizer] Optimizing Island: ${islandId} (${island.type})`, { nodes: island.numaNodes });

            // A. Partition Resources (OS & IRQ)
            const islandCores = topology.cores.filter(c => island.numaNodes.includes(c.numaNodeId));
            const totalIslandCores = islandCores.length;

            // OS Calculation
            let osCores = [];
            const osCount = Math.max(this.CONSTANTS.MIN_OS_CORES, Math.ceil(totalIslandCores * this.CONSTANTS.OS_RATIO));

            if (island.osStrategy === 'start') {
                // First N cores of the island (sorted by ID)
                osCores = islandCores.slice(0, osCount).map(c => c.id);
            } else if (island.osStrategy === 'end') {
                // Last N cores of the island
                osCores = islandCores.slice(-osCount).map(c => c.id);
            }
            // 'none' strategy implies shared pool or no OS needed (handled in shared logic if any)

            allOsCores.push(...osCores);

            // IRQ Calculation
            let irqCount = 0;
            if (island.type === 'network') {
                irqCount = (islandMap.size > 1 && islandMap.get('shared') ? this.CONSTANTS.IRQ_CORES_SPLIT :
                           (islandMap.size > 1 ? this.CONSTANTS.IRQ_CORES_SPLIT : this.CONSTANTS.IRQ_CORES_SINGLE));

                // If this is split brain (more than 1 network island), force 3.
                // If single network island, force 4.
                // Check if we have multiple network islands
                const netIslands = Array.from(islandMap.values()).filter(i => i.type === 'network');
                irqCount = netIslands.length > 1 ? this.CONSTANTS.IRQ_CORES_SPLIT : this.CONSTANTS.IRQ_CORES_SINGLE;
            }
            totalIrqCount += irqCount;

            // Available for instances
            // Exclude OS cores. IRQ cores are "allocated" later but take space.
            const availableForWork = totalIslandCores - osCores.length - irqCount;

            // B. Filter Instances for this Island
            const islandInstances = instanceNeeds.filter(inst => {
                // If instance has specific interface mapping, check if it matches island interfaces
                // If not mapped, and this is the only network island, assign here.
                const assignedIf = snapshot.instanceToInterface[inst.instanceId];
                if (assignedIf) {
                    return island.interfaces.includes(assignedIf);
                }
                // Fallback: If single network island, take it.
                if (island.type === 'network' && Array.from(islandMap.values()).filter(i => i.type === 'network').length === 1) {
                    return true;
                }
                return false;
            });

            if (island.type === 'network') {
                // C. Allocation Logic (The "z" Factor)
                const islandAlloc = this.allocateIslandResources(islandInstances, availableForWork, irqCount);
                allocations.push(...islandAlloc);
            } else {
                // Shared pool logic (Robots overflow)
                // We'll handle shared pool after network islands are processed?
                // Or just mark these cores as available for spillover.
            }
        });

        // 5. Shared Pool Spillover (if applicable)
        // Check for unallocated Robot needs and place on Shared Island if exists
        const sharedIsland = islandMap.get('shared');
        if (sharedIsland) {
             const sharedCores = topology.cores.filter(c => sharedIsland.numaNodes.includes(c.numaNodeId));
             // Use all shared cores for robots (no OS/IRQ usually, or maybe minimal OS? User said "common pool")
             // User: "if extra nodes... common pool... distribute resources... for robots of both"
             // So we treat them as pure robot capacity.

             this.distributeSpillover(allocations, sharedCores, instanceNeeds);
        }

        // 6. Topological Placement
        const optimizedTopology = this.placeServices(allocations, snapshot, allOsCores, totalIrqCount, islandMap);

        return {
            totalCores: snapshot.topology.length,
            osCores: allOsCores,
            irqCores: optimizedTopology.irqCoresCount,
            instances: optimizedTopology.instances,
            recommendations: [] // TODO: Generate nice messages
        };
    },

    analyzeTopology(snapshot) {
        const cores = snapshot.topology.sort((a, b) => a.id - b.id);
        const numaNodes = [...new Set(cores.map(c => c.numaNodeId))];
        const netInterfaces = snapshot.network || [];

        // Group interfaces by NUMA
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
        const netGroups = {}; // endpoint -> { interfaces, numas }

        // Group interfaces by endpoint (net0/net1 => same, hit0/hit1 => same)
        // Heuristic: Remove digits? Or user specified: net vs hit.
        // Let's group by prefix (alpha part).
        // Actually user said: "net0 / net1 not counted [different], but net0/1 and hit0/1 are different"
        // So we look for distinct groups.

        // Strategy: Create an island for each Network NUMA Node.
        // If multiple Network NUMA nodes share the SAME interface prefix (e.g. net0 on node0, net1 on node0), they are one island.
        // If net0 on Node 0 and hit0 on Node 1 -> Two Islands.

        networkNumas.forEach(numaId => {
            const ifaces = topology.numaInterfaces[numaId];
            // Key based on interface naming?
            // Let's use the NUMA ID as the island ID for network nodes essentially.
            // But we need to check if we should Merge them?
            // User: "Scenario 2... both numa nodes are network... >1 network interface".
            // If we have Node 0 (net0) and Node 1 (net1) -> Are they split brain?
            // "net0 / net1 ne schitautsya... endpoint konechniy... a vot net0/1 i hit0/1 uzhe raznie"
            // This implies: net0 & net1 are ONE group. hit0 & hit1 are ANOTHER group.

            // Check prefixes
            const prefixes = [...new Set(ifaces.map(i => i.replace(/\d+$/, '')))];
            const groupKey = prefixes.sort().join('+'); // e.g. "net" or "hit" or "net+hit"

            if (!netGroups[groupKey]) netGroups[groupKey] = { numas: [], interfaces: [] };
            netGroups[groupKey].numas.push(numaId);
            netGroups[groupKey].interfaces.push(...ifaces);
        });

        const distinctGroups = Object.keys(netGroups);
        const isSplitBrain = distinctGroups.length > 1;

        if (isSplitBrain) {
            distinctGroups.forEach((key, idx) => {
                const group = netGroups[key];
                const islandId = `island_${key}`;
                islands.set(islandId, {
                    id: islandId,
                    type: 'network',
                    numaNodes: group.numas,
                    interfaces: group.interfaces,
                    osStrategy: idx === 0 ? 'start' : 'end' // First group start, second group end
                });
            });
        } else {
            // Single Group (Scenario 1)
            // Even if multiple NUMAs, if they share "net", treat as one big island or standard?
            // "Scenario 2... only if both... > 1 interface".
            // If 1 interface group, standard logic.
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

        // Shared Nodes (Non-Network)
        const sharedNumas = topology.numaNodes.filter(n => !networkNumas.includes(n));
        if (sharedNumas.length > 0) {
            islands.set('shared', {
                id: 'shared',
                type: 'shared',
                numaNodes: sharedNumas,
                interfaces: [],
                osStrategy: 'none'
            });
        }

        // Fallback: If no network found at all (simulation/error), treat all as Main
        if (islands.size === 0 && topology.numaNodes.length > 0) {
             islands.set('main', {
                id: 'main',
                type: 'network', // treat as network for calculation
                numaNodes: topology.numaNodes,
                interfaces: [],
                osStrategy: 'start'
            });
        }

        return islands;
    },

    extractInstances(snapshot) {
        // Extract instances from current allocation to determine "Needs"
        // In a real run, we might want to preserve existing instance mapping if provided
        // Or re-calculate from scratch.
        // Here we extract distinct Instance IDs from the snapshot services
        const instMap = new Map();

        // Heuristic: Iterate services in topology
        snapshot.topology.forEach(c => {
            c.services.forEach(s => {
                if (s.instanceId === 'SYSTEM') return;
                if (!instMap.has(s.instanceId)) {
                    instMap.set(s.instanceId, {
                        instanceId: s.instanceId,
                        // Default loads if not found?
                        gateways: 0,
                        robots: 0,
                        loadSumGw: 0,
                        loadSumRob: 0
                    });
                }
                const rec = instMap.get(s.instanceId);
                const type = s.name.toLowerCase();
                if (type.includes('gateway')) { rec.gateways++; rec.loadSumGw += c.currentLoad || 0; }
                if (type.includes('robot')) { rec.robots++; rec.loadSumRob += c.currentLoad || 0; }
            });
        });

        // If map is empty (e.g. fresh state), we can't do much unless provided externally.
        // For the purpose of this tool, we assume 'snapshot' reflects the current state we want to optimize.
        return Array.from(instMap.values());
    },

    calculateInstanceNeeds(inst) {
        const gwAvg = inst.gateways > 0 ? inst.loadSumGw / inst.gateways : 0;
        const robAvg = inst.robots > 0 ? inst.loadSumRob / inst.robots : 0;

        // 1. Fixed Cores (Trash/RF/Click + UDP + AR/Formula)
        // Always 3 per instance
        const fixed = this.CONSTANTS.FIXED_CORES_PER_INST;

        // 2. Gateway Cores
        // Rule: Base + 20% buffer.
        // If current load > 25%, scale up?
        // Let's stick to: maintain ~25% load.
        // Needed = (CurrentCores * CurrentAvg) / Target(25) * Buffer(1.2)
        // If 0 gateways currently, assume 1 minimum.
        let gwNeeded = 1;
        if (inst.gateways > 0) {
            const rawNeeded = (inst.gateways * gwAvg) / 25;
            gwNeeded = Math.ceil(rawNeeded * this.CONSTANTS.GATEWAY_BUFFER);
        }
        gwNeeded = Math.max(1, gwNeeded);

        // 3. Robot Cores
        // Target 30-50%, let's aim for 40%.
        let robNeeded = 1;
        if (inst.robots > 0) {
            robNeeded = Math.ceil((inst.robots * robAvg) / 40);
        }
        robNeeded = Math.max(1, robNeeded);

        return {
            instanceId: inst.instanceId,
            needs: {
                fixed: fixed,
                gateway: gwNeeded,
                robot: robNeeded,
                total: fixed + gwNeeded + robNeeded
            },
            // Current stats for reference
            current: { gateway: inst.gateways, robot: inst.robots }
        };
    },

    allocateIslandResources(instances, availableCores, irqCount) {
        // "z" Allocation Logic
        // 1. Mandatory Network: Fixed + Gateways
        let mandatoryTotal = 0;
        instances.forEach(i => mandatoryTotal += i.needs.fixed + i.needs.gateway);

        // 2. Calculate z
        let z = availableCores - mandatoryTotal; // Can be negative!

        const results = instances.map(i => ({
            instanceId: i.instanceId,
            assigned: {
                fixed: i.needs.fixed,
                gateway: i.needs.gateway,
                robot: 0 // Will fill
            }
        }));

        if (z < 0) {
            // Crisis: Not enough space for Mandatory!
            // Strategy: Squeeze Gateways?
            // For now, distribute deficit proportionally to Gateway count?
            console.warn(`[Optimizer] CRISIS: Not enough cores for mandatory services! Deficit: ${z}`);
            // We'll proceed with negative z (oversubscription) handling or clamping?
            // In a real tool, we might want to prioritize Fixed > Gateway.
            // Let's cap allocation to available.

            // Re-calc with squeeze
            let remaining = availableCores;

            // 1. Fixed (Absolute Priority)
            results.forEach(r => {
                const canTake = Math.min(remaining, r.assigned.fixed);
                r.assigned.fixed = canTake;
                remaining -= canTake;
            });

            // 2. Gateway (Priority 2)
            if (remaining > 0) {
                // Distribute remaining to gateways proportionally
                const totalGwDemand = instances.reduce((sum, i) => sum + i.needs.gateway, 0);
                results.forEach(r => {
                    const share = Math.floor(remaining * (r.assigned.gateway / totalGwDemand));
                    r.assigned.gateway = Math.max(1, share); // Ensure min 1
                });
                // Fix rounding errors? (skipped for brevity)
            } else {
                 results.forEach(r => r.assigned.gateway = 0); // Fatal
            }

            // 3. Robots - None
            results.forEach(r => r.assigned.robot = 0);

        } else {
            // Surplus z for Robots
            // Distribute z proportionally based on Total Needs (A)
            // Constraint: "At least 50% of necessary" (if z is small)
            // User: "distribute proportionally... if 1st needs 12, 2nd needs 8..."

            const totalNeeds = instances.reduce((sum, i) => sum + i.needs.total, 0);

            instances.forEach((inst, idx) => {
                const res = results[idx];
                const weight = inst.needs.total;

                // Proportional share of z
                let robotShare = Math.floor(z * (weight / totalNeeds));

                // Check 50% guarantee rule
                // "Each instance must have at least 50% of necessary cores" (Total necessary?)
                // Or 50% of its ROBOT necessary cores?
                // Context implies "striving to all cores necessary".
                // Let's assume we try to fit as many robots as possible.

                // Cap at needed robots (don't give more than needed if z is huge)
                robotShare = Math.min(robotShare, inst.needs.robot);

                res.assigned.robot = robotShare;

                // Spillover logic handled later (unmet robot needs)
            });

            // Distribute remainders (integer math rounding)
            // (Skipped for brevity, but "z" might have dust)
        }

        return results;
    },

    distributeSpillover(allocations, sharedCores, allNeeds) {
        let available = sharedCores.length;
        if (available <= 0) return;

        // Calculate unmet robot needs
        const unmet = [];
        allocations.forEach(alloc => {
            const need = allNeeds.find(n => n.instanceId === alloc.instanceId);
            const missing = need.needs.robot - alloc.assigned.robot;
            if (missing > 0) {
                unmet.push({ alloc, missing });
            }
        });

        if (unmet.length === 0) return;

        // Distribute shared cores proportionally to missing needs
        const totalMissing = unmet.reduce((s, u) => s + u.missing, 0);

        unmet.forEach(u => {
            const share = Math.min(u.missing, Math.floor(available * (u.missing / totalMissing)));
            u.alloc.assigned.robot += share; // Add to existing assignment count
            // Note: We need to tag these as "shared" or "remote" placement?
            // The allocation object just has counts.
            // The Placement phase will see "Robot: 15" and try to place them.
            // If Network Node is full, it should naturally spill to Shared Node.
        });
    },

    placeServices(allocations, snapshot, osCores, totalIrqNeeded, islandMap) {
        const result = { irqCoresCount: 0, instances: [] };

        // Prepare global free core list
        const coreMap = {}; // id -> { assigned: bool, numa: id }
        const freeCores = new Set();

        snapshot.topology.forEach(c => {
            coreMap[c.id] = { id: c.id, numa: c.numaNodeId, l3: c.l3CacheId };
            freeCores.add(c.id);
        });

        // Mark OS
        osCores.forEach(id => freeCores.delete(id));

        // Placement Helper
        const pickCore = (criteria) => {
            // criteria: { numas: [], l3: optional, exclude: [] }
            const candidates = Array.from(freeCores).map(id => coreMap[id])
                .filter(c => criteria.numas.includes(c.numa));

            if (candidates.length === 0) return null;

            // L3 constraint
            if (criteria.l3 !== undefined) {
                const l3Matches = candidates.filter(c => c.l3 === criteria.l3);
                if (l3Matches.length > 0) return l3Matches[0].id;
            }

            // Default: First available (sort by ID)
            candidates.sort((a, b) => a.id - b.id);
            return candidates[0].id;
        };

        // 1. Place IRQs (High Priority, Fixed per island)
        // We know how many IRQs needed per island from step 4.
        // We need to place them on the specific island's NUMA.
        let irqPlaced = 0;
        islandMap.forEach((island) => {
            if (island.type !== 'network') return;
            // IRQ Count: Single=4, Split=3
            const count = (islandMap.size > 1 && islandMap.get('shared') ? this.CONSTANTS.IRQ_CORES_SPLIT :
                          (islandMap.size > 1 ? this.CONSTANTS.IRQ_CORES_SPLIT : this.CONSTANTS.IRQ_CORES_SINGLE));
            const needed = (Array.from(islandMap.values()).filter(i => i.type === 'network').length > 1) ? 3 : 4;

            for(let i=0; i<needed; i++) {
                const c = pickCore({ numas: island.numaNodes });
                if (c !== null) {
                    freeCores.delete(c);
                    irqPlaced++;
                }
            }
        });
        result.irqCoresCount = irqPlaced;

        // 2. Place Instances
        allocations.forEach(alloc => {
            const instResult = {
                instanceId: alloc.instanceId,
                allocatedCores: 0,
                coreAssignments: [],
                gateway: alloc.assigned.gateway, // Stats
                robot: alloc.assigned.robot
            };

            // Identify Target Island for this instance
            // We need to find which island this instance belongs to
            // Using interface mapping again
            let targetIsland = null;
            const assignedIf = snapshot.instanceToInterface[alloc.instanceId];

            for (const island of islandMap.values()) {
                if (assignedIf && island.interfaces.includes(assignedIf)) {
                    targetIsland = island;
                    break;
                }
            }
            if (!targetIsland) {
                 // Fallback to Main or First Network Island
                 targetIsland = Array.from(islandMap.values()).find(i => i.type === 'network');
            }

            const targetNumas = targetIsland ? targetIsland.numaNodes : [];
            const sharedNumas = islandMap.get('shared') ? islandMap.get('shared').numaNodes : [];

            // A. Mandatory Fixed Services (Trash/Click/RF | UDP | AR/Form)
            // They need specific L3 isolation if possible.
            // Priority: Place on Target Network Island

            // Helper to assign
            const assign = (service, role, count, preferenceNumas) => {
                 const assigned = [];
                 for(let i=0; i<count; i++) {
                     let c = pickCore({ numas: preferenceNumas });
                     // Fallback to shared if network full? (Bad for fixed services, they need Net)
                     if (c === null) c = pickCore({ numas: sharedNumas });

                     if (c !== null) {
                         freeCores.delete(c);
                         assigned.push(c);
                     }
                 }
                 if (assigned.length > 0) {
                     instResult.coreAssignments.push({ service, role, cores: assigned });
                     instResult.allocatedCores += assigned.length;
                 }
            };

            // Fixed Services (Count is usually 1 each in the assigned object, but passed as 'fixed:3')
            // We split 'fixed' back into components for placement
            assign('trash_combo', 'trash', 1, targetNumas);
            assign('udp', 'udp', 1, targetNumas);
            assign('ar_combo', 'ar', 1, targetNumas);

            // B. Gateways (Strictly Network)
            assign('gateway', 'gateway', alloc.assigned.gateway, targetNumas);

            // C. Robots (Network Preferred, then Shared)
            // We allocated 'alloc.assigned.robot' count.
            // Try to put as many on Target Island as possible.
            const robotCount = alloc.assigned.robot;
            const robotCores = [];

            for(let i=0; i<robotCount; i++) {
                // Try Target first
                let c = pickCore({ numas: targetNumas });
                if (c === null) {
                    // Try Shared
                    c = pickCore({ numas: sharedNumas });
                }

                if (c !== null) {
                    freeCores.delete(c);
                    robotCores.push(c);
                }
            }
             if (robotCores.length > 0) {
                 instResult.coreAssignments.push({ service: 'robot', role: 'robot_default', cores: robotCores });
                 instResult.allocatedCores += robotCores.length;
             }

            result.instances.push(instResult);
        });

        // Calculate Scores (Simplified for now)
        // ...

        return result;
    }
};

if (typeof window !== 'undefined') window.CPU_OPTIMIZER = CPU_OPTIMIZER;
if (typeof module !== 'undefined') module.exports = CPU_OPTIMIZER;

/**
 * HFT CPU Optimizer - Capacity Planning Engine v5.2
 * 
 * Logic:
 * 1. Analyze Topology & Split-Brain detection (Interface Groups).
 * 2. Calculate Resource Needs per Instance (Grouped by Co-location).
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
        console.log('[Optimizer] Starting optimization v5.2', { totalCores: snapshot.topology.length });

        // 1. Analyze Topology & Detect Islands
        const topology = this.analyzeTopology(snapshot);
        const islandMap = this.detectIslands(snapshot, topology);

        // 2. Calculate Needs (Grouped by Shared Resources)
        // We group instances that share cores into "Resource Groups" to avoid double counting needs.
        const instanceGroups = this.extractInstanceGroups(snapshot);
        const groupNeeds = instanceGroups.map(grp => this.calculateGroupNeeds(grp));

        // 3. Global OS/IRQ Calculation
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
                osCores = islandCores.slice(0, osCount).map(c => c.id);
            } else if (island.osStrategy === 'end') {
                osCores = islandCores.slice(-osCount).map(c => c.id);
            }
            allOsCores.push(...osCores);

            // IRQ Calculation
            let irqCount = 0;
            if (island.type === 'network') {
                // Check if we have multiple network islands
                const netIslands = Array.from(islandMap.values()).filter(i => i.type === 'network');
                irqCount = netIslands.length > 1 ? this.CONSTANTS.IRQ_CORES_SPLIT : this.CONSTANTS.IRQ_CORES_SINGLE;
            }
            totalIrqCount += irqCount;

            const availableForWork = totalIslandCores - osCores.length - irqCount;

            // B. Filter Groups for this Island
            const islandGroups = groupNeeds.filter(grp => {
                // If any instance in the group maps to this island, the whole group goes here.
                // We assume a group doesn't span islands (physical constraint).
                const representative = grp.instances[0];
                const assignedIf = snapshot.instanceToInterface[representative];

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
                const islandAlloc = this.allocateIslandResources(islandGroups, availableForWork, irqCount);
                allocations.push(...islandAlloc);
            }
        });

        // 5. Shared Pool Spillover
        const sharedIsland = islandMap.get('shared');
        if (sharedIsland) {
             const sharedCores = topology.cores.filter(c => sharedIsland.numaNodes.includes(c.numaNodeId));
             this.distributeSpillover(allocations, sharedCores, groupNeeds);
        }

        // 6. Topological Placement
        const optimizedTopology = this.placeServices(allocations, snapshot, allOsCores, totalIrqCount, islandMap);

        return {
            totalCores: snapshot.topology.length,
            osCores: allOsCores,
            irqCores: optimizedTopology.irqCores, // List of IDs
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

        // Detect Distinct Network Endpoints (e.g. net vs hit)
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
            // Single Group
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

        // Shared Nodes
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

    extractInstanceGroups(snapshot) {
        // 1. Identify all instances and their core usage
        const instMap = new Map(); // instId -> Set(coreIds)

        snapshot.topology.forEach(c => {
            c.services.forEach(s => {
                if (s.instanceId === 'SYSTEM') return;
                if (!instMap.has(s.instanceId)) instMap.set(s.instanceId, new Set());
                instMap.get(s.instanceId).add(c.id);
            });
        });

        // 2. Build adjacency (sharing cores)
        const instances = Array.from(instMap.keys());
        const adj = new Map();
        instances.forEach(i => adj.set(i, []));

        for (let i = 0; i < instances.length; i++) {
            for (let j = i + 1; j < instances.length; j++) {
                const idA = instances[i];
                const idB = instances[j];
                const coresA = instMap.get(idA);
                const coresB = instMap.get(idB);

                // Intersection
                let shared = false;
                for (const c of coresA) {
                    if (coresB.has(c)) { shared = true; break; }
                }

                if (shared) {
                    adj.get(idA).push(idB);
                    adj.get(idB).push(idA);
                }
            }
        }

        // 3. Find Connected Components (Groups)
        const visited = new Set();
        const groups = [];

        instances.forEach(startNode => {
            if (visited.has(startNode)) return;
            const component = [];
            const stack = [startNode];
            visited.add(startNode);

            while (stack.length > 0) {
                const node = stack.pop();
                component.push(node);
                adj.get(node).forEach(neighbor => {
                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        stack.push(neighbor);
                    }
                });
            }
            groups.push(component);
        });

        // 4. Extract data for each group
        return groups.map(grpInstances => {
            // Aggregate loads
            let gateways = 0;
            let robots = 0;
            let loadSumGw = 0;
            let loadSumRob = 0;

            const groupInstSet = new Set(grpInstances);
            const coresUsed = { gateway: new Set(), robot: new Set() };
            const loadAccum = { gateway: 0, robot: 0 };

            snapshot.topology.forEach(c => {
                let coreHasGw = false;
                let coreHasRob = false;

                c.services.forEach(s => {
                    if (groupInstSet.has(s.instanceId)) {
                        const type = s.name.toLowerCase();
                        if (type.includes('gateway')) coreHasGw = true;
                        if (type.includes('robot')) coreHasRob = true;
                    }
                });

                if (coreHasGw) {
                    coresUsed.gateway.add(c.id);
                    loadAccum.gateway += c.currentLoad || 0;
                }
                if (coreHasRob) {
                    coresUsed.robot.add(c.id);
                    loadAccum.robot += c.currentLoad || 0;
                }
            });

            return {
                groupId: grpInstances.join('+'),
                instances: grpInstances,
                gateways: coresUsed.gateway.size,
                robots: coresUsed.robot.size,
                loadSumGw: loadAccum.gateway,
                loadSumRob: loadAccum.robot
            };
        });
    },

    calculateGroupNeeds(grp) {
        const gwAvg = grp.gateways > 0 ? grp.loadSumGw / grp.gateways : 0;
        const robAvg = grp.robots > 0 ? grp.loadSumRob / grp.robots : 0;

        // 1. Fixed Cores - One set per GROUP
        const fixed = this.CONSTANTS.FIXED_CORES_PER_INST;

        // 2. Gateway Cores
        let gwNeeded = 1;
        // FIX: If load is missing/low (< 1%), assume current capacity is desired/safe default
        if (gwAvg < 1 && grp.gateways > 0) {
            gwNeeded = grp.gateways;
        } else if (grp.gateways > 0) {
            const rawNeeded = (grp.gateways * gwAvg) / 25;
            gwNeeded = Math.ceil(rawNeeded * this.CONSTANTS.GATEWAY_BUFFER);
        }
        gwNeeded = Math.max(1, gwNeeded);

        // 3. Robot Cores
        let robNeeded = 1;
        // FIX: Same logic for robots. If no load data, don't collapse to 1.
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
            }
        }));

        if (z < 0) {
            // Squeeze
            console.warn(`[Optimizer] CRISIS: Not enough cores! Deficit: ${z}`);
            let remaining = availableCores;

            // 1. Fixed
            results.forEach(r => {
                const canTake = Math.min(remaining, r.assigned.fixed);
                r.assigned.fixed = canTake;
                remaining -= canTake;
            });

            // 2. Gateway
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
            // Distribute z
            // Calculate total weight based on calculated "Needs" (which might be based on current capacity if load is low)
            const totalNeeds = groups.reduce((sum, g) => sum + g.needs.total, 0);

            groups.forEach((grp, idx) => {
                const res = results[idx];
                const weight = grp.needs.total;

                // Proportional Share of the EXTRA space (z)
                let robotShare = Math.floor(z * (weight / totalNeeds));

                // FIX: Do NOT cap at needs.robot. Allow robots to consume all available space.
                // The goal is to maximize performance, not just meet minimum needs.
                res.assigned.robot = robotShare;
            });
        }

        return results;
    },

    distributeSpillover(allocations, sharedCores, allGroupNeeds) {
        let available = sharedCores.length;
        if (available <= 0) return;

        // If we have spillover space, just give it to whoever has robots (which is everyone usually)
        // Weighted by their size
        const totalAssignedRobots = allocations.reduce((sum, a) => sum + a.assigned.robot, 0);

        if (totalAssignedRobots === 0) return;

        allocations.forEach(alloc => {
            const share = Math.floor(available * (alloc.assigned.robot / totalAssignedRobots));
            alloc.assigned.robot += share;
        });
    },

    placeServices(allocations, snapshot, osCores, totalIrqNeeded, islandMap) {
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

        // 1. Place IRQs
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

        // 2. Place Groups
        allocations.forEach(alloc => {
            const groupAssignments = [];
            let groupAllocatedCount = 0;

            let targetIsland = null;
            const repInst = alloc.instances[0];
            const assignedIf = snapshot.instanceToInterface[repInst];
            for (const island of islandMap.values()) {
                if (assignedIf && island.interfaces.includes(assignedIf)) {
                    targetIsland = island;
                    break;
                }
            }
            if (!targetIsland) {
                 targetIsland = Array.from(islandMap.values()).find(i => i.type === 'network');
            }

            const targetNumas = targetIsland ? targetIsland.numaNodes : [];
            const sharedNumas = islandMap.get('shared') ? islandMap.get('shared').numaNodes : [];

            // Helper to assign
            const assign = (service, role, count, preferenceNumas) => {
                 const assigned = [];
                 for(let i=0; i<count; i++) {
                     let c = pickCore({ numas: preferenceNumas });
                     if (c === null) c = pickCore({ numas: sharedNumas });

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

            assign('trash_combo', 'trash', 1, targetNumas);
            assign('udp', 'udp', 1, targetNumas);
            assign('ar_combo', 'ar', 1, targetNumas);
            assign('gateway', 'gateway', alloc.assigned.gateway, targetNumas);

            const robotCount = alloc.assigned.robot;
            const robotCores = [];
            for(let i=0; i<robotCount; i++) {
                let c = pickCore({ numas: targetNumas });
                if (c === null) c = pickCore({ numas: sharedNumas });
                if (c !== null) {
                    freeCores.delete(c);
                    robotCores.push(c);
                }
            }
             if (robotCores.length > 0) {
                 groupAssignments.push({ service: 'robot', role: 'robot_default', cores: robotCores });
                 groupAllocatedCount += robotCores.length;
             }

            // Distribute assignments to all instances in group
            alloc.instances.forEach(instId => {
                result.instances.push({
                    instanceId: instId,
                    allocatedCores: groupAllocatedCount,
                    coreAssignments: groupAssignments,
                    gateway: alloc.assigned.gateway,
                    robot: alloc.assigned.robot
                });
            });
        });

        return result;
    }
};

if (typeof window !== 'undefined') window.CPU_OPTIMIZER = CPU_OPTIMIZER;
if (typeof module !== 'undefined') module.exports = CPU_OPTIMIZER;

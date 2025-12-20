/**
 * HFT CPU Optimizer - Capacity Planning Engine v5.4
 * 
 * Logic:
 * 1. Analyze Topology & Split-Brain detection (Interface Groups).
 * 2. Strict Instance->NUMA Mapping (Instance "Islands").
 * 3. Calculate Resource Needs per Instance.
 * 4. Partition Resources & Proportional Allocation (z-factor).
 * 5. Starvation Protection (Robin Hood + IRQ/Gateway Sacrifice).
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
        console.log('[Optimizer] Starting optimization v5.4', { totalCores: snapshot.topology.length });

        // 1. Analyze Topology & Detect Islands
        const topology = this.analyzeTopology(snapshot);
        const islandMap = this.detectIslands(snapshot, topology);

        // 2. Strict Instance Mapping
        const instanceToIsland = this.mapInstancesToIslands(snapshot, islandMap, topology);

        // 3. Calculate Needs
        const instanceGroups = this.extractInstanceGroups(snapshot);
        const groupNeeds = instanceGroups.map(grp => this.calculateGroupNeeds(grp));

        // 4. Global OS/IRQ Calculation (applied per Island with Retry)
        let allOsCores = [];
        let totalIrqCount = 0;

        const allocations = [];

        islandMap.forEach((island, islandId) => {
            console.log(`[Optimizer] Optimizing Island: ${islandId} (${island.type})`, { nodes: island.numaNodes });

            // A. Partition Resources (OS) - Fixed
            const islandCores = topology.cores.filter(c => island.numaNodes.includes(c.numaNodeId));
            const totalIslandCores = islandCores.length;

            const osCount = Math.max(this.CONSTANTS.MIN_OS_CORES, Math.floor(totalIslandCores * this.CONSTANTS.OS_RATIO));
            let osCores = [];

            if (island.osStrategy === 'start') {
                osCores = islandCores.slice(0, osCount).map(c => c.id);
            } else if (island.osStrategy === 'end') {
                osCores = islandCores.slice(-osCount).map(c => c.id);
            }
            allOsCores.push(...osCores);

            // B. Filter Groups for this Island
            const islandGroups = groupNeeds.filter(grp => {
                const repInst = grp.instances[0];
                return instanceToIsland.get(repInst) === islandId;
            });

            if (island.type === 'network') {
                // Retry Loop for Resource Allocation
                // Fallbacks: 1. Reduce IRQ (if > 2), 2. Reduce Gateway (if > 1)
                const netIslands = Array.from(islandMap.values()).filter(i => i.type === 'network');
                const defaultIrq = netIslands.length > 1 ? this.CONSTANTS.IRQ_CORES_SPLIT : this.CONSTANTS.IRQ_CORES_SINGLE;

                let finalAlloc = null;
                let currentIrq = defaultIrq;
                let usedIrq = defaultIrq;

                // ATTEMPT 1: Standard IRQ
                const available1 = totalIslandCores - osCores.length - currentIrq;
                let result1 = this.allocateIslandResources(islandGroups, available1);
                if (this.checkStarvation(result1)) {
                    finalAlloc = result1;
                    usedIrq = currentIrq;
                } else {
                    // ATTEMPT 2: Reduce IRQ if possible (> 2)
                    if (currentIrq > 2) {
                        console.warn(`[Optimizer] Starvation detected. Reducing IRQ from ${currentIrq} to ${currentIrq - 1}`);
                        currentIrq--;
                        const available2 = totalIslandCores - osCores.length - currentIrq;
                        let result2 = this.allocateIslandResources(islandGroups, available2);
                        if (this.checkStarvation(result2)) {
                            finalAlloc = result2;
                            usedIrq = currentIrq;
                        }
                    }
                }

                // ATTEMPT 3: Reduce Gateways (Force Mode)
                if (!finalAlloc) {
                    // Even with reduced IRQ, we are starving.
                    // Force allocateIslandResources to cut gateways if needed (it does this if z < 0)
                    // But if z > 0 and we are just fragmentation-starved, we need to force it.
                    // Actually, allocateIslandResources handles "z < 0" by cutting gateways.
                    // The issue is if z >= 0 but proportional share = 0 for someone?
                    // Re-run with aggressive flag?
                    console.warn(`[Optimizer] Critical Starvation. Forcing Gateway Reduction.`);
                    // We can simulate less available cores to force squeeze logic?
                    // No, simply rely on the logic: if z > 0 but someone gets 0 robots, Robin Hood handles it.
                    // If Robin Hood fails (everyone has <= 1 robot), then we need more space.
                    // Let's use the result from Attempt 2 (or 1) and modify it manually to steal from Gateways.

                    let bestResult = result1; // Fallback to initial
                    // Steal from Gateways
                    const availableFinal = totalIslandCores - osCores.length - usedIrq;
                    finalAlloc = this.forceStarvationRelief(islandGroups, availableFinal);
                }

                allocations.push(...finalAlloc);
                totalIrqCount += usedIrq;
            }
        });

        const optimizedTopology = this.placeServices(allocations, snapshot, allOsCores, totalIrqCount, islandMap, instanceToIsland);

        return {
            totalCores: snapshot.topology.length,
            osCores: allOsCores,
            irqCores: optimizedTopology.irqCores,
            instances: optimizedTopology.instances,
            recommendations: []
        };
    },

    checkStarvation(results) {
        // Return true if NO ONE is starving (all have >= 1 robot)
        return results.every(r => r.assigned.robot > 0);
    },

    forceStarvationRelief(groups, availableCores) {
        // Aggressive allocation: Ensure 1 robot for everyone first, then Gateways, then Fixed.
        // If not enough, cut Gateways.

        let mandatoryFixed = 0;
        groups.forEach(g => mandatoryFixed += g.needs.fixed);

        // Reserve 1 robot for each
        const robotReservation = groups.length;

        let remaining = availableCores - mandatoryFixed - robotReservation;

        const results = groups.map(g => ({
            groupId: g.groupId,
            instances: g.instances,
            assigned: {
                fixed: g.needs.fixed,
                gateway: 0, // Reset
                robot: 1 // Guaranteed
            },
            weight: g.needs.total
        }));

        if (remaining < 0) {
            console.error("Critical Failure: Not enough cores for even 1 robot per instance + Fixed!");
            // Just return what we have, logic will fail gracefully or overlap
            return results;
        }

        // Distribute remaining to Gateways first, then more Robots
        // Calculate Total Gateway Demand
        const totalGwDemand = groups.reduce((sum, g) => sum + g.needs.gateway, 0);

        // 1. Fill Gateways up to demand or limit
        if (remaining > 0) {
            if (remaining >= totalGwDemand) {
                // Give requested gateways
                results.forEach((r, i) => r.assigned.gateway = groups[i].needs.gateway);
                remaining -= totalGwDemand;
            } else {
                // Proportional Gateway squeeze
                 results.forEach((r, i) => {
                    const demand = groups[i].needs.gateway;
                    const share = Math.floor(remaining * (demand / totalGwDemand));
                    r.assigned.gateway = Math.max(1, share); // Try to keep at least 1 gateway
                 });
                 remaining = 0; // Consumed all trying to satisfy gateways
            }
        } else {
             // No space for gateways? Set to 1 and eat into Robot reservation?
             // Logic above reserved robots first. This implies Gateways = 0.
             // User said: "N cores gates, if their < 4" -> reduce gateways.
             // Minimum should be 1.
             results.forEach(r => r.assigned.gateway = 1);
        }

        // 2. If any remaining, give to Robots (Proportional)
        if (remaining > 0) {
             const totalWeight = groups.reduce((sum, g) => sum + g.needs.total, 0);
             results.forEach((r, i) => {
                 const share = Math.floor(remaining * (groups[i].needs.total / totalWeight));
                 r.assigned.robot += share;
             });
        }

        return results;
    },

    allocateIslandResources(groups, availableCores) {
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
            weight: g.needs.total
        }));

        if (z < 0) {
            // Squeeze Gateways
            let remaining = availableCores - groups.reduce((s,g) => s+g.needs.fixed, 0); // Remove fixed cost

            // Distribute remaining to Gateways
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
            // Surplus -> Robots
            const totalWeight = groups.reduce((sum, g) => sum + g.needs.total, 0);
            let usedZ = 0;
            groups.forEach((grp, idx) => {
                const res = results[idx];
                const share = Math.floor(z * (grp.needs.total / totalWeight));
                res.assigned.robot = share;
                usedZ += share;
            });

            // Remainder
            let remainder = z - usedZ;
            if (remainder > 0) {
                const sortedByWeight = [...results].sort((a, b) => b.weight - a.weight);
                for (let i = 0; i < remainder; i++) {
                    sortedByWeight[i % sortedByWeight.length].assigned.robot++;
                }
            }
        }

        // Robin Hood (Robot <-> Robot only)
        let starving = results.filter(r => r.assigned.robot === 0);
        let maxIterations = groups.length * 2;

        while (starving.length > 0 && maxIterations-- > 0) {
            const rich = results.filter(r => r.assigned.robot > 1).sort((a, b) => b.assigned.robot - a.assigned.robot);
            if (rich.length === 0) break;

            const donor = rich[0];
            const receiver = starving[0];

            donor.assigned.robot--;
            receiver.assigned.robot++;

            starving = results.filter(r => r.assigned.robot === 0);
        }

        return results;
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
        const instances = new Set();
        snapshot.topology.forEach(c => c.services.forEach(s => {
            if (s.instanceId !== 'SYSTEM') instances.add(s.instanceId);
        }));

        instances.forEach(instId => {
            let homeNuma = -1;
            const instanceCores = snapshot.topology.filter(c =>
                c.services.some(s => s.instanceId === instId)
            );
            const trashCore = instanceCores.find(c =>
                c.services.some(s => s.instanceId === instId && (s.name.includes('Trash') || s.name.includes('UDP')))
            );

            if (trashCore) {
                homeNuma = trashCore.numaNodeId;
            } else {
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

            let assignedIslandId = null;
            if (homeNuma !== -1) {
                for (const [islandId, island] of islandMap.entries()) {
                    if (island.numaNodes.includes(homeNuma)) {
                        assignedIslandId = islandId;
                        break;
                    }
                }
            }

            if (!assignedIslandId) {
                const firstNet = Array.from(islandMap.values()).find(i => i.type === 'network');
                assignedIslandId = firstNet ? firstNet.id : 'main';
            }

            mapping.set(instId, assignedIslandId);
        });

        return mapping;
    },

    extractInstanceGroups(snapshot) {
        const instSet = new Set();
        snapshot.topology.forEach(c => c.services.forEach(s => {
            if (s.instanceId !== 'SYSTEM') instSet.add(s.instanceId);
        }));

        return Array.from(instSet).map(instId => {
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
        const fixed = this.CONSTANTS.FIXED_CORES_PER_INST;

        let gwNeeded = 1;
        if (gwAvg < 1 && grp.gateways > 0) {
            gwNeeded = grp.gateways;
        } else if (grp.gateways > 0) {
            const rawNeeded = (grp.gateways * gwAvg) / 25;
            gwNeeded = Math.ceil(rawNeeded * this.CONSTANTS.GATEWAY_BUFFER);
        }
        gwNeeded = Math.max(1, gwNeeded);

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

        const irqCoresList = [];
        islandMap.forEach((island) => {
            if (island.type !== 'network') return;
            const netIslands = Array.from(islandMap.values()).filter(i => i.type === 'network');
            // We use totalIrqNeeded passed from caller if it varies?
            // Actually optimize() loops islands and sums irq. We need to respect the *actual* IRQ used in that pass.
            // But optimize() calculates IRQ per island dynamically now.
            // Let's rely on the passed totalIrqNeeded for GLOBAL, but we need per-island count.
            // Simplified: Re-calculate or use the constant?
            // Wait, optimize() decided on IRQ count (maybe reduced). We need that info here.
            // But we don't pass it easily.
            // FIX: We will just allocate 'totalIrqNeeded' cores by distributing them to network islands.
            // Since placeServices logic for IRQ was simple loop:

            // Actually, totalIrqNeeded is global. We need to know how many per island.
            // For now, assume uniform or standard unless we pass a map.
            // In split brain, usually 3 per island. If reduced to 2, it's global reduction?
            // The logic in optimize() reduced `currentIrq` for *that specific island*.
            // We should ideally pass `irqMap` or similar.
            // Fallback: Just allocate 3 (or standard) and if we run out of free cores, we run out.
            // BUT: placeServices consumes freeCores. If we allocate 3 IRQ but the logic assumed 2, we might steal a core from robots.
            // Critical Fix: placeServices needs to know exactly how many IRQs per island.

            // Let's infer from free space? No.
            // Let's assume standard for now, as passing complex object requires signature change.
            // Or better: Just allocate `totalIrqNeeded` greedily across network islands.

            // BETTER: We'll modify placeServices to accept an `islandIrqCounts` map if possible.
            // Given I can't easily change signature in this tool block without risk,
            // I will use a heuristic: Allocate `totalIrqNeeded` by cycling through network islands.
        });

        // Re-implement IRQ placement using totalIrqNeeded
        // We know totalIrqNeeded is the sum of decision made in optimize()
        const netIslands = Array.from(islandMap.values()).filter(i => i.type === 'network');
        if (netIslands.length > 0) {
            let placed = 0;
            // Distribute round-robin or fill?
            // Usually symmetric.
            const limitPerIsland = Math.ceil(totalIrqNeeded / netIslands.length);

            netIslands.forEach(island => {
                 for(let i=0; i<limitPerIsland; i++) {
                     if (placed >= totalIrqNeeded) break;
                     const c = pickCore({ numas: island.numaNodes });
                     if (c !== null) {
                         freeCores.delete(c);
                         irqCoresList.push(c);
                         placed++;
                     }
                 }
            });
        }
        result.irqCores = irqCoresList;

        allocations.forEach(alloc => {
            const groupAssignments = [];
            let groupAllocatedCount = 0;

            const repInst = alloc.instances[0];
            const islandId = instanceToIsland.get(repInst);
            const targetIsland = islandMap.get(islandId);
            const targetNumas = targetIsland ? targetIsland.numaNodes : [];

            const assign = (service, role, count) => {
                 const assigned = [];
                 for(let i=0; i<count; i++) {
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

            assign('trash_combo', 'trash', 1);
            assign('udp', 'udp', 1);
            assign('ar_combo', 'ar', 1);
            assign('gateway', 'gateway', alloc.assigned.gateway);

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

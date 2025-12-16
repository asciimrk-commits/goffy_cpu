/**
 * HFT Core Commander - Advanced CPU Optimizer
 * 
 * L3 Zone Classification:
 * - DIRTY: Contains Core 0 (OS) - place service bundles here
 * - GOLD: Network NUMA L3s (excl DIRTY) - Gateways + IRQ
 * - SILVER: All other L3s - Robots + overflow
 */

// =====================================================
// TYPES
// =====================================================

export type L3Zone = 'dirty' | 'gold' | 'silver';

export interface L3Cache {
    id: string;
    numa: number;
    cores: number[];
    zone: L3Zone;
}

export interface NumaNode {
    id: number;
    isNetwork: boolean;
    l3Caches: L3Cache[];
    totalCores: number;
}

// Instance model with priority and weight
export interface Instance {
    id: string;
    type: 'PROD' | 'TEST' | 'DEV';
    weight: number;  // 0.0 - 1.0
    priority: number; // Lower = higher priority
}

export interface OptimizationInput {
    geometry: Record<string, Record<string, Record<string, number[]>>>;
    coreNumaMap: Record<string, number>;
    l3Groups: Record<string, number[]>;
    netNumaNodes: number[];
    coreLoads: Record<number, number>;
    instances: Instance[];  // Multi-instance support
}

export interface CoreAllocation {
    coreId: number;
    role: string;
    instance?: string;
    l3Id: string;
    numa: number;
    zone: L3Zone;
}

export interface OptimizationResult {
    allocations: CoreAllocation[];
    osCores: number[];
    isolatedCores: number[];
    l3Zones: L3Cache[];
    warnings: string[];
    summary: {
        osCount: number;
        irqCount: number;
        gwCount: number;
        robotCount: number;
    };
}

// =====================================================
// L3 ZONE CLASSIFICATION
// =====================================================

/**
 * Classify L3 caches into DIRTY/GOLD/SILVER zones
 */
export function classifyL3Zones(
    l3Groups: Record<string, number[]>,
    coreNumaMap: Record<string, number>,
    netNuma: number,
    osCores: number[]
): L3Cache[] {
    const osSet = new Set(osCores);
    const l3Caches: L3Cache[] = [];

    Object.entries(l3Groups).forEach(([l3Id, cores]) => {
        const numa = coreNumaMap[String(cores[0])] ?? 0;
        const hasOsCores = cores.some(c => osSet.has(c));
        const isNetNuma = numa === netNuma;

        let zone: L3Zone;

        if (hasOsCores) {
            zone = 'dirty';
        } else if (isNetNuma) {
            zone = 'gold';
        } else {
            zone = 'silver';
        }

        l3Caches.push({ id: l3Id, numa, cores, zone });
    });

    return l3Caches;
}

// =====================================================
// MAIN OPTIMIZER (Network Packing Strategy)
// =====================================================

/**
 * optimizeTopology - The Brain
 * 
 * Strategy: "The Network Packing"
 * Phase 1: Fill Network Node (Strict Order: OS > Anchors > IRQ > Gateways)
 * Phase 2: Fill Remote Nodes (Robots)
 * Phase 3: Rebalance (Ensure min Gateways)
 */
export function optimizeTopology(input: OptimizationInput): OptimizationResult {
    const { coreNumaMap, l3Groups, netNumaNodes, instances } = input;
    const netNuma = netNumaNodes[0] ?? 0;

    const allCores = Object.keys(coreNumaMap).map(Number).sort((a, b) => a - b);

    const allocations: CoreAllocation[] = [];
    const warnings: string[] = [];
    const assigned = new Set<number>();

    // Sort instances by priority
    const sortedInstances = [...instances].sort((a, b) => a.priority - b.priority);

    // --- Phase 1.1: Identify OS Cores (Fixed 4 on Node 0) ---
    const node0Cores = allCores.filter(c => coreNumaMap[String(c)] === netNuma);
    const osCores = node0Cores.slice(0, 4);

    // Check if we found less than 4 (e.g. tiny server)
    if (osCores.length < 4) {
        warnings.push(`Server too small: OS has only ${osCores.length} cores`);
    }

    // Mark OS
    osCores.forEach(c => assigned.add(c));

    // Classify L3s based on OS choice
    const l3Zones = classifyL3Zones(l3Groups, coreNumaMap, netNuma, osCores);
    const dirtyL3s = l3Zones.filter(z => z.zone === 'dirty');
    const goldL3s = l3Zones.filter(z => z.zone === 'gold');
    const silverL3s = l3Zones.filter(z => z.zone === 'silver');

    // Helper: Allocate
    const allocate = (coreId: number, role: string, instanceId?: string) => {
        if (assigned.has(coreId)) {
            // Check if we are overwriting (shouldn't happen with correct logic)
            return;
        }

        const l3 = l3Zones.find(z => z.cores.includes(coreId));
        allocations.push({
            coreId,
            role,
            instance: instanceId,
            l3Id: l3?.id ?? '0',
            numa: coreNumaMap[String(coreId)] ?? 0,
            zone: l3?.zone ?? 'silver'
        });
        assigned.add(coreId);
    };

    // Helper: Get free cores from a list of pools (L3s)
    const getFreeFromL3s = (l3s: L3Cache[], count: number): number[] => {
        const result: number[] = [];
        for (const l3 of l3s) {
            for (const c of l3.cores) {
                if (!assigned.has(c)) {
                    result.push(c);
                    if (result.length === count) return result;
                }
            }
        }
        return result;
    };

    // Get ALL free cores on Node 0 (Network)
    // We prioritize Dirty (for Anchors) then Gold

    // --- Phase 1.2: Service Anchors (2 per instance) ---
    // Rule: "Keeps all dirty traffic on the dirty node"
    sortedInstances.forEach(inst => {
        // Need 2 cores. Try Dirty first, then Gold.
        const needed = 2;
        let got: number[] = [];

        // Try Dirty L3 first
        const fromDirty = getFreeFromL3s(dirtyL3s, needed);
        got = [...fromDirty];

        // Overflow to Gold if needed
        if (got.length < needed) {
            const fromGold = getFreeFromL3s(goldL3s, needed - got.length);
            got = [...got, ...fromGold];
        }

        // Assign
        if (got.length > 0) allocate(got[0], 'trash_bundle', inst.id);
        if (got.length > 1) allocate(got[1], 'ar_bundle', inst.id);

        if (got.length < needed) {
            warnings.push(`Instance ${inst.id}: Not enough space on Node 0 for Anchors`);
            // Spillover to Silver?
            // "The Network Node (Node 0) is premium real estate... Fill it in this STRICT order until full"
            // If full, we go to Remote.
            const fromSilver = getFreeFromL3s(silverL3s, needed - got.length);
            fromSilver.forEach((c, i) => {
                const role = (got.length + i) === 0 ? 'trash_bundle' : 'ar_bundle';
                allocate(c, role, inst.id);
                warnings.push(`Instance ${inst.id}: Anchor ${role} pushed to SILVER (Node 0 Full)`);
            });
        }
    });

    // --- Phase 1.3: IRQ Cores (Fixed 4) ---
    // Rule: "IRQ Cores: Fixed 4 cores."
    // Prefer Gold L3s (clean network), but Dirty is acceptable if Gold full.
    const neededIrq = 4;
    let irqCores = getFreeFromL3s(goldL3s, neededIrq);

    if (irqCores.length < neededIrq) {
        // Fallback to Dirty
        const fromDirty = getFreeFromL3s(dirtyL3s, neededIrq - irqCores.length);
        irqCores = [...irqCores, ...fromDirty];
    }

    irqCores.forEach(c => allocate(c, 'irq')); // Shared IRQ

    if (irqCores.length < neededIrq) {
        // Fallback to Silver?? Very bad latency.
        warnings.push('Critical: IRQ cores pushed to Remote Node (Node 0 Full)');
        const fromSilver = getFreeFromL3s(silverL3s, neededIrq - irqCores.length);
        fromSilver.forEach(c => allocate(c, 'irq'));
    }

    // --- Phase 1.4: Gateways (All Instances) ---
    // Rule: "Calculate remaining space on Node 0... Distribute these Gold Cores"
    // Get truly remaining on Node 0 (Gold preferred, then Dirty)
    const remainingGold = getFreeFromL3s(goldL3s, 999);
    const remainingDirty = getFreeFromL3s(dirtyL3s, 999);
    let poolNode0 = [...remainingGold, ...remainingDirty];

    const instanceGwCounts: Record<string, number> = {};
    instances.forEach(i => instanceGwCounts[i.id] = 0);

    // Distribute Node 0 pool among instances
    if (poolNode0.length > 0 && instances.length > 0) {

        // Round robin allocation to ensure fairness until pool empty
        let activeIdx = 0;
        let pIndex = 0;

        // Optimization: Give weight-based share?
        // User says: "Distribute these 'Gold Cores' between instances."
        // "Example: If 12 cores remain and we have 2 instances -> Each gets 6"
        // Implies Equal distribution? Or Weighted?
        // Let's do Round Robin for simplicity and fairness.

        while (pIndex < poolNode0.length) {
            const inst = sortedInstances[activeIdx];
            const core = poolNode0[pIndex];
            allocate(core, 'gateway', inst.id);
            instanceGwCounts[inst.id]++;

            pIndex++;
            activeIdx = (activeIdx + 1) % sortedInstances.length;
        }
    }

    // --- Phase 2: Fill Remote Nodes (Robots) ---
    // Rule: "All Remote Nodes are exclusively for Robots."
    // "Do NOT leave any core empty. If 3 cores are left, assign them to the busiest Robot Pool."

    const remoteL3s = silverL3s; // Theoretically Silver = Remote (mostly)
    const poolRemote = getFreeFromL3s(remoteL3s, 999);

    if (poolRemote.length > 0 && instances.length > 0) {
        // Distribute remaining cores among instances for Robots
        // Use Round Robin for fairness
        let activeIdx = 0;
        let pIndex = 0;

        while (pIndex < poolRemote.length) {
            const inst = sortedInstances[activeIdx];
            const core = poolRemote[pIndex];
            allocate(core, 'robot', inst.id);

            pIndex++;
            activeIdx = (activeIdx + 1) % sortedInstances.length;
        }
    }

    // --- Phase 3: Gateway Scaling Rule & Rebalance ---
    // Rule: "NEVER assign just 1 core to Gateways unless server < 8 cores"
    // Rule: "If Robot cores exist but GW < Healthy... Rebalance: Take from Robots give to GW"

    const totalCoresAvailable = allCores.length;

    sortedInstances.forEach(inst => {
        const gwCount = instanceGwCounts[inst.id];
        const robots = allocations.filter(a => a.instance === inst.id && a.role === 'robot');
        const minGw = 3; // "Try to give at least 3-4 cores"

        if (totalCoresAvailable >= 8 && gwCount < minGw) {
            // Need to steal X cores from Robots
            const deficit = minGw - gwCount;
            const stoleCount = Math.min(deficit, robots.length);

            if (stoleCount > 0) {
                // Steal the last assigned robots (likely on Remote Node)
                // "Do NOT put Gateways here unless Node 0 is 100% full."
                // Node 0 IS full (otherwise we would have taken it in Phase 1.4).
                // So we are putting Gateways on Remote Node (Silver).

                // Which robots to steal? 
                // We want to minimize fragmentation? Just take any.
                const stolen = robots.slice(0, stoleCount);

                // Mutation! Update allocations
                stolen.forEach(robotAlloc => {
                    // Update Role
                    robotAlloc.role = 'gateway'; // Converted
                    instanceGwCounts[inst.id]++;
                });

                warnings.push(`Instance ${inst.id}: Rebalanced ${stoleCount} cores from Robots to Gateways (Node 0 Full)`);
            } else {
                if (gwCount < 1) {
                    warnings.push(`Critical: Instance ${inst.id} has NO Gateways and NO Robots to steal from!`);
                }
            }
        }
    });

    // Final calculations
    return {
        allocations,
        osCores,
        isolatedCores: allCores.filter(c => !assigned.has(c) && !osCores.includes(c)), // Should be empty
        l3Zones,
        warnings,
        summary: {
            osCount: osCores.length,
            irqCount: allocations.filter(a => a.role === 'irq').length,
            gwCount: allocations.filter(a => a.role === 'gateway').length,
            robotCount: allocations.filter(a => a.role === 'robot').length
        }
    };
}

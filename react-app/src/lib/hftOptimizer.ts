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
// CONSTANTS
// =====================================================

const GW_TO_IRQ_RATIO = 3; // 1 IRQ per 3 Gateways
const MAX_GW_PER_INSTANCE = 10;

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
// MAIN OPTIMIZER
// =====================================================

/**
 * optimizeTopology - The Brain
 * 
 * Phase 1: Zoning (Hardware Classification)
 * Phase 2: Global Tax (OS + Service Bundles)
 * Phase 3: Critical Path (Gateways & IRQ)
 * Phase 4: Computation (Robots)
 */
export function optimizeTopology(input: OptimizationInput): OptimizationResult {
    const { coreNumaMap, l3Groups, netNumaNodes, instances } = input;
    const netNuma = netNumaNodes[0] ?? 0;

    const allCores = Object.keys(coreNumaMap).map(Number).sort((a, b) => a - b);
    const totalCores = allCores.length;

    const allocations: CoreAllocation[] = [];
    const warnings: string[] = [];
    const assigned = new Set<number>();

    // Sort instances by priority
    const sortedInstances = [...instances].sort((a, b) => a.priority - b.priority);
    const instanceCount = sortedInstances.length;

    // Get cores by NUMA
    const getCoresByNuma = (numa: number): number[] => {
        return allCores.filter(c => coreNumaMap[String(c)] === numa).sort((a, b) => a - b);
    };

    const numa0Cores = getCoresByNuma(0);
    const netNumaCores = getCoresByNuma(netNuma);

    // ===== PHASE 2: Global Tax (OS) =====
    const osCount = totalCores < 48 ? 4 : Math.min(8, Math.ceil(totalCores / 12));
    const osCores: number[] = [];

    for (let i = 0; i < osCount && i < numa0Cores.length; i++) {
        osCores.push(numa0Cores[i]);
        assigned.add(numa0Cores[i]);
    }

    // Classify L3 zones after OS assignment
    const l3Zones = classifyL3Zones(l3Groups, coreNumaMap, netNuma, osCores);
    const dirtyL3 = l3Zones.find(z => z.zone === 'dirty');
    const goldL3s = l3Zones.filter(z => z.zone === 'gold');
    // silverL3s used for robot allocation (implicit via getAvailableFromZone)

    // Helper to add allocation
    const allocate = (coreId: number, role: string, instanceId?: string) => {
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

    // Get available cores from L3
    const getAvailableFromL3 = (l3: L3Cache | undefined, count: number): number[] => {
        if (!l3) return [];
        return l3.cores.filter(c => !assigned.has(c)).slice(0, count);
    };

    // Get available cores from zone
    const getAvailableFromZone = (zone: L3Zone, count: number): number[] => {
        const result: number[] = [];
        const targetL3s = l3Zones.filter(z => z.zone === zone);
        for (const l3 of targetL3s) {
            for (const core of l3.cores) {
                if (!assigned.has(core) && result.length < count) {
                    result.push(core);
                }
            }
        }
        return result;
    };

    // ===== PHASE 2 continued: Service Bundles (in DIRTY L3) =====
    sortedInstances.forEach(inst => {
        // Trash Bundle (Trash + RF + ClickHouse)
        const trashCores = getAvailableFromL3(dirtyL3, 1);
        if (trashCores.length > 0) {
            allocate(trashCores[0], 'trash_bundle', inst.id);
        } else {
            // Overflow to SILVER (never GOLD!)
            const overflow = getAvailableFromZone('silver', 1);
            if (overflow.length > 0) {
                allocate(overflow[0], 'trash_bundle', inst.id);
                warnings.push(`Service bundle for ${inst.id} placed in SILVER (DIRTY full)`);
            }
        }

        // AR Bundle (AllRobots + Formula)
        const arCores = getAvailableFromL3(dirtyL3, 1);
        if (arCores.length > 0) {
            allocate(arCores[0], 'ar_bundle', inst.id);
        } else {
            const overflow = getAvailableFromZone('silver', 1);
            if (overflow.length > 0) {
                allocate(overflow[0], 'ar_bundle', inst.id);
            }
        }
    });

    // ===== PHASE 3: Critical Path (Gateways & IRQ) =====
    const netCapacity = netNumaCores.filter(c => !assigned.has(c)).length;
    const totalWeight = sortedInstances.reduce((sum, i) => sum + i.weight, 0);

    sortedInstances.forEach((inst, idx) => {
        const capacityShare = Math.floor(netCapacity * (inst.weight / totalWeight));
        const gwCount = Math.min(MAX_GW_PER_INSTANCE, Math.floor(capacityShare * 0.75));
        const irqCount = Math.ceil(gwCount / GW_TO_IRQ_RATIO);

        // For PROD: try to get exclusive GOLD L3
        const targetL3 = inst.type === 'PROD' && goldL3s[idx] ? goldL3s[idx] : goldL3s[0];

        // IRQ cores in GOLD
        const irqCores = getAvailableFromL3(targetL3, irqCount);
        irqCores.forEach(c => allocate(c, 'irq', inst.id));

        // Gateway cores in same GOLD L3
        const gwCores = getAvailableFromL3(targetL3, gwCount);
        gwCores.forEach(c => allocate(c, 'gateway', inst.id));

        // Overflow to other GOLD L3s
        const remaining = gwCount - gwCores.length;
        if (remaining > 0) {
            const overflow = getAvailableFromZone('gold', remaining);
            overflow.forEach(c => allocate(c, 'gateway', inst.id));
        }
    });

    // ===== PHASE 4: Computation (Robots) =====
    // Fill SILVER first, then GOLD tail
    const remainingCores = allCores.filter(c => !assigned.has(c) && !osCores.includes(c));

    remainingCores.forEach((c, idx) => {
        const inst = sortedInstances[idx % instanceCount] || sortedInstances[0];
        allocate(c, 'robot', inst?.id);
    });

    // Build isolated cores (all except OS)
    const isolatedCores = allCores.filter(c => !osCores.includes(c));

    return {
        allocations,
        osCores,
        isolatedCores,
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

// =====================================================
// VALIDATION
// =====================================================

export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * validateL3Rules - The L3 Guard
 * 
 * Rule 1: Gateway + OS in same L3 (DIRTY) → Critical Error
 * Rule 2: GW + IRQ cross-NUMA → Warning
 * Rule 3: Service Bundle in GOLD → Warning
 */
export function validateL3Rules(
    allocations: CoreAllocation[],
    netNuma: number
): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    allocations.forEach(alloc => {
        // Rule 1: Gateway on DIRTY → Critical
        if (alloc.role === 'gateway' && alloc.zone === 'dirty') {
            errors.push(
                `Critical: Gateway (Core ${alloc.coreId}) cannot share L3 with OS`
            );
        }

        // Rule 2: IRQ cross-socket → Warning
        if (alloc.role === 'irq' && alloc.numa !== netNuma) {
            warnings.push(
                `Latency: IRQ (Core ${alloc.coreId}) is cross-socket`
            );
        }

        // Rule 3: Service Bundle in GOLD → Warning
        if ((alloc.role === 'trash_bundle' || alloc.role === 'ar_bundle') && alloc.zone === 'gold') {
            warnings.push(
                `Suboptimal: ${alloc.role} (Core ${alloc.coreId}) is in GOLD L3`
            );
        }
    });

    return {
        isValid: errors.length === 0,
        errors,
        warnings
    };
}

/**
 * HFT CPU Optimizer with L3 Cache Partitioning Strategy
 * 
 * "Stealth Engineering" - Bloomberg Terminal Level Optimization
 */

// =====================================================
// TYPES
// =====================================================

export interface L3Cache {
    id: string;
    numa: number;
    cores: number[];
    zone: 'dirty' | 'mixed' | 'pure';
}

export interface NumaNode {
    id: number;
    isNetwork: boolean;
    l3Caches: L3Cache[];
    totalCores: number;
}

export interface OptimizationInput {
    geometry: Record<string, Record<string, Record<string, number[]>>>;
    coreNumaMap: Record<string, number>;
    l3Groups: Record<string, number[]>;
    netNumaNodes: number[];
    coreLoads: Record<number, number>;
    instanceCount: number;  // 1 or 2
}

export interface CoreAllocation {
    coreId: number;
    role: string;
    instance?: string;
    l3Id: string;
    numa: number;
    zone: 'dirty' | 'mixed' | 'pure';
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

const WEIGHT_MAIN = 0.70;  // 70% for main instance
// WEIGHT_AUX = 1 - WEIGHT_MAIN (30% for aux instance)
const GW_TO_IRQ_RATIO = 3; // 1 IRQ per 3 Gateways
const MAX_GW_PER_INSTANCE = 10;

// =====================================================
// L3 ZONE CLASSIFICATION
// =====================================================

/**
 * Classify L3 caches into Dirty/Mixed/Pure zones
 * 
 * - Dirty (L3 #0): Contains OS cores -> place Trash+AR bundles
 * - Mixed (L3 #1): IRQ + Gateways
 * - Pure (L3 #2+): Gateways + Robots only
 */
export function classifyL3Zones(
    l3Groups: Record<string, number[]>,
    coreNumaMap: Record<string, number>,
    netNuma: number,
    osCores: number[]
): L3Cache[] {
    const osSet = new Set(osCores);
    const l3Caches: L3Cache[] = [];

    // Get network NUMA L3 caches first, then others
    const entries = Object.entries(l3Groups).sort((a, b) => {
        const numaA = coreNumaMap[String(a[1][0])] ?? 0;
        const numaB = coreNumaMap[String(b[1][0])] ?? 0;
        // Network NUMA first
        if (numaA === netNuma && numaB !== netNuma) return -1;
        if (numaB === netNuma && numaA !== netNuma) return 1;
        return parseInt(a[0]) - parseInt(b[0]);
    });

    let netL3Index = 0;

    entries.forEach(([l3Id, cores]) => {
        const numa = coreNumaMap[String(cores[0])] ?? 0;
        const hasOsCores = cores.some(c => osSet.has(c));
        const isNetNuma = numa === netNuma;

        let zone: 'dirty' | 'mixed' | 'pure';

        if (hasOsCores) {
            zone = 'dirty';
        } else if (isNetNuma && netL3Index === 1) {
            zone = 'mixed';
        } else {
            zone = 'pure';
        }

        if (isNetNuma) netL3Index++;

        l3Caches.push({
            id: l3Id,
            numa,
            cores,
            zone
        });
    });

    return l3Caches;
}

// =====================================================
// MAIN OPTIMIZER
// =====================================================

/**
 * optimizeTopology - The Brain
 * 
 * Implements the 4-step algorithm:
 * 1. Global Tax (OS)
 * 2. Fixed Service Tax (Anchors)
 * 3. Variable Tax (GW + IRQ)
 * 4. Computation (Robots)
 */
export function optimizeTopology(input: OptimizationInput): OptimizationResult {
    const { coreNumaMap, l3Groups, netNumaNodes, instanceCount } = input;
    const netNuma = netNumaNodes[0] ?? 0;

    const allCores = Object.keys(coreNumaMap).map(Number).sort((a, b) => a - b);
    const totalCores = allCores.length;

    const allocations: CoreAllocation[] = [];
    const warnings: string[] = [];
    const assigned = new Set<number>();

    // Get cores by NUMA
    const getCoresByNuma = (numa: number): number[] => {
        return allCores.filter(c => coreNumaMap[String(c)] === numa).sort((a, b) => a - b);
    };

    const numa0Cores = getCoresByNuma(0);  // Always OS on NUMA 0
    const netNumaCores = getCoresByNuma(netNuma);
    // remoteNumaCores used for robot allocation priority

    // ===== STEP 1: Global Tax (OS) =====
    // OS cores fixed on Node 0, starting from index 0
    const osCount = totalCores < 48 ? 4 : Math.min(8, Math.ceil(totalCores / 12));
    const osCores: number[] = [];

    for (let i = 0; i < osCount && i < numa0Cores.length; i++) {
        osCores.push(numa0Cores[i]);
        assigned.add(numa0Cores[i]);
    }

    // Classify L3 zones
    const l3Zones = classifyL3Zones(l3Groups, coreNumaMap, netNuma, osCores);
    const dirtyL3 = l3Zones.find(z => z.zone === 'dirty');
    const mixedL3 = l3Zones.find(z => z.zone === 'mixed');
    // Pure L3s are used for gateway overflow and robots

    // Helper to add allocation
    const allocate = (coreId: number, role: string, instance?: string) => {
        const l3 = l3Zones.find(z => z.cores.includes(coreId));
        allocations.push({
            coreId,
            role,
            instance,
            l3Id: l3?.id ?? '0',
            numa: coreNumaMap[String(coreId)] ?? 0,
            zone: l3?.zone ?? 'pure'
        });
        assigned.add(coreId);
    };

    // Get available cores from specific L3
    const getAvailableFromL3 = (l3: L3Cache | undefined, count: number): number[] => {
        if (!l3) return [];
        const available = l3.cores.filter(c => !assigned.has(c));
        return available.slice(0, count);
    };

    // Get available cores from zone
    const getAvailableFromZone = (zone: 'dirty' | 'mixed' | 'pure', count: number): number[] => {
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

    // ===== STEP 2: Fixed Service Tax (Anchors) =====
    // Each instance pays 2 cores on Network Node (in Dirty L3!)
    const instances = instanceCount === 2 ? ['MAIN', 'AUX'] : ['MAIN'];

    instances.forEach(inst => {
        // Core A: Trash Bundle (Trash + RF + ClickHouse) - Dirty L3
        const trashCores = getAvailableFromL3(dirtyL3, 1);
        if (trashCores.length > 0) {
            allocate(trashCores[0], 'trash_bundle', inst);
        }

        // Core B: AR Bundle (AllRobots + Formula) - Dirty L3
        const arCores = getAvailableFromL3(dirtyL3, 1);
        if (arCores.length > 0) {
            allocate(arCores[0], 'ar_bundle', inst);
        }
    });

    // ===== STEP 3: Variable Tax (Gateways & IRQ) =====
    // Calculate remaining network capacity
    const netCapacity = netNumaCores.filter(c => !assigned.has(c)).length;

    // Split capacity by weight if 2 instances
    const capacityMain = instanceCount === 2
        ? Math.floor(netCapacity * WEIGHT_MAIN)
        : netCapacity;
    const capacityAux = instanceCount === 2
        ? netCapacity - capacityMain
        : 0;

    const allocateGwIrq = (capacity: number, instance: string) => {
        // Max 10 GW per instance
        const gwCount = Math.min(MAX_GW_PER_INSTANCE, Math.floor(capacity * 0.75));
        const irqCount = Math.ceil(gwCount / GW_TO_IRQ_RATIO);

        // IRQ cores go to Mixed L3
        const irqCores = getAvailableFromL3(mixedL3, irqCount);
        irqCores.forEach(c => allocate(c, 'irq', instance));

        // Gateway cores go to Mixed L3 first, then Pure
        let gwAllocated = 0;
        const mixedGw = getAvailableFromL3(mixedL3, gwCount);
        mixedGw.forEach(c => {
            allocate(c, 'gateway', instance);
            gwAllocated++;
        });

        if (gwAllocated < gwCount) {
            const pureGw = getAvailableFromZone('pure', gwCount - gwAllocated);
            pureGw.forEach(c => allocate(c, 'gateway', instance));
        }
    };

    allocateGwIrq(capacityMain, 'MAIN');
    if (instanceCount === 2) {
        allocateGwIrq(capacityAux, 'AUX');
    }

    // ===== STEP 4: Computation (Robots) =====
    // All remaining cores go to Robot Pools
    const remainingCores = allCores.filter(c => !assigned.has(c) && !osCores.includes(c));

    remainingCores.forEach((c, idx) => {
        const instance = instanceCount === 2
            ? (idx % 3 < 2 ? 'MAIN' : 'AUX')  // 70/30 split
            : 'MAIN';
        allocate(c, 'robot', instance);
    });

    // Build isolated cores (all except OS)
    const isolatedCores = allCores.filter(c => !osCores.includes(c));

    // Summary
    const summary = {
        osCount: osCores.length,
        irqCount: allocations.filter(a => a.role === 'irq').length,
        gwCount: allocations.filter(a => a.role === 'gateway').length,
        robotCount: allocations.filter(a => a.role === 'robot').length
    };

    return {
        allocations,
        osCores,
        isolatedCores,
        l3Zones,
        warnings,
        summary
    };
}

// =====================================================
// L3 VALIDATION
// =====================================================

export interface ValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
}

/**
 * validateL3Rules - The L3 Guard
 * 
 * Checks L3 Quarantine rules:
 * - Gateway on Dirty L3 → Critical error
 * - IRQ on Remote NUMA → Latency warning
 * - ClickHouse on Pure L3 → Critical error
 */
export function validateL3Rules(
    allocations: CoreAllocation[],
    _l3Zones: L3Cache[],
    netNuma: number
): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    allocations.forEach(alloc => {
        // Check zone violations

        // Gateway on Dirty L3 → Error
        if (alloc.role === 'gateway' && alloc.zone === 'dirty') {
            errors.push(
                `Critical: Gateway (Core ${alloc.coreId}) cannot share L3 with Trash/OS`
            );
        }

        // IRQ on Remote NUMA → Warning
        if (alloc.role === 'irq' && alloc.numa !== netNuma) {
            warnings.push(
                `Latency Penalty: IRQ (Core ${alloc.coreId}) is cross-socket`
            );
        }

        // ClickHouse/Trash on Pure L3 → Error
        if ((alloc.role === 'trash_bundle' || alloc.role === 'ar_bundle') && alloc.zone === 'pure') {
            errors.push(
                `Critical: ${alloc.role} (Core ${alloc.coreId}) must be in Dirty L3`
            );
        }
    });

    return {
        isValid: errors.length === 0,
        errors,
        warnings
    };
}

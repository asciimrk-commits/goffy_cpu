/**
 * Multi-Instance CPU Optimizer v6.0
 * 
 * Algorithm:
 * 1. Parse input and detect instances (HUB7, RFQ1, etc.)
 * 2. For each instance, map cores to services (Trash, UDP, AR, RF, Gateways, Robots)
 * 3. Calculate total load per pool per instance
 * 4. Calculate needed cores: ceil(totalLoad / 30)
 * 5. Distribute cores optimally with L3 cache locality
 * 
 * Key Features:
 * - Target load: 30%
 * - IRQ scaling: ceil(gateways / 4) per instance
 * - Mandatory per-instance: Trash, UDP, AR, RF (can share cores)
 * - Optional: ClickHouse, Formula (detected from input)
 * - L3 cache visualization for fragmentation analysis
 */

import type { Geometry, InstanceConfig } from '../types/topology';

// =====================================================
// TYPES
// =====================================================

export interface InstanceAnalysis {
    name: string;
    // Current cores per role
    cores: {
        trash: number[];
        udp: number[];
        ar: number[];
        rf: number[];
        irq: number[];
        gateways: number[];
        robots: number[];
        clickhouse: number[];
        formula: number[];
    };
    // Load per pool
    loads: {
        gateways: number;
        robots: number;
        os: number;
    };
    // Current core counts
    current: {
        gateways: number;
        robots: number;
    };
    // Calculated needs (based on 30% target)
    needs: {
        trash: number;      // 1
        udp: number;        // 1
        ar: number;         // 1
        rf: number;         // 1 (can share)
        irq: number;        // ceil(gateways / 4)
        gateways: number;   // based on load
        robots: number;     // based on load + can add extra if available
        clickhouse: number; // 0 or 1
        formula: number;    // 0 or 1
    };
    // Total isolated cores needed
    totalNeeded: number;
}

export interface OSAnalysis {
    cores: number[];
    loads: number[];
    totalLoad: number;
    currentCount: number;
    neededCount: number;
}

export interface OptimizationResult {
    // OS is shared across all instances
    os: {
        cores: number[];
        needed: number;
        currentLoad: number;
    };
    // Per-instance analysis and allocation
    instances: Record<string, InstanceAnalysis>;
    // IRQ cores (shared, on network NUMA)
    irq: {
        cores: number[];
        needed: number;
    };
    // Recommendations
    recommendations: Recommendation[];
    warnings: string[];
    // Summary stats
    summary: {
        totalCores: number;
        isolatedCores: number;
        osNeeded: number;
        totalInstanceNeeds: Record<string, number>;
    };
    // L3 cache distribution for visualization
    l3Distribution: Record<string, {
        l3Id: string;
        numa: number;
        cores: number[];
        instances: Record<string, string[]>; // instance -> roles
    }>;
}

export interface Recommendation {
    id: string;
    title: string;
    description: string;
    cores: number[];
    role: string;
    instance?: string;
    rationale: string;
    warning?: string;
    severity: 'info' | 'warning' | 'error' | 'success';
    delta?: number; // Change in core count (+2, -1, etc.)
}

// =====================================================
// CONSTANTS  
// =====================================================

const TARGET_LOAD = 30;  // Target load percentage

// Bender role to internal role mapping (supports both raw Bender names AND parser output)
const BENDER_ROLE_MAP: Record<string, string> = {
    // Raw Bender names
    'TrashCPU': 'trash',
    'ClickHouseCores': 'clickhouse',
    'UdpSendCores': 'udp',
    'UdpReceiveCores': 'udp',
    'AllRobotsThCPU': 'ar',
    'GatewaysDefault': 'gateways',
    'Gateways': 'gateways',
    'RemoteFormulaCPU': 'rf',
    'Formula': 'formula',
    'RobotsDefault': 'robots',
    'net_cpu': 'irq',
    // Parser output role IDs (from BENDER_TO_ROLE)
    'trash': 'trash',
    'click': 'clickhouse',
    'udp': 'udp',
    'ar': 'ar',
    'gateway': 'gateways',
    'rf': 'rf',
    'formula': 'formula',
    'robot_default': 'robots',
    'pool1': 'robots',
    'pool2': 'robots',
    'isolated_robots': 'robots',
    'net_irq': 'irq',
    'sys_os': 'os'
};


// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Calculate needed cores based on load (30% target)
 * Formula: ceil(totalLoad / 30)
 */
function calcNeededCores(totalLoad: number, minCores: number = 1): number {
    if (totalLoad === 0) return minCores;
    return Math.max(minCores, Math.ceil(totalLoad / TARGET_LOAD));
}

/**
 * Calculate IRQ cores needed based on gateway count
 * Formula: ceil(gateways / 4)
 */
function calcIrqNeeded(gatewayCount: number): number {
    if (gatewayCount === 0) return 1;
    return Math.max(1, Math.ceil(gatewayCount / 4));
}

/**
 * Sum loads for given cores
 */
function sumLoads(cores: number[], coreLoads: Record<number, number>): number {
    return cores.reduce((sum, c) => sum + (coreLoads[c] || 0), 0);
}

/**
 * Parse core range string to array
 */
export function parseCoreRange(str: string): number[] {
    const cores: number[] = [];
    str.split(',').forEach(part => {
        part = part.trim();
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(s => parseInt(s.trim()));
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = start; i <= end; i++) cores.push(i);
            }
        } else {
            const num = parseInt(part);
            if (!isNaN(num)) cores.push(num);
        }
    });
    return cores;
}

/**
 * Format core array to range string
 */
export function formatCoreRange(cores: number[]): string {
    if (cores.length === 0) return '';
    const sorted = [...cores].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0], end = sorted[0];

    for (let i = 1; i <= sorted.length; i++) {
        if (i < sorted.length && sorted[i] === end + 1) {
            end = sorted[i];
        } else {
            ranges.push(start === end ? String(start) : `${start}-${end}`);
            if (i < sorted.length) {
                start = sorted[i];
                end = sorted[i];
            }
        }
    }
    return ranges.join(',');
}

// =====================================================
// INSTANCE DETECTION FROM RAW BENDER OUTPUT
// =====================================================

interface ParsedBenderEntry {
    cpu: number;
    isolated: boolean;
    roles: Record<string, string[]>; // role -> instances
}

/**
 * Parse raw bender output lines like:
 * {cpu_id:2,isolated:True,TrashCPU:[HUB7],ClickHouseCores:[HUB7]}
 */
export function parseBenderLine(line: string): ParsedBenderEntry | null {
    const cpuMatch = line.match(/cpu_id\s*:\s*(\d+)/);
    if (!cpuMatch) return null;

    const cpu = parseInt(cpuMatch[1]);
    const isolated = /isolated\s*:\s*True/i.test(line);
    const roles: Record<string, string[]> = {};

    // Match patterns like TrashCPU:[HUB7] or GatewaysDefault:[RFQ1]
    const rolePattern = /(\w+)\s*:\s*\[([^\]]+)\]/g;
    let match;
    while ((match = rolePattern.exec(line)) !== null) {
        const roleName = match[1];
        const instanceName = match[2].trim();

        // Skip 'cpu_id' and 'isolated'
        if (roleName === 'cpu_id' || roleName === 'isolated') continue;

        const internalRole = BENDER_ROLE_MAP[roleName];
        if (internalRole) {
            if (!roles[internalRole]) roles[internalRole] = [];
            if (!roles[internalRole].includes(instanceName)) {
                roles[internalRole].push(instanceName);
            }
        }
    }

    return { cpu, isolated, roles };
}

// =====================================================
// MAIN ANALYZER
// =====================================================

export interface OptimizerInput {
    geometry: Geometry;
    instances: InstanceConfig;
    isolatedCores: number[];
    coreNumaMap: Record<string, number>;
    coreLoads: Record<number, number>;
    netNumaNodes: number[];
    l3Groups: Record<string, number[]>;
}

/**
 * Analyze current allocation and calculate needs
 */
export function analyzeAllocation(input: OptimizerInput): OptimizationResult {
    const {
        // geometry - used by caller for rendering
        instances,
        isolatedCores,
        coreNumaMap,
        coreLoads,
        // netNumaNodes - reserved for future use
        l3Groups
    } = input;

    const isolatedSet = new Set(isolatedCores);
    const allCores = Object.keys(coreNumaMap).map(Number).sort((a, b) => a - b);
    const totalCores = allCores.length;

    const recommendations: Recommendation[] = [];
    const warnings: string[] = [];

    // ===== STEP 1: Detect instances =====
    const detectedInstances = new Set<string>();
    const instanceCores: Record<string, InstanceAnalysis['cores']> = {};

    // Initialize with empty arrays
    const emptyInstanceCores = (): InstanceAnalysis['cores'] => ({
        trash: [], udp: [], ar: [], rf: [], irq: [],
        gateways: [], robots: [], clickhouse: [], formula: []
    });

    // Scan instances config and map cores to instances
    Object.entries(instances).forEach(([instName, coreMap]) => {
        if (instName === 'Physical' || instName === 'OS') return;

        detectedInstances.add(instName);
        if (!instanceCores[instName]) {
            instanceCores[instName] = emptyInstanceCores();
        }

        Object.entries(coreMap).forEach(([cpuStr, roles]) => {
            const cpu = parseInt(cpuStr);
            roles.forEach(role => {
                const internalRole = BENDER_ROLE_MAP[role] || role;
                const target = instanceCores[instName];
                if (target[internalRole as keyof typeof target]) {
                    if (!target[internalRole as keyof typeof target].includes(cpu)) {
                        target[internalRole as keyof typeof target].push(cpu);
                    }
                }
            });
        });
    });

    // Also check Physical for instance hints
    if (instances.Physical) {
        Object.entries(instances.Physical).forEach(([_cpuStr, roles]) => {
            roles.forEach(role => {
                // Check if role contains instance name in brackets
                const match = role.match(/\[([A-Z][A-Z0-9]+)\]/);
                if (match) {
                    const inst = match[1];
                    if (!detectedInstances.has(inst)) {
                        detectedInstances.add(inst);
                        instanceCores[inst] = emptyInstanceCores();
                    }
                }
            });
        });
    }

    // If no named instances, use default
    if (detectedInstances.size === 0) {
        detectedInstances.add('Default');
        instanceCores['Default'] = emptyInstanceCores();
    }

    // ===== STEP 2: Identify OS cores =====
    // OS cores = non-isolated cores (no roles, no isolation flag)
    const osCores: number[] = [];
    allCores.forEach(cpu => {
        if (!isolatedSet.has(cpu)) {
            // Check if it has any instance roles
            let hasRole = false;
            Object.values(instanceCores).forEach(ic => {
                Object.values(ic).forEach(cores => {
                    if (cores.includes(cpu)) hasRole = true;
                });
            });
            if (!hasRole) {
                osCores.push(cpu);
            }
        }
    });

    // Calculate OS needs
    const osLoad = sumLoads(osCores, coreLoads);
    const osNeeded = calcNeededCores(osLoad, 2); // Minimum 2 for OS

    // ===== STEP 3: Analyze each instance =====
    const instanceAnalyses: Record<string, InstanceAnalysis> = {};

    detectedInstances.forEach(instName => {
        const cores = instanceCores[instName] || emptyInstanceCores();

        // Calculate loads
        const gwLoad = sumLoads(cores.gateways, coreLoads);
        const robotLoad = sumLoads(cores.robots, coreLoads);

        // Calculate needs
        const gwCount = cores.gateways.length;
        const robotCount = cores.robots.length;

        const gwNeeded = calcNeededCores(gwLoad, 1);
        const robotNeeded = calcNeededCores(robotLoad, 1);
        const irqNeeded = calcIrqNeeded(gwCount);

        const needs = {
            trash: 1,
            udp: 1,
            ar: 1,
            rf: 1, // Can share with gateways
            irq: irqNeeded,
            gateways: gwNeeded,
            robots: robotNeeded,
            clickhouse: cores.clickhouse.length > 0 ? 1 : 0,
            formula: cores.formula.length > 0 ? 1 : 0
        };

        // Total isolated cores needed for this instance
        // Note: RF can share with gateways, Trash+Clickhouse can share
        const totalNeeded = needs.trash + needs.udp + needs.ar +
            needs.gateways + needs.robots +
            needs.formula +
            needs.irq;

        instanceAnalyses[instName] = {
            name: instName,
            cores,
            loads: {
                gateways: gwLoad,
                robots: robotLoad,
                os: 0
            },
            current: {
                gateways: gwCount,
                robots: robotCount
            },
            needs,
            totalNeeded
        };
    });

    // ===== STEP 4: Generate recommendations =====

    // OS recommendation
    const osDelta = osNeeded - osCores.length;
    recommendations.push({
        id: 'os',
        title: 'OS',
        description: `${osCores.length} -> ${osNeeded} ядер`,
        cores: osCores.slice(0, osNeeded),
        role: 'sys_os',
        rationale: `Нагрузка ${osLoad.toFixed(1)}% / ${osCores.length} ядер -> нужно ${osNeeded} (таргет 30%)`,
        delta: osDelta,
        severity: osDelta === 0 ? 'success' : osDelta > 0 ? 'warning' : 'info'
    });

    // Per-instance recommendations
    Object.entries(instanceAnalyses).forEach(([instName, analysis]) => {
        // IRQ
        const currentIrq = analysis.cores.irq.length;
        const irqDelta = analysis.needs.irq - currentIrq;
        recommendations.push({
            id: `${instName}-irq`,
            title: 'IRQ',
            description: `${currentIrq} -> ${analysis.needs.irq} ядер`,
            cores: analysis.cores.irq,
            role: 'net_irq',
            instance: instName,
            rationale: `${analysis.current.gateways} гейтов -> ceil(${analysis.current.gateways}/4) = ${analysis.needs.irq} IRQ`,
            delta: irqDelta,
            severity: irqDelta === 0 ? 'success' : irqDelta > 0 ? 'warning' : 'info'
        });

        // Gateways
        const gwDelta = analysis.needs.gateways - analysis.current.gateways;
        recommendations.push({
            id: `${instName}-gateways`,
            title: 'Gateways',
            description: `${analysis.current.gateways} -> ${analysis.needs.gateways} ядер`,
            cores: analysis.cores.gateways,
            role: 'gateway',
            instance: instName,
            rationale: `Нагрузка ${analysis.loads.gateways.toFixed(1)}% -> нужно ${analysis.needs.gateways} (таргет 30%)`,
            delta: gwDelta,
            severity: gwDelta === 0 ? 'success' : gwDelta > 0 ? 'warning' : 'info'
        });

        // Robots
        const robotDelta = analysis.needs.robots - analysis.current.robots;
        recommendations.push({
            id: `${instName}-robots`,
            title: 'Robots',
            description: `${analysis.current.robots} -> ${analysis.needs.robots} ядер`,
            cores: analysis.cores.robots,
            role: 'robot_default',
            instance: instName,
            rationale: `Нагрузка ${analysis.loads.robots.toFixed(1)}% на ${analysis.current.robots} ядер`,
            delta: robotDelta,
            severity: robotDelta === 0 ? 'success' :
                (analysis.loads.robots / analysis.current.robots > 40) ? 'warning' : 'success',
            warning: (analysis.loads.robots / analysis.current.robots > 50) ?
                'Нагрузка >50% - рекомендуется добавить ядра' : undefined
        });

        // Services (Trash, UDP, AR, RF)
        const services = [
            { key: 'trash', name: 'Trash' },
            { key: 'udp', name: 'UDP' },
            { key: 'ar', name: 'AR' },
            { key: 'rf', name: 'RF' }
        ];

        services.forEach(svc => {
            const current = analysis.cores[svc.key as keyof typeof analysis.cores];
            const needed = analysis.needs[svc.key as keyof typeof analysis.needs];
            if (current.length === 0 && needed > 0) {
                warnings.push(`${instName}: отсутствует ${svc.name}`);
            }
        });
    });

    // ===== STEP 5: Build L3 cache distribution =====
    const l3Distribution: OptimizationResult['l3Distribution'] = {};

    Object.entries(l3Groups).forEach(([l3Id, cores]) => {
        const numa = cores.length > 0 ? (coreNumaMap[String(cores[0])] || 0) : 0;
        const instanceRoles: Record<string, string[]> = {};

        cores.forEach(cpu => {
            Object.entries(instanceAnalyses).forEach(([instName, analysis]) => {
                Object.entries(analysis.cores).forEach(([role, roleCores]) => {
                    if (roleCores.includes(cpu)) {
                        if (!instanceRoles[instName]) instanceRoles[instName] = [];
                        if (!instanceRoles[instName].includes(role)) {
                            instanceRoles[instName].push(role);
                        }
                    }
                });
            });
        });

        l3Distribution[l3Id] = {
            l3Id,
            numa,
            cores,
            instances: instanceRoles
        };
    });

    // ===== BUILD RESULT =====
    const totalInstanceNeeds: Record<string, number> = {};
    Object.entries(instanceAnalyses).forEach(([name, analysis]) => {
        totalInstanceNeeds[name] = analysis.totalNeeded;
    });

    // Generate summary with L3 info
    const result: OptimizationResult = {
        os: {
            cores: osCores,
            needed: osNeeded,
            currentLoad: osLoad
        },
        instances: instanceAnalyses,
        irq: {
            cores: [],
            needed: 0
        },
        recommendations,
        warnings,
        summary: {
            totalCores,
            isolatedCores: isolatedCores.length,
            osNeeded,
            totalInstanceNeeds
        },
        l3Distribution
    };

    // Calculate total IRQ across instances
    let totalIrqNeeded = 0;
    Object.values(instanceAnalyses).forEach(a => totalIrqNeeded += a.needs.irq);
    result.irq.needed = totalIrqNeeded;

    return result;
}

// =====================================================
// NUMA-AWARE REDISTRIBUTION
// =====================================================

export interface RedistributionPlan {
    proposedOs: number[];
    proposedIsolated: number[];
    sharedIrq: number[];  // Shared IRQ cores for all instances
    netNuma: number;      // Network NUMA node
    instanceAllocations: Record<string, {
        trash: number[];
        udp: number[];
        ar: number[];
        rf: number[];
        gateways: number[];
        robotPoolNode0: number[];  // Robots on NUMA 0
        robotPoolNode1: number[];  // Robots on NUMA 1
        clickhouse: number[];
        formula: number[];
    }>;
    changes: string[];
}

/**
 * Generate optimal redistribution plan with NUMA locality
 * 
 * RULES:
 * 1. OS: only non-isolated cores
 * 2. For small systems (<16 cores): services share more aggressively
 * 3. IRQ: 1 core on network NUMA
 * 4. Trash+UDP+Formula: can share 1 core
 * 5. AR+RF: can share 1 core (separate from Trash!)
 * 6. Gateways: proportional to available cores
 * 7. Robots: remaining cores
 */
export function generateRedistributionPlan(
    input: OptimizerInput,
    analysis: OptimizationResult
): RedistributionPlan {
    const { coreNumaMap, netNumaNodes, isolatedCores } = input;
    const isolatedSet = new Set(isolatedCores);
    const allCores = Object.keys(coreNumaMap).map(Number).sort((a, b) => a - b);
    const netNuma = netNumaNodes.length > 0 ? netNumaNodes[0] : 0;
    const totalCores = allCores.length;
    const isSmallSystem = totalCores <= 16;

    const changes: string[] = [];
    const assigned = new Set<number>();

    // Get cores by NUMA, sorted
    const getCoresByNuma = (numa: number): number[] => {
        return allCores.filter(c => coreNumaMap[String(c)] === numa).sort((a, b) => a - b);
    };

    // Get all NUMA nodes
    const allNumaNodes = [...new Set(Object.values(coreNumaMap))].sort((a, b) => a - b);
    const otherNumaNodes = allNumaNodes.filter(n => n !== netNuma);

    const netNumaCores = getCoresByNuma(netNuma);
    const otherNumaCores = otherNumaNodes.flatMap(n => getCoresByNuma(n)).sort((a, b) => a - b);

    const proposedOs: number[] = [];
    const proposedIsolated: number[] = [];
    const sharedIrq: number[] = [];
    const instanceAllocations: RedistributionPlan['instanceAllocations'] = {};

    // ===== STEP 1: OS cores = ONLY non-isolated cores =====
    const nonIsolatedCores = allCores.filter(c => !isolatedSet.has(c));
    nonIsolatedCores.forEach(c => {
        proposedOs.push(c);
        assigned.add(c);
    });

    changes.push(`### Physical / OS Layer ###`);
    changes.push(`System (OS): [${proposedOs.join(', ')}] (non-isolated)`);

    // ===== STEP 2: IRQ =====
    // Pick first isolated core on network NUMA for IRQ
    const isolatedNetCores = netNumaCores.filter(c => isolatedSet.has(c) && !assigned.has(c));
    if (isolatedNetCores.length > 0) {
        const irqCore = isolatedNetCores[0];
        sharedIrq.push(irqCore);
        assigned.add(irqCore);
    }
    changes.push(`IRQ (Net): [${sharedIrq.join(', ')}]`);

    // ===== STEP 3: Per-instance allocation =====
    const instanceNames = Object.keys(analysis.instances);
    const numInstances = Math.max(1, instanceNames.length);

    // Available isolated cores after IRQ
    let availableIsolated = allCores.filter(c => isolatedSet.has(c) && !assigned.has(c)).sort((a, b) => a - b);
    let coreIdx = 0;

    const takeCores = (n: number): number[] => {
        const taken: number[] = [];
        while (taken.length < n && coreIdx < availableIsolated.length) {
            const c = availableIsolated[coreIdx++];
            if (!assigned.has(c)) {
                taken.push(c);
                assigned.add(c);
            }
        }
        return taken;
    };

    // Calculate proportional allocations based on system size
    const coresPerInstance = Math.floor(availableIsolated.length / numInstances);

    instanceNames.forEach(instName => {
        const current = analysis.instances[instName].current;

        changes.push(`### Instance: ${instName} ###`);

        if (isSmallSystem) {
            // SMALL SYSTEM: aggressive sharing
            // Trash+UDP+Formula share 1 core
            const serviceCore1 = takeCores(1);
            // AR+RF share 1 core (NOT on trash!)
            const serviceCore2 = takeCores(1);

            // Gateways: 1-2 for small systems
            const gwCount = Math.min(2, Math.max(1, current.gateways || 2));
            const gateways = takeCores(gwCount);

            // Remaining cores = robots
            const robotCores = takeCores(Math.max(1, coresPerInstance - gwCount - 2));

            const instAlloc = {
                trash: serviceCore1,
                udp: serviceCore1.slice(),  // Same as trash
                ar: serviceCore2,
                rf: serviceCore2.slice(),   // Same as AR
                gateways,
                robotPoolNode0: robotCores,
                robotPoolNode1: [],  // No other NUMA for small systems usually
                clickhouse: serviceCore1.slice(),  // Same as trash
                formula: serviceCore1.slice()      // Same as trash
            };

            instanceAllocations[instName] = instAlloc;

            changes.push(`Trash+UDP+Formula+Click: [${serviceCore1.join(', ')}] (shared)`);
            changes.push(`AR+RF: [${serviceCore2.join(', ')}] (shared)`);
            changes.push(`Gateway: [${gateways.join(', ')}]`);
            changes.push(`Robots: [${robotCores.join(', ')}]`);
        } else {
            // LARGE SYSTEM: more separation
            const gwCount = Math.max(3, Math.min(6, current.gateways || 4));

            // Services on network NUMA
            const trash = takeCores(1);
            const udp = takeCores(1);
            const ar = takeCores(1);
            const gateways = takeCores(gwCount);

            // Robot pools: split between NUMAs
            const availableForRobots = coresPerInstance - gwCount - 3;
            const robotsNet = takeCores(Math.floor(availableForRobots / 3));
            const robotsOther = otherNumaCores
                .filter(c => isolatedSet.has(c) && !assigned.has(c))
                .slice(0, Math.floor(availableForRobots * 2 / 3));
            robotsOther.forEach(c => assigned.add(c));

            const instAlloc = {
                trash,
                udp,
                ar,
                rf: ar.slice(),      // RF shares with AR
                gateways,
                robotPoolNode0: robotsNet,
                robotPoolNode1: robotsOther,
                clickhouse: trash.slice(),  // ClickHouse shares with Trash
                formula: ar.slice()         // Formula shares with AR
            };

            instanceAllocations[instName] = instAlloc;

            changes.push(`Trash+Click: [${trash.join(', ')}] (shared)`);
            changes.push(`UDP: [${udp.join(', ')}]`);
            changes.push(`AR+RF+Formula: [${ar.join(', ')}] (shared)`);
            changes.push(`Gateway: [${gateways.join(', ')}] (${gateways.length} cores)`);
            changes.push(`Robot_Pool_Net: [${robotsNet.join(', ')}]`);
            changes.push(`Robot_Pool_Other: [${robotsOther.join(', ')}]`);
        }
    });

    // ===== STEP 4: Proposed isolated = all originally isolated =====
    isolatedCores.forEach(c => proposedIsolated.push(c));
    const uniqueIsolated = [...new Set(proposedIsolated)].sort((a, b) => a - b);

    changes.push(`### Isolation ###`);
    changes.push(`Total Isolated: ${uniqueIsolated.length} cores`);

    return {
        proposedOs,
        proposedIsolated: uniqueIsolated,
        sharedIrq,
        netNuma,
        instanceAllocations,
        changes
    };
}



// =====================================================
// APPLY REDISTRIBUTION TO INSTANCE CONFIG
// =====================================================

export function applyRedistribution(
    plan: RedistributionPlan
): InstanceConfig {
    const newInstances: InstanceConfig = { Physical: {} };

    // Add OS cores
    plan.proposedOs.forEach(cpu => {
        const cpuStr = String(cpu);
        if (!newInstances.Physical[cpuStr]) newInstances.Physical[cpuStr] = [];
        newInstances.Physical[cpuStr].push('sys_os');
    });

    // Add shared IRQ cores
    plan.sharedIrq.forEach(cpu => {
        const cpuStr = String(cpu);
        if (!newInstances.Physical[cpuStr]) newInstances.Physical[cpuStr] = [];
        newInstances.Physical[cpuStr].push('net_irq');
    });

    // Add per-instance allocations
    Object.entries(plan.instanceAllocations).forEach(([instName, alloc]) => {
        newInstances[instName] = {};

        // Role mapping to Bender names
        const roleMapping: [keyof typeof alloc, string][] = [
            ['trash', 'trash'],
            ['udp', 'udp'],
            ['ar', 'ar'],
            ['rf', 'rf'],
            ['gateways', 'gateway'],
            ['robotPoolNode0', 'pool1'],
            ['robotPoolNode1', 'pool2'],
            ['clickhouse', 'click'],
            ['formula', 'formula']
        ];

        roleMapping.forEach(([key, roleName]) => {
            alloc[key].forEach(cpu => {
                const cpuStr = String(cpu);
                if (!newInstances[instName][cpuStr]) newInstances[instName][cpuStr] = [];
                newInstances[instName][cpuStr].push(roleName);
            });
        });
    });

    return newInstances;
}

// =====================================================
// EXPORT TO BENDER FORMAT
// =====================================================

export interface BenderExportConfig {
    serverName: string;
    isolcpus: string;
    instances: Record<string, {
        TrashCPU: string;
        UdpSendCores: string;
        UdpReceiveCores: string;
        AllRobotsThCPU: string;
        RemoteFormulaCPU: string;
        GatewaysDefault: string;
        RobotsDefault: string;
        Formula?: string;
        ClickHouseCores?: string;
        irqaffinity_cpus: string;
    }>;
}

/**
 * Export redistribution plan to Bender-compatible format
 */
export function exportToBender(
    plan: RedistributionPlan,
    serverName: string = 'server'
): BenderExportConfig {
    const result: BenderExportConfig = {
        serverName,
        isolcpus: formatCoreRange(plan.proposedIsolated),
        instances: {}
    };

    Object.entries(plan.instanceAllocations).forEach(([instName, alloc]) => {
        // Combine robot pools for RobotsDefault
        const allRobots = [...alloc.robotPoolNode0, ...alloc.robotPoolNode1].sort((a, b) => a - b);

        result.instances[instName] = {
            TrashCPU: formatCoreRange(alloc.trash),
            UdpSendCores: formatCoreRange(alloc.udp),
            UdpReceiveCores: formatCoreRange(alloc.udp),
            AllRobotsThCPU: formatCoreRange(alloc.ar),
            RemoteFormulaCPU: formatCoreRange(alloc.rf),
            GatewaysDefault: formatCoreRange(alloc.gateways),
            RobotsDefault: formatCoreRange(allRobots),
            irqaffinity_cpus: formatCoreRange(plan.sharedIrq) // Use shared IRQ
        };

        if (alloc.formula.length > 0) {
            result.instances[instName].Formula = formatCoreRange(alloc.formula);
        }
        if (alloc.clickhouse.length > 0) {
            result.instances[instName].ClickHouseCores = formatCoreRange(alloc.clickhouse);
        }
    });

    return result;
}

/**
 * Format Bender config to YAML string
 */
export function formatBenderYaml(config: BenderExportConfig): string {
    let yaml = `# Bender Configuration for ${config.serverName}\n`;
    yaml += `# Generated by CPU Optimizer\n\n`;
    yaml += `isolcpus: "${config.isolcpus}"\n\n`;

    Object.entries(config.instances).forEach(([instName, inst]) => {
        yaml += `# Instance: ${instName}\n`;
        yaml += `${instName}:\n`;
        yaml += `  TrashCPU: "${inst.TrashCPU}"\n`;
        yaml += `  UdpSendCores: "${inst.UdpSendCores}"\n`;
        yaml += `  UdpReceiveCores: "${inst.UdpReceiveCores}"\n`;
        yaml += `  AllRobotsThCPU: "${inst.AllRobotsThCPU}"\n`;
        yaml += `  RemoteFormulaCPU: "${inst.RemoteFormulaCPU}"\n`;
        yaml += `  GatewaysDefault: "${inst.GatewaysDefault}"\n`;
        yaml += `  RobotsDefault: "${inst.RobotsDefault}"\n`;
        yaml += `  irqaffinity_cpus: "${inst.irqaffinity_cpus}"\n`;
        if (inst.Formula) {
            yaml += `  Formula: "${inst.Formula}"\n`;
        }
        if (inst.ClickHouseCores) {
            yaml += `  ClickHouseCores: "${inst.ClickHouseCores}"\n`;
        }
        yaml += '\n';
    });

    return yaml;
}

// =====================================================
// LEGACY OPTIMIZER (for backward compatibility)
// =====================================================

export function optimizeAllocation(input: OptimizerInput): OptimizationResult {
    return analyzeAllocation(input);
}

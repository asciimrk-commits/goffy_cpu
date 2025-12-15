import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';

interface Recommendation {
    title: string;
    description: string;
    cores: number[];
    role: string;
    rationale?: string;
    warning?: string | null;
    instance?: string;
}

interface InstanceAllocation {
    name: string;
    trash: number | null;
    udp: number | null;
    ar: number | null;
    irq: number[];
    gateways: number[];
    robots: number[];
    reserve: number[];
}

export function AutoOptimize() {
    const {
        geometry,
        isolatedCores,

        instances,
        setInstances,
    } = useAppStore();

    const [result, setResult] = useState<string | null>(null);
    const [recommendations, setRecommendations] = useState<Recommendation[]>([]);

    const generateOptimization = () => {
        if (Object.keys(geometry).length === 0) {
            setResult('No topology data. Load server data first.');
            return;
        }

        const coreLoads = useAppStore.getState().coreLoads;
        const isolatedSet = new Set(isolatedCores.map(String));

        // === Helper Functions ===
        const getTotalLoad = (cores: (string | number)[]): number => {
            if (!cores?.length) return 0;
            return cores.reduce((sum: number, c) => sum + (coreLoads[typeof c === 'string' ? parseInt(c) : c] || 0), 0);
        };

        // Analyze topology
        const byNuma: Record<string, number[]> = {};
        Object.entries(geometry).forEach(([, numaData]) => {
            Object.entries(numaData).forEach(([numaId, l3Data]) => {
                if (!byNuma[numaId]) byNuma[numaId] = [];
                Object.entries(l3Data).forEach(([, cores]) => {
                    byNuma[numaId].push(...cores);
                });
            });
        });

        const allCoresSorted = Object.values(byNuma).flat().sort((a, b) => a - b);
        const totalCores = allCoresSorted.length;

        // === Parse Instance-Specific Roles ===
        const detectedInstances: string[] = [];
        const instanceRoles: Record<string, Record<string, string[]>> = {};

        // Scan Physical for instance tags
        Object.entries(instances.Physical || {}).forEach(([, tags]) => {
            tags.forEach((tag: string) => {
                // Check if tag contains instance pattern
                const instMatch = tag.match(/\[([A-Z0-9]+)\]/);
                if (instMatch) {
                    const instName = instMatch[1];
                    if (!detectedInstances.includes(instName)) {
                        detectedInstances.push(instName);
                        instanceRoles[instName] = {};
                    }
                }
            });
        });

        // If no instances found, parse from current roles mapping
        if (detectedInstances.length === 0) {
            // Try to detect from existing role structure
            const instanceEntries = Object.entries(instances) as [string, Record<string, string[]>][];
            instanceEntries.forEach(([instName, cpuMap]) => {
                if (instName !== 'Physical' && cpuMap && Object.keys(cpuMap).length > 0) {
                    detectedInstances.push(instName);
                    instanceRoles[instName] = {};
                    Object.entries(cpuMap).forEach(([cpu, tags]) => {
                        if (Array.isArray(tags)) {
                            tags.forEach((t: string) => {
                                if (!instanceRoles[instName][t]) instanceRoles[instName][t] = [];
                                instanceRoles[instName][t].push(cpu);
                            });
                        }
                    });
                }
            });
        }

        // Fallback to Physical as single instance
        if (detectedInstances.length === 0) {
            detectedInstances.push('Physical');
        }

        // Collect all current roles from Physical
        const currentRoles: Record<string, string[]> = {};
        Object.entries(instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach((t: string) => {
                if (!currentRoles[t]) currentRoles[t] = [];
                currentRoles[t].push(cpu);
            });
        });

        // Use current roles if instanceRoles empty
        detectedInstances.forEach(inst => {
            if (!instanceRoles[inst] || Object.keys(instanceRoles[inst]).length === 0) {
                instanceRoles[inst] = currentRoles;
            }
        });

        const proposed: Record<string, string[]> = {};
        const recs: Recommendation[] = [];
        const assignedCores = new Set<number>();

        const assignRole = (cpu: number | string, role: string, _instance?: string) => {
            const cpuNum = typeof cpu === 'string' ? parseInt(cpu) : cpu;
            const cpuStr = String(cpuNum);
            if (!proposed[cpuStr]) proposed[cpuStr] = [];

            if (!proposed[cpuStr].includes(role)) proposed[cpuStr].push(role);
            assignedCores.add(cpuNum);
        };
        const isAssigned = (cpu: number | string) => {
            const cpuNum = typeof cpu === 'string' ? parseInt(cpu) : cpu;
            return assignedCores.has(cpuNum);
        };

        // === PHASE 1: OS Cores (Shared) ===
        // Target 30%, consecutive from 0
        const osCoresAvailable = allCoresSorted.filter(c => !isolatedSet.has(String(c)));
        const osLoad = getTotalLoad(currentRoles['sys_os'] || osCoresAvailable.map(String));
        let osNeeded = osLoad > 0
            ? Math.max(1, Math.ceil(osLoad / 30))  // target 30%
            : Math.max(1, Math.min(3, osCoresAvailable.length));

        // Cap at reasonable maximum (50% load means we still have margin)
        osNeeded = Math.min(osNeeded, Math.max(1, Math.ceil(osLoad / 50)), osCoresAvailable.length);

        const assignedOsCores = osCoresAvailable.slice(0, osNeeded);
        assignedOsCores.forEach(c => assignRole(c, 'sys_os'));

        const osLoadPerCore = assignedOsCores.length > 0 ? osLoad / assignedOsCores.length : 0;
        recs.push({
            title: '[OS] Shared',
            cores: assignedOsCores,
            description: `${assignedOsCores.length} ядер (${osLoad.toFixed(0)}% → ${osLoadPerCore.toFixed(0)}%/core)`,
            role: 'sys_os',
            rationale: 'Target 30%, от 0 последовательно',
        });

        // === PHASE 2: Shared Net IRQ (from net_cpu config) ===
        // These are typically marked with net_cpu in BENDER
        const netIrqCores = currentRoles['net_irq'] || [];
        netIrqCores.forEach(c => assignRole(parseInt(c), 'net_irq'));
        if (netIrqCores.length > 0) {
            recs.push({
                title: '[NET IRQ] Shared',
                cores: netIrqCores.map(Number),
                description: `${netIrqCores.length} ядер`,
                role: 'net_irq',
                rationale: 'net_cpu из конфига',
            });
        }

        // === PHASE 3: Per-Instance Allocation ===
        const instanceAllocations: InstanceAllocation[] = [];

        for (const instName of detectedInstances) {
            const instRoles = instanceRoles[instName] || currentRoles;

            // Get available cores (not assigned yet)
            const instCandidates = allCoresSorted
                .filter(c => isolatedSet.has(String(c)) && !isAssigned(c))
                .sort((a, b) => a - b);

            let instIdx = 0;
            const getInstCore = () => {
                while (instIdx < instCandidates.length) {
                    const c = instCandidates[instIdx++];
                    if (!isAssigned(c)) return c;
                }
                return null;
            };

            const allocation: InstanceAllocation = {
                name: instName,
                trash: null,
                udp: null,
                ar: null,
                irq: [],
                gateways: [],
                robots: [],
                reserve: [],
            };

            // 3.1 Trash + ClickHouse (1 core per instance)
            const trashCore = getInstCore();
            if (trashCore !== null) {
                allocation.trash = trashCore;
                assignRole(trashCore, 'trash', instName);
                assignRole(trashCore, 'click', instName);
                recs.push({
                    title: `[TRASH+CLICK] ${instName}`,
                    cores: [trashCore],
                    description: `Ядро ${trashCore}`,
                    role: 'trash',
                    rationale: '"Грязный" L3',
                    instance: instName,
                });
            }

            // 3.2 UDP (1 core per instance)
            const udpCore = getInstCore();
            if (udpCore !== null) {
                allocation.udp = udpCore;
                assignRole(udpCore, 'udp', instName);
                recs.push({
                    title: `[UDP] ${instName}`,
                    cores: [udpCore],
                    description: `Ядро ${udpCore}`,
                    role: 'udp',
                    rationale: 'Обязательный',
                    instance: instName,
                });
            }

            // 3.3 AR + RF + Formula (1 core per instance, NOT on trash!)
            const arCore = getInstCore();
            if (arCore !== null) {
                allocation.ar = arCore;
                assignRole(arCore, 'ar', instName);
                assignRole(arCore, 'rf', instName);
                assignRole(arCore, 'formula', instName);
                recs.push({
                    title: `[AR+RF+FORMULA] ${instName}`,
                    cores: [arCore],
                    description: `Ядро ${arCore}`,
                    role: 'ar',
                    rationale: 'НЕ на Trash!',
                    instance: instName,
                });
            }

            // 3.4 IRQ per instance: 1 per 4 gateways FOR THIS INSTANCE
            const instGwCount = instRoles['gateway']?.length || 0;
            const instIrqNeeded = Math.max(1, Math.ceil(instGwCount / 4));

            for (let i = 0; i < instIrqNeeded; i++) {
                const c = getInstCore();
                if (c !== null) {
                    allocation.irq.push(c);
                    assignRole(c, 'net_irq', instName);
                }
            }

            if (allocation.irq.length > 0) {
                recs.push({
                    title: `[IRQ] ${instName}`,
                    cores: allocation.irq,
                    description: `${allocation.irq.length} ядер (${instGwCount} gw / 4)`,
                    role: 'net_irq',
                    rationale: '1 IRQ / 4 gateways per instance',
                    instance: instName,
                });
            }

            // 3.5 Gateways (target 30%)
            const gwLoad = getTotalLoad(instRoles['gateway'] || []);
            const gwNeeded = gwLoad > 0
                ? Math.max(1, Math.ceil(gwLoad / 30))
                : instGwCount;

            // Check if low load - maybe reduce or skip


            if (gwLoad < 5) {
                // Very low load - can reduce
                recs.push({
                    title: `[GATEWAYS] ${instName}`,
                    cores: [],
                    description: `Низкая нагрузка (${gwLoad.toFixed(0)}%)`,
                    role: 'gateway',
                    rationale: '<5% - можно сократить',
                    warning: 'Рекомендуется проверить',
                    instance: instName,
                });
            } else {
                for (let i = 0; i < gwNeeded; i++) {
                    const c = getInstCore();
                    if (c !== null) {
                        allocation.gateways.push(c);
                        assignRole(c, 'gateway', instName);
                    }
                }

                if (allocation.gateways.length > 0) {
                    const newLoad = gwLoad / allocation.gateways.length;
                    recs.push({
                        title: `[GATEWAYS] ${instName}`,
                        cores: allocation.gateways,
                        description: `${allocation.gateways.length} ядер (${gwLoad.toFixed(0)}% → ${newLoad.toFixed(0)}%/core)`,
                        role: 'gateway',
                        rationale: 'Target 30%',
                        warning: allocation.gateways.length < gwNeeded ? `Нужно ${gwNeeded}!` : null,
                        instance: instName,
                    });
                }
            }

            // 3.6 Robots (target 30%, remaining cores)
            const robotLoad = getTotalLoad(instRoles['robot_default'] || []);
            const robotNeeded = robotLoad > 0
                ? Math.max(1, Math.ceil(robotLoad / 30))
                : 0;

            if (robotLoad < 5) {
                // Very low load - keep as reserve
                let c = getInstCore();
                while (c !== null) {
                    allocation.reserve.push(c);
                    assignRole(c, 'isolated', instName);
                    c = getInstCore();
                }

                if (allocation.reserve.length > 0) {
                    recs.push({
                        title: `[RESERVE] ${instName}`,
                        cores: allocation.reserve,
                        description: `${allocation.reserve.length} ядер (нагрузка <5%)`,
                        role: 'isolated',
                        rationale: 'Резерв для будущего',
                        instance: instName,
                    });
                }
            } else {
                // Allocate robots
                let robotAllocated = 0;
                let c = getInstCore();
                while (c !== null) {
                    if (robotAllocated < robotNeeded) {
                        allocation.robots.push(c);
                        assignRole(c, 'robot_default', instName);
                        robotAllocated++;
                    } else {
                        // Extra cores → reserve if low individual load
                        allocation.reserve.push(c);
                        assignRole(c, 'robot_default', instName); // Still usable
                    }
                    c = getInstCore();
                }

                if (allocation.robots.length > 0) {
                    const robotLoadPerCore = robotLoad / allocation.robots.length;
                    recs.push({
                        title: `[ROBOTS] ${instName}`,
                        cores: allocation.robots,
                        description: `${allocation.robots.length} ядер (${robotLoad.toFixed(0)}% → ${robotLoadPerCore.toFixed(0)}%/core)`,
                        role: 'robot_default',
                        rationale: 'Target 30%',
                        instance: instName,
                    });
                }

                if (allocation.reserve.length > 0) {
                    recs.push({
                        title: `[EXTRA ROBOTS] ${instName}`,
                        cores: allocation.reserve,
                        description: `${allocation.reserve.length} ядер`,
                        role: 'robot_default',
                        rationale: 'Доп. мощность',
                        instance: instName,
                    });
                }
            }

            instanceAllocations.push(allocation);
        }

        // === PHASE 4: Fill Remaining ===
        // Non-isolated remaining → OS
        const remainingNonIsolated = allCoresSorted.filter(c =>
            !isolatedSet.has(String(c)) && !isAssigned(c)
        );
        if (remainingNonIsolated.length > 0) {
            remainingNonIsolated.forEach(c => assignRole(c, 'sys_os'));
            recs.push({
                title: '[OS] Additional',
                cores: remainingNonIsolated,
                description: `${remainingNonIsolated.length} ядер`,
                role: 'sys_os',
                rationale: 'Не изолированы → OS',
            });
        }

        // Isolated remaining → reserve
        const remainingIsolated = allCoresSorted.filter(c =>
            isolatedSet.has(String(c)) && !isAssigned(c)
        );
        if (remainingIsolated.length > 0) {
            remainingIsolated.forEach(c => assignRole(c, 'isolated'));
            recs.push({
                title: '[RESERVE] Unassigned',
                cores: remainingIsolated,
                description: `${remainingIsolated.length} ядер`,
                role: 'isolated',
                rationale: 'Резерв',
            });
        }

        // === Summary ===
        const assignedCount = assignedCores.size;

        setRecommendations(recs);

        const summaryParts = detectedInstances.map(inst => {
            const alloc = instanceAllocations.find(a => a.name === inst);
            if (!alloc) return inst;
            const total = (alloc.trash ? 1 : 0) + (alloc.udp ? 1 : 0) + (alloc.ar ? 1 : 0) +
                alloc.irq.length + alloc.gateways.length + alloc.robots.length;
            return `${inst}:${total}`;
        });

        setResult(`${detectedInstances.length} instance(s) | ${summaryParts.join(', ')} | ${assignedCount}/${totalCores} cores`);
    };

    const applyRecommendations = () => {
        const proposed: Record<string, string[]> = {};
        recommendations.forEach(rec => {
            rec.cores.forEach(c => {
                const cpuStr = String(c);
                if (!proposed[cpuStr]) proposed[cpuStr] = [];
                if (!proposed[cpuStr].includes(rec.role)) {
                    proposed[cpuStr].push(rec.role);
                }
                // Special combinations
                if (rec.role === 'trash') {
                    if (!proposed[cpuStr].includes('click')) proposed[cpuStr].push('click');
                }
                if (rec.role === 'ar') {
                    if (!proposed[cpuStr].includes('rf')) proposed[cpuStr].push('rf');
                    if (!proposed[cpuStr].includes('formula')) proposed[cpuStr].push('formula');
                }
            });
        });
        setInstances({ Physical: proposed });
        setResult('Applied! Check topology map.');
    };

    // Group recommendations by instance
    const groupedRecs = recommendations.reduce((acc, rec) => {
        const key = rec.instance || 'Shared';
        if (!acc[key]) acc[key] = [];
        acc[key].push(rec);
        return acc;
    }, {} as Record<string, Recommendation[]>);

    return (
        <div className="optimize-container">
            <div className="optimize-header">
                <h2>[AUTO-OPTIMIZATION ENGINE v4]</h2>
                <p>Multi-instance support with per-instance IRQ and 30% load target</p>
            </div>

            <div className="optimize-actions">
                <button className="btn btn-primary btn-lg" onClick={generateOptimization}>
                    GENERATE
                </button>
                {recommendations.length > 0 && (
                    <button className="btn btn-secondary" onClick={applyRecommendations}>
                        APPLY
                    </button>
                )}
            </div>

            {result && (
                <div className="optimize-result">
                    <p>{result}</p>
                </div>
            )}

            {Object.keys(groupedRecs).length > 0 && (
                <div className="optimize-recommendations">
                    {Object.entries(groupedRecs).map(([instName, instRecs]) => (
                        <div key={instName} className="instance-section">
                            <h3 className="instance-header">=== {instName} ===</h3>
                            {instRecs.map((rec, idx) => (
                                <div key={idx} className={`recommend-card ${rec.warning ? 'warning' : ''}`}>
                                    <h4>{rec.title}</h4>
                                    <p>{rec.description}</p>
                                    {rec.rationale && <p className="rationale">{rec.rationale}</p>}
                                    {rec.warning && <p className="warning-text">[!] {rec.warning}</p>}
                                    {rec.cores.length > 0 && (
                                        <div className="recommend-cores">
                                            {rec.cores.map(c => (
                                                <span
                                                    key={c}
                                                    className="recommend-core"
                                                    style={{ backgroundColor: ROLES[rec.role]?.color || '#64748b' }}
                                                >
                                                    {c}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

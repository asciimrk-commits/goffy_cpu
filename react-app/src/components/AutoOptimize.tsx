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
    instance: string;
}

interface InstanceBudget {
    name: string;
    trash: number | null;
    click: number | null;
    udp: number | null;
    ar: number | null;
    irq: number[];
    gateways: number[];
    robots: number[];
    formula: number | null;
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
            return cores.reduce((sum: number, c) => {
                const load = coreLoads[typeof c === 'string' ? parseInt(c) : c] || 0;
                return sum + load;
            }, 0);
        };

        // All cores sorted
        const allCores: number[] = [];
        Object.entries(geometry).forEach(([, numaData]) => {
            Object.entries(numaData).forEach(([, l3Data]) => {
                Object.entries(l3Data).forEach(([, cores]) => {
                    allCores.push(...cores);
                });
            });
        });
        allCores.sort((a, b) => a - b);
        const totalCores = allCores.length;

        // === Step 1: Detect Instances from parsed data ===
        const detectedInstances: string[] = [];
        const instanceCores: Record<string, Record<string, string[]>> = {};

        Object.entries(instances).forEach(([instName, cpuMap]) => {
            if (instName === 'Physical') return;
            if (cpuMap && Object.keys(cpuMap).length > 0) {
                detectedInstances.push(instName);
                instanceCores[instName] = {};

                Object.entries(cpuMap).forEach(([cpu, roles]) => {
                    if (Array.isArray(roles)) {
                        roles.forEach((role: string) => {
                            if (!instanceCores[instName][role]) {
                                instanceCores[instName][role] = [];
                            }
                            instanceCores[instName][role].push(cpu);
                        });
                    }
                });
            }
        });

        // Fallback if no named instances
        if (detectedInstances.length === 0) {
            detectedInstances.push('Physical');
            instanceCores['Physical'] = {};
            Object.entries(instances.Physical || {}).forEach(([cpu, roles]) => {
                roles.forEach((role: string) => {
                    if (!instanceCores['Physical'][role]) {
                        instanceCores['Physical'][role] = [];
                    }
                    instanceCores['Physical'][role].push(cpu);
                });
            });
        }

        const proposed: Record<string, string[]> = {};
        const recs: Recommendation[] = [];
        const assignedCores = new Set<number>();

        const assignRole = (cpu: number | string, role: string) => {
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

        // === Step 2: Calculate OS (non-isolated cores) ===
        // Cores without isolation = OS cores
        const currentOsCores = allCores.filter(c => !isolatedSet.has(String(c)));
        const osLoad = getTotalLoad(currentOsCores);

        // Target 30% per core
        let osNeeded = osLoad > 0
            ? Math.max(1, Math.ceil(osLoad / 30))
            : Math.max(1, Math.min(4, currentOsCores.length));

        // OS takes 0, 1, 2, ... consecutive from start
        const assignedOsCores = allCores.slice(0, osNeeded);
        assignedOsCores.forEach(c => assignRole(c, 'sys_os'));

        const osLoadPerCore = assignedOsCores.length > 0 ? osLoad / assignedOsCores.length : 0;
        recs.push({
            title: '[OS]',
            cores: assignedOsCores,
            description: `${assignedOsCores.length} ядер (${osLoad.toFixed(0)}% → ${osLoadPerCore.toFixed(0)}%/core)`,
            role: 'sys_os',
            rationale: `0-${osNeeded - 1} последовательно, target 30%`,
            instance: 'OS',
        });

        // === Step 3: Per-Instance Allocation ===
        const instanceBudgets: InstanceBudget[] = [];

        // Divide remaining isolated cores between instances
        const isolatedAvailable = allCores.filter(c =>
            c >= osNeeded && isolatedSet.has(String(c)) && !isAssigned(c)
        );

        const coresPerInstance = Math.floor(isolatedAvailable.length / detectedInstances.length);
        const instancePools: Record<string, number[]> = {};

        detectedInstances.forEach((instName, idx) => {
            const start = idx * coresPerInstance;
            const end = idx === detectedInstances.length - 1
                ? isolatedAvailable.length
                : start + coresPerInstance;
            instancePools[instName] = isolatedAvailable.slice(start, end);
        });

        for (const instName of detectedInstances) {
            const instRoles = instanceCores[instName] || {};
            const pool = [...instancePools[instName]];

            let poolIdx = 0;
            const getCore = () => {
                while (poolIdx < pool.length) {
                    const c = pool[poolIdx++];
                    if (!isAssigned(c)) return c;
                }
                return null;
            };

            const budget: InstanceBudget = {
                name: instName,
                trash: null,
                click: null,
                udp: null,
                ar: null,
                irq: [],
                gateways: [],
                robots: [],
                formula: null,
                reserve: [],
            };

            // 3.1 Trash + ClickHouse
            const trashCore = getCore();
            if (trashCore !== null) {
                budget.trash = trashCore;
                budget.click = trashCore;
                assignRole(trashCore, 'trash');
                assignRole(trashCore, 'click');
                recs.push({
                    title: '[TRASH+CLICK]',
                    cores: [trashCore],
                    description: `Ядро ${trashCore}`,
                    role: 'trash',
                    rationale: '"Грязный" L3',
                    instance: instName,
                });
            }

            // 3.2 UDP
            const udpCore = getCore();
            if (udpCore !== null) {
                budget.udp = udpCore;
                assignRole(udpCore, 'udp');
                recs.push({
                    title: '[UDP]',
                    cores: [udpCore],
                    description: `Ядро ${udpCore}`,
                    role: 'udp',
                    rationale: 'Обязательный',
                    instance: instName,
                });
            }

            // 3.3 AR + RF + Formula
            const arCore = getCore();
            if (arCore !== null) {
                budget.ar = arCore;
                budget.formula = arCore;
                assignRole(arCore, 'ar');
                assignRole(arCore, 'rf');
                assignRole(arCore, 'formula');
                recs.push({
                    title: '[AR+RF+FORMULA]',
                    cores: [arCore],
                    description: `Ядро ${arCore}`,
                    role: 'ar',
                    rationale: 'НЕ на Trash!',
                    instance: instName,
                });
            }

            // 3.4 IRQ per instance: 1 per 4 gateways
            const gwCoresCurrent = instRoles['gateway'] || [];
            const gwCount = gwCoresCurrent.length;
            const irqNeeded = Math.max(1, Math.ceil(gwCount / 4));

            for (let i = 0; i < irqNeeded; i++) {
                const c = getCore();
                if (c !== null) {
                    budget.irq.push(c);
                    assignRole(c, 'net_irq');
                }
            }

            if (budget.irq.length > 0) {
                recs.push({
                    title: '[IRQ]',
                    cores: budget.irq,
                    description: `${budget.irq.length} ядер (${gwCount} gw / 4)`,
                    role: 'net_irq',
                    rationale: '1 IRQ / 4 gateways',
                    instance: instName,
                });
            }

            // 3.5 Gateways (load-based, target 30%)
            const gwLoad = getTotalLoad(gwCoresCurrent);
            const gwNeeded = gwLoad > 5
                ? Math.max(1, Math.ceil(gwLoad / 30))
                : Math.max(1, gwCount - 1); // Low load, can reduce by 1

            for (let i = 0; i < gwNeeded; i++) {
                const c = getCore();
                if (c !== null) {
                    budget.gateways.push(c);
                    assignRole(c, 'gateway');
                }
            }

            if (budget.gateways.length > 0) {
                const gwLoadPerCore = budget.gateways.length > 0 ? gwLoad / budget.gateways.length : 0;
                recs.push({
                    title: '[GATEWAYS]',
                    cores: budget.gateways,
                    description: `${budget.gateways.length} ядер (${gwLoad.toFixed(0)}% → ${gwLoadPerCore.toFixed(0)}%/core)`,
                    role: 'gateway',
                    rationale: 'Target 30%',
                    warning: budget.gateways.length < gwNeeded ? `Нужно ${gwNeeded}!` : null,
                    instance: instName,
                });
            }

            // 3.6 Robots (remaining cores, target 30%)
            const robotCoresCurrent = instRoles['robot_default'] || [];
            const robotLoad = getTotalLoad(robotCoresCurrent);
            const robotNeeded = robotLoad > 5
                ? Math.max(1, Math.ceil(robotLoad / 30))
                : 1;

            let robotAllocated = 0;
            let c = getCore();
            while (c !== null) {
                if (robotAllocated < robotNeeded || robotLoad > robotAllocated * 40) {
                    budget.robots.push(c);
                    assignRole(c, 'robot_default');
                    robotAllocated++;
                } else {
                    // Extra → reserve
                    budget.reserve.push(c);
                    assignRole(c, 'isolated');
                }
                c = getCore();
            }

            if (budget.robots.length > 0) {
                const robotLoadPerCore = budget.robots.length > 0 ? robotLoad / budget.robots.length : 0;
                recs.push({
                    title: '[ROBOTS]',
                    cores: budget.robots,
                    description: `${budget.robots.length} ядер (${robotLoad.toFixed(0)}% → ${robotLoadPerCore.toFixed(0)}%/core)`,
                    role: 'robot_default',
                    rationale: 'Target 30-40%',
                    instance: instName,
                });
            }

            if (budget.reserve.length > 0) {
                recs.push({
                    title: '[RESERVE]',
                    cores: budget.reserve,
                    description: `${budget.reserve.length} ядер`,
                    role: 'isolated',
                    rationale: 'Резерв для будущего',
                    instance: instName,
                });
            }

            instanceBudgets.push(budget);
        }

        // === Step 4: Fill any remaining cores ===
        const remainingCores = allCores.filter(c => !isAssigned(c));
        if (remainingCores.length > 0) {
            // Non-isolated → OS
            const remNonIso = remainingCores.filter(c => !isolatedSet.has(String(c)));
            remNonIso.forEach(c => assignRole(c, 'sys_os'));
            if (remNonIso.length > 0) {
                recs.push({
                    title: '[OS Additional]',
                    cores: remNonIso,
                    description: `${remNonIso.length} ядер`,
                    role: 'sys_os',
                    rationale: 'Не изолированы',
                    instance: 'OS',
                });
            }

            // Isolated → reserve
            const remIso = remainingCores.filter(c => isolatedSet.has(String(c)));
            remIso.forEach(c => assignRole(c, 'isolated'));
            if (remIso.length > 0) {
                recs.push({
                    title: '[RESERVE Global]',
                    cores: remIso,
                    description: `${remIso.length} ядер`,
                    role: 'isolated',
                    rationale: 'Резерв',
                    instance: 'Reserve',
                });
            }
        }

        setRecommendations(recs);

        const summaryParts = instanceBudgets.map(b => {
            const total = (b.trash ? 1 : 0) + (b.udp ? 1 : 0) + (b.ar ? 1 : 0) +
                b.irq.length + b.gateways.length + b.robots.length;
            return `${b.name}:${total}`;
        });

        setResult(`${detectedInstances.length} instance(s) | ${summaryParts.join(', ')} | OS:${assignedOsCores.length} | ${assignedCores.size}/${totalCores}`);
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
                if (rec.role === 'trash' && !proposed[cpuStr].includes('click')) {
                    proposed[cpuStr].push('click');
                }
                if (rec.role === 'ar') {
                    if (!proposed[cpuStr].includes('rf')) proposed[cpuStr].push('rf');
                    if (!proposed[cpuStr].includes('formula')) proposed[cpuStr].push('formula');
                }
            });
        });

        // Update state and force refresh
        setInstances({ Physical: proposed });
        setResult('Applied! Check topology map.');
    };

    // Group recommendations by instance
    const groupedRecs: Record<string, Recommendation[]> = {};
    recommendations.forEach(rec => {
        if (!groupedRecs[rec.instance]) groupedRecs[rec.instance] = [];
        groupedRecs[rec.instance].push(rec);
    });

    // Order: OS first, then instances alphabetically, Reserve last
    const instanceOrder = Object.keys(groupedRecs).sort((a, b) => {
        if (a === 'OS') return -1;
        if (b === 'OS') return 1;
        if (a === 'Reserve') return 1;
        if (b === 'Reserve') return -1;
        return a.localeCompare(b);
    });

    return (
        <div className="optimize-container">
            <div className="optimize-header">
                <h2>[AUTO-OPTIMIZATION ENGINE v5]</h2>
                <p>Per-instance allocation with load-based calculation (target 30%)</p>
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

            {instanceOrder.length > 0 && (
                <div className="optimize-recommendations">
                    {instanceOrder.map(instName => (
                        <div key={instName} className="instance-section">
                            <h3 className="instance-header">=== {instName} ===</h3>
                            {groupedRecs[instName].map((rec, idx) => (
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

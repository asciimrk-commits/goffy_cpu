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
        netNumaNodes,
        coreNumaMap,
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

        // Network NUMA (from IF:net0|NUMA:X)
        const netNuma = netNumaNodes.length > 0 ? netNumaNodes[0] : 0;

        // === Helper Functions ===
        const getTotalLoad = (cores: (string | number)[]): number => {
            if (!cores?.length) return 0;
            return cores.reduce((sum: number, c) => {
                const load = coreLoads[typeof c === 'string' ? parseInt(c) : c] || 0;
                return sum + load;
            }, 0);
        };

        const getCoreNuma = (core: number): number => {
            return coreNumaMap[String(core)] ?? 0;
        };

        // Build cores by NUMA
        const coresByNuma: Record<number, number[]> = {};
        const allCores: number[] = [];

        Object.entries(geometry).forEach(([, numaData]) => {
            Object.entries(numaData).forEach(([numaId, l3Data]) => {
                const numa = parseInt(numaId);
                if (!coresByNuma[numa]) coresByNuma[numa] = [];
                Object.entries(l3Data).forEach(([, cores]) => {
                    allCores.push(...cores);
                    coresByNuma[numa].push(...cores);
                });
            });
        });

        allCores.sort((a, b) => a - b);
        Object.values(coresByNuma).forEach(arr => arr.sort((a, b) => a - b));
        const totalCores = allCores.length;

        // === Step 1: Detect Instances ===
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
                            if (!instanceCores[instName][role]) instanceCores[instName][role] = [];
                            instanceCores[instName][role].push(cpu);
                        });
                    }
                });
            }
        });

        if (detectedInstances.length === 0) {
            detectedInstances.push('Physical');
            instanceCores['Physical'] = {};
            Object.entries(instances.Physical || {}).forEach(([cpu, roles]) => {
                roles.forEach((role: string) => {
                    if (!instanceCores['Physical'][role]) instanceCores['Physical'][role] = [];
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

        // === Step 2: OS Cores (0 to N consecutive) ===
        const currentOsCores = allCores.filter(c => !isolatedSet.has(String(c)));
        const osLoad = getTotalLoad(currentOsCores);

        let osNeeded = osLoad > 0
            ? Math.max(1, Math.ceil(osLoad / 30))
            : Math.max(1, Math.min(4, currentOsCores.length));

        // OS = 0, 1, 2, ... osNeeded-1
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

        // All cores after OS are now available for services (isolated)
        const isolatedForServices = allCores.filter(c => c >= osNeeded && !isAssigned(c));

        // === Step 3: Per-Instance Allocation ===
        const instanceBudgets: InstanceBudget[] = [];

        // Cores on network NUMA (for IRQ + Gateways)
        const netNumaCores = isolatedForServices.filter(c => getCoreNuma(c) === netNuma);
        const otherNumaCores = isolatedForServices.filter(c => getCoreNuma(c) !== netNuma);

        // Divide cores between instances
        const coresPerInstance = Math.floor(isolatedForServices.length / detectedInstances.length);
        const instancePools: Record<string, number[]> = {};
        const instanceNetPools: Record<string, number[]> = {};

        detectedInstances.forEach((instName, idx) => {
            // Each instance gets portion of net NUMA cores for IRQ/GW
            const netStart = Math.floor(idx * netNumaCores.length / detectedInstances.length);
            const netEnd = Math.floor((idx + 1) * netNumaCores.length / detectedInstances.length);
            instanceNetPools[instName] = netNumaCores.slice(netStart, netEnd);

            // Plus portion of other cores
            const start = idx * coresPerInstance;
            const end = idx === detectedInstances.length - 1
                ? isolatedForServices.length
                : start + coresPerInstance;
            instancePools[instName] = [
                ...instanceNetPools[instName],
                ...otherNumaCores.slice(start, end)
            ];
        });

        for (const instName of detectedInstances) {
            const instRoles = instanceCores[instName] || {};
            const netPool = [...instanceNetPools[instName]];
            const allPool = [...instancePools[instName]];

            let netIdx = 0;
            let allIdx = 0;

            const getNetCore = () => {
                while (netIdx < netPool.length) {
                    const c = netPool[netIdx++];
                    if (!isAssigned(c)) return c;
                }
                return null;
            };

            const getAnyCore = () => {
                while (allIdx < allPool.length) {
                    const c = allPool[allIdx++];
                    if (!isAssigned(c)) return c;
                }
                return null;
            };

            const budget: InstanceBudget = {
                name: instName,
                trash: null, click: null, udp: null, ar: null,
                irq: [], gateways: [], robots: [], formula: null, reserve: [],
            };

            // 3.1 Trash + ClickHouse (NOT on net NUMA, dirty L3)
            const trashCore = getAnyCore();
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
                    rationale: '"Грязный" L3, НЕ на сетевой NUMA',
                    instance: instName,
                });
            }

            // 3.2 UDP
            const udpCore = getAnyCore();
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

            // 3.3 AR + RF + Formula (NOT on trash, NOT on net NUMA)
            const arCore = getAnyCore();
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

            // 3.4 IRQ on NET NUMA (1 per 4 gateways)
            const gwCoresCurrent = instRoles['gateway'] || [];
            const gwCount = gwCoresCurrent.length;
            const irqNeeded = Math.max(1, Math.ceil(gwCount / 4));

            for (let i = 0; i < irqNeeded; i++) {
                const c = getNetCore();
                if (c !== null) {
                    budget.irq.push(c);
                    assignRole(c, 'net_irq');
                }
            }

            if (budget.irq.length > 0) {
                recs.push({
                    title: '[IRQ]',
                    cores: budget.irq,
                    description: `${budget.irq.length} ядер (${gwCount} gw / 4) NUMA ${netNuma}`,
                    role: 'net_irq',
                    rationale: 'На сетевой NUMA!',
                    instance: instName,
                });
            }

            // 3.5 Gateways on NET NUMA (calc × 2 for first optimization)
            const gwLoad = getTotalLoad(gwCoresCurrent);
            const gwCalc = gwLoad > 5 ? Math.max(1, Math.ceil(gwLoad / 30)) : gwCount;
            const gwNeeded = Math.max(gwCalc * 2, gwCount - 1); // × 2 buffer!

            for (let i = 0; i < gwNeeded; i++) {
                let c = getNetCore();
                if (c === null) c = getAnyCore(); // fallback if net NUMA exhausted
                if (c !== null) {
                    budget.gateways.push(c);
                    assignRole(c, 'gateway');
                }
            }

            if (budget.gateways.length > 0) {
                const gwLoadPerCore = budget.gateways.length > 0 ? gwLoad / budget.gateways.length : 0;
                const onNetNuma = budget.gateways.filter(c => getCoreNuma(c) === netNuma).length;
                recs.push({
                    title: '[GATEWAYS]',
                    cores: budget.gateways,
                    description: `${budget.gateways.length} ядер (${gwLoad.toFixed(0)}% → ${gwLoadPerCore.toFixed(0)}%/core)`,
                    role: 'gateway',
                    rationale: `calc×2, ${onNetNuma}/${budget.gateways.length} на NUMA ${netNuma}`,
                    warning: budget.gateways.length < gwNeeded ? `Нужно ${gwNeeded}!` : null,
                    instance: instName,
                });
            }

            // 3.6 Robots (remaining cores)
            const robotCoresCurrent = instRoles['robot_default'] || [];
            const robotLoad = getTotalLoad(robotCoresCurrent);

            let c = getAnyCore();
            while (c !== null) {
                budget.robots.push(c);
                assignRole(c, 'robot_default');
                c = getAnyCore();
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

            instanceBudgets.push(budget);
        }

        // === Step 4: Fill remaining ===
        const remaining = allCores.filter(c => !isAssigned(c));
        if (remaining.length > 0) {
            remaining.forEach(c => assignRole(c, 'robot_default'));
            recs.push({
                title: '[EXTRA → ROBOTS]',
                cores: remaining,
                description: `${remaining.length} ядер`,
                role: 'robot_default',
                rationale: 'Все ядра заняты',
                instance: 'Extra',
            });
        }

        setRecommendations(recs);

        const summaryParts = instanceBudgets.map(b => {
            const total = (b.trash ? 1 : 0) + (b.udp ? 1 : 0) + (b.ar ? 1 : 0) +
                b.irq.length + b.gateways.length + b.robots.length;
            return `${b.name}:${total}`;
        });

        setResult(`${detectedInstances.length} instance(s) | ${summaryParts.join(', ')} | OS:${assignedOsCores.length} | netNUMA:${netNuma} | ${assignedCores.size}/${totalCores}`);
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
        setInstances({ Physical: proposed });
        setResult('Applied! Check topology map.');
    };

    // Group by instance
    const groupedRecs: Record<string, Recommendation[]> = {};
    recommendations.forEach(rec => {
        if (!groupedRecs[rec.instance]) groupedRecs[rec.instance] = [];
        groupedRecs[rec.instance].push(rec);
    });

    const instanceOrder = Object.keys(groupedRecs).sort((a, b) => {
        if (a === 'OS') return -1;
        if (b === 'OS') return 1;
        if (a === 'Extra') return 1;
        if (b === 'Extra') return -1;
        return a.localeCompare(b);
    });

    return (
        <div className="optimize-container">
            <div className="optimize-header">
                <h2>[AUTO-OPTIMIZATION ENGINE v6]</h2>
                <p>Network NUMA placement + Gateway ×2 buffer</p>
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

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
    cores: Set<number>;
    trash: number | null;
    click: number | null;
    udp: number | null;
    ar: number | null;
    irq: number[];
    gateways: number[];
    robots: number[];
    formula: number | null;
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
    const [instanceOwnership, setInstanceOwnership] = useState<Record<string, Set<number>>>({});

    const generateOptimization = () => {
        if (Object.keys(geometry).length === 0) {
            setResult('No topology data. Load server data first.');
            return;
        }

        const coreLoads = useAppStore.getState().coreLoads;
        const isolatedSet = new Set(isolatedCores.map(String));
        const netNuma = netNumaNodes.length > 0 ? netNumaNodes[0] : 0;

        // Helpers
        const getTotalLoad = (cores: (string | number)[]): number => {
            if (!cores?.length) return 0;
            return cores.reduce((sum: number, c) => {
                const load = coreLoads[typeof c === 'string' ? parseInt(c) : c] || 0;
                return sum + load;
            }, 0);
        };

        const getCoreNuma = (core: number): number => coreNumaMap[String(core)] ?? 0;


        // Build cores
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
        const totalCores = allCores.length;

        // Detect instances
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
        const ownership: Record<string, Set<number>> = {};
        detectedInstances.forEach(inst => ownership[inst] = new Set());
        ownership['OS'] = new Set();

        const assignRole = (cpu: number, role: string, inst?: string) => {
            const cpuStr = String(cpu);
            if (!proposed[cpuStr]) proposed[cpuStr] = [];
            if (!proposed[cpuStr].includes(role)) proposed[cpuStr].push(role);
            assignedCores.add(cpu);
            if (inst && ownership[inst]) ownership[inst].add(cpu);
        };
        const isAssigned = (cpu: number) => assignedCores.has(cpu);

        // === Step 1: OS (0 to N consecutive) ===
        const currentOsCores = allCores.filter(c => !isolatedSet.has(String(c)));
        const osLoad = getTotalLoad(currentOsCores);
        let osNeeded = osLoad > 0
            ? Math.max(1, Math.ceil(osLoad / 30))
            : Math.max(1, Math.min(4, currentOsCores.length));

        const assignedOsCores = allCores.slice(0, osNeeded);
        assignedOsCores.forEach(c => {
            assignRole(c, 'sys_os', 'OS');
        });

        recs.push({
            title: '[OS]',
            cores: assignedOsCores,
            description: `${assignedOsCores.length} ядер (${osLoad.toFixed(0)}% → ${(osLoad / assignedOsCores.length).toFixed(0)}%/core)`,
            role: 'sys_os',
            rationale: `0-${osNeeded - 1}, target 30%`,
            instance: 'OS',
        });

        // ALL cores after OS position are isolated for services
        const isolatedForServices = allCores.filter(c => c >= osNeeded);
        const netNumaCores = isolatedForServices.filter(c => getCoreNuma(c) === netNuma);

        // Divide between instances
        const coresPerInstance = Math.floor(isolatedForServices.length / detectedInstances.length);
        const instancePools: Record<string, number[]> = {};
        const instanceNetPools: Record<string, number[]> = {};

        detectedInstances.forEach((instName, idx) => {
            const netStart = Math.floor(idx * netNumaCores.length / detectedInstances.length);
            const netEnd = Math.floor((idx + 1) * netNumaCores.length / detectedInstances.length);
            instanceNetPools[instName] = netNumaCores.slice(netStart, netEnd);

            const start = idx * coresPerInstance;
            const end = idx === detectedInstances.length - 1
                ? isolatedForServices.length
                : start + coresPerInstance;
            instancePools[instName] = [...instanceNetPools[instName], ...isolatedForServices.slice(start, end).filter(c => !instanceNetPools[instName].includes(c))];
        });

        const instanceBudgets: InstanceBudget[] = [];

        for (const instName of detectedInstances) {
            const instRoles = instanceCores[instName] || {};
            const netPool = [...instanceNetPools[instName]];
            const allPool = [...instancePools[instName]];

            let netIdx = 0;
            let allIdx = 0;

            const getNetCore = () => {
                while (netIdx < netPool.length && isAssigned(netPool[netIdx])) netIdx++;
                return netIdx < netPool.length ? netPool[netIdx++] : null;
            };

            const getAnyCore = () => {
                while (allIdx < allPool.length && isAssigned(allPool[allIdx])) allIdx++;
                return allIdx < allPool.length ? allPool[allIdx++] : null;
            };

            const budget: InstanceBudget = {
                name: instName,
                cores: new Set(),
                trash: null, click: null, udp: null, ar: null,
                irq: [], gateways: [], robots: [], formula: null,
            };

            const addToBudget = (c: number, role: string) => {
                budget.cores.add(c);
                assignRole(c, role, instName);
            };

            // Trash + ClickHouse
            let c = getAnyCore();
            if (c !== null) {
                budget.trash = c; budget.click = c;
                addToBudget(c, 'trash');
                addToBudget(c, 'click');
                recs.push({ title: '[TRASH+CLICK]', cores: [c], description: `Ядро ${c}`, role: 'trash', rationale: '"Грязный" L3', instance: instName });
            }

            // UDP
            c = getAnyCore();
            if (c !== null) {
                budget.udp = c;
                addToBudget(c, 'udp');
                recs.push({ title: '[UDP]', cores: [c], description: `Ядро ${c}`, role: 'udp', rationale: 'Обязательный', instance: instName });
            }

            // AR + RF + Formula
            c = getAnyCore();
            if (c !== null) {
                budget.ar = c; budget.formula = c;
                addToBudget(c, 'ar'); addToBudget(c, 'rf'); addToBudget(c, 'formula');
                recs.push({ title: '[AR+RF+FORMULA]', cores: [c], description: `Ядро ${c}`, role: 'ar', rationale: 'НЕ на Trash!', instance: instName });
            }

            // IRQ on net NUMA
            const gwCount = (instRoles['gateway'] || []).length;
            const irqNeeded = Math.max(1, Math.ceil(gwCount / 4));
            for (let i = 0; i < irqNeeded; i++) {
                c = getNetCore();
                if (c !== null) { budget.irq.push(c); addToBudget(c, 'net_irq'); }
            }
            if (budget.irq.length > 0) {
                recs.push({ title: '[IRQ]', cores: budget.irq, description: `${budget.irq.length} ядер (${gwCount} gw/4) NUMA ${netNuma}`, role: 'net_irq', rationale: 'Сетевая NUMA', instance: instName });
            }

            // Gateways on net NUMA (calc × 2)
            const gwLoad = getTotalLoad(instRoles['gateway'] || []);
            const gwCalc = gwLoad > 5 ? Math.max(1, Math.ceil(gwLoad / 30)) : gwCount;
            const gwNeeded = Math.max(gwCalc * 2, gwCount - 1);
            for (let i = 0; i < gwNeeded; i++) {
                c = getNetCore() ?? getAnyCore();
                if (c !== null) { budget.gateways.push(c); addToBudget(c, 'gateway'); }
            }
            if (budget.gateways.length > 0) {
                recs.push({ title: '[GATEWAYS]', cores: budget.gateways, description: `${budget.gateways.length} ядер (${gwLoad.toFixed(0)}% → ${(gwLoad / budget.gateways.length).toFixed(0)}%/core)`, role: 'gateway', rationale: `calc×2, сетевая NUMA`, instance: instName });
            }

            instanceBudgets.push(budget);
        }

        // === Step 4: Distribute remaining 70% robots / 30% gateways ===
        const remaining = allCores.filter(c => !isAssigned(c));
        if (remaining.length > 0) {
            const robotCount = Math.ceil(remaining.length * 0.7);


            const robotCores = remaining.slice(0, robotCount);
            const gwCores = remaining.slice(robotCount);

            // Distribute to instances round-robin
            robotCores.forEach((c, i) => {
                const inst = detectedInstances[i % detectedInstances.length];
                assignRole(c, 'robot_default', inst);
                instanceBudgets.find(b => b.name === inst)?.robots.push(c);
            });

            gwCores.forEach((c, i) => {
                const inst = detectedInstances[i % detectedInstances.length];
                assignRole(c, 'gateway', inst);
                instanceBudgets.find(b => b.name === inst)?.gateways.push(c);
            });

            for (const budget of instanceBudgets) {
                const instRobots = robotCores.filter((_, i) => detectedInstances[i % detectedInstances.length] === budget.name);
                const instGw = gwCores.filter((_, i) => detectedInstances[i % detectedInstances.length] === budget.name);

                if (instRobots.length > 0) {
                    recs.push({ title: '[ROBOTS+]', cores: instRobots, description: `+${instRobots.length} (70% доп)`, role: 'robot_default', rationale: 'Доп. мощность', instance: budget.name });
                }
                if (instGw.length > 0) {
                    recs.push({ title: '[GATEWAYS+]', cores: instGw, description: `+${instGw.length} (30% доп)`, role: 'gateway', rationale: 'Буфер', instance: budget.name });
                }
            }
        }

        // Update ownership for visualization
        setInstanceOwnership(ownership);
        setRecommendations(recs);

        const summaryParts = instanceBudgets.map(b => `${b.name}:${b.cores.size}`);
        setResult(`${detectedInstances.length} inst | ${summaryParts.join(', ')} | OS:${osNeeded} | ${assignedCores.size}/${totalCores}`);
    };

    const applyRecommendations = () => {
        const proposed: Record<string, string[]> = {};
        recommendations.forEach(rec => {
            rec.cores.forEach(c => {
                const cpuStr = String(c);
                if (!proposed[cpuStr]) proposed[cpuStr] = [];
                if (!proposed[cpuStr].includes(rec.role)) proposed[cpuStr].push(rec.role);
                if (rec.role === 'trash' && !proposed[cpuStr].includes('click')) proposed[cpuStr].push('click');
                if (rec.role === 'ar') {
                    if (!proposed[cpuStr].includes('rf')) proposed[cpuStr].push('rf');
                    if (!proposed[cpuStr].includes('formula')) proposed[cpuStr].push('formula');
                }
            });
        });
        setInstances({ Physical: proposed });
        setResult('Applied!');
    };

    // Group by instance
    const groupedRecs: Record<string, Recommendation[]> = {};
    recommendations.forEach(rec => {
        if (!groupedRecs[rec.instance]) groupedRecs[rec.instance] = [];
        groupedRecs[rec.instance].push(rec);
    });
    const instanceOrder = Object.keys(groupedRecs).sort((a, b) => a === 'OS' ? -1 : b === 'OS' ? 1 : a.localeCompare(b));

    // Per-instance topology rendering
    const renderInstanceTopology = (targetInstance: string) => {
        const ownedCores = instanceOwnership[targetInstance] || new Set();

        return (
            <div className="instance-topology">
                <h4 className="instance-topo-title">{targetInstance} Topology</h4>
                <div className="topology-grid compact">
                    {Object.entries(geometry).map(([socketId, numaData]) => (
                        <div key={socketId} className="socket-card compact">
                            {Object.entries(numaData).map(([numaId, l3Data]) => (
                                <div key={numaId} className="numa-section compact">
                                    <div className="numa-header">NUMA {numaId}</div>
                                    {Object.entries(l3Data).map(([l3Id, cores]) => (
                                        <div key={l3Id} className="l3-group compact">
                                            <div className="l3-label">L3:{l3Id}</div>
                                            <div className="cores-grid compact">
                                                {cores.map(cpuId => {
                                                    const roles = instances.Physical[String(cpuId)] || [];
                                                    const primaryRole = roles[0];
                                                    const roleColor = primaryRole ? ROLES[primaryRole]?.color || '#64748b' : '#1e293b';
                                                    const isOwned = ownedCores.has(cpuId);

                                                    return (
                                                        <div
                                                            key={cpuId}
                                                            className="core compact"
                                                            style={{
                                                                backgroundColor: roleColor,
                                                                opacity: isOwned ? 1 : 0.25,
                                                                border: isOwned ? '2px solid #fff' : '1px solid #333',
                                                            }}
                                                        >
                                                            {cpuId}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className="optimize-container">
            <div className="optimize-header">
                <h2>[AUTO-OPTIMIZATION ENGINE v7]</h2>
                <p>Per-instance topology + 70/30 robots/gw split</p>
            </div>

            <div className="optimize-actions">
                <button className="btn btn-primary btn-lg" onClick={generateOptimization}>GENERATE</button>
                {recommendations.length > 0 && <button className="btn btn-secondary" onClick={applyRecommendations}>APPLY</button>}
            </div>

            {result && <div className="optimize-result"><p>{result}</p></div>}

            {/* Per-Instance Topology Views */}
            {Object.keys(instanceOwnership).length > 0 && (
                <div className="instance-topologies">
                    {Object.keys(instanceOwnership).filter(i => i !== 'OS').map(inst => renderInstanceTopology(inst))}
                </div>
            )}

            {/* Recommendations by instance */}
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
                                    {rec.cores.length > 0 && (
                                        <div className="recommend-cores">
                                            {rec.cores.map(c => (
                                                <span key={c} className="recommend-core" style={{ backgroundColor: ROLES[rec.role]?.color || '#64748b' }}>{c}</span>
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

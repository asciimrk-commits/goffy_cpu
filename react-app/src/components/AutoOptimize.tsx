import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';

interface Recommendation {
    title: string;
    description: string;
    cores: string[];
    role: string;
    rationale?: string;
    warning?: string | null;
    instance: string;
}

interface Topology {
    byNuma: Record<string, string[]>;
    byL3: Record<string, string[]>;
    byNumaL3: Record<string, Record<string, string[]>>;
}

export function AutoOptimize() {
    const {
        geometry,
        isolatedCores,
        instances,
        netNumaNodes,
        coreNumaMap,
        l3Groups,
        coreLoads,
        setInstances,
    } = useAppStore();

    const [result, setResult] = useState<string | null>(null);
    const [recommendations, setRecommendations] = useState<Recommendation[]>([]);

    // Port of analyzeTopology from hft-rules.js
    const analyzeTopology = (): Topology => {
        const r: Topology = { byNuma: {}, byL3: {}, byNumaL3: {} };

        Object.entries(coreNumaMap).forEach(([cpu, numa]) => {
            const numaStr = String(numa);
            if (!r.byNuma[numaStr]) r.byNuma[numaStr] = [];
            r.byNuma[numaStr].push(cpu);
        });

        Object.entries(l3Groups).forEach(([l3, cores]) => {
            r.byL3[l3] = cores.map(String);
            const numa = coreNumaMap[String(cores[0])];
            const numaStr = String(numa);
            if (!r.byNumaL3[numaStr]) r.byNumaL3[numaStr] = {};
            r.byNumaL3[numaStr][l3] = cores.map(String);
        });

        Object.values(r.byNuma).forEach(c => c.sort((a, b) => parseInt(a) - parseInt(b)));
        return r;
    };

    const generateOptimization = () => {
        if (Object.keys(geometry).length === 0) {
            setResult('No topology data. Load server data first.');
            return;
        }

        const totalCores = Object.keys(coreNumaMap).length;
        const netNuma = String(netNumaNodes.length > 0 ? netNumaNodes[0] : 0);
        const isolatedSet = new Set(isolatedCores.map(String));
        const topology = analyzeTopology();

        // Current roles from instances
        const currentRoles: Record<string, string[]> = {};
        Object.entries(instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!currentRoles[t]) currentRoles[t] = [];
                currentRoles[t].push(cpu);
            });
        });

        // Helpers
        const getLoad = (cores: string[]) => {
            if (!cores?.length) return 0;
            return cores.reduce((s, c) => s + (coreLoads[parseInt(c)] || 0), 0) / cores.length;
        };
        const getTotalLoad = (cores: string[]) => {
            if (!cores?.length) return 0;
            return cores.reduce((s, c) => s + (coreLoads[parseInt(c)] || 0), 0);
        };
        const calcNeeded = (cores: string[], target = 25) => {
            const t = getTotalLoad(cores);
            return t === 0 ? (cores?.length || 1) : Math.max(1, Math.ceil(t / target));
        };

        const proposed: Record<string, string[]> = {};
        const recs: Recommendation[] = [];

        const assignRole = (cpu: string, role: string) => {
            if (!proposed[cpu]) proposed[cpu] = [];
            if (!proposed[cpu].includes(role)) proposed[cpu].push(role);
        };
        const isAssigned = (cpu: string) => (proposed[cpu]?.length || 0) > 0;

        const netNumaCores = topology.byNuma[netNuma] || [];
        const netL3Pools = topology.byNumaL3[netNuma] || {};
        const netL3Keys = Object.keys(netL3Pools).sort((a, b) =>
            (parseInt(a.split('-').pop() || '0')) - (parseInt(b.split('-').pop() || '0'))
        );

        // === 1. OS ===
        let osCores = netNumaCores.filter(c => !isolatedSet.has(c));
        if (osCores.length === 0) {
            osCores = currentRoles['sys_os']?.length ? currentRoles['sys_os'] : netNumaCores.slice(0, 2);
        }

        const osLoad = getLoad(currentRoles['sys_os'] || osCores);
        let osNeeded = Math.max(2, Math.ceil(osLoad * (currentRoles['sys_os']?.length || osCores.length) / 25));
        osNeeded = Math.min(osNeeded, osCores.length || 4);

        const assignedOsCores = osCores.slice(0, osNeeded);
        assignedOsCores.forEach(cpu => assignRole(cpu, 'sys_os'));
        recs.push({ title: '🖥️ OS', cores: assignedOsCores, description: `${assignedOsCores.length} ядер`, role: 'sys_os', rationale: `~${osLoad.toFixed(0)}%`, instance: 'OS' });

        // Service L3 (where OS lives)
        let serviceL3: string | null = null;
        for (const l3 of netL3Keys) {
            if (netL3Pools[l3].some(c => assignedOsCores.includes(c))) {
                serviceL3 = l3;
                break;
            }
        }
        if (!serviceL3 && netL3Keys.length > 0) serviceL3 = netL3Keys[0];

        // Work L3 pools (for IRQ/GW/Robots)
        let workL3Keys = netL3Keys.filter(k => k !== serviceL3);
        if (workL3Keys.length === 0 && netL3Keys.length > 0) workL3Keys = [serviceL3!];

        // === 2. Service cores (Trash, UDP, AR) ===
        const getServiceCandidates = () => {
            let candidates = (netL3Pools[serviceL3!] || [])
                .filter(c => isolatedSet.has(c) && !isAssigned(c))
                .sort((a, b) => parseInt(a) - parseInt(b));
            if (candidates.length === 0) {
                for (const l3 of workL3Keys) {
                    candidates = candidates.concat(
                        (netL3Pools[l3] || []).filter(c => isolatedSet.has(c) && !isAssigned(c))
                    );
                }
            }
            return candidates;
        };

        const servicePool = getServiceCandidates();
        let svcIdx = 0;
        const getSvc = () => svcIdx < servicePool.length ? servicePool[svcIdx++] : null;

        const trashCore = getSvc();
        if (trashCore) {
            assignRole(trashCore, 'trash');
            assignRole(trashCore, 'rf');
            assignRole(trashCore, 'click');
            recs.push({ title: '🗑️ Trash+RF+Click', cores: [trashCore], description: `Ядро ${trashCore}`, role: 'trash', rationale: 'Сервисный L3', instance: 'Service' });
        }

        if ((currentRoles['udp']?.length || 0) > 0) {
            const c = getSvc();
            if (c) {
                assignRole(c, 'udp');
                recs.push({ title: '📡 UDP', cores: [c], description: `Ядро ${c}`, role: 'udp', rationale: 'Макс 1', instance: 'Service' });
            }
        }

        const arCore = getSvc();
        if (arCore) {
            assignRole(arCore, 'ar');
            assignRole(arCore, 'formula');
            recs.push({ title: '🔄 AR+Formula', cores: [arCore], description: `Ядро ${arCore}`, role: 'ar', rationale: 'НЕ на Trash!', instance: 'Service' });
        }

        // === 3. IRQ + Gateways ===
        const neededIrq = Math.max(2, currentRoles['net_irq']?.length || 2);
        const neededGw = Math.ceil(calcNeeded(currentRoles['gateway']) * 1.2);
        const gwLoad = getLoad(currentRoles['gateway']);

        // Build work pool per L3
        const workPool: Record<string, string[]> = {};
        workL3Keys.forEach(l3 => {
            workPool[l3] = (netL3Pools[l3] || [])
                .filter(c => isolatedSet.has(c) && !isAssigned(c))
                .sort((a, b) => parseInt(a) - parseInt(b));
        });

        // IRQ: distribute across L3 pools
        const irqCores: string[] = [];
        const irqPerL3: Record<string, string[]> = {};
        let irqN = neededIrq, l3i = 0;
        while (irqN > 0 && l3i < neededIrq * workL3Keys.length) {
            const l3 = workL3Keys[l3i % workL3Keys.length];
            if (workPool[l3]?.length > 0) {
                const c = workPool[l3].shift()!;
                assignRole(c, 'net_irq');
                irqCores.push(c);
                if (!irqPerL3[l3]) irqPerL3[l3] = [];
                irqPerL3[l3].push(c);
                irqN--;
            }
            l3i++;
        }
        if (irqCores.length > 0) {
            recs.push({
                title: '⚡ IRQ',
                cores: irqCores,
                description: `${irqCores.length} ядер`,
                role: 'net_irq',
                rationale: `L3: ${Object.entries(irqPerL3).map(([l, c]) => `${l}:${c.length}`).join(', ')}`,
                instance: 'Network'
            });
        }

        // Gateways: distribute across L3 pools
        const gwCores: string[] = [];
        const gwPerL3: Record<string, string[]> = {};
        let gwN = neededGw;
        l3i = 0;
        while (gwN > 0 && l3i < neededGw * workL3Keys.length) {
            const l3 = workL3Keys[l3i % workL3Keys.length];
            if (workPool[l3]?.length > 0) {
                const c = workPool[l3].shift()!;
                assignRole(c, 'gateway');
                gwCores.push(c);
                if (!gwPerL3[l3]) gwPerL3[l3] = [];
                gwPerL3[l3].push(c);
                gwN--;
            }
            l3i++;
        }
        if (gwCores.length > 0) {
            recs.push({
                title: '🚪 Gateways',
                cores: gwCores,
                description: `${gwCores.length} ядер (~${gwLoad.toFixed(0)}%)`,
                role: 'gateway',
                rationale: `×1.2 buffer`,
                warning: gwCores.length < neededGw ? `Нужно ${neededGw}!` : null,
                instance: 'Network'
            });
        }

        // === 4. Robots with tier system ===
        const MIN_ISO = 4;
        const isoRobots: string[] = [];
        workL3Keys.forEach(l3 => {
            (workPool[l3] || []).forEach(c => {
                if (!isAssigned(c)) isoRobots.push(c);
            });
        });

        if (isoRobots.length >= MIN_ISO) {
            isoRobots.forEach(c => assignRole(c, 'isolated_robots'));
            recs.push({
                title: '💎 Isolated Robots',
                cores: isoRobots,
                description: `${isoRobots.length} ядер`,
                role: 'isolated_robots',
                rationale: 'Tier 1 - ЛУЧШИЙ!',
                instance: 'Robots'
            });
        }

        // Robot pools from other NUMAs
        const pool1: string[] = [];
        const pool2: string[] = [];
        const defCores: string[] = [];
        const otherNumas = Object.keys(topology.byNuma).filter(n => n !== netNuma).sort();

        if (otherNumas.length >= 1) {
            const n1 = (topology.byNuma[otherNumas[0]] || []).filter(c => isolatedSet.has(c) && !isAssigned(c));
            if (isoRobots.length > 0 && isoRobots.length < MIN_ISO) {
                isoRobots.forEach(c => { assignRole(c, 'pool1'); pool1.push(c); });
            }
            n1.forEach(c => { assignRole(c, 'pool1'); pool1.push(c); });
            if (pool1.length > 0) {
                recs.push({
                    title: '🤖 Pool 1',
                    cores: pool1,
                    description: `NUMA ${otherNumas[0]}: ${pool1.length}`,
                    role: 'pool1',
                    rationale: 'Tier 2',
                    instance: 'Robots'
                });
            }
        }

        if (otherNumas.length >= 2) {
            const n2 = (topology.byNuma[otherNumas[1]] || []).filter(c => isolatedSet.has(c) && !isAssigned(c));
            n2.forEach(c => { assignRole(c, 'pool2'); pool2.push(c); });
            if (pool2.length > 0) {
                recs.push({
                    title: '🤖 Pool 2',
                    cores: pool2,
                    description: `NUMA ${otherNumas[1]}: ${pool2.length}`,
                    role: 'pool2',
                    rationale: 'Tier 3',
                    instance: 'Robots'
                });
            }
        }

        // Default pool for remaining
        Object.keys(topology.byNuma).forEach(numa => {
            (topology.byNuma[numa] || []).filter(c => isolatedSet.has(c) && !isAssigned(c)).forEach(c => {
                assignRole(c, 'robot_default');
                defCores.push(c);
            });
        });
        if (defCores.length > 0) {
            recs.push({
                title: '🤖 Default',
                cores: defCores,
                description: `${defCores.length} ядер`,
                role: 'robot_default',
                rationale: 'Tier 4',
                instance: 'Robots'
            });
        }

        const allRobots = [...(isoRobots.length >= MIN_ISO ? isoRobots : []), ...pool1, ...pool2, ...defCores];

        // 1:4 check
        const gwCount = gwCores.length;
        const robotCount = allRobots.length;
        const ratio = gwCount > 0 ? robotCount / gwCount : 0;

        setRecommendations(recs);
        setResult(`IRQ:${irqCores.length} | GW:${gwCores.length} | Robots:${allRobots.length} (1:${ratio.toFixed(1)}) | ${Object.keys(proposed).length}/${totalCores}`);
    };

    const applyRecommendations = () => {
        const proposed: Record<string, string[]> = {};
        recommendations.forEach(rec => {
            rec.cores.forEach(c => {
                if (!proposed[c]) proposed[c] = [];
                if (!proposed[c].includes(rec.role)) proposed[c].push(rec.role);
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
    const instanceOrder = ['OS', 'Service', 'Network', 'Robots'].filter(k => groupedRecs[k]);

    return (
        <div className="optimize-container">
            <div className="optimize-header">
                <h2>[AUTO-OPTIMIZATION ENGINE v8]</h2>
                <p>L3-based allocation from hft-rules.js</p>
            </div>

            <div className="optimize-actions">
                <button className="btn btn-primary btn-lg" onClick={generateOptimization}>GENERATE</button>
                {recommendations.length > 0 && <button className="btn btn-secondary" onClick={applyRecommendations}>APPLY</button>}
            </div>

            {result && <div className="optimize-result"><p>{result}</p></div>}

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

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
}

export function AutoOptimize() {
    const {
        geometry,
        isolatedCores,
        netNumaNodes,
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

        const netNuma = String(netNumaNodes[0] ?? 0);
        const isolatedSet = new Set(isolatedCores.map(String));

        // Analyze topology - collect cores by NUMA and L3
        const byNuma: Record<string, number[]> = {};
        const byNumaL3: Record<string, Record<string, number[]>> = {};

        Object.entries(geometry).forEach(([socketId, numaData]) => {
            Object.entries(numaData).forEach(([numaId, l3Data]) => {
                if (!byNuma[numaId]) byNuma[numaId] = [];
                if (!byNumaL3[numaId]) byNumaL3[numaId] = {};

                Object.entries(l3Data).forEach(([l3Id, cores]) => {
                    byNuma[numaId].push(...cores);
                    const l3Key = `${socketId}-${numaId}-${l3Id}`;
                    byNumaL3[numaId][l3Key] = cores;
                });
            });
        });

        // Current roles from existing config
        const currentRoles: Record<string, string[]> = {};
        Object.entries(instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!currentRoles[t]) currentRoles[t] = [];
                currentRoles[t].push(cpu);
            });
        });

        const proposed: Record<string, string[]> = {};
        const recs: Recommendation[] = [];

        const assignRole = (cpu: number | string, role: string) => {
            const cpuStr = String(cpu);
            if (!proposed[cpuStr]) proposed[cpuStr] = [];
            if (!proposed[cpuStr].includes(role)) proposed[cpuStr].push(role);
        };
        const isAssigned = (cpu: number | string) => (proposed[String(cpu)]?.length || 0) > 0;

        const netNumaCores = byNuma[netNuma] || [];
        const netL3Pools = byNumaL3[netNuma] || {};
        const netL3Keys = Object.keys(netL3Pools).sort();

        // === OS Cores ===
        let osCores = netNumaCores.filter(c => !isolatedSet.has(String(c)));
        if (osCores.length === 0) {
            osCores = currentRoles['sys_os']?.map(Number) || netNumaCores.slice(0, 2);
        }
        const osNeeded = Math.max(2, Math.min(osCores.length, 8));
        const assignedOsCores = osCores.slice(0, osNeeded);
        assignedOsCores.forEach(c => assignRole(c, 'sys_os'));
        recs.push({
            title: '🖥️ OS',
            cores: assignedOsCores,
            description: `${assignedOsCores.length} ядер`,
            role: 'sys_os',
            rationale: 'Системные процессы',
        });

        // Find service L3 (containing OS cores)
        let serviceL3: string | null = null;
        for (const l3 of netL3Keys) {
            if (netL3Pools[l3].some(c => assignedOsCores.includes(c))) {
                serviceL3 = l3;
                break;
            }
        }
        if (!serviceL3 && netL3Keys.length > 0) serviceL3 = netL3Keys[0];

        const workL3Keys = netL3Keys.filter(k => k !== serviceL3);
        if (workL3Keys.length === 0 && serviceL3) workL3Keys.push(serviceL3);

        // === Service cores pool ===
        const getServiceCandidates = (): number[] => {
            let candidates: number[] = [];
            if (serviceL3) {
                candidates = netL3Pools[serviceL3]
                    .filter(c => isolatedSet.has(String(c)) && !isAssigned(c))
                    .sort((a, b) => a - b);
            }
            if (candidates.length === 0) {
                for (const l3 of workL3Keys) {
                    const extra = netL3Pools[l3]
                        .filter(c => isolatedSet.has(String(c)) && !isAssigned(c))
                        .sort((a, b) => a - b);
                    candidates.push(...extra);
                }
            }
            return candidates;
        };

        const servicePool = getServiceCandidates();
        let svcIdx = 0;
        const getSvc = () => svcIdx < servicePool.length ? servicePool[svcIdx++] : null;

        // === Trash + RF + Click ===
        const trashCore = getSvc();
        if (trashCore !== null) {
            assignRole(trashCore, 'trash');
            assignRole(trashCore, 'rf');
            assignRole(trashCore, 'click');
            recs.push({
                title: '🗑️ Trash+RF+Click',
                cores: [trashCore],
                description: `Ядро ${trashCore}`,
                role: 'trash',
                rationale: 'Сервисный L3',
            });
        }

        // === UDP (if exists in current) ===
        if ((currentRoles['udp']?.length || 0) > 0) {
            const udpCore = getSvc();
            if (udpCore !== null) {
                assignRole(udpCore, 'udp');
                recs.push({
                    title: '📡 UDP',
                    cores: [udpCore],
                    description: `Ядро ${udpCore}`,
                    role: 'udp',
                    rationale: 'Макс 1',
                });
            }
        }

        // === AR + Formula ===
        const arCore = getSvc();
        if (arCore !== null) {
            assignRole(arCore, 'ar');
            assignRole(arCore, 'formula');
            recs.push({
                title: '🔄 AR+Formula',
                cores: [arCore],
                description: `Ядро ${arCore}`,
                role: 'ar',
                rationale: 'НЕ на Trash!',
            });
        }

        // === IRQ + Gateways (Mandatory!) ===
        const neededIrq = Math.max(2, currentRoles['net_irq']?.length || 2);
        const neededGw = Math.max(4, Math.ceil((currentRoles['gateway']?.length || 4) * 1.2));

        // Build work pool
        const workPool: Record<string, number[]> = {};
        workL3Keys.forEach(l3 => {
            workPool[l3] = (netL3Pools[l3] || [])
                .filter(c => isolatedSet.has(String(c)) && !isAssigned(c))
                .sort((a, b) => a - b);
        });

        // IRQ allocation
        const irqCores: number[] = [];
        let irqN = neededIrq, l3i = 0;
        while (irqN > 0 && l3i < neededIrq * workL3Keys.length) {
            const l3 = workL3Keys[l3i % workL3Keys.length];
            if (workPool[l3]?.length > 0) {
                const c = workPool[l3].shift()!;
                assignRole(c, 'net_irq');
                irqCores.push(c);
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
                rationale: 'Network interrupts',
            });
        }

        // Gateways allocation
        const gwCores: number[] = [];
        let gwN = neededGw;
        l3i = 0;
        while (gwN > 0 && l3i < neededGw * workL3Keys.length) {
            const l3 = workL3Keys[l3i % workL3Keys.length];
            if (workPool[l3]?.length > 0) {
                const c = workPool[l3].shift()!;
                assignRole(c, 'gateway');
                gwCores.push(c);
                gwN--;
            }
            l3i++;
        }
        if (gwCores.length > 0) {
            recs.push({
                title: '🚪 Gateways',
                cores: gwCores,
                description: `${gwCores.length} ядер`,
                role: 'gateway',
                rationale: 'Critical path',
                warning: gwCores.length < neededGw ? `Нужно ${neededGw}!` : null,
            });
        }

        // === Isolated Robots (remaining in net NUMA) ===
        const isoRobots: number[] = [];
        workL3Keys.forEach(l3 => {
            (workPool[l3] || []).forEach(c => {
                if (!isAssigned(c)) isoRobots.push(c);
            });
        });
        const MIN_ISO = 4;
        if (isoRobots.length >= MIN_ISO) {
            isoRobots.forEach(c => assignRole(c, 'isolated_robots'));
            recs.push({
                title: '💎 Isolated Robots',
                cores: isoRobots,
                description: `${isoRobots.length} ядер`,
                role: 'isolated_robots',
                rationale: 'ЛУЧШИЙ! Tier 1',
            });
        }

        // === Robot Pools (other NUMAs) ===
        const otherNumas = Object.keys(byNuma)
            .filter(n => n !== netNuma)
            .sort((a, b) => parseInt(a) - parseInt(b));

        const pool1: number[] = [];
        const pool2: number[] = [];

        if (otherNumas.length >= 1) {
            // If isolated robots < MIN_ISO, move to pool1
            if (isoRobots.length > 0 && isoRobots.length < MIN_ISO) {
                isoRobots.forEach(c => {
                    assignRole(c, 'pool1');
                    pool1.push(c);
                });
            }

            const n1cores = (byNuma[otherNumas[0]] || [])
                .filter(c => isolatedSet.has(String(c)) && !isAssigned(c));
            n1cores.forEach(c => {
                assignRole(c, 'pool1');
                pool1.push(c);
            });

            if (pool1.length > 0) {
                recs.push({
                    title: '🤖 Pool 1',
                    cores: pool1,
                    description: `NUMA ${otherNumas[0]}: ${pool1.length}`,
                    role: 'pool1',
                    rationale: 'Tier 2',
                });
            }
        }

        if (otherNumas.length >= 2) {
            const n2cores = (byNuma[otherNumas[1]] || [])
                .filter(c => isolatedSet.has(String(c)) && !isAssigned(c));
            n2cores.forEach(c => {
                assignRole(c, 'pool2');
                pool2.push(c);
            });

            if (pool2.length > 0) {
                recs.push({
                    title: '🤖 Pool 2',
                    cores: pool2,
                    description: `NUMA ${otherNumas[1]}: ${pool2.length}`,
                    role: 'pool2',
                    rationale: 'Tier 3',
                });
            }
        }

        // Default robots (remaining isolated cores not assigned)
        const defCores: number[] = [];
        Object.keys(byNuma).forEach(numa => {
            byNuma[numa].forEach(c => {
                if (isolatedSet.has(String(c)) && !isAssigned(c)) {
                    assignRole(c, 'robot_default');
                    defCores.push(c);
                }
            });
        });
        if (defCores.length > 0) {
            recs.push({
                title: '🤖 Default Robots',
                cores: defCores,
                description: `${defCores.length} ядер`,
                role: 'robot_default',
                rationale: 'Fallback',
            });
        }

        setRecommendations(recs);
        setResult(`Generated ${recs.length} recommendations`);
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
                // Special cases: trash also gets rf, click
                if (rec.role === 'trash') {
                    if (!proposed[cpuStr].includes('rf')) proposed[cpuStr].push('rf');
                    if (!proposed[cpuStr].includes('click')) proposed[cpuStr].push('click');
                }
                // ar also gets formula
                if (rec.role === 'ar') {
                    if (!proposed[cpuStr].includes('formula')) proposed[cpuStr].push('formula');
                }
            });
        });
        setInstances({ Physical: proposed });
        setResult('Applied! Check topology map.');
    };

    return (
        <div className="optimize-container">
            <div className="optimize-header">
                <h2>⚡ Auto-Optimization Engine</h2>
                <p>Generate optimized configuration based on BenderServer best practices</p>
            </div>

            <div className="optimize-actions">
                <button className="btn btn-primary btn-lg" onClick={generateOptimization}>
                    🔄 Generate Optimization
                </button>
                {recommendations.length > 0 && (
                    <button className="btn btn-secondary" onClick={applyRecommendations}>
                        ✅ Apply to Map
                    </button>
                )}
            </div>

            {result && (
                <div className="optimize-result">
                    <p>{result}</p>
                </div>
            )}

            {recommendations.length > 0 && (
                <div className="optimize-recommendations">
                    {recommendations.map((rec, idx) => (
                        <div key={idx} className={`recommend-card ${rec.warning ? 'warning' : ''}`}>
                            <h4>{rec.title}</h4>
                            <p>{rec.description}</p>
                            {rec.rationale && <p className="rationale">{rec.rationale}</p>}
                            {rec.warning && <p className="warning-text">⚠️ {rec.warning}</p>}
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
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

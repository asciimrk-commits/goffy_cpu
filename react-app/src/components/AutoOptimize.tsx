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
        const coreLoads = useAppStore.getState().coreLoads;

        // Helper: Get average load for cores
        const getAvgLoad = (cores: string[]): number => {
            if (!cores?.length) return 0;
            const total = cores.reduce((sum, c) => sum + (coreLoads[parseInt(c)] || 0), 0);
            return total / cores.length;
        };



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

        const totalCores = Object.keys(byNuma).reduce((sum, n) => sum + byNuma[n].length, 0);
        const proposed: Record<string, string[]> = {};
        const recs: Recommendation[] = [];

        const assignRole = (cpu: number | string, role: string) => {
            const cpuStr = String(cpu);
            if (!proposed[cpuStr]) proposed[cpuStr] = [];
            if (!proposed[cpuStr].includes(role)) proposed[cpuStr].push(role);
        };
        const isAssigned = (cpu: number | string) => (proposed[String(cpu)]?.length || 0) > 0;


        const netL3Pools = byNumaL3[netNuma] || {};
        const netL3Keys = Object.keys(netL3Pools).sort();

        // === OS Cores ===
        // KB: OS from 0 to N CONSECUTIVE, target ~20% load
        const allCoresSorted = Object.values(byNuma).flat().sort((a, b) => a - b);
        let osCores = allCoresSorted.filter(c => !isolatedSet.has(String(c)));

        if (osCores.length === 0) {
            // Fallback: use existing or first cores
            osCores = currentRoles['sys_os']?.map(Number) || allCoresSorted.slice(0, 2);
        }

        // Calculate OS needed based on 20% load target
        const osLoad = getAvgLoad(currentRoles['sys_os'] || osCores.map(String));
        const osCoreCount = currentRoles['sys_os']?.length || osCores.length;
        let osNeeded: number;

        if (osLoad > 0) {
            // Formula: current_cores * current_load% / target_20%
            osNeeded = Math.max(1, Math.ceil(osLoad * osCoreCount / 20));
        } else {
            // No load data: use conservative estimate
            if (totalCores >= 100) osNeeded = 4;
            else if (totalCores <= 12) osNeeded = 1;
            else osNeeded = 2;
        }
        osNeeded = Math.min(osNeeded, osCores.length);

        // Assign consecutive OS cores starting from 0
        const assignedOsCores = osCores.slice(0, osNeeded);
        assignedOsCores.forEach(c => assignRole(c, 'sys_os'));
        recs.push({
            title: '[OS]',
            cores: assignedOsCores,
            description: `${assignedOsCores.length} ядер (0-${assignedOsCores.length - 1})`,
            role: 'sys_os',
            rationale: `~${osLoad.toFixed(0)}% → 20% target`,
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

        // === Trash + ClickHouse (NOT AR!) ===
        // KB: Trash + RF + ClickHouse on 1 core, RF can also go to AR
        const trashCore = getSvc();
        if (trashCore !== null) {
            assignRole(trashCore, 'trash');
            assignRole(trashCore, 'click');
            // RF will be added to AR if available, else to trash later
            recs.push({
                title: '[TRASH+CLICK]',
                cores: [trashCore],
                description: `Ядро ${trashCore}`,
                role: 'trash',
                rationale: '"Грязный" L3',
            });
        }

        // === UDP Handler ===
        // KB: Separate core if >10k pps, else can share with trash
        const hasUdpInInput = (currentRoles['udp']?.length || 0) > 0;
        let udpCore: number | null = null;

        if (hasUdpInInput) {
            udpCore = getSvc();
            if (udpCore !== null) {
                assignRole(udpCore, 'udp');
                recs.push({
                    title: '[UDP]',
                    cores: [udpCore],
                    description: `Ядро ${udpCore}`,
                    role: 'udp',
                    rationale: 'Отдельное ядро',
                });
            }
        } else if (trashCore !== null) {
            // Low traffic: share with trash
            assignRole(trashCore, 'udp');
        }

        // === AR + RF + Formula (NEVER with Trash!) ===
        // KB: AR must not be with Trash! RF can be with AR or Trash
        const arCore = getSvc();
        if (arCore !== null) {
            assignRole(arCore, 'ar');
            assignRole(arCore, 'rf');  // RF prefers AR
            assignRole(arCore, 'formula');
            recs.push({
                title: '[AR+RF+FORMULA]',
                cores: [arCore],
                description: `Ядро ${arCore}`,
                role: 'ar',
                rationale: 'НЕ на Trash!',
            });
        } else if (trashCore !== null) {
            // Fallback: RF on trash if no AR core
            assignRole(trashCore, 'rf');
        }

        // === IRQ ===
        // KB: 1 IRQ per 4 gateways, min 1, max 6
        const gwCount = currentRoles['gateway']?.length || 1;
        const neededIrq = Math.min(6, Math.max(1, Math.ceil(gwCount / 4)));

        // === Gateways ===
        // KB: Target ~20% load
        const gwLoad = getAvgLoad(currentRoles['gateway']);
        const gwCoreCount = currentRoles['gateway']?.length || 1;
        const neededGw = gwLoad > 0
            ? Math.max(1, Math.ceil(gwLoad * gwCoreCount / 20))
            : Math.max(1, gwCoreCount);

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
                title: '[IRQ]',
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
                title: '[GATEWAYS]',
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
                title: '[ISO ROBOTS]',
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
                    title: '[POOL 1]',
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
                    title: '[POOL 2]',
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
                title: '[DEFAULT]',
                cores: defCores,
                description: `${defCores.length} ядер`,
                role: 'robot_default',
                rationale: 'Fallback',
            });
        }

        // Check for minimum robots
        const allRobotCores = [...isoRobots, ...pool1, ...pool2, ...defCores];
        if (allRobotCores.length === 0) {
            recs.push({
                title: '[WARNING]',
                cores: [],
                description: 'НЕТ РОБОТОВ!',
                role: 'robot_default',
                rationale: 'Trading не будет работать!',
                warning: 'Критично!',
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
                // Special case: trash gets click (NOT rf!)
                if (rec.role === 'trash') {
                    if (!proposed[cpuStr].includes('click')) proposed[cpuStr].push('click');
                }
                // ar gets rf + formula
                if (rec.role === 'ar') {
                    if (!proposed[cpuStr].includes('rf')) proposed[cpuStr].push('rf');
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
                <h2>[AUTO-OPTIMIZATION ENGINE]</h2>
                <p>Generate optimized configuration based on BenderServer best practices</p>
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

            {recommendations.length > 0 && (
                <div className="optimize-recommendations">
                    {recommendations.map((rec, idx) => (
                        <div key={idx} className={`recommend-card ${rec.warning ? 'warning' : ''}`}>
                            <h4>{rec.title}</h4>
                            <p>{rec.description}</p>
                            {rec.rationale && <p className="rationale">{rec.rationale}</p>}
                            {rec.warning && <p className="warning-text">[!] {rec.warning}</p>}
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

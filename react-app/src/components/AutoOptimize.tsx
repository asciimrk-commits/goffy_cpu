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

        // === Helper Functions ===
        const getTotalLoad = (cores: string[]): number => {
            if (!cores?.length) return 0;
            return cores.reduce((sum, c) => sum + (coreLoads[parseInt(c)] || 0), 0);
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

        // === Detect Instances from current config ===
        const detectedInstances: string[] = [];
        const instanceRoles: Record<string, Record<string, string[]>> = {};

        // Check for named instances (beyond Physical)
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

        // If no named instances, use Physical as single instance
        if (detectedInstances.length === 0) {
            detectedInstances.push('Physical');
            instanceRoles['Physical'] = {};
            Object.entries(instances.Physical || {}).forEach(([cpu, tags]) => {
                tags.forEach(t => {
                    if (!instanceRoles['Physical'][t]) instanceRoles['Physical'][t] = [];
                    instanceRoles['Physical'][t].push(cpu);
                });
            });
        }

        // Collect all roles from Physical for legacy support
        const currentRoles: Record<string, string[]> = {};
        Object.entries(instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!currentRoles[t]) currentRoles[t] = [];
                currentRoles[t].push(cpu);
            });
        });

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

        // === PHASE 1: OS Cores (Shared) ===
        // Formula: totalLoad / targetPerCore (25%)
        // Consecutive from 0
        const osCoresAvailable = allCoresSorted.filter(c => !isolatedSet.has(String(c)));
        const osLoad = getTotalLoad(currentRoles['sys_os'] || osCoresAvailable.map(String));
        let osNeeded = osLoad > 0
            ? Math.max(1, Math.ceil(osLoad / 25))
            : Math.max(1, Math.min(3, osCoresAvailable.length));

        osNeeded = Math.min(osNeeded, osCoresAvailable.length);

        const assignedOsCores = osCoresAvailable.slice(0, osNeeded);
        assignedOsCores.forEach(c => assignRole(c, 'sys_os'));

        const osLoadPerCore = assignedOsCores.length > 0 ? osLoad / assignedOsCores.length : 0;
        recs.push({
            title: '[OS] Shared',
            cores: assignedOsCores,
            description: `${assignedOsCores.length} ядер (${osLoad.toFixed(0)}% → ${osLoadPerCore.toFixed(0)}%/core)`,
            role: 'sys_os',
            rationale: 'От 0 последовательно, target 25%',
        });

        // === PHASE 2: IRQ (Shared) ===
        // Formula: 1 IRQ per 4 gateways across ALL instances
        let totalGateways = 0;
        detectedInstances.forEach(inst => {
            totalGateways += (instanceRoles[inst]?.['gateway']?.length || 0);
        });
        if (totalGateways === 0) totalGateways = currentRoles['gateway']?.length || 1;

        const neededIrq = Math.min(6, Math.max(1, Math.ceil(totalGateways / 4)));

        const netNumaCores = byNuma[netNuma] || [];
        const irqCandidates = netNumaCores
            .filter(c => isolatedSet.has(String(c)) && !isAssigned(c))
            .sort((a, b) => a - b);

        const irqCores: number[] = [];
        for (let i = 0; i < neededIrq && i < irqCandidates.length; i++) {
            const c = irqCandidates[i];
            assignRole(c, 'net_irq');
            irqCores.push(c);
        }

        if (irqCores.length > 0) {
            recs.push({
                title: '[IRQ] Shared',
                cores: irqCores,
                description: `${irqCores.length} ядер (${totalGateways} gw total)`,
                role: 'net_irq',
                rationale: '1 IRQ / 4 gateways',
            });
        }

        // === PHASE 3: Partition Cores Between Instances ===
        // First, divide available cores equally between instances
        const availableForInstances = allCoresSorted
            .filter(c => isolatedSet.has(String(c)) && !isAssigned(c))
            .sort((a, b) => a - b);

        const coresPerInstance = Math.floor(availableForInstances.length / detectedInstances.length);
        const instanceCorePool: Record<string, number[]> = {};

        detectedInstances.forEach((instName, idx) => {
            const startIdx = idx * coresPerInstance;
            const endIdx = idx === detectedInstances.length - 1
                ? availableForInstances.length  // Last instance gets remaining
                : startIdx + coresPerInstance;
            instanceCorePool[instName] = availableForInstances.slice(startIdx, endIdx);
        });

        // === PHASE 4: Per-Instance Allocation ===
        for (const instName of detectedInstances) {
            const instRoles = instanceRoles[instName] || currentRoles;
            const instCandidates = [...instanceCorePool[instName]];

            let instIdx = 0;
            const getInstCore = () => {
                while (instIdx < instCandidates.length) {
                    const c = instCandidates[instIdx++];
                    if (!isAssigned(c)) return c;
                }
                return null;
            };

            // 3.1 Trash + ClickHouse
            const trashCore = getInstCore();
            if (trashCore !== null) {
                assignRole(trashCore, 'trash');
                assignRole(trashCore, 'click');
                recs.push({
                    title: `[TRASH+CLICK] ${instName}`,
                    cores: [trashCore],
                    description: `Ядро ${trashCore}`,
                    role: 'trash',
                    rationale: '"Грязный" L3',
                    instance: instName,
                });
            }

            // 3.2 UDP (mandatory)
            const udpCore = getInstCore();
            if (udpCore !== null) {
                assignRole(udpCore, 'udp');
                recs.push({
                    title: `[UDP] ${instName}`,
                    cores: [udpCore],
                    description: `Ядро ${udpCore}`,
                    role: 'udp',
                    rationale: 'Обязательный',
                    instance: instName,
                });
            }

            // 3.3 AR + RF + Formula (NOT on trash!)
            const arCore = getInstCore();
            if (arCore !== null) {
                assignRole(arCore, 'ar');
                assignRole(arCore, 'rf');
                assignRole(arCore, 'formula');
                recs.push({
                    title: `[AR+RF+FORMULA] ${instName}`,
                    cores: [arCore],
                    description: `Ядро ${arCore}`,
                    role: 'ar',
                    rationale: 'НЕ на Trash!',
                    instance: instName,
                });
            }

            // 3.4 Gateways (load-based, target 25%)
            const gwLoad = getTotalLoad(instRoles['gateway'] || []);
            const gwCount = instRoles['gateway']?.length || 1;
            const neededGw = gwLoad > 0
                ? Math.max(1, Math.ceil(gwLoad / 25))
                : gwCount;

            const gwCores: number[] = [];
            for (let i = 0; i < neededGw; i++) {
                const c = getInstCore();
                if (c !== null) {
                    assignRole(c, 'gateway');
                    gwCores.push(c);
                }
            }

            if (gwCores.length > 0) {
                const newLoad = gwCores.length > 0 ? gwLoad / gwCores.length : 0;
                recs.push({
                    title: `[GATEWAYS] ${instName}`,
                    cores: gwCores,
                    description: `${gwCores.length} ядер (${gwLoad.toFixed(0)}% → ${newLoad.toFixed(0)}%/core)`,
                    role: 'gateway',
                    rationale: 'Target 25%',
                    warning: gwCores.length < neededGw ? `Нужно ${neededGw}!` : null,
                    instance: instName,
                });
            }

            // 3.5 Robots = ALL remaining instance cores
            const robotCores: number[] = [];
            let c = getInstCore();
            while (c !== null) {
                assignRole(c, 'robot_default');
                robotCores.push(c);
                c = getInstCore();
            }

            if (robotCores.length > 0) {
                const robotLoad = getTotalLoad(instRoles['robot_default'] || []);
                const robotLoadPerCore = robotCores.length > 0 ? robotLoad / robotCores.length : 0;
                recs.push({
                    title: `[ROBOTS] ${instName}`,
                    cores: robotCores,
                    description: `${robotCores.length} ядер`,
                    role: 'robot_default',
                    rationale: robotLoad > 0 ? `~${robotLoadPerCore.toFixed(0)}%/core` : 'Оставшиеся',
                    instance: instName,
                });
            } else {
                recs.push({
                    title: `[WARNING] ${instName}`,
                    cores: [],
                    description: 'НЕТ РОБОТОВ!',
                    role: 'robot_default',
                    rationale: 'Критично!',
                    warning: 'Trading не будет работать!',
                    instance: instName,
                });
            }
        }

        // === PHASE 5: Fill All Remaining Cores ===
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

        // Isolated remaining → Robots
        const remainingIsolated = allCoresSorted.filter(c =>
            isolatedSet.has(String(c)) && !isAssigned(c)
        );
        if (remainingIsolated.length > 0) {
            remainingIsolated.forEach(c => assignRole(c, 'robot_default'));
            recs.push({
                title: '[REMAINING] → Robots',
                cores: remainingIsolated,
                description: `${remainingIsolated.length} ядер`,
                role: 'robot_default',
                rationale: 'Нет пустых ядер',
            });
        }

        // === Summary ===
        const assignedCount = assignedCores.size;

        setRecommendations(recs);
        setResult(`${detectedInstances.length} instance(s): ${detectedInstances.join(', ')} | ${assignedCount}/${totalCores} cores`);
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
                // Special case: trash gets click
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
            )}
        </div>
    );
}

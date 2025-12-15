import { useState } from 'react';
import { useAppStore } from '../store/appStore';


interface Recommendation {
    title: string;
    description: string;
    cores: string[];
    role: string;
    rationale?: string;
    warning?: string | null;
    instance: string;
}

interface InstanceDemand {
    name: string;
    gateways: number;
    robots: number;
    irq: number;
    trash: boolean;
    udp: boolean;
    ar: boolean;
    rf: boolean;
    formula: boolean;
    gwLoad: number;
    robotLoad: number;
}

// Instance Color Palette
const INSTANCE_COLORS: Record<string, string> = {
    'OS': '#64748b', // Slate
    'Physical': '#64748b',
};
const PREDEFINED_COLORS = [
    '#3b82f6', // Blue (HUB7?)
    '#8b5cf6', // Violet
    '#10b981', // Emerald
    '#f59e0b', // Amber
    '#ec4899', // Pink
    '#06b6d4', // Cyan
];

export function AutoOptimize() {
    const {
        geometry,
        isolatedCores,
        instances,
        netNumaNodes,
        coreNumaMap,
        coreLoads,
        setInstances,
    } = useAppStore();

    const [result, setResult] = useState<string | null>(null);
    const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
    const [instanceOwnership, setInstanceOwnership] = useState<Record<string, Set<number>>>({});
    const [instColors, setInstColors] = useState<Record<string, string>>(INSTANCE_COLORS);
    const [proposedAllocation, setProposedAllocation] = useState<Record<string, Record<string, string[]>> | null>(null);
    const [hoveredInstance, setHoveredInstance] = useState<string | null>(null);

    const generateOptimization = () => {
        if (Object.keys(geometry).length === 0) {
            setResult('No topology data. Load server data first.');
            return;
        }

        const netNuma = String(netNumaNodes.length > 0 ? netNumaNodes[0] : 0);
        const isolatedSet = new Set(isolatedCores.map(String));

        // === Helpers ===
        const getTotalLoad = (cores: string[]) => {
            if (!cores?.length) return 0;
            return cores.reduce((s, c) => s + (coreLoads[parseInt(c)] || 0), 0);
        };
        const calcNeeded = (totalLoad: number, target = 25) => {
            return totalLoad === 0 ? 0 : Math.max(1, Math.ceil(totalLoad / target));
        };

        const proposed: Record<string, string[]> = {};
        const recs: Recommendation[] = [];
        const ownership: Record<string, Set<number>> = {};
        const newInstColors = { ...INSTANCE_COLORS };
        const proposedByInstance: Record<string, Record<string, string[]>> = {};

        const assignRole = (cpu: string, role: string, inst: string) => {
            if (!proposed[cpu]) proposed[cpu] = [];
            if (!proposed[cpu].includes(role)) proposed[cpu].push(role);

            if (!ownership[inst]) ownership[inst] = new Set();
            ownership[inst].add(parseInt(cpu));

            if (!proposedByInstance[inst]) proposedByInstance[inst] = {};
            if (!proposedByInstance[inst][cpu]) proposedByInstance[inst][cpu] = [];
            if (!proposedByInstance[inst][cpu].includes(role)) proposedByInstance[inst][cpu].push(role);
        };
        const isAssigned = (cpu: string) => (proposed[cpu]?.length || 0) > 0;

        // === 1. Analyze Input & Calculate Demand ===
        // Detect instances
        const detectedInstances: string[] = [];
        const instanceData: Record<string, Record<string, string[]>> = {};

        const rawInstances = new Set<string>();
        Object.values(instances).forEach(() => {
            // If Physical has roles like "HUB7:..."
        });

        Object.keys(instances).forEach(k => {
            if (k !== 'Physical' && k !== 'OS') rawInstances.add(k);
        });

        detectedInstances.push(...Array.from(rawInstances).sort());

        // Calculate Demand
        calcNeeded(getTotalLoad(instances['OS'] ? Object.keys(instances['OS']) : []), 25);

        // Setup Instance Demands
        detectedInstances.forEach(() => {
            // ... (existing logic)
        });
        // Parse existing roles
        Object.entries(instances).forEach(([instName, cpuMap]) => {
            if (instName === 'Physical') return;
            if (Object.keys(cpuMap).length > 0) {
                detectedInstances.push(instName);
                instanceData[instName] = {};
                Object.entries(cpuMap).forEach(([cpu, roles]) => {
                    roles.forEach((r: string) => {
                        if (!instanceData[instName][r]) instanceData[instName][r] = [];
                        instanceData[instName][r].push(cpu);
                    });
                });
            }
        });
        // Fallback
        if (detectedInstances.length === 0) {
            detectedInstances.push('Physical');
            instanceData['Physical'] = {};
            Object.entries(instances.Physical || {}).forEach(([cpu, roles]) => {
                roles.forEach((r: string) => {
                    if (!instanceData['Physical'][r]) instanceData['Physical'][r] = [];
                    instanceData['Physical'][r].push(cpu);
                });
            });
        }

        // Assign colors
        detectedInstances.forEach((inst, idx) => {
            if (!newInstColors[inst]) {
                newInstColors[inst] = PREDEFINED_COLORS[idx % PREDEFINED_COLORS.length];
            }
        });

        const demands: InstanceDemand[] = [];

        detectedInstances.forEach(instName => {
            const data = instanceData[instName] || {};

            const hasAr = (data['ar'] || []).length > 0;
            const hasRf = (data['rf'] || []).length > 0;
            const hasFormula = (data['formula'] || []).length > 0;

            // Gateway Demand + BUFFER
            const gwLoad = getTotalLoad(data['gateway'] || []);
            const gwNeededCalc = calcNeeded(gwLoad, 25);
            const gwNeeded = gwNeededCalc + 2; // +2 Buffer as requested

            // Robot Demand
            const robotCores = [
                ...(data['isolated_robots'] || []),
                ...(data['pool1'] || []),
                ...(data['pool2'] || []),
                ...(data['robot_default'] || [])
            ];
            const robotLoad = getTotalLoad(robotCores);
            const robotNeeded = calcNeeded(robotLoad, 25);

            // IRQ Demand (1 per 4 Gateways)
            const irqNeeded = Math.ceil(gwNeeded / 4) || 1;

            demands.push({
                name: instName,
                gateways: gwNeeded,
                robots: robotNeeded,
                irq: irqNeeded,
                trash: true,
                udp: true,
                ar: hasAr || hasRf || hasFormula,
                rf: hasRf, // Track specific needs for co-location
                formula: hasFormula,
                gwLoad,
                robotLoad
            });
        });

        // OS Demand
        const sysOsCoresInput = detectedInstances.length === 1 && detectedInstances[0] === 'Physical'
            ? (instanceData['Physical']['sys_os'] || [])
            : [];
        let osLoad = getTotalLoad(sysOsCoresInput);
        if (osLoad === 0) {
            const nonIsoCores = Object.keys(coreNumaMap).filter(c => !isolatedSet.has(c));
            osLoad = getTotalLoad(nonIsoCores);
        }
        let osNeeded = calcNeeded(osLoad, 25);
        osNeeded = Math.min(osNeeded, 4);
        if (osNeeded < 1) osNeeded = 1;

        // === 2. Topology Analysis ===
        const coresByNuma: Record<string, string[]> = {};
        Object.entries(coreNumaMap).forEach(([c, n]) => {
            const ns = String(n);
            if (!coresByNuma[ns]) coresByNuma[ns] = [];
            coresByNuma[ns].push(c);
        });
        Object.values(coresByNuma).forEach(list => list.sort((a, b) => parseInt(a) - parseInt(b)));

        // === 3. Allocation ===

        // A. OS Allocation (Priority 1 -> Net NUMA preferred)
        const allCoresSorted = Object.keys(coreNumaMap).sort((a, b) => parseInt(a) - parseInt(b));
        // Try to take un-isolated first?
        // Actually typical OS is 0-N
        const osCandidates = allCoresSorted.slice(0, osNeeded);

        osCandidates.forEach(c => assignRole(c, 'sys_os', 'OS'));
        recs.push({
            title: 'OS',
            cores: osCandidates,
            description: `${osCandidates.length} cores`,
            role: 'sys_os',
            rationale: `Target 25% load`,
            instance: 'OS'
        });

        const availableParams = allCoresSorted.filter(c => !isAssigned(c));

        let netPool = availableParams.filter(c => String(coreNumaMap[c]) === netNuma);
        let otherPool = availableParams.filter(c => String(coreNumaMap[c]) !== netNuma);

        const popNet = (cnt: number): string[] => {
            const res: string[] = [];
            for (let i = 0; i < cnt; i++) {
                if (netPool.length > 0) res.push(netPool.shift()!);
                else if (otherPool.length > 0) res.push(otherPool.shift()!);
            }
            return res;
        };

        // B. Per-Instance Allocation
        // Priority: Net Services > Trash/AR (Net) > Robots (Other)

        // 1. Network Services (Net NUMA)
        demands.forEach(d => {
            // IRQ
            const irqCores = popNet(d.irq);
            irqCores.forEach(c => assignRole(c, 'net_irq', d.name));
            recs.push({
                title: 'IRQ',
                cores: irqCores,
                description: `${irqCores.length} ядер`,
                role: 'net_irq',
                rationale: `Mandatory (1:4 GW)`,
                instance: d.name
            });

            // Gateways
            const gwCores = popNet(d.gateways);
            gwCores.forEach(c => assignRole(c, 'gateway', d.name));
            recs.push({
                title: 'Gateways',
                cores: gwCores,
                description: `${gwCores.length} ядер`,
                role: 'gateway',
                rationale: `Calculated + 2 Buffer`,
                instance: d.name
            });

            // UDP (Mandatory)
            const udpCores = popNet(1);
            udpCores.forEach(c => assignRole(c, 'udp', d.name));
            recs.push({
                title: 'UDP',
                cores: udpCores,
                description: '1 ядро',
                role: 'udp',
                rationale: 'Mandatory',
                instance: d.name
            });

            // Trash (Moved to Net NUMA as requested)
            const trashCores = popNet(1); // Was popOther
            trashCores.forEach(c => {
                assignRole(c, 'trash', d.name);
                // RF & ClickHouse on Trash
                if (d.rf) assignRole(c, 'rf', d.name); // RF maps to Trash now? "RF and clickhouse on trash"
                assignRole(c, 'click', d.name);
            });
            recs.push({
                title: 'Trash+RF+Click',
                cores: trashCores,
                description: '1 ядро',
                role: 'trash',
                rationale: 'Mandatory (Net NUMA)',
                instance: d.name
            });

            // AR (Moved to Net NUMA)
            if (d.ar) {
                const arCores = popNet(1); // Was popOther
                arCores.forEach(c => {
                    assignRole(c, 'ar', d.name);
                    // Formula on AR
                    if (d.formula) assignRole(c, 'formula', d.name);
                });
                recs.push({
                    title: 'AR+Formula',
                    cores: arCores,
                    description: '1 ядро',
                    role: 'ar',
                    rationale: 'Mandatory (Net NUMA)',
                    instance: d.name
                });
            }
        });

        // 3. Robots (Compute) -> Rest (Other Preferred)
        const allRemaining = [...netPool, ...otherPool]; // Actually netPool might be depleted, but check order
        // We really want to prefer popOther if available.
        // Let's rebuild the consolidated pool properly:
        // Use popOther preferentially for Robots, then spill to Net.

        demands.forEach(d => {
            const count = d.robots;
            // We need 'count' cores. Prefer OtherPool.
            const taken: string[] = [];
            for (let i = 0; i < count; i++) {
                if (otherPool.length > 0) taken.push(otherPool.shift()!);
                else if (netPool.length > 0) taken.push(netPool.shift()!); // Fill net if valid
                else if (allRemaining.length > 0) {
                    // Safety check
                }
            }

            if (taken.length > 0) {
                taken.forEach(c => assignRole(c, 'robot_default', d.name));
                recs.push({
                    title: 'Robots',
                    cores: taken,
                    description: `${taken.length} cores`,
                    role: 'robot_default',
                    rationale: `Target 25%`,
                    instance: d.name
                });
            }
        });

        // Fill leftovers
        let leftoverCount = netPool.length + otherPool.length;
        if (leftoverCount > 0 && demands.length > 0) {
            const leftovers = [...otherPool, ...netPool]; // Prefer other
            let dIdx = 0;
            while (leftovers.length > 0) {
                const c = leftovers.shift()!;
                const d = demands[dIdx % demands.length];
                assignRole(c, 'robot_default', d.name);
                dIdx++;
            }
        }

        setInstColors(newInstColors);
        setInstanceOwnership(ownership);
        setRecommendations(recs);
        setProposedAllocation(proposedByInstance);
        setResult(`Optimization Complete. Net NUMA: ${netNuma}`);
    };

    const applyRecommendations = () => {
        if (!proposedAllocation) return;
        const config: any = { ...proposedAllocation };
        if (!config.Physical) config.Physical = {};
        setInstances(config);
        setResult('Applied!');
    };

    // === RENDER ===
    const renderUnifiedMap = () => {
        return (
            <div className="topology-grid" style={{ overflow: 'auto' }}>
                {Object.entries(geometry).map(([socketId, numaData]) => (
                    <div key={socketId} className="socket-card">
                        <div className="socket-header">Socket {socketId}</div>
                        {Object.entries(numaData).map(([numaId, l3Data]) => {
                            const isNet = netNumaNodes.includes(parseInt(numaId));
                            return (
                                <div key={numaId} className="numa-section" style={{
                                    borderColor: isNet ? 'var(--color-success)' : 'var(--border-color)',
                                    backgroundColor: isNet ? 'rgba(16, 185, 129, 0.05)' : 'transparent'
                                }}>
                                    <div className="numa-header" style={{ color: isNet ? 'var(--color-success)' : 'var(--text-secondary)' }}>
                                        NUMA {numaId} {isNet && '[NET]'}
                                    </div>
                                    <div className="cmp-cores">
                                        {Object.entries(l3Data).flatMap(([, cores]) => cores).map(cpuId => {
                                            // Find Owner
                                            let owner = 'Free';
                                            let color = '#334155'; // default

                                            for (const [inst, set] of Object.entries(instanceOwnership)) {
                                                if (set.has(cpuId)) {
                                                    owner = inst;
                                                    color = instColors[inst] || '#64748b';
                                                    break;
                                                }
                                            }

                                            // Opacity Logic
                                            // If hover:
                                            //   Highlight hovered instance + OS
                                            //   Fade everything else
                                            let opacity = 1;
                                            if (hoveredInstance) {
                                                const isTarget = owner === hoveredInstance;
                                                const isOS = owner === 'OS';

                                                if (!isTarget && !isOS) {
                                                    opacity = 0.2;
                                                }
                                            }

                                            return (
                                                <div
                                                    key={cpuId}
                                                    className="core"
                                                    onMouseEnter={() => owner !== 'Free' && setHoveredInstance(owner)}
                                                    onMouseLeave={() => setHoveredInstance(null)}
                                                    title={`Core ${cpuId} | Assigned: ${owner}`}
                                                    style={{
                                                        backgroundColor: color,
                                                        opacity,
                                                        transition: 'opacity 0.2s',
                                                        color: '#fff',
                                                        cursor: owner !== 'Free' ? 'default' : 'not-allowed'
                                                    }}
                                                >
                                                    {cpuId}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        );
    };

    return (
        <div className="optimize-container">
            <div className="optimize-header" style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>[AUTO-OPTIMIZATION ENGINE]</h2>
                <div className="optimize-actions" style={{ display: 'flex', gap: '10px' }}>
                    <button className="btn btn-primary" onClick={generateOptimization}>GENERATE</button>
                    {recommendations.length > 0 && <button className="btn btn-secondary" onClick={applyRecommendations}>APPLY CONFIG</button>}
                </div>
            </div>

            {result && <div className="optimize-result" style={{ marginBottom: '20px', padding: '10px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>{result}</div>}

            {recommendations.length > 0 ? (
                renderUnifiedMap()
            ) : (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    Press GENERATE to calculate optimal placement
                </div>
            )}

            {/* Recommendations List (Bottom) */}
            {recommendations.length > 0 && (
                <div style={{ marginTop: '30px', borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
                    <h3>Allocation Details</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
                        {recommendations.map((rec, idx) => (
                            <div key={idx} className="recommend-card" style={{
                                borderLeft: `3px solid ${instColors[rec.instance] || '#ccc'}`,
                                background: 'var(--bg-panel)',
                                padding: '12px',
                                borderRadius: 'var(--radius-sm)',
                                boxShadow: 'var(--shadow-sm)'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                    <span style={{ fontWeight: 600, color: instColors[rec.instance] }}>{rec.instance}</span>
                                    <span style={{ fontSize: '0.8em', opacity: 0.7 }}>{rec.role}</span>
                                </div>
                                <div style={{ fontSize: '0.9em', marginBottom: '8px' }}>{rec.description}</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                    {rec.cores.map(c => (
                                        <span key={c} style={{ fontSize: '0.75em', padding: '2px 6px', background: 'var(--bg-input)', borderRadius: '4px' }}>{c}</span>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

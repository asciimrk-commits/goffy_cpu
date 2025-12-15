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

// Colors for detected instances
const PREDEFINED_COLORS = [
    '#3b82f6', // Blue
    '#8b5cf6', // Violet
    '#10b981', // Emerald
    '#f59e0b', // Amber
    '#ec4899', // Pink
    '#06b6d4', // Cyan
];

const SHARED_COLOR = '#64748b'; // Slate for OS/IRQ

export function AutoOptimize() {
    const {
        geometry,
        instances,
        netNumaNodes,
        coreNumaMap,
        coreLoads,
        setInstances,
    } = useAppStore();

    const [result, setResult] = useState<string | null>(null);
    const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
    const [instanceOwnership, setInstanceOwnership] = useState<Record<string, Set<number>>>({});
    const [instColors, setInstColors] = useState<Record<string, string>>({});
    const [proposedAllocation, setProposedAllocation] = useState<Record<string, Record<string, string[]>> | null>(null);
    const [hoveredInstance, setHoveredInstance] = useState<string | null>(null);

    const generateOptimization = () => {
        if (Object.keys(geometry).length === 0) {
            setResult('No topology data. Load server data first.');
            return;
        }

        const netNuma = String(netNumaNodes.length > 0 ? netNumaNodes[0] : 0);
        // const isoSet = new Set(isolatedCores.map(String)); // Unused for now
        const recs: Recommendation[] = [];

        // 1. Detect Instances
        const detectedInstances: string[] = [];
        Object.keys(instances).forEach(k => {
            if (k !== 'Physical' && k !== 'OS') detectedInstances.push(k);
        });
        if (detectedInstances.length === 0) detectedInstances.push('Total'); // Default if no instances
        detectedInstances.sort();

        // Assign Colors
        const mapColors: Record<string, string> = { 'OS': SHARED_COLOR, 'Shared': SHARED_COLOR };
        detectedInstances.forEach((inst, idx) => {
            mapColors[inst] = PREDEFINED_COLORS[idx % PREDEFINED_COLORS.length];
        });
        setInstColors(mapColors);

        // 2. Resource Pools (Global)
        const byNuma: Record<string, string[]> = {};
        Object.entries(coreNumaMap).forEach(([cpu, numa]) => {
            const n = String(numa);
            if (!byNuma[n]) byNuma[n] = [];
            byNuma[n].push(cpu);
        });
        Object.values(byNuma).forEach(c => c.sort((a, b) => parseInt(a) - parseInt(b)));

        // Net Pool (Preferred for OS, IRQ, Gateways, Flash, UDP)
        // Compute Pool (Preferred for Robots)
        // We track used cores to ensure segregation
        const usedCores = new Set<string>();

        const popCore = (pool: string[], count: number): string[] => {
            const res: string[] = [];
            // Try to find isolated/non-isolated based on preference
            // Logic: Sort pool by isolation match?
            // Actually user logic: "Isolated robots" might prefer isolated.
            // But strict "Net vs Other" is simpler.

            // Filter out used
            const available = pool.filter(c => !usedCores.has(c));

            for (let i = 0; i < count; i++) {
                if (available.length > 0) {
                    const c = available.shift()!;
                    res.push(c);
                    usedCores.add(c);
                }
            }
            return res;
        };

        const netPool = byNuma[netNuma] || [];
        const computePool: string[] = [];
        Object.keys(byNuma).forEach(n => {
            if (n !== netNuma) computePool.push(...byNuma[n]);
        });

        // Helper to get total load of a role across all instances
        const getLoad = (role: string, inst?: string) => {
            let cores: string[] = [];
            if (inst) {
                cores = instances[inst]?.[role] || [];
            } else {
                // Global search
                detectedInstances.forEach(i => {
                    const c = instances[i]?.[role] || [];
                    cores.push(...c);
                });
                // Also check Physical?
                if (instances.Physical?.[role]) cores.push(...instances.Physical[role]);
            }
            if (cores.length === 0) return 0;
            const total = cores.reduce((acc, c) => acc + (coreLoads[parseInt(c)] || 0), 0);
            return total;
        };

        const calcNeeded = (load: number, target = 25) => {
            if (load === 0) return 0; // If 0 load, maybe 1 core min?
            // Logic: "assess load ... target 20-30%"
            return Math.max(1, Math.ceil(load / target));
        };

        // --- SHARED RESOURCES (OS, IRQ) ---

        // OS
        const osLoad = getLoad('sys_os');
        // If current OS load is 0 (missing data), assume minimal safety (2 cores)
        const osNeeded = osLoad === 0 ? 2 : calcNeeded(osLoad, 25);
        const osCores = popCore(netPool, Math.min(osNeeded, 4)); // Cap at 4

        recs.push({
            title: 'Shared OS',
            instance: 'Global',
            role: 'sys_os',
            cores: osCores,
            description: `${osCores.length} cores`,
            rationale: `Load: ${osLoad.toFixed(0)}%`
        });

        // IRQ
        // Count TOTAL gateways across all instances to determine IRQ count
        let totalGateways = 0;
        detectedInstances.forEach(i => {
            totalGateways += (instances[i]?.['gateway']?.length || 0);
        });
        // Logic: 1-4 gw -> 1 irq. 5-8 -> 2.
        const irqNeeded = Math.ceil(Math.max(1, totalGateways) / 4);
        const irqCores = popCore(netPool, irqNeeded);

        recs.push({
            title: 'Shared IRQ',
            instance: 'Global',
            role: 'net_irq',
            cores: irqCores,
            description: `${irqCores.length} cores`,
            rationale: `Gateways: ${totalGateways}`
        });

        // Mark SHARED ownership
        const ownership: Record<string, Set<number>> = {};
        const proposedByInst: Record<string, Record<string, string[]>> = {};

        const register = (inst: string, role: string, cores: string[]) => {
            if (!proposedByInst[inst]) proposedByInst[inst] = {};
            cores.forEach(c => {
                if (!proposedByInst[inst][c]) proposedByInst[inst][c] = [];
                proposedByInst[inst][c].push(role);

                if (!ownership[inst]) ownership[inst] = new Set();
                ownership[inst].add(parseInt(c));
            });
        };

        // Register Shared
        // We register them to 'Global' or to ALL instances?
        // User: "used by N services simultaneously".
        // Let's register to ALL detected instances so they show up.
        detectedInstances.forEach(inst => {
            register(inst, 'sys_os', osCores);
            register(inst, 'net_irq', irqCores);
        });

        // --- SEGREGATED RESOURCES (Per Instance) ---

        detectedInstances.forEach(inst => {
            // Check existence in input
            const myRoles = instances[inst] || {};
            const hasRf = (myRoles['rf']?.length || 0) > 0;
            const hasClick = (myRoles['click']?.length || 0) > 0;
            // The user said: "Trash, AR-RF, UDP mandatory".

            // 1. Network Services (Net Pool)
            const trashCores = popCore(netPool, 1);
            register(inst, 'trash', trashCores);
            if (hasClick) register(inst, 'click', trashCores); // Co-locate?
            recs.push({ title: 'Trash', instance: inst, role: 'trash', cores: trashCores, description: '1 core' });

            const udpCores = popCore(netPool, 1);
            register(inst, 'udp', udpCores);
            recs.push({ title: 'UDP', instance: inst, role: 'udp', cores: udpCores, description: '1 core' });

            // AR/RF/Formula
            const arCores = popCore(netPool, 1); // 1 core for AR+RF
            register(inst, 'ar', arCores);
            if (hasRf) register(inst, 'rf', arCores);
            if (myRoles['formula']) register(inst, 'formula', arCores);
            recs.push({ title: 'AR/RF', instance: inst, role: 'ar', cores: arCores, description: '1 core' });

            // 2. Gateways (Net Pool)
            const gwLoad = getLoad('gateway', inst);
            const gwNeeded = calcNeeded(gwLoad, 25);
            // The user previously said "+2 buffer", but now "target 20-30%".
            // "math calculate how many necessary considering current load and striving to 20-30%".
            // If we use calcNeeded with 25%, that satisfies the requirement. No explicit buffer mention in NEW prompt.
            const gwCores = popCore(netPool, gwNeeded);
            register(inst, 'gateway', gwCores);
            recs.push({ title: 'Gateways', instance: inst, role: 'gateway', cores: gwCores, description: `${gwCores.length} cores`, rationale: `Load ${gwLoad.toFixed(0)}%` });

            // 3. Robots (Compute Pool)
            // Use compute pool first, spill to Net if needed
            const robotLoad = getLoad('robot_default', inst)
                + getLoad('isolated_robots', inst)
                + getLoad('pool1', inst)
                + getLoad('pool2', inst);

            const robotNeeded = calcNeeded(robotLoad, 25);

            // Try Compute Pool
            let robotCores = popCore(computePool, robotNeeded);
            // Spill to Net if needed
            if (robotCores.length < robotNeeded) {
                const needed = robotNeeded - robotCores.length;
                const extra = popCore(netPool, needed);
                robotCores = [...robotCores, ...extra];
            }

            // Assign generic 'robot_default' or split?
            // If input had 'isolated', preserve it? 
            // User: "evaluate load on EACH pool ... (pool gates, pool robots...)".
            // This implies we treat all robots as one big pool for calculation, OR check specific pools?
            // "Optional: Clickhouse, Isolated, Formula... others mandatory"
            // Let's assign to 'robot_default' generally.
            register(inst, 'robot_default', robotCores);
            recs.push({ title: 'Robots', instance: inst, role: 'robot_default', cores: robotCores, description: `${robotCores.length} cores`, rationale: `Load ${robotLoad.toFixed(0)}%` });
        });

        setRecommendations(recs);
        setProposedAllocation(proposedByInst);
        setInstanceOwnership(ownership);
        setResult('Optimization Complete: V2 Demand-Based');
    };

    const applyRecommendations = () => {
        if (!proposedAllocation) return;
        // Merge shared logic?
        // proposedAllocation keys are Instances.
        // We need to flatten to single map OR keep multi-instance structure if App supports it.
        // 'setInstances' takes InstanceConfig.
        // We need to make sure we don't overwrite if we are merging?
        // Actually, the proposedAllocation IS the full state per instance.
        // Just merge 'sys_os' and 'net_irq' carefully? 
        // My 'register' function added them to EACH instance. So it is fine.
        setInstances(proposedAllocation as any);
        setResult('Applied Config!');
    };

    // Render Unified Map with Segregation
    const renderUnifiedMap = () => {
        return (
            <div className="topology-grid">
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
                                    <div className="cmp-cores" style={{ gap: '8px' }}>
                                        {/* Group by L3 */}
                                        {Object.entries(l3Data).map(([l3Id, cores]) => (
                                            <div key={l3Id} className="l3-group">
                                                <div className="l3-header">L3: {l3Id}</div>
                                                <div className="l3-cores">
                                                    {cores.map(cpuId => {
                                                        // Determine Owner
                                                        const owners: string[] = [];
                                                        const roles: string[] = [];

                                                        Object.entries(instanceOwnership).forEach(([inst, set]) => {
                                                            if (set.has(cpuId)) {
                                                                owners.push(inst);
                                                                const r = proposedAllocation?.[inst]?.[String(cpuId)] || [];
                                                                roles.push(...r);
                                                            }
                                                        });

                                                        const uniqueOwners = [...new Set(owners)];

                                                        // Color Logic
                                                        let background = 'var(--bg-panel)';
                                                        let border = '2px solid transparent';

                                                        if (uniqueOwners.length === 1) {
                                                            background = instColors[uniqueOwners[0]] || '#334155';
                                                        } else if (uniqueOwners.length > 1) {
                                                            const isSystem = roles.includes('sys_os') || roles.includes('net_irq');
                                                            if (isSystem) {
                                                                background = SHARED_COLOR;
                                                                border = '2px dashed #fff';
                                                            } else {
                                                                background = 'repeating-linear-gradient(45deg, #606dbc, #606dbc 10px, #465298 10px, #465298 20px)';
                                                            }
                                                        }

                                                        // Opacity for Hover
                                                        let opacity = 1;
                                                        if (hoveredInstance) {
                                                            if (!uniqueOwners.includes(hoveredInstance) && !roles.includes('sys_os') && !roles.includes('net_irq')) {
                                                                opacity = 0.2;
                                                            }
                                                        }

                                                        return (
                                                            <div
                                                                key={cpuId}
                                                                className="core"
                                                                onMouseEnter={() => uniqueOwners.length > 0 && setHoveredInstance(uniqueOwners[0])}
                                                                onMouseLeave={() => setHoveredInstance(null)}
                                                                title={`Core ${cpuId}\nInstances: ${uniqueOwners.join(', ')}\nRoles: ${[...new Set(roles)].join(', ')}`}
                                                                style={{
                                                                    background,
                                                                    border,
                                                                    opacity,
                                                                    transition: 'opacity 0.2s',
                                                                    color: '#fff',
                                                                    cursor: uniqueOwners.length > 0 ? 'default' : 'not-allowed',
                                                                    display: 'flex', alignItems: 'center', justifyContent: 'center'
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
                <h2 style={{ margin: 0 }}>[AUTO-OPTIMIZATION V2]</h2>
                <div className="optimize-actions" style={{ display: 'flex', gap: '10px' }}>
                    <button className="btn btn-primary" onClick={generateOptimization}>GENERATE V2</button>
                    {recommendations.length > 0 && <button className="btn btn-secondary" onClick={applyRecommendations}>APPLY CONFIG</button>}
                </div>
            </div>

            {result && <div className="optimize-result" style={{ marginBottom: '20px', padding: '10px', background: 'var(--bg-input)', borderRadius: 'var(--radius-md)' }}>{result}</div>}

            {recommendations.length > 0 ? (
                renderUnifiedMap()
            ) : (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    Press GENERATE to calculate optimal placement (Demand-Based)
                </div>
            )}

            {/* Recommendations List */}
            {recommendations.length > 0 && (
                <div style={{ marginTop: '30px', borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
                    <h3>Allocation Details</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
                        {recommendations.map((rec, idx) => (
                            <div key={idx} className="recommend-card" style={{
                                borderLeft: `4px solid ${instColors[rec.instance] || '#ccc'}`,
                                background: 'var(--bg-panel)',
                                padding: '12px',
                                borderRadius: 'var(--radius-sm)',
                                boxShadow: 'var(--shadow-sm)'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                    <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>{rec.title}</span>
                                    <span style={{ fontSize: '0.8em', opacity: 0.7, background: 'var(--bg-input)', padding: '2px 6px', borderRadius: '4px' }}>{rec.instance}</span>
                                </div>
                                <div style={{ fontSize: '0.9em', marginBottom: '8px' }}>{rec.description}</div>
                                <div style={{ fontSize: '0.8em', color: 'var(--text-secondary)', marginBottom: '8px' }}>{rec.rationale}</div>
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


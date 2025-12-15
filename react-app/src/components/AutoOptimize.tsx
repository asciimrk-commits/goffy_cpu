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

        // --- SHARED RESOURCES (OS, IRQ) ---

        // OS: Global Load
        const osLoad = getLoad('sys_os');
        const osNeeded = Math.max(2, calcNeeded(osLoad, 25)); // Min 2 cores for OS safety
        const osCores = popCore(netPool, Math.min(osNeeded, 4));

        register('Shared', 'sys_os', osCores);
        recs.push({ title: 'Shared OS', instance: 'Global', role: 'sys_os', cores: osCores, description: `${osCores.length} cores`, rationale: `Load: ${osLoad.toFixed(1)}%` });

        // IRQ: Based on Total Gateways
        let totalGateways = 0;
        detectedInstances.forEach(i => {
            totalGateways += (instances[i]?.['gateway']?.length || 0);
        });
        const irqNeeded = Math.ceil(Math.max(totalGateways, 1) / 4); // 1 per 4 GW
        const irqCores = popCore(netPool, irqNeeded);

        register('Shared', 'net_irq', irqCores);
        recs.push({ title: 'Shared IRQ', instance: 'Global', role: 'net_irq', cores: irqCores, description: `${irqCores.length} cores`, rationale: `${totalGateways} Gateways` });

        // --- SEGREGATED RESOURCES (Per Instance) ---

        detectedInstances.forEach(inst => {
            if (inst === 'Shared') return;

            const myRoles = instances[inst] || {};

            // 1. Mandatory Services (1 Core Each, Net Pool)
            // Trash
            const trashCores = popCore(netPool, 1);
            register(inst, 'trash', trashCores);
            recs.push({ title: 'Trash', instance: inst, role: 'trash', cores: trashCores, description: 'Mandatory', rationale: 'Single/Unique' });

            // UDP
            const udpCores = popCore(netPool, 1);
            register(inst, 'udp', udpCores);
            recs.push({ title: 'UDP', instance: inst, role: 'udp', cores: udpCores, description: 'Mandatory' });

            // AR (AllRobotsTh) - Mandatory
            const arCores = popCore(netPool, 1);
            register(inst, 'ar', arCores);
            recs.push({ title: 'AR/RF', instance: inst, role: 'ar', cores: arCores, description: 'Mandatory' });

            // 2. Optional Services (Check Input)
            // ClickHouse
            if ((myRoles['click']?.length || 0) > 0) {
                const clickCores = popCore(netPool, 1);
                register(inst, 'click', clickCores);
                recs.push({ title: 'ClickHouse', instance: inst, role: 'click', cores: clickCores, description: 'Optional (Detected)' });
            }
            // Formula
            if ((myRoles['formula']?.length || 0) > 0) {
                const formCores = popCore(netPool, 1);
                register(inst, 'formula', formCores);
                recs.push({ title: 'Formula', instance: inst, role: 'formula', cores: formCores, description: 'Optional (Detected)' });
            }

            // 3. Scaled Services
            // Gateways (Net Pool)
            const gwLoad = getLoad('gateway', inst);
            const gwNeeded = Math.max(1, calcNeeded(gwLoad, 25)); // Min 1
            const gwCores = popCore(netPool, gwNeeded);
            register(inst, 'gateway', gwCores);
            recs.push({ title: 'Gateways', instance: inst, role: 'gateway', cores: gwCores, description: `${gwCores.length} cores`, rationale: `Load ${gwLoad.toFixed(1)}% (Target 25%)` });

            // Robots (Compute Pool)
            const robotLoad = getLoad('robot_default', inst)
                + getLoad('isolated_robots', inst)
                + getLoad('pool1', inst)
                + getLoad('pool2', inst);

            const robotNeeded = Math.max(1, calcNeeded(robotLoad, 25)); // Min 1

            // Use Compute Pool first
            let robotCores = popCore(computePool, robotNeeded);
            // Spillover
            if (robotCores.length < robotNeeded) {
                const needed = robotNeeded - robotCores.length;
                const extra = popCore(netPool, needed);
                robotCores = [...robotCores, ...extra];
            }

            register(inst, 'robot_default', robotCores);
            recs.push({ title: 'Robots (All Pools)', instance: inst, role: 'robot_default', cores: robotCores, description: `${robotCores.length} cores`, rationale: `Load ${robotLoad.toFixed(1)}% (Target 25%)` });
        });

        // Flatten ownership for visualization
        // OS/IRQ are in 'Shared' bucket from register step
        // We need to map 'Shared' ownership in a way that visualizer understands
        // "Intersection": The visualizer looks for `uniqueOwners`.
        // If we want Shared IS Intersection, then `Shared` cores should be added to ALL instances?
        // User said: "(Shared) will be used by N services simultaneously"
        // So yes, logically they belong to everyone.

        // Post-process 'Shared' ownership
        if (proposedByInst['Shared']) {
            Object.keys(proposedByInst['Shared']).forEach(coreId => {
                detectedInstances.forEach(inst => {
                    // Add shared cores to every instance's allocation map
                    // But don't duplicate role entries if unnecessary
                    // Visualization checks `instanceOwnership`.

                    // We just update `ownership` set
                    if (!ownership[inst]) ownership[inst] = new Set();
                    ownership[inst].add(parseInt(coreId));

                    // And proposedByInst for role lookup
                    if (!proposedByInst[inst]) proposedByInst[inst] = {};
                    if (!proposedByInst[inst][coreId]) proposedByInst[inst][coreId] = [];
                    const sharedRoles = proposedByInst['Shared'][coreId];
                    sharedRoles.forEach(r => {
                        if (!proposedByInst[inst][coreId].includes(r)) proposedByInst[inst][coreId].push(r);
                    });
                });
            });
        }

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
            <div className="optimize-header" style={{ marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '16px' }}>
                <h2 style={{ margin: 0, fontWeight: 600, letterSpacing: '-0.02em' }}>Auto-Placement</h2>
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


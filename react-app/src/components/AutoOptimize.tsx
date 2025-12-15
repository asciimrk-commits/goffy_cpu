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

// Fixed Color Palette matching HFT Rules
const COLORS: Record<string, string> = {
    'sys_os': '#64748b', // Slate
    'net_irq': '#e63946',
    'udp': '#f4a261',
    'trash': '#8b6914',
    'gateway': '#ffd60a',
    'isolated_robots': '#10b981',
    'pool1': '#3b82f6',
    'pool2': '#6366f1',
    'robot_default': '#2ec4b6',
    'ar': '#a855f7',
    'rf': '#22d3ee',
    'formula': '#94a3b8',
    'click': '#4f46e5'
};

const INSTANCE_COLORS: Record<string, string> = {
    'OS': '#64748b',
    'Physical': '#64748b',
};

// Colors for detected instances
const PREDEFINED_COLORS = [
    '#3b82f6', // Blue
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
        l3Groups
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
        const isoSet = new Set(isolatedCores.map(String));

        // === Logic from hft-rules.js ===

        // 1. Analyze Topology
        const byNuma: Record<string, string[]> = {};
        const byNumaL3: Record<string, Record<string, string[]>> = {};

        Object.entries(coreNumaMap).forEach(([cpu, numa]) => {
            const n = String(numa);
            if (!byNuma[n]) byNuma[n] = [];
            byNuma[n].push(cpu);
        });
        Object.entries(l3Groups || {}).forEach(([l3, cores]) => {
            if (cores.length === 0) return;
            const cpu = String(cores[0]);
            const numa = String(coreNumaMap[cpu] || 0);
            if (!byNumaL3[numa]) byNumaL3[numa] = {};
            byNumaL3[numa][l3] = cores.map(String);
        });
        Object.values(byNuma).forEach(c => c.sort((a, b) => parseInt(a) - parseInt(b)));

        const recs: Recommendation[] = [];
        const proposed: Record<string, string[]> = {};
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

        // Helpers
        const getTotalLoad = (cores: string[]) => !cores?.length ? 0 : cores.reduce((s, c) => s + (coreLoads[parseInt(c)] || 0), 0);
        const calcNeeded = (cores: string[], target = 25) => {
            const t = getTotalLoad(cores);
            return t === 0 ? (cores?.length || 1) : Math.max(1, Math.ceil(t / target));
        };

        // Detect Instances (Legacy+New Hybrid)
        // In this version (Global Optimization), we treat "Physical" as the target for the User's Rules.
        // But we DO verify specific instances if provided.
        // The user says "Auto-Configurator distributed cores incorrectly", implying global allocation is paramount.
        // We will assign to "Physical" instance mostly, OR if inputs have names, map to them.

        // Let's stick to assigning "roles" globally (like hft-rules.js) but tagging them with an Instance Name if reasonable.
        // HFT Rules assumes ONE set of roles for the server.
        // "DETECTED INSTANCES" might be multiple.

        // Logic: Iterate DETECTED instances and run the HFT Rules for EACH?
        // OR Run Global HFT Rules and split?
        // The user complained about "redistributing cores".
        // Let's assume SINGLE TENANT OPTIMIZATION for now (Physical), or per-instance?
        // hft-rules.js processes `s.instances.Physical`. It seems single-tenant focused.

        // However, standard `AutoOptimize.tsx` supported multiple instances.
        // Let's use PREVIOUS LOGIC (v8) which was "Port hft-rules.js".
        // BUT v9 was "Per Instance".

        // If the user says "return the first version", and "hft-rules.js" is the reference...
        // I will implement "Per Instance" loop but using "hft-rules" logic inside?
        // No, hft-rules uses "Net NUMA" global concept.

        // Let's detect instances and run "hft-rules-like" allocation for EACH instance,
        // sharing the Global Resources (Net NUMA) round-robin.

        const detectedInstances: string[] = [];

        // Populate detectedInstances
        Object.keys(instances).forEach(k => {
            if (k !== 'Physical' && k !== 'OS') detectedInstances.push(k);
        });
        if (detectedInstances.length === 0) detectedInstances.push('Physical');
        detectedInstances.sort();

        // Assign colors
        detectedInstances.forEach((inst, idx) => {
            if (!newInstColors[inst]) {
                newInstColors[inst] = PREDEFINED_COLORS[idx % PREDEFINED_COLORS.length];
            }
        });

        // 2. Global Resources Setup
        const netNumaCores = byNuma[netNuma] || [];
        const netL3Pools = byNumaL3[netNuma] || {};
        const netL3Keys = Object.keys(netL3Pools).sort((a, b) => (parseInt(a.split('-').pop()!) || 0) - (parseInt(b.split('-').pop()!) || 0));

        // Shared OS Allocation (First N cores of Net NUMA)
        // hft-rules: Check input 'sys_os'. If not, use first 2 net numa.
        let osCores = netNumaCores.filter(c => !isoSet.has(c));
        if (osCores.length === 0) {
            // All isolated? Force take first 2
            osCores = netNumaCores.slice(0, 2);
            if (osCores.length === 0) osCores = ['0', '1'];
        }

        // Calculate needed OS
        const osNeededRaw = Math.ceil(getTotalLoad(osCores) / 25);
        const osNeeded = Math.min(Math.max(2, osNeededRaw), 4);

        const assignedOsCores = osCores.slice(0, osNeeded);
        assignedOsCores.forEach(c => assignRole(c, 'sys_os', 'OS'));
        recs.push({
            title: 'OS',
            cores: assignedOsCores,
            description: `${assignedOsCores.length} cores`,
            role: 'sys_os',
            rationale: `Global System`,
            instance: 'OS'
        });

        // 3. Round-Robin / Priority Allocation for Instances
        // We have:
        // - Service L3 (for Trash/AR)
        // - Work L3s (for GW/IRQ)
        // - Robot NUMAs (Other)

        // Identify Service L3 (the one intersected by OS or first)
        let serviceL3 = netL3Keys.find(l3 => netL3Pools[l3].some(c => assignedOsCores.includes(c))) || netL3Keys[0];
        let workL3Keys = netL3Keys.filter(k => k !== serviceL3);
        if (workL3Keys.length === 0 && netL3Keys.length > 0) workL3Keys = [serviceL3];

        const servicePool = (netL3Pools[serviceL3] || []).filter(c => !isAssigned(c));
        // Sort service pool by isolation? Preferred isolated.
        servicePool.sort((a) => (isoSet.has(a) ? -1 : 1));

        // Global Pools
        const workPools: Record<string, string[]> = {};
        workL3Keys.forEach(k => {
            workPools[k] = (netL3Pools[k] || []).filter(c => !isAssigned(c));
        });

        // Per-Instance Demand Calc
        detectedInstances.forEach(instName => {
            const myCpuMap = instances[instName] || {};
            // Gather roles
            const myRoles: Record<string, string[]> = {};
            Object.entries(myCpuMap).forEach(([cpu, roles]) => {
                roles.forEach(r => {
                    if (!myRoles[r]) myRoles[r] = [];
                    myRoles[r].push(cpu);
                });
            });

            // Demands
            const hasAr = (myRoles['ar']?.length || 0) > 0 || (myRoles['formula']?.length || 0) > 0;
            const gwRaw = myRoles['gateway'] || [];
            const gwNeeded = calcNeeded(gwRaw, 25) + 2; // Buffer
            const irqNeeded = Math.ceil(gwNeeded / 4) || 1;

            // Robot Demand
            // Count all robot roles
            const robotRoles = ['isolated_robots', 'pool1', 'pool2', 'robot_default'];
            let robotCoresRaw: string[] = [];
            robotRoles.forEach(r => {
                if (myRoles[r]) robotCoresRaw.push(...myRoles[r]);
            });
            const robotNeeded = Math.max(1, calcNeeded(robotCoresRaw, 25));

            // --- Allocation ---

            // 1. Service Cores (Trash, UDP, AR)
            // Try Service Pool first
            const popService = (cnt: number) => {
                const res: string[] = [];
                for (let i = 0; i < cnt; i++) {
                    if (servicePool.length > 0) res.push(servicePool.shift()!);
                    else {
                        // Fallback to work pools?
                        for (const k of workL3Keys) {
                            if (workPools[k]?.length > 0) {
                                res.push(workPools[k].shift()!);
                                break;
                            }
                        }
                    }
                }
                return res;
            };

            const trashCores = popService(1);
            trashCores.forEach(c => {
                assignRole(c, 'trash', instName);
                assignRole(c, 'rf', instName);
                assignRole(c, 'click', instName);
            });
            recs.push({ title: 'Trash+RF', cores: trashCores, description: '1 core', role: 'trash', instance: instName });

            const udpCores = popService(1);
            udpCores.forEach(c => assignRole(c, 'udp', instName));
            recs.push({ title: 'UDP', cores: udpCores, description: '1 core', role: 'udp', instance: instName });

            if (hasAr) {
                const arCores = popService(1);
                arCores.forEach(c => {
                    assignRole(c, 'ar', instName);
                    assignRole(c, 'formula', instName);
                });
                recs.push({ title: 'AR+Formula', cores: arCores, description: '1 core', role: 'ar', instance: instName });
            }

            // 2. Gateway + IRQ
            // Round Robin across Work L3s to spread load?
            // "Strive to flush one L3 pool... IRQ/GW use non-service pools"

            let currentL3Idx = 0;
            const popWork = (cnt: number) => {
                const res: string[] = [];
                for (let i = 0; i < cnt; i++) {
                    // Try current L3, then next
                    let found = false;
                    for (let j = 0; j < workL3Keys.length; j++) {
                        const l3 = workL3Keys[(currentL3Idx + j) % workL3Keys.length];
                        if (workPools[l3]?.length > 0) {
                            res.push(workPools[l3].shift()!);
                            currentL3Idx = (currentL3Idx + j + 1) % workL3Keys.length; // Rotate
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        // Use service pool fallback?
                        if (servicePool.length > 0) res.push(servicePool.shift()!);
                    }
                }
                return res;
            };

            const irqCores = popWork(irqNeeded);
            irqCores.forEach(c => assignRole(c, 'net_irq', instName));
            recs.push({ title: 'IRQ', cores: irqCores, description: `${irqCores.length} cores`, role: 'net_irq', instance: instName });

            const gwCores = popWork(gwNeeded);
            gwCores.forEach(c => assignRole(c, 'gateway', instName));
            recs.push({ title: 'Gateways', cores: gwCores, description: `${gwCores.length} cores`, role: 'gateway', instance: instName });

            // 3. Robots (Compute NUMA)
            // Available NUMAs excluding Net
            const computeNumas = Object.keys(byNuma).filter(n => n !== netNuma).sort((a, b) => parseInt(a) - parseInt(b));

            // Build pool of all compute cores
            const computePool: string[] = [];
            computeNumas.forEach(n => {
                const cores = byNuma[n].filter(c => !isAssigned(c));
                computePool.push(...cores);
            });
            // If empty, spill to Net
            if (computePool.length === 0) {
                // Remaining Net
                workL3Keys.forEach(k => {
                    if (workPools[k]) computePool.push(...workPools[k]);
                });
                if (servicePool.length > 0) computePool.push(...servicePool);
            }

            const robotsTaken: string[] = [];
            for (let i = 0; i < robotNeeded; i++) {
                if (computePool.length > 0) robotsTaken.push(computePool.shift()!);
            }

            // Fill remainder if only 1 instance? 
            // "Robots target 25-30%". 
            // If we have single instance, give ALL remaining?
            if (detectedInstances.length === 1 && computePool.length > 0) {
                robotsTaken.push(...computePool);
            }

            if (robotsTaken.length > 0) {
                // Tier Logic
                // If >=4, allocate 4 to Isolated
                const isoCount = robotsTaken.length >= 4 ? 4 : 0;
                const iso = robotsTaken.slice(0, isoCount);
                const rest = robotsTaken.slice(isoCount);

                if (iso.length > 0) {
                    iso.forEach(c => assignRole(c, 'isolated_robots', instName));
                    recs.push({ title: 'Isolated Robots', cores: iso, description: `${iso.length} cores`, role: 'isolated_robots', instance: instName, rationale: 'Tier 1' });
                }
                if (rest.length > 0) {
                    rest.forEach(c => assignRole(c, 'pool1', instName)); // Just pool1 for simplicity or split?
                    recs.push({ title: 'Robot Pool', cores: rest, description: `${rest.length} cores`, role: 'pool1', instance: instName, rationale: 'Tier 2' });
                }
            } else {
                recs.push({ title: 'Robots', cores: [], description: '0 cores', role: 'robot_default', instance: instName, warning: 'No cores available!' });
            }

        });

        setInstanceOwnership(ownership);
        setRecommendations(recs);
        setProposedAllocation(proposedByInstance);
        setInstColors(newInstColors);
        setResult('Optimization Complete (Legacy Rules v4.5)');
    };

    const applyRecommendations = () => {
        if (!proposedAllocation) return;
        const config: any = { ...proposedAllocation };
        if (!config.Physical) config.Physical = {};
        setInstances(config);
        setResult('Applied!');
    };

    // Render Logic (Unified Map)
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
                                    <div className="cmp-cores">
                                        {Object.entries(l3Data).flatMap(([, cores]) => cores).map(cpuId => {
                                            let owner = 'Free';
                                            let color = '#334155';
                                            let coreRoles: string[] = [];

                                            // Find Owner & Roles
                                            for (const [inst, set] of Object.entries(instanceOwnership)) {
                                                if (set.has(cpuId)) {
                                                    owner = inst;
                                                    // Lookup role color
                                                    const pInst = proposedAllocation?.[inst] || {};
                                                    const pRoles = pInst[String(cpuId)] || [];
                                                    coreRoles = pRoles;

                                                    // Role Priority color (hft-rules style)
                                                    if (pRoles.length > 0) {
                                                        // Find highest priority role color
                                                        if (pRoles.includes('sys_os')) color = COLORS['sys_os'];
                                                        else if (pRoles.includes('net_irq')) color = COLORS['net_irq'];
                                                        else if (pRoles.includes('gateway')) color = COLORS['gateway'];
                                                        else if (pRoles.includes('isolated_robots')) color = COLORS['isolated_robots'];
                                                        else if (pRoles.includes('pool1')) color = COLORS['pool1'];
                                                        else if (pRoles.includes('trash')) color = COLORS['trash'];
                                                        else color = instColors[inst] || '#64748b';
                                                    } else {
                                                        color = instColors[inst] || '#64748b';
                                                    }
                                                    break;
                                                }
                                            }

                                            // Opacity
                                            let opacity = 1;
                                            if (hoveredInstance) {
                                                const isTarget = owner === hoveredInstance;
                                                const isOS = owner === 'OS';
                                                if (!isTarget && !isOS) opacity = 0.2;
                                            }

                                            return (
                                                <div
                                                    key={cpuId}
                                                    className="core"
                                                    onMouseEnter={() => owner !== 'Free' && setHoveredInstance(owner)}
                                                    onMouseLeave={() => setHoveredInstance(null)}
                                                    title={`Core ${cpuId} | ${owner} | ${coreRoles.join(',')}`}
                                                    style={{
                                                        backgroundColor: color,
                                                        opacity,
                                                        transition: 'opacity 0.2s',
                                                        color: '#fff',
                                                        cursor: owner !== 'Free' ? 'default' : 'not-allowed',
                                                        border: coreRoles.includes('sys_os') ? '2px solid #fff' : '2px solid transparent' // Highlight OS
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
                    <button className="btn btn-primary" onClick={generateOptimization}>GENERATE (Legacy v4.5)</button>
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

            {/* Recommendations List */}
            {recommendations.length > 0 && (
                <div style={{ marginTop: '30px', borderTop: '1px solid var(--border-color)', paddingTop: '20px' }}>
                    <h3>Allocation Details</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
                        {recommendations.map((rec, idx) => (
                            <div key={idx} className="recommend-card" style={{
                                borderLeft: `4px solid ${COLORS[rec.role] || instColors[rec.instance] || '#ccc'}`,
                                background: 'var(--bg-panel)',
                                padding: '12px',
                                borderRadius: 'var(--radius-sm)',
                                boxShadow: 'var(--shadow-sm)'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                                    <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>{rec.title}</span>
                                    <span style={{ fontSize: '0.8em', opacity: 0.7 }}>{rec.instance}</span>
                                </div>
                                <div style={{ fontSize: '0.9em', marginBottom: '8px' }}>{rec.description}</div>
                                {rec.warning && <div style={{ color: 'var(--color-danger)', fontSize: '0.8em', marginBottom: '8px', fontWeight: 600 }}>⚠ {rec.warning}</div>}
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

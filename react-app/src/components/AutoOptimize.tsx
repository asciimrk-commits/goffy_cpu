import { useState } from 'react';
import { useAppStore } from '../store/appStore';

interface OptimizationRec {
    title: string;
    instance: string;
    role: string;
    cores: string[];
    description: string;
    rationale?: string;
}

export function AutoOptimize() {
    const {
        geometry,
        netNumaNodes,
        coreLoads,
        instances
    } = useAppStore();

    const [recommendations, setRecommendations] = useState<OptimizationRec[]>([]);
    const [proposedAllocation, setProposedAllocation] = useState<Record<string, Record<string, string[]>> | null>(null);
    const [hoveredInstance, setHoveredInstance] = useState<string | null>(null);
    const [optimized, setOptimized] = useState(false);

    // Helpers
    const SHARED_COLOR = '#475569';
    const instColors: Record<string, string> = {
        'HUB7': '#3b82f6',
        'RFQ1': '#8b5cf6',
        'Shared': SHARED_COLOR,
    };

    // Color Generator for unknown instances
    const getColor = (inst: string) => {
        if (instColors[inst]) return instColors[inst];
        // Hash string to color
        let hash = 0;
        for (let i = 0; i < inst.length; i++) hash = inst.charCodeAt(i) + ((hash << 5) - hash);
        const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
        return '#' + '00000'.substring(0, 6 - c.length) + c;
    };

    const generatePlacement = () => {
        const netPool: string[] = [];
        const computePool: string[] = [];
        const recs: OptimizationRec[] = [];
        const proposal: Record<string, Record<string, string[]>> = {};

        // 1. Build Pools based on NUMA
        // geometry: { [socket]: { [numa]: { [l3]: cores[] } } }
        Object.values(geometry).forEach((numaMap: any) => {
            Object.entries(numaMap).forEach(([numaId, l3Map]: [string, any]) => {
                const isNet = netNumaNodes.includes(parseInt(numaId));
                Object.values(l3Map).forEach((cores: any) => {
                    (cores as number[]).forEach(c => {
                        const s = String(c);
                        if (isNet) netPool.push(s);
                        else computePool.push(s);
                    });
                });
            });
        });

        // Initialize proposal structure for tracked instances
        const detectedInstances = Object.keys(instances).filter(k => k !== 'Physical');
        detectedInstances.forEach(inst => {
            proposal[inst] = {};
        });

        // Add Shared Container
        proposal['Shared'] = {};

        // Helper: Pop cores from pool
        const popCores = (pool: string[], count: number): string[] => {
            const allocated: string[] = [];
            for (let i = 0; i < count; i++) {
                if (pool.length > 0) allocated.push(pool.shift()!);
            }
            return allocated;
        };

        // Helper: Register allocation
        const register = (inst: string, role: string, cores: string[]) => {
            if (!proposal[inst]) proposal[inst] = {};
            cores.forEach(c => {
                if (!proposal[inst][c]) proposal[inst][c] = [];
                proposal[inst][c].push(role);
            });
        };

        // Helper: Calculate Load
        const getLoad = (role: string, inst?: string): number => {
            let cores: string[] = [];
            if (inst) {
                cores = instances[inst]?.[role] || [];
            } else {
                // Global
                detectedInstances.forEach(i => {
                    const c = instances[i]?.[role] || [];
                    cores.push(...c);
                });
                if (instances.Physical?.[role]) cores.push(...instances.Physical[role]);
            }
            if (!cores.length) return 0;
            return cores.reduce((acc, c) => acc + (coreLoads[parseInt(c)] || 0), 0);
        };

        const calcNeeded = (load: number, target = 25) => Math.max(1, Math.ceil(load / target));

        // --- ALLOCATION LOGIC ---

        // 1. Shared Resources (Global)
        // OS: Min 2, Load safe
        const osLoad = getLoad('sys_os');
        const osNeeded = Math.max(2, calcNeeded(osLoad, 25));
        const osCores = popCores(netPool, Math.min(osNeeded, 4)); // Cap at 4
        register('Shared', 'sys_os', osCores);
        recs.push({ title: 'Shared OS', instance: 'Global', role: 'sys_os', cores: osCores, description: `${osCores.length} Cores`, rationale: `Global Load ${osLoad.toFixed(0)}%` });

        // IRQ: 1 per 4 Gateways
        let totalGw = 0;
        detectedInstances.forEach(i => totalGw += (instances[i]?.['gateway']?.length || 0));
        const irqNeeded = Math.ceil(Math.max(1, totalGw) / 4);
        const irqCores = popCores(netPool, irqNeeded);
        register('Shared', 'net_irq', irqCores);
        recs.push({ title: 'Shared IRQ', instance: 'Global', role: 'net_irq', cores: irqCores, description: `${irqCores.length} Cores`, rationale: `${totalGw} Total Gateways` });

        // 2. Per-Instance Allocation
        detectedInstances.forEach(inst => {
            const myRoles = instances[inst] || {};

            // A. Mandatory (Trash, UDP, AR) - Unique, NetPool
            // Trash
            const trash = popCores(netPool, 1);
            register(inst, 'trash', trash);
            recs.push({ title: 'Trash', instance: inst, role: 'trash', cores: trash, description: 'Mandatory', rationale: 'Unique Core' });

            // UDP
            const udp = popCores(netPool, 1);
            register(inst, 'udp', udp);
            recs.push({ title: 'UDP', instance: inst, role: 'udp', cores: udp, description: 'Mandatory' });

            // AR/RF (Combined)
            const ar = popCores(netPool, 1);
            register(inst, 'ar', ar);
            recs.push({ title: 'AR/RF', instance: inst, role: 'ar', cores: ar, description: 'Mandatory' });

            // B. Optional (ClickHouse, Formula) - Only if detected
            if ((myRoles['click']?.length || 0) > 0) {
                const click = popCores(netPool, 1);
                register(inst, 'click', click);
                recs.push({ title: 'ClickHouse', instance: inst, role: 'click', cores: click, description: 'Optional', rationale: 'Detected in Input' });
            }
            if ((myRoles['formula']?.length || 0) > 0) {
                const form = popCores(netPool, 1);
                register(inst, 'formula', form);
                recs.push({ title: 'Formula', instance: inst, role: 'formula', cores: form, description: 'Optional', rationale: 'Detected in Input' });
            }

            // C. Scaled Pools
            // Gateways (Net)
            const gwLoad = getLoad('gateway', inst);
            const gwCount = calcNeeded(gwLoad, 25);
            const gateways = popCores(netPool, gwCount);
            register(inst, 'gateway', gateways);
            recs.push({ title: 'Gateways', instance: inst, role: 'gateway', cores: gateways, description: `${gateways.length} Cores`, rationale: `Load ${gwLoad.toFixed(0)}%` });

            // Robots (Compute, spill to Net)
            const robotLoad = getLoad('robot_default', inst)
                + getLoad('isolated_robots', inst)
                + getLoad('pool1', inst)
                + getLoad('pool2', inst);
            const robotCount = calcNeeded(robotLoad, 25);
            let robots = popCores(computePool, robotCount);
            if (robots.length < robotCount) {
                const needed = robotCount - robots.length;
                const extra = popCores(netPool, needed);
                robots = [...robots, ...extra];
            }
            register(inst, 'robot_default', robots);
            recs.push({ title: 'Robots', instance: inst, role: 'robot_default', cores: robots, description: `${robots.length} Cores`, rationale: `Load ${robotLoad.toFixed(0)}%` });
        });

        setProposedAllocation(proposal);
        setRecommendations(recs);
        setOptimized(true);
    };

    const applyConfig = () => {
        alert("Configuration applied (Simulated). Export JSON not yet implemented.");
    };

    // --- VISUALIZATION ---

    // Helper to determine ownership & style for a specific core
    const getCoreStyle = (cpuId: string) => {
        if (!proposedAllocation) return { background: '#1e293b', border: '1px solid #334155', opacity: 1, owners: [] as string[], roles: [] as string[] };

        // Find all instances that own this core
        const owners: string[] = [];
        const roles: string[] = [];

        // Check Shared First
        if (proposedAllocation['Shared']?.[cpuId]) {
            owners.push('Shared');
            roles.push(...proposedAllocation['Shared'][cpuId]);
        }

        // Check Specific Instances
        Object.keys(proposedAllocation).forEach(inst => {
            if (inst === 'Shared') return;
            if (proposedAllocation[inst]?.[cpuId]) {
                owners.push(inst);
                roles.push(...proposedAllocation[inst][cpuId]);
            }
        });

        const uniqueOwners = [...new Set(owners)];

        let background = 'var(--bg-input)';
        let border = '1px solid var(--border-color)';
        let opacity = 1;

        if (uniqueOwners.length > 0) {
            if (uniqueOwners.includes('Shared')) {
                background = `repeating-linear-gradient(
                    45deg,
                    ${SHARED_COLOR},
                    ${SHARED_COLOR} 10px,
                    #334155 10px,
                    #334155 20px
                )`;
                border = '2px solid #94a3b8';
            } else if (uniqueOwners.length === 1) {
                const owner = uniqueOwners[0];
                background = getColor(owner);
                // Check if Trash (must be unique)
                if (roles.includes('trash')) {
                    border = '2px solid #fbbf24'; // Amber ring for trash
                }
            } else {
                // Intersection (Collision)
                background = `repeating-linear-gradient(
                    135deg,
                    #ef4444,
                    #ef4444 10px,
                    #7f1d1d 10px,
                    #7f1d1d 20px
                )`;
            }
        } else {
            // Unused
            opacity = 0.3;
        }

        // Hover Effect
        if (hoveredInstance) {
            if (hoveredInstance === 'Shared') {
                if (!uniqueOwners.includes('Shared')) opacity = 0.1;
            } else {
                if (!uniqueOwners.includes(hoveredInstance) && !uniqueOwners.includes('Shared')) opacity = 0.1;
            }
        }

        return { background, border, opacity, owners: uniqueOwners, roles };
    };

    return (
        <div className="flex flex-col h-full bg-[var(--bg-main)] text-[var(--text-main)] overflow-hidden">
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-[var(--border-color)] bg-[var(--header-bg)] relative z-10 shadow-sm">
                <div>
                    <h2 className="text-xl font-bold tracking-tight">Auto-Placement Engine</h2>
                    <p className="text-sm text-[var(--text-secondary)] mt-1">
                        Strict topology-aware allocation optimization
                    </p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={generatePlacement}
                        className="px-4 py-2 bg-[var(--accent-color)] hover:bg-[var(--color-primary-hover)] text-white rounded-md font-medium shadow-sm transition-colors text-sm"
                    >
                        Generate Allocation
                    </button>
                    {optimized && (
                        <button
                            onClick={applyConfig}
                            className="px-4 py-2 bg-[var(--bg-input)] hover:bg-[var(--border-color)] text-[var(--text-main)] border border-[var(--border-color)] rounded-md font-medium transition-colors text-sm"
                        >
                            Apply Config
                        </button>
                    )}
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 overflow-auto p-6">
                {!optimized ? (
                    <div className="h-full flex flex-col items-center justify-center text-[var(--text-muted)] opacity-60">
                        <div className="text-4xl mb-4">⚡</div>
                        <p>Click "Generate Allocation" to calculate optimal placement</p>
                    </div>
                ) : (
                    <div className="space-y-8">
                        {/* Visualization: Socket -> NUMA -> L3 */}
                        {Object.entries(geometry).map(([socketId, numaMap]: [string, any]) => (
                            <div key={socketId} className="bg-[var(--bg-panel)] rounded-lg border border-[var(--border-color)] shadow-sm overflow-hidden">
                                <div className="px-4 py-3 bg-[var(--bg-input)] border-b border-[var(--border-color)] font-semibold text-sm uppercase tracking-wider text-[var(--text-secondary)]">
                                    Socket {socketId}
                                </div>

                                <div className="p-4 grid gap-6">
                                    {Object.entries(numaMap).map(([numaId, l3Map]: [string, any]) => {
                                        const isNet = netNumaNodes.includes(parseInt(numaId));
                                        return (
                                            <div
                                                key={numaId}
                                                className={`relative rounded-md border-2 p-4 transition-colors ${isNet
                                                        ? 'border-emerald-500/20 bg-emerald-500/5'
                                                        : 'border-[var(--border-color)] bg-[var(--bg-main)]'
                                                    }`}
                                            >
                                                {/* NUMA Label */}
                                                <div className={`absolute -top-3 left-4 px-2 text-xs font-bold uppercase tracking-wider bg-[var(--bg-panel)] rounded ${isNet ? 'text-emerald-500' : 'text-[var(--text-secondary)]'
                                                    }`}>
                                                    NUMA {numaId} {isNet && '[NETWORK]'}
                                                </div>

                                                <div className="flex flex-wrap gap-4 mt-2">
                                                    {Object.entries(l3Map).map(([l3Id, cores]: [string, any]) => (
                                                        <div key={l3Id} className="l3-group">
                                                            <div className="l3-header">L3 Cache {l3Id}</div>
                                                            <div className="l3-cores">
                                                                {(cores as number[]).map((cpuId: number) => {
                                                                    const style = getCoreStyle(String(cpuId));

                                                                    return (
                                                                        <div
                                                                            key={cpuId}
                                                                            className="core"
                                                                            style={{
                                                                                background: style.background,
                                                                                border: style.border,
                                                                                opacity: style.opacity,
                                                                                cursor: style.owners.length ? 'help' : 'default'
                                                                            }}
                                                                            onMouseEnter={() => style.owners.length && setHoveredInstance(style.owners[0])}
                                                                            onMouseLeave={() => setHoveredInstance(null)}
                                                                            title={`CPU ${cpuId}\nOwners: ${style.owners.join(', ')}\nRoles: ${style.roles.join(', ')}`}
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
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Recommendations Panel (Bottom or Slide-out) */}
            {optimized && (
                <div className="border-t border-[var(--border-color)] bg-[var(--bg-panel)] h-64 overflow-auto p-4 flex gap-4">
                    <div className="w-1/4 min-w-[250px] border-r border-[var(--border-color)] pr-4">
                        <h3 className="font-bold text-sm mb-3">Allocated Instances</h3>
                        <div className="space-y-2">
                            {['Shared', ...Object.keys(instances).filter(k => k !== 'Physical')].map(inst => (
                                <div
                                    key={inst}
                                    className="flex items-center justify-between p-2 rounded cursor-pointer hover:bg-[var(--bg-input)]"
                                    onMouseEnter={() => setHoveredInstance(inst)}
                                    onMouseLeave={() => setHoveredInstance(null)}
                                    style={{
                                        background: hoveredInstance === inst ? 'var(--bg-input)' : 'transparent'
                                    }}
                                >
                                    <div className="flex items-center gap-2">
                                        <div className="w-3 h-3 rounded-full" style={{ background: inst === 'Shared' ? SHARED_COLOR : getColor(inst) }}></div>
                                        <span className="text-sm font-medium">{inst}</span>
                                    </div>
                                    <span className="text-xs text-[var(--text-muted)]">
                                        {recommendations.filter(r => r.instance === inst).reduce((acc, r) => acc + (r.cores?.length || 0), 0)} cores
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="flex-1">
                        <h3 className="font-bold text-sm mb-3">Allocation Log</h3>
                        <table className="w-full text-sm text-left">
                            <thead className="text-xs text-[var(--text-secondary)] uppercase bg-[var(--bg-input)]">
                                <tr>
                                    <th className="px-3 py-2">Instance</th>
                                    <th className="px-3 py-2">Role</th>
                                    <th className="px-3 py-2">Allocation</th>
                                    <th className="px-3 py-2">Rationale</th>
                                </tr>
                            </thead>
                            <tbody>
                                {recommendations.map((rec, i) => (
                                    <tr key={i} className="border-b border-[var(--border-color)] hover:bg-[var(--bg-input)]">
                                        <td className="px-3 py-2 font-medium">{rec.instance}</td>
                                        <td className="px-3 py-2 text-[var(--text-secondary)]">{rec.title}</td>
                                        <td className="px-3 py-2 font-mono text-xs">{rec.cores.join(', ')} ({rec.description})</td>
                                        <td className="px-3 py-2 text-[var(--text-muted)] italic">{rec.rationale}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}

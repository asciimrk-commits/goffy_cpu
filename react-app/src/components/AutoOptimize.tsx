import { useState } from 'react';
import { useAppStore } from '../store/appStore';

interface OptimizationRec {
    title: string;
    instance: string;
    role: string;
    cores: string[];
    description: string;
    rationale?: string;
    priority: number; // 0=Critical, 1=High, 2=Normal
}

interface InstanceAlloc {
    [role: string]: string[];
}

export function AutoOptimize() {
    const {
        geometry,
        netNumaNodes,
        coreLoads,
        instances: inputInstances, // Renamed to avoid confusion
    } = useAppStore();

    const [recommendations, setRecommendations] = useState<OptimizationRec[]>([]);
    const [proposedAllocation, setProposedAllocation] = useState<Record<string, InstanceAlloc> | null>(null);
    const [hoveredInstance, setHoveredInstance] = useState<string | null>(null);
    const [optimized, setOptimized] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Helpers
    const SHARED_COLOR = '#64748b'; // Slate 500
    const INST_PALETTE = [
        '#3b82f6', // Blue
        '#8b5cf6', // Violet
        '#ec4899', // Pink
        '#10b981', // Emerald
        '#f59e0b', // Amber
        '#6366f1', // Indigo
    ];

    const getColor = (inst: string) => {
        if (inst === 'Shared') return SHARED_COLOR;
        // Deterministic color based on instance name string
        let sum = 0;
        for (let i = 0; i < inst.length; i++) sum += inst.charCodeAt(i);
        return INST_PALETTE[sum % INST_PALETTE.length];
    };

    const getLoad = (cores: number[]) => {
        if (!cores || cores.length === 0) return 0;
        return cores.reduce((acc, c) => acc + (coreLoads[c] || 0), 0);
    };

    const generatePlacement = () => {
        setErrorMsg(null);
        const recs: OptimizationRec[] = [];
        const proposal: Record<string, InstanceAlloc> = {
            'Shared': {},
        };

        // 1. Initialize Pools
        let netPool: string[] = [];
        let computePool: string[] = [];

        Object.values(geometry).forEach((numaMap: any) => {
            Object.entries(numaMap).forEach(([numaId, l3Map]: [string, any]) => {
                const isNet = netNumaNodes.includes(parseInt(numaId));
                Object.values(l3Map).forEach((cores: any) => {
                    const sortedCores = (cores as number[]).sort((a, b) => a - b).map(String);
                    if (isNet) netPool.push(...sortedCores);
                    else computePool.push(...sortedCores);
                });
            });
        });

        // Ensure we have cores
        if (netPool.length === 0 && computePool.length === 0) {
            setErrorMsg("No cores detected in geometry!");
            return;
        }

        // Helper: Allocate cores
        const allocate = (inst: string, role: string, pool: 'net' | 'compute' | 'any', count: number, description: string, rationale: string, priority: number): string[] => {
            const allocated: string[] = [];

            // Allocation strategy:
            // 1. Try preferred pool
            // 2. Try other pool
            const tryPool = (p: string[]) => {
                while (p.length > 0 && allocated.length < count) {
                    allocated.push(p.shift()!);
                }
            };

            if (pool === 'net' || pool === 'any') tryPool(netPool);
            if (allocated.length < count && (pool === 'compute' || pool === 'any')) tryPool(computePool);

            // If strictly compute requested but failed, try net (spillover)
            if (pool === 'compute' && allocated.length < count) tryPool(netPool);

            if (allocated.length > 0) {
                if (!proposal[inst]) proposal[inst] = {};
                proposal[inst][role] = allocated;
                recs.push({
                    title: role.toUpperCase(),
                    instance: inst,
                    role,
                    cores: allocated,
                    description,
                    rationale,
                    priority
                });
            } else {
                recs.push({
                    title: role.toUpperCase(),
                    instance: inst,
                    role,
                    cores: [],
                    description: 'FAILED',
                    rationale: `Not enough cores (wanted ${count})`,
                    priority: 0
                });
            }
            return allocated;
        };

        // --- STEP 1: GLOBAL SHARED RESOURCES (OS, IRQ) ---
        // OS: Shared system-wide.
        // Logic: Load based (target 30%). Min 1 core.
        // Calculate total OS load from input? We can sum up load of all cores currently assigned to sys_os (or unassigned/isolated=false ones).
        // Since input might be messy, let's sum load of ALL current OS Cpus.
        let currentOsCores = inputInstances['Physical']?.['sys_os']?.map(Number) || [];
        // Fallback: if sys_os not explicit, maybe use core 0?
        if (currentOsCores.length === 0) currentOsCores = [0];

        const osLoad = getLoad(currentOsCores);
        // User feedback: "2 cores on OS (? why there 8 cores)". 
        // We set Target=30%. Min=1.
        const osNeeded = Math.max(1, Math.ceil(osLoad / 30));

        allocate('Shared', 'sys_os', 'net', osNeeded, `${osNeeded} Core(s)`, `Global Load ${osLoad.toFixed(1)}% / 30%`, 0);

        // IRQ: Shared system-wide.
        // Logic: 1 IRQ per 4 Gateways (Total).
        // Count total gateways in input.
        const detectedInstances = Object.keys(inputInstances).filter(k => k !== 'Physical');
        let totalGateways = 0;
        detectedInstances.forEach(inst => {
            totalGateways += (inputInstances[inst]?.['gateway']?.length || 0);
        });

        // If no instances detected (e.g. fresh config), assume 0? Or maybe check Physical gateway roles?
        if (totalGateways === 0 && inputInstances['Physical']?.['gateway']) {
            totalGateways = inputInstances['Physical']['gateway'].length;
        }

        // "progress with every 4 gateways... 1-4 -> 1, 4-8 -> 2" (Wait: 1-4=1. 5-8=2). 
        // Formula: ceil(total / 4).
        const irqNeeded = Math.max(1, Math.ceil(totalGateways / 4));
        // If no gateways, maybe still 1 IRQ? Yes, "IRQ should be mandatory".
        allocate('Shared', 'net_irq', 'net', irqNeeded, `${irqNeeded} Core(s)`, `${totalGateways} Gateways Detected`, 0);


        // --- STEP 2: INSTANCE MANDATORY SERVICES ---
        detectedInstances.forEach(inst => {
            const roles = inputInstances[inst] || {};

            // TRASH: Mandatory, SINGLE core.
            allocate(inst, 'trash', 'net', 1, '1 Core', 'Mandatory Single', 0);

            // UDP: Mandatory. Usually 1 core is sufficient? User says "UDP should be mandatory".
            allocate(inst, 'udp', 'net', 1, '1 Core', 'Mandatory', 0);

            // AR/RF (Remote Formula/AllRobotsTh): Mandatory.
            // Check if they exist in input? "evaluate from primary data... if there are these services... they are needed".
            // BUT user also said "AR-RF should be mandatory". AND "optional we can deliver ourselves".
            // Let's assume 1 core for AR/RF combined or separate? 
            // Input usually has 'ar' and 'rf' separate or together.
            // Let's check input presence. If not present, do we add it? User says "AR-RF should be mandatory".
            // We will allocate 'ar' (AllRobotsTh) as mandatory.
            allocate(inst, 'ar', 'net', 1, '1 Core', 'Mandatory', 0);
        });

        // --- STEP 3: OPTIONAL & SCALED SERVICES ---
        detectedInstances.forEach(inst => {
            const roles = inputInstances[inst] || {};

            // 1. OPTIONAL (Clickhouse, Formula, Isolated)
            // Check if present in input
            if (roles['click']?.length) {
                allocate(inst, 'click', 'net', 1, '1 Core', 'Detected in Input', 1);
            }
            if (roles['formula']?.length) {
                allocate(inst, 'formula', 'net', 1, '1 Core', 'Detected in Input', 1);
            }
            if (roles['isolated']?.length) {
                allocate(inst, 'isolated', 'compute', 1, '1 Core', 'Detected in Input', 1);
            }

            // 2. SCALED: Gateways
            // Target 25-30%. Min 1 if service exists.
            const currentGw = roles['gateway']?.map(Number) || [];
            if (currentGw.length > 0) {
                const gwLoad = getLoad(currentGw);
                const gwNeeded = Math.max(1, Math.ceil(gwLoad / 30));
                allocate(inst, 'gateway', 'net', gwNeeded, `${gwNeeded} Core(s)`, `Load ${gwLoad.toFixed(1)}% / 30%`, 1);
            }

            // 3. SCALED: Robots
            // Target 25-30%. Min 1 if service exists.
            // Consolidate robot roles
            let currentRobotCores: number[] = [];
            ['robot_default', 'isolated_robots', 'pool1', 'pool2'].forEach(r => {
                if (roles[r]) currentRobotCores.push(...roles[r].map(Number));
            });

            if (currentRobotCores.length > 0) {
                const robotLoad = getLoad(currentRobotCores);
                // User complaint: "Micro server... robots got 0 cores". 
                // We ensure AT LEAST 1 if load > 0 or if service exists.
                const robotNeeded = Math.max(1, Math.ceil(robotLoad / 30));
                allocate(inst, 'robot_default', 'compute', robotNeeded, `${robotNeeded} Core(s)`, `Load ${robotLoad.toFixed(1)}% / 30%`, 1);
            } else {
                // Even if no robots in input?? "critical services ... cannot NOT give cores".
                // Logic says: "Optional... evaluate from primary data...". Robots are usually mandatory for HFT.
                // But if key is missing in input, maybe it's a non-trading node? 
                // User says "gateways, robots, os... strive for load 20-30%".
                // If no robots detected, we skip.
            }
        });

        // Determine if optimized successfully
        const failed = recs.some(r => r.description === 'FAILED');
        setProposedAllocation(proposal);
        setRecommendations(recs);
        setOptimized(true);
        if (failed) setErrorMsg("Optimization incomplete: Insufficient cores for some services.");
    };

    const applyConfig = () => {
        alert("Config export not implemented yet via web.");
    };

    // --- RENDER HELPERS ---
    const getCellInfo = (cpuId: string) => {
        if (!proposedAllocation) return null;
        const owners: string[] = [];
        const roles: string[] = [];

        // check Shared
        const sharedRoles = proposedAllocation['Shared']?.[cpuId];
        if (sharedRoles) {

            // Shared logic: check if it's sys_os or irq
            // Actually, my data structure: proposal[inst][role] = [c1, c2].
            // need reverse lookup
            Object.entries(proposedAllocation['Shared']).forEach(([r, cores]) => {
                if (cores.includes(cpuId)) {
                    owners.push('Shared');
                    roles.push(r);
                }
            });
        }

        // check Instances
        Object.keys(proposedAllocation).forEach(inst => {
            if (inst === 'Shared') return;
            Object.entries(proposedAllocation[inst]).forEach(([r, cores]) => {
                if (cores.includes(cpuId)) {
                    owners.push(inst);
                    roles.push(r);
                }
            });
        });

        return { owners: [...new Set(owners)], roles };
    };

    return (
        <div className="flex flex-col h-full bg-[var(--bg-main)] text-[var(--text-main)] animate-fade-in">
            {/* Toolbar */}
            <div className="p-4 border-b border-[var(--border-color)] bg-[var(--bg-panel)] flex justify-between items-center shadow-sm">
                <div>
                    <h2 className="text-lg font-bold flex items-center gap-2">
                        <span>🚀</span> Auto-Optimizer v2
                    </h2>
                    <p className="text-xs text-[var(--text-muted)] mt-1">
                        Priority-based allocation • Multi-instance segregation • Load balancing
                    </p>
                </div>
                <div className="flex gap-2">
                    <button onClick={generatePlacement} className="px-4 py-2 bg-[var(--accent-color)] hover:bg-emerald-600 text-white rounded text-sm font-medium shadow-md transition-all">
                        Run Optimization
                    </button>
                    {optimized && (
                        <button onClick={applyConfig} className="px-4 py-2 border border-[var(--border-color)] hover:bg-[var(--bg-input)] rounded text-sm font-medium transition-all">
                            Export
                        </button>
                    )}
                </div>
            </div>

            {/* Error Banner */}
            {errorMsg && (
                <div className="bg-red-500/10 border-b border-red-500/20 p-3 text-red-400 text-sm flex items-center gap-2">
                    <span>⚠️</span> {errorMsg}
                </div>
            )}

            {/* Main Content */}
            <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">

                {/* Visualizer (Left/Top) */}
                <div className="flex-1 overflow-auto p-6 bg-[var(--bg-main)] relative">
                    {!optimized ? (
                        <div className="h-full flex flex-col items-center justify-center text-[var(--text-muted)] opacity-50 select-none">
                            <div className="text-6xl mb-4">🧠</div>
                            <p className="text-lg">Ready to optimize</p>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {/* Socket Level */}
                            {Object.entries(geometry).map(([socketId, numaMap]: [string, any]) => (
                                <div key={socketId} className="border border-[var(--border-color)] bg-[var(--bg-panel)] rounded-xl overflow-hidden shadow-sm">
                                    <div className="px-4 py-2 bg-[var(--bg-input)] border-b border-[var(--border-color)] text-xs font-bold uppercase tracking-widest text-[var(--text-secondary)]">
                                        Socket {socketId}
                                    </div>
                                    <div className="p-4 grid gap-4 grid-cols-1 md:grid-cols-2">
                                        {/* NUMA Level */}
                                        {Object.entries(numaMap).map(([numaId, l3Map]: [string, any]) => {
                                            const isNet = netNumaNodes.includes(parseInt(numaId));
                                            return (
                                                <div key={numaId} className={`relative p-5 rounded-lg border-2 transition-all ${isNet ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-[var(--border-color)] bg-[var(--bg-main)]'}`}>
                                                    <div className={`absolute -top-3 left-4 px-2 text-[10px] font-bold uppercase tracking-wider bg-[var(--bg-panel)] rounded border border-[var(--border-color)] ${isNet ? 'text-emerald-400' : 'text-[var(--text-muted)]'}`}>
                                                        NUMA {numaId} {isNet && '• NET'}
                                                    </div>

                                                    {/* L3 Groups */}
                                                    <div className="flex flex-wrap gap-4 mt-2">
                                                        {Object.entries(l3Map).map(([l3Id, cores]: [string, any]) => (
                                                            <div key={l3Id} className="flex-1 min-w-[120px]">
                                                                <div className="text-[10px] text-[var(--text-muted)] mb-1.5 flex justify-between">
                                                                    <span>L3 Cache {l3Id}</span>
                                                                </div>
                                                                <div className="grid grid-cols-4 gap-1.5">
                                                                    {(cores as number[]).map(c => {
                                                                        const info = getCellInfo(String(c));
                                                                        const assigned = info && info.owners.length > 0;
                                                                        const isShared = info?.owners.includes('Shared');
                                                                        const owner = info?.owners[0];

                                                                        return (
                                                                            <div
                                                                                key={c}
                                                                                title={assigned ? `CPU ${c}\n${info.owners.join('+')}\n${info.roles.join(', ')}` : `CPU ${c} (Unused)`}
                                                                                className={`
                                                                                    h-8 rounded flex items-center justify-center text-xs font-medium cursor-help transition-all relative overflow-hidden
                                                                                    ${assigned
                                                                                        ? 'text-white shadow-sm'
                                                                                        : 'bg-[var(--bg-input)] text-[var(--text-muted)] opacity-40 hover:opacity-70'}
                                                                                `}
                                                                                style={assigned ? {
                                                                                    background: isShared ? SHARED_COLOR : getColor(owner!),
                                                                                    border: info.roles.includes('trash') ? '2px solid #fbbf24' : 'none' // Highlight trash
                                                                                } : {}}
                                                                                onMouseEnter={() => owner && setHoveredInstance(owner)}
                                                                                onMouseLeave={() => setHoveredInstance(null)}
                                                                            >
                                                                                {c}
                                                                                {/* Overlap Indicator */}
                                                                                {info && info.owners.length > 1 && (
                                                                                    <div className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full border border-white"></div>
                                                                                )}
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

                {/* Report Panel (Right/Bottom) */}
                {optimized && (
                    <div className="w-full lg:w-96 border-l border-[var(--border-color)] bg-[var(--bg-panel)] flex flex-col h-[400px] lg:h-auto">
                        <div className="p-4 border-b border-[var(--border-color)] bg-[var(--bg-input)]">
                            <h3 className="font-bold text-sm uppercase tracking-wider text-[var(--text-secondary)]">Allocation Report</h3>
                        </div>

                        <div className="flex-1 overflow-auto p-4 space-y-4">
                            {/* Instance Summaries */}
                            <div className="grid grid-cols-2 gap-2">
                                {Object.keys(proposedAllocation || {}).map(inst => {
                                    if (inst === 'Shared' && Object.keys(proposedAllocation!['Shared']).length === 0) return null;

                                    const totalCores = Object.values(proposedAllocation![inst]).reduce((acc, c) => acc + c.length, 0);

                                    return (
                                        <div
                                            key={inst}
                                            className={`p-2 rounded border border-[var(--border-color)] bg-[var(--bg-main)] cursor-pointer transition-colors ${hoveredInstance === inst ? 'ring-2 ring-emerald-500/50' : ''}`}
                                            onMouseEnter={() => setHoveredInstance(inst)}
                                            onMouseLeave={() => setHoveredInstance(null)}
                                        >
                                            <div className="flex items-center gap-2 mb-1">
                                                <div className="w-2 h-2 rounded-full" style={{ background: getColor(inst) }}></div>
                                                <span className="font-bold text-sm">{inst}</span>
                                            </div>
                                            <div className="text-xs text-[var(--text-muted)]">{totalCores} Cores</div>
                                        </div>
                                    );
                                })}
                            </div>

                            <hr className="border-[var(--border-color)]" />

                            {/* Detailed Log */}
                            <div className="space-y-3">
                                {recommendations.map((rec, i) => (
                                    <div key={i} className="text-xs border-l-2 pl-3 py-1" style={{ borderColor: getColor(rec.instance) }}>
                                        <div className="flex justify-between items-baseline mb-1">
                                            <span className="font-bold">{rec.instance} :: {rec.role}</span>
                                            {rec.priority === 0 && <span className="text-[10px] bg-red-500/20 text-red-400 px-1 rounded">REQ</span>}
                                        </div>
                                        <div className="font-mono text-[var(--text-main)] break-all mb-0.5">
                                            [{rec.cores.join(', ')}]
                                        </div>
                                        <div className="text-[var(--text-muted)] italic">
                                            {rec.rationale}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default AutoOptimize;

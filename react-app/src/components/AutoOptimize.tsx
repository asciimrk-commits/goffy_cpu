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

        const assignRole = (cpu: string, role: string, inst: string) => {
            if (!proposed[cpu]) proposed[cpu] = [];
            if (!proposed[cpu].includes(role)) proposed[cpu].push(role);

            if (!ownership[inst]) ownership[inst] = new Set();
            ownership[inst].add(parseInt(cpu));
        };
        const isAssigned = (cpu: string) => (proposed[cpu]?.length || 0) > 0;

        // === 1. Analyze Input & Calculate Demand ===
        const detectedInstances: string[] = [];
        const instanceData: Record<string, Record<string, string[]>> = {};

        // Parse existing roles to find what services exist
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
        // Fallback for flat structure
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

        const demands: InstanceDemand[] = [];

        detectedInstances.forEach(instName => {
            const data = instanceData[instName] || {};

            // Fixed Services presence check
            // Mandatory services are enforced in demand object below
            const hasAr = (data['ar'] || []).length > 0;
            const hasRf = (data['rf'] || []).length > 0;
            const hasFormula = (data['formula'] || []).length > 0;

            // Gateway Demand
            const gwLoad = getTotalLoad(data['gateway'] || []);
            const gwNeeded = calcNeeded(gwLoad, 25); // Target 25%

            // Robot Demand
            // Consolidate all robot types for calculation
            const robotCores = [
                ...(data['isolated_robots'] || []),
                ...(data['pool1'] || []),
                ...(data['pool2'] || []),
                ...(data['robot_default'] || [])
            ];
            const robotLoad = getTotalLoad(robotCores);
            const robotNeeded = calcNeeded(robotLoad, 25);

            // IRQ Demand (1 per 4 Gateways)
            // If gwNeeded = 1..4 -> 1 IRQ
            // If gwNeeded = 5..8 -> 2 IRQ
            const irqNeeded = Math.ceil(gwNeeded / 4) || 1; // Minimum 1 if any gateways? Or fixed. Rules say mandatory.

            demands.push({
                name: instName,
                gateways: gwNeeded,
                robots: robotNeeded,
                irq: irqNeeded,
                trash: true, // Always mandatory per instance
                udp: true,   // Always mandatory 
                ar: hasAr || hasRf || hasFormula, // Grouped AR/RF/Formula
                rf: false, // Handled in AR group
                formula: false,
                gwLoad,
                robotLoad
            });
        });

        // OS Demand
        const sysOsCoresInput = detectedInstances.length === 1 && detectedInstances[0] === 'Physical'
            ? (instanceData['Physical']['sys_os'] || [])
            : []; // Only count explicit OS cores if they exist in input, otherwise calc from load

        let osLoad = getTotalLoad(sysOsCoresInput);
        if (osLoad === 0) {
            // Heuristic if no OS tags found: estimate from total system load? 
            // Or just default to safety. 
            // Let's use non-isolated cores load from input map as proxy for OS load
            const nonIsoCores = Object.keys(coreNumaMap).filter(c => !isolatedSet.has(c));
            osLoad = getTotalLoad(nonIsoCores);
        }

        // Target 25% for OS too
        let osNeeded = calcNeeded(osLoad, 25);
        osNeeded = Math.min(osNeeded, 4); // Cap at 4 for safety unless huge load
        if (osNeeded < 1) osNeeded = 1;

        // === 2. Topology Analysis ===
        const coresByNuma: Record<string, string[]> = {};
        Object.entries(coreNumaMap).forEach(([c, n]) => {
            const ns = String(n);
            if (!coresByNuma[ns]) coresByNuma[ns] = [];
            coresByNuma[ns].push(c);
        });
        // Sort cores numerically
        Object.values(coresByNuma).forEach(list => list.sort((a, b) => parseInt(a) - parseInt(b)));

        // === 3. Allocation ===

        // --- A. OS Allocation (Priority 1) ---
        // Place on Network NUMA, non-isolated preferred, but simply first N cores physically
        const allCoresSorted = Object.keys(coreNumaMap).sort((a, b) => parseInt(a) - parseInt(b));
        const osCandidates = allCoresSorted.slice(0, osNeeded); // Simple 0-N

        osCandidates.forEach(c => assignRole(c, 'sys_os', 'OS'));
        recs.push({
            title: '🖥️ OS',
            cores: osCandidates,
            description: `${osCandidates.length} ядер`,
            role: 'sys_os',
            rationale: `Target 25% load (${osLoad.toFixed(0)}%)`,
            instance: 'OS'
        });

        // Pool of available cores (Isolated only?)
        // Rules say: "OS 0-N", then rest for services.
        // We should treat all non-OS cores as available for assignment
        const availableParams = allCoresSorted.filter(c => !isAssigned(c));

        // Split available cores by NUMA for strict placement
        let netPool = availableParams.filter(c => String(coreNumaMap[c]) === netNuma);
        let otherPool = availableParams.filter(c => String(coreNumaMap[c]) !== netNuma);

        // --- B. Per-Instance Allocation ---
        // To segregate, we can split the pools or assign strictly.
        // "Segregate instances" -> Divide resources?
        // Let's allocate Critical Network stuff first for ALL instances to ensure they fit on Net NUMA

        const popNet = (cnt: number): string[] => {
            const res: string[] = [];
            for (let i = 0; i < cnt; i++) {
                if (netPool.length > 0) res.push(netPool.shift()!);
                else if (otherPool.length > 0) res.push(otherPool.shift()!); // Spillover
            }
            return res;
        };

        const popOther = (cnt: number): string[] => {
            const res: string[] = [];
            for (let i = 0; i < cnt; i++) {
                if (otherPool.length > 0) res.push(otherPool.shift()!);
                else if (netPool.length > 0) res.push(netPool.shift()!); // Backfill
            }
            return res;
        };

        // 1. Mandatory Network Services (IRQ, UDP, Gateway) -> Net NUMA preferred
        demands.forEach(d => {
            // IRQ
            const irqCores = popNet(d.irq);
            irqCores.forEach(c => assignRole(c, 'net_irq', d.name));
            recs.push({
                title: '⚡ IRQ',
                cores: irqCores,
                description: `${irqCores.length} ядер (1:${d.gateways > 4 ? '4+' : '4'})`,
                role: 'net_irq',
                rationale: 'Mandatory',
                instance: d.name
            });

            // Gateways
            const gwCores = popNet(d.gateways);
            gwCores.forEach(c => assignRole(c, 'gateway', d.name));
            recs.push({
                title: '🚪 Gateways',
                cores: gwCores,
                description: `${gwCores.length} ядер`,
                role: 'gateway',
                rationale: `Target 25% (${d.gwLoad.toFixed(0)}%)`,
                instance: d.name
            });

            // UDP (1 mandatory)
            const udpCores = popNet(1);
            udpCores.forEach(c => assignRole(c, 'udp', d.name));
            recs.push({
                title: '📡 UDP',
                cores: udpCores,
                description: '1 ядро',
                role: 'udp',
                rationale: 'Mandatory',
                instance: d.name
            });
        });

        // 2. Mandatory Services (Trash, AR/RF) -> Can be on other NUMA, but Trash usually dirty service L3?
        // Let's put them on OtherPool to save NetPool for networking if possible, or mixed.
        // "Trash must be mandatory and single"

        demands.forEach(d => {
            // Trash
            const trashCores = popOther(1);
            trashCores.forEach(c => {
                assignRole(c, 'trash', d.name);
                assignRole(c, 'click', d.name); // Co-locate ClickHouse
            });
            recs.push({
                title: '🗑️ Trash+Click',
                cores: trashCores,
                description: '1 ядро',
                role: 'trash',
                rationale: 'Mandatory',
                instance: d.name
            });

            // AR/RF (if present or mandatory? User said "Must be mandatory if present")
            if (d.ar) {
                const arCores = popOther(1);
                arCores.forEach(c => {
                    assignRole(c, 'ar', d.name);
                    assignRole(c, 'rf', d.name);
                    assignRole(c, 'formula', d.name);
                });
                recs.push({
                    title: '🔄 AR/RF',
                    cores: arCores,
                    description: '1 ядро',
                    role: 'ar',
                    rationale: 'Computed',
                    instance: d.name
                });
            }
        });

        // 3. Robots (Compute) -> Rest of cores
        // We have d.robots needed.
        // We have remaining netPool and otherPool.
        // We should distribute remaining cores roughly proportionally to demand or just fill.

        const allRemaining = [...netPool, ...otherPool];
        const totalRobotDemand = demands.reduce((s, d) => s + d.robots, 0);

        demands.forEach(d => {
            // Proportional share of remaining capacity?
            // Or strict demand?
            // "Target 20-30% load"

            // Allocate strict demand first

            // Try to pick cores contiguous/close? For now just pop.
            // SEGREGATION: We want to keep instance cores distinct.
            // Since we merged allRemaining, we need to be careful.
            // Let's split allRemaining by the ratio of demand.

            // Fairness: distribute remaining available cores proportional to demand.

            const strictShare = Math.floor(allRemaining.length * (d.robots / (totalRobotDemand || 1)));
            const extra = allRemaining.length > 0 ? Math.floor(allRemaining.length / demands.length) : 0; // Simple distribution of spare

            // Final count: Strict demand, but limited by available. 
            // If we have excess, fill it up!

            // Let's just grab cores for now.
            // For true segregation we should have kept pools separate per instance earlier?
            // But we didn't know which NUMA is best.

            // Simple approach: Round robin for remaining? 
            // Or chunked. Chunked is better for L3.

            const numToTake = Math.min(allRemaining.length, Math.max(d.robots, strictShare + extra));
            const taken = allRemaining.splice(0, numToTake);

            taken.forEach(c => assignRole(c, 'robot_default', d.name));
            recs.push({
                title: '🤖 Robots',
                cores: taken,
                description: `${taken.length} ядер`,
                role: 'robot_default',
                rationale: `Target 25%`,
                instance: d.name
            });
        });

        // 4. Update State
        setInstanceOwnership(ownership);
        setRecommendations(recs);
        setResult(`Optimization Complete. Net NUMA: ${netNuma}`);
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

    // UI Rendering
    const groupedRecs: Record<string, Recommendation[]> = {};
    recommendations.forEach(rec => {
        if (!groupedRecs[rec.instance]) groupedRecs[rec.instance] = [];
        groupedRecs[rec.instance].push(rec);
    });

    // Sort instances: OS first, then others alphabetically
    const instanceOrder = Object.keys(groupedRecs).sort((a, b) => {
        if (a === 'OS') return -1;
        if (b === 'OS') return 1;
        return a.localeCompare(b);
    });

    // Helper for per-instance topo
    const renderInstanceTopology = (instName: string) => {
        const owned = instanceOwnership[instName] || new Set();
        return (
            <div className="instance-topology" key={instName} style={{ marginBottom: '20px' }}>
                <h4 style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {instName} Map
                </h4>
                <div className="topology-grid compact">
                    {Object.entries(geometry).map(([socketId, numaData]) => (
                        <div key={socketId} className="socket-card compact">
                            {Object.entries(numaData).map(([numaId, l3Data]) => (
                                <div key={numaId} className="numa-section compact">
                                    <div className="numa-header">NUMA {numaId}</div>
                                    {Object.entries(l3Data).map(([l3Id, cores]) => (
                                        <div key={l3Id} className="l3-group compact">
                                            <div className="cores-grid compact">
                                                {cores.map(cpuId => {
                                                    const isOwned = owned.has(cpuId);
                                                    // Determine color based on role if owned
                                                    // We can't easily get the role here without passing it or looking up
                                                    // Simple visualization: Active vs Inactive
                                                    return (
                                                        <div
                                                            key={cpuId}
                                                            className="core compact"
                                                            style={{
                                                                opacity: isOwned ? 1 : 0.15,
                                                                backgroundColor: isOwned ? '#3b82f6' : '#334155',
                                                                border: isOwned ? '1px solid #60a5fa' : '1px solid transparent'
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
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className="optimize-container">
            <div className="optimize-header">
                <h2>[AUTO-OPTIMIZATION ENGINE v9]</h2>
                <p>Demand-Based Calculation • Segregated Instances • Mandatory Services</p>
            </div>

            <div className="optimize-actions">
                <button className="btn btn-primary btn-lg" onClick={generateOptimization}>GENERATE v9</button>
                {recommendations.length > 0 && <button className="btn btn-secondary" onClick={applyRecommendations}>APPLY</button>}
            </div>

            {result && <div className="optimize-result">{result}</div>}

            <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', marginTop: '20px' }}>
                {/* Left col: Recommendations */}
                <div style={{ flex: '1 1 400px' }}>
                    {instanceOrder.map(instName => (
                        <div key={instName} className="instance-section">
                            <h3 className="instance-header">=== {instName} ===</h3>
                            {groupedRecs[instName].map((rec, idx) => (
                                <div key={idx} className={`recommend-card ${rec.warning ? 'warning' : ''}`}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <h4>{rec.title}</h4>
                                        <span style={{ fontSize: '10px', opacity: 0.7 }}>{rec.role}</span>
                                    </div>
                                    <p>{rec.description}</p>
                                    {rec.rationale && <p className="rationale">{rec.rationale}</p>}
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

                {/* Right col: Mini Maps */}
                <div style={{ flex: '1 1 250px' }}>
                    {Object.keys(instanceOwnership).filter(i => i !== 'OS').map(i => renderInstanceTopology(i))}
                </div>
            </div>
        </div>
    );
}

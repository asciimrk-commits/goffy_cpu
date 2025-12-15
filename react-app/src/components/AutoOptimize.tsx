import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';
import {
    analyzeAllocation,
    formatCoreRange,
    generateRedistributionPlan,
    applyRedistribution,
    exportToBender,
    formatBenderYaml,
    type OptimizationResult,
    type Recommendation,
    type RedistributionPlan
} from '../lib/multiInstanceOptimizer';
import { CoreTooltip } from './Tooltip';


// Severity colors
const SEVERITY_COLORS: Record<string, string> = {
    info: '#3b82f6',
    success: '#10b981',
    warning: '#f59e0b',
    error: '#ef4444'
};

// Instance colors
const INSTANCE_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'];
function getInstanceColor(index: number): string {
    return INSTANCE_COLORS[index % INSTANCE_COLORS.length];
}

function RecommendationCard({ rec, instanceIndex }: { rec: Recommendation; instanceIndex?: number }) {
    const bgColor = `${SEVERITY_COLORS[rec.severity]}15`;
    const borderColor = SEVERITY_COLORS[rec.severity];
    const instanceColor = instanceIndex !== undefined ? getInstanceColor(instanceIndex) : undefined;

    return (
        <div
            className="recommend-card"
            style={{
                background: bgColor,
                borderLeft: `3px solid ${borderColor}`,
                padding: '10px 12px',
                borderRadius: '6px',
                marginBottom: '6px'
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{rec.title}</span>
                    {rec.delta !== undefined && rec.delta !== 0 && (
                        <span style={{
                            fontSize: '11px',
                            color: rec.delta > 0 ? '#f59e0b' : '#10b981',
                            fontWeight: 600
                        }}>
                            {rec.delta > 0 ? `+${rec.delta}` : rec.delta}
                        </span>
                    )}
                </div>
                {rec.instance && (
                    <span style={{
                        fontSize: '9px',
                        background: instanceColor || '#8b5cf6',
                        color: 'white',
                        padding: '2px 6px',
                        borderRadius: '3px',
                        fontWeight: 600
                    }}>
                        {rec.instance}
                    </span>
                )}
            </div>
            <p style={{ margin: '2px 0', fontSize: '11px', color: 'var(--text-secondary)' }}>
                {rec.description}
            </p>
            <p style={{ margin: '2px 0', fontSize: '10px', color: 'var(--text-muted)' }}>
                {rec.rationale}
            </p>
            {rec.warning && (
                <p style={{ margin: '4px 0 0 0', fontSize: '11px', color: '#ef4444', fontWeight: 500 }}>
                    {rec.warning}
                </p>
            )}
        </div>
    );
}

function L3CacheView({ result }: { result: OptimizationResult }) {
    const instanceNames = Object.keys(result.instances);

    return (
        <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '13px', fontWeight: 600 }}>
                L3 Cache Distribution
            </h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {Object.entries(result.l3Distribution).map(([l3Id, data]) => {
                    const hasMultipleInstances = Object.keys(data.instances).length > 1;
                    return (
                        <div
                            key={l3Id}
                            style={{
                                background: hasMultipleInstances ? 'rgba(239, 68, 68, 0.1)' : 'var(--bg-input)',
                                border: hasMultipleInstances ? '1px solid #ef4444' : '1px solid var(--border-color)',
                                borderRadius: '6px',
                                padding: '8px',
                                minWidth: '120px'
                            }}
                        >
                            <div style={{
                                fontSize: '10px',
                                fontWeight: 600,
                                marginBottom: '6px',
                                display: 'flex',
                                justifyContent: 'space-between'
                            }}>
                                <span>L3 #{l3Id}</span>
                                <span style={{ color: 'var(--text-muted)' }}>NUMA {data.numa}</span>
                            </div>
                            <div style={{ fontSize: '9px', marginBottom: '4px' }}>
                                {data.cores.length} cores: {formatCoreRange(data.cores)}
                            </div>
                            {Object.entries(data.instances).map(([instName, roles]) => {
                                const idx = instanceNames.indexOf(instName);
                                return (
                                    <div
                                        key={instName}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '4px',
                                            fontSize: '9px',
                                            marginTop: '2px'
                                        }}
                                    >
                                        <div style={{
                                            width: '8px',
                                            height: '8px',
                                            borderRadius: '2px',
                                            background: getInstanceColor(idx)
                                        }} />
                                        <span>{instName}: {roles.join(', ')}</span>
                                    </div>
                                );
                            })}
                            {hasMultipleInstances && (
                                <div style={{
                                    fontSize: '9px',
                                    color: '#ef4444',
                                    marginTop: '4px',
                                    fontWeight: 500
                                }}>
                                    Fragmented!
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function InstanceSummary({ result }: { result: OptimizationResult }) {
    const instanceNames = Object.keys(result.instances);

    return (
        <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '13px', fontWeight: 600 }}>
                Instance Needs
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
                {instanceNames.map((instName, idx) => {
                    const inst = result.instances[instName];
                    return (
                        <div
                            key={instName}
                            style={{
                                background: `${getInstanceColor(idx)}15`,
                                border: `1px solid ${getInstanceColor(idx)}`,
                                borderRadius: '8px',
                                padding: '10px'
                            }}
                        >
                            <div style={{
                                fontSize: '13px',
                                fontWeight: 700,
                                marginBottom: '8px',
                                color: getInstanceColor(idx)
                            }}>
                                {instName}
                            </div>
                            <div style={{ fontSize: '10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
                                <div>GW: {inst.current.gateways} → {inst.needs.gateways}</div>
                                <div>Robots: {inst.current.robots} → {inst.needs.robots}</div>
                                <div>IRQ: {inst.cores.irq.length} → {inst.needs.irq}</div>
                                <div>Total: {inst.totalNeeded} cores</div>
                            </div>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '6px' }}>
                                GW Load: {inst.loads.gateways.toFixed(0)}% | Robot Load: {inst.loads.robots.toFixed(0)}%
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function SummaryPanel({ result }: { result: OptimizationResult }) {
    const { warnings } = result;
    const totalIsolatedNeeded = Object.values(result.summary.totalInstanceNeeds).reduce((a, b) => a + b, 0);

    return (
        <div style={{
            background: 'var(--bg-input)',
            padding: '12px',
            borderRadius: '8px',
            marginBottom: '12px'
        }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '14px' }}>Summary</h3>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '10px' }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--color-primary)' }}>
                        {result.summary.totalCores}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Total</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#10b981' }}>
                        {result.summary.isolatedCores}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Isolated</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#64748b' }}>
                        {result.os.needed}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>OS Needed</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: '#e63946' }}>
                        {totalIsolatedNeeded}
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Instances</div>
                </div>
            </div>

            {warnings.length > 0 && (
                <div style={{ marginTop: '8px' }}>
                    {warnings.map((w, i) => (
                        <div
                            key={i}
                            style={{
                                background: '#ef444420',
                                color: '#ef4444',
                                padding: '6px 10px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 500,
                                marginTop: '4px'
                            }}
                        >
                            {w}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function TopologyPreview({ result }: { result: OptimizationResult }) {
    const { geometry, isolatedCores, coreLoads } = useAppStore();
    const isolatedSet = new Set(isolatedCores);
    const instanceNames = Object.keys(result.instances);

    // Build role map from result
    const roleMap: Record<number, { roles: string[]; instance?: string }> = {};

    // Map instance cores
    Object.entries(result.instances).forEach(([instName, analysis]) => {
        Object.entries(analysis.cores).forEach(([role, cores]) => {
            cores.forEach(c => {
                if (!roleMap[c]) roleMap[c] = { roles: [], instance: instName };
                if (!roleMap[c].roles.includes(role)) {
                    roleMap[c].roles.push(role);
                }
                roleMap[c].instance = instName;
            });
        });
    });

    // Add OS cores
    result.os.cores.forEach(c => {
        if (!roleMap[c]) roleMap[c] = { roles: [] };
        if (!roleMap[c].roles.includes('sys_os')) {
            roleMap[c].roles.push('sys_os');
        }
    });

    return (
        <div style={{ marginBottom: '16px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '13px', fontWeight: 600 }}>
                Current Topology
            </h4>

            {Object.entries(geometry).map(([socketId, numaData]) => (
                <div key={socketId} style={{
                    border: '2px solid var(--color-primary)',
                    borderRadius: '10px',
                    padding: '12px',
                    marginBottom: '10px'
                }}>
                    <div style={{
                        display: 'inline-block',
                        background: 'var(--color-primary)',
                        color: 'white',
                        padding: '4px 12px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 700,
                        marginBottom: '10px'
                    }}>
                        Socket {socketId}
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                        {Object.entries(numaData).map(([numaId, l3Data]) => (
                            <div key={numaId} style={{
                                border: '1px dashed var(--border-color)',
                                borderRadius: '8px',
                                padding: '10px',
                                flex: '1 1 auto',
                                minWidth: '180px'
                            }}>
                                <div style={{ fontSize: '10px', marginBottom: '8px' }}>
                                    <span style={{
                                        background: 'var(--color-accent)',
                                        color: 'white',
                                        padding: '2px 6px',
                                        borderRadius: '3px'
                                    }}>
                                        NUMA {numaId}
                                    </span>
                                </div>

                                {Object.entries(l3Data).map(([l3Id, cores]) => (
                                    <div key={l3Id} style={{
                                        background: 'var(--bg-input)',
                                        borderRadius: '6px',
                                        padding: '8px',
                                        marginBottom: '6px'
                                    }}>
                                        <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                                            L3 #{l3Id} ({cores.length} cores)
                                        </div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                            {cores.map(cpuId => {
                                                const data = roleMap[cpuId] || { roles: [] };
                                                const primaryRole = data.roles[0];
                                                const color = primaryRole ? ROLES[primaryRole]?.color || '#64748b' : '#1e293b';
                                                const isIsolated = isolatedSet.has(cpuId);
                                                const instIdx = data.instance ? instanceNames.indexOf(data.instance) : -1;

                                                return (
                                                    <CoreTooltip
                                                        key={cpuId}
                                                        cpuId={cpuId}
                                                        roles={data.roles}
                                                        load={coreLoads[cpuId]}
                                                        isIsolated={isIsolated}
                                                        instanceName={data.instance}
                                                    >
                                                        <div style={{
                                                            width: '36px',
                                                            height: '36px',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            background: color,
                                                            border: isIsolated ? '2px solid rgba(255,255,255,0.4)' : '1px solid rgba(255,255,255,0.1)',
                                                            borderRadius: '4px',
                                                            fontSize: '10px',
                                                            fontWeight: 600,
                                                            color: '#fff',
                                                            position: 'relative'
                                                        }}>
                                                            {cpuId}
                                                            {data.instance && instIdx >= 0 && (
                                                                <div style={{
                                                                    position: 'absolute',
                                                                    top: '-4px',
                                                                    right: '-4px',
                                                                    width: '8px',
                                                                    height: '8px',
                                                                    borderRadius: '50%',
                                                                    background: getInstanceColor(instIdx),
                                                                    border: '1px solid white'
                                                                }} />
                                                            )}
                                                        </div>
                                                    </CoreTooltip>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

export function AutoOptimize() {
    const {
        geometry,
        isolatedCores,
        instances,
        netNumaNodes,
        coreNumaMap,
        coreLoads,
        l3Groups,
        setInstances,
        setIsolatedCores,
        serverName
    } = useAppStore();

    const [result, setResult] = useState<OptimizationResult | null>(null);
    const [plan, setPlan] = useState<RedistributionPlan | null>(null);
    const [isRunning, setIsRunning] = useState(false);
    const [exportYaml, setExportYaml] = useState<string | null>(null);

    const inputParams = {
        geometry,
        instances,
        isolatedCores,
        coreNumaMap,
        coreLoads,
        netNumaNodes,
        l3Groups
    };

    const handleOptimize = () => {
        if (Object.keys(geometry).length === 0) {
            alert('Нет данных топологии. Загрузите данные cpu-map.sh.');
            return;
        }

        setIsRunning(true);
        setExportYaml(null);

        try {
            const optimizationResult = analyzeAllocation(inputParams);
            setResult(optimizationResult);

            // Generate redistribution plan
            const redistPlan = generateRedistributionPlan(inputParams, optimizationResult);
            setPlan(redistPlan);
        } catch (err) {
            console.error('Optimization error:', err);
            alert('Ошибка анализа: ' + (err as Error).message);
        } finally {
            setIsRunning(false);
        }
    };

    const handleApply = () => {
        if (!plan || !result) return;

        try {
            // Apply redistribution to state
            const newInstances = applyRedistribution(plan);
            setInstances(newInstances);
            setIsolatedCores(plan.proposedIsolated);

            alert(`Применено! OS: ${plan.proposedOs.length} ядер, Isolated: ${plan.proposedIsolated.length}`);

            // Re-analyze with new config
            setTimeout(() => handleOptimize(), 100);
        } catch (err) {
            console.error('Apply error:', err);
            alert('Ошибка применения: ' + (err as Error).message);
        }
    };

    const handleExport = () => {
        if (!plan) return;

        try {
            const benderConfig = exportToBender(plan, serverName || 'server');
            const yaml = formatBenderYaml(benderConfig);
            setExportYaml(yaml);
        } catch (err) {
            console.error('Export error:', err);
            alert('Ошибка экспорта: ' + (err as Error).message);
        }
    };

    const handleCopyYaml = () => {
        if (!exportYaml) return;
        navigator.clipboard.writeText(exportYaml);
        alert('Скопировано в буфер обмена!');
    };

    const hasData = Object.keys(geometry).length > 0;
    const instanceNames = result ? Object.keys(result.instances) : [];


    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: result ? '1fr 360px' : '1fr',
            gap: '16px',
            height: '100%',
            overflow: 'hidden'
        }}>
            {/* Left Panel - Topology & L3 */}
            <div style={{ overflow: 'auto', padding: '16px' }}>
                {!hasData ? (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100%',
                        color: 'var(--text-muted)'
                    }}>
                        <p>Загрузите данные cpu-map.sh для анализа</p>
                    </div>
                ) : (
                    <>
                        {result && (
                            <>
                                <InstanceSummary result={result} />
                                <L3CacheView result={result} />
                                <TopologyPreview result={result} />
                            </>
                        )}

                        {!result && (
                            <div style={{ textAlign: 'center', padding: '40px' }}>
                                <p style={{ color: 'var(--text-muted)', marginBottom: '20px' }}>
                                    Нажмите "Анализировать" для оценки текущей конфигурации
                                </p>
                                <button
                                    onClick={handleOptimize}
                                    disabled={isRunning}
                                    className="btn-primary"
                                    style={{
                                        padding: '12px 32px',
                                        fontSize: '14px',
                                        cursor: isRunning ? 'wait' : 'pointer'
                                    }}
                                >
                                    {isRunning ? 'Анализ...' : 'Анализировать'}
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Right Panel - Recommendations */}
            {result && (
                <div style={{
                    borderLeft: '1px solid var(--border-color)',
                    padding: '16px',
                    overflow: 'auto',
                    background: 'var(--bg-panel)'
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                        <h2 style={{ margin: 0, fontSize: '16px' }}>Recommendations</h2>
                        <button
                            onClick={handleOptimize}
                            className="btn-ghost"
                            style={{ fontSize: '11px', padding: '4px 10px' }}
                        >
                            Refresh
                        </button>
                    </div>

                    <SummaryPanel result={result} />

                    <div style={{ marginTop: '12px' }}>
                        {result.recommendations.map(rec => {
                            const instIdx = rec.instance ? instanceNames.indexOf(rec.instance) : undefined;
                            return (
                                <RecommendationCard
                                    key={rec.id}
                                    rec={rec}
                                    instanceIndex={instIdx}
                                />
                            );
                        })}
                    </div>

                    {/* Legend */}
                    <div style={{
                        marginTop: '16px',
                        padding: '10px',
                        background: 'var(--bg-input)',
                        borderRadius: '6px'
                    }}>
                        <h4 style={{ margin: '0 0 8px 0', fontSize: '11px', color: 'var(--text-muted)' }}>
                            Roles
                        </h4>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {Object.entries(ROLES).slice(0, 8).map(([id, role]) => (
                                <div
                                    key={id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '4px',
                                        fontSize: '9px'
                                    }}
                                >
                                    <div style={{
                                        width: '10px',
                                        height: '10px',
                                        background: role.color,
                                        borderRadius: '2px'
                                    }} />
                                    <span>{role.name}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Redistribution Plan */}
                    {plan && (
                        <div style={{
                            marginTop: '16px',
                            padding: '10px',
                            background: 'linear-gradient(135deg, #3b82f615 0%, #10b98115 100%)',
                            border: '1px solid var(--color-primary)',
                            borderRadius: '6px'
                        }}>
                            <h4 style={{ margin: '0 0 8px 0', fontSize: '12px', fontWeight: 600 }}>
                                Redistribution Plan
                            </h4>
                            <div style={{ fontSize: '10px', marginBottom: '8px' }}>
                                {plan.changes.map((change, i) => (
                                    <div key={i} style={{
                                        padding: '2px 0',
                                        color: change.startsWith('WARNING') ? '#f59e0b' :
                                            change.startsWith('  -') ? 'var(--text-muted)' : 'var(--text-primary)'
                                    }}>
                                        {change}
                                    </div>
                                ))}
                            </div>
                            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                                <button
                                    onClick={handleApply}
                                    className="btn-primary"
                                    style={{ flex: 1, padding: '8px', fontSize: '11px' }}
                                >
                                    Apply
                                </button>
                                <button
                                    onClick={handleExport}
                                    className="btn-secondary"
                                    style={{ flex: 1, padding: '8px', fontSize: '11px' }}
                                >
                                    Export YAML
                                </button>
                            </div>
                        </div>
                    )}

                    {/* YAML Export Modal */}
                    {exportYaml && (
                        <div style={{
                            marginTop: '12px',
                            padding: '10px',
                            background: '#1e293b',
                            borderRadius: '6px'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                <h4 style={{ margin: 0, fontSize: '11px', color: '#94a3b8' }}>
                                    Bender YAML
                                </h4>
                                <button
                                    onClick={handleCopyYaml}
                                    className="btn-ghost"
                                    style={{ fontSize: '10px', padding: '2px 8px' }}
                                >
                                    Copy
                                </button>
                            </div>
                            <pre style={{
                                margin: 0,
                                fontSize: '9px',
                                color: '#e2e8f0',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                maxHeight: '200px',
                                overflow: 'auto'
                            }}>
                                {exportYaml}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

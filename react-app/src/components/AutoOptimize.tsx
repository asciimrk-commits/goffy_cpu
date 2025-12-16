import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { optimizeTopology, type OptimizationResult, type Instance, type CoreAllocation } from '../lib/hftOptimizer';
import { L3Island } from './L3Island';
import { Core } from './Core';
import { exportToBender, downloadYaml } from '../lib/exporter';
import type { InstanceConfig } from '../types/topology';

export function AutoOptimize() {
    const {
        geometry, instances, coreNumaMap,
        l3Groups, netNumaNodes, coreLoads,
        setInstances, setPreviousInstances, setIsolatedCores,
        serverName
    } = useAppStore();

    const [result, setResult] = useState<OptimizationResult | null>(null);
    const [isRunning, setIsRunning] = useState(false);

    const hasData = Object.keys(geometry).length > 0;

    const handleOptimize = () => {
        if (!hasData) return;
        setIsRunning(true);

        // Convert instances map to array for optimizer
        // Infer priority/weight from name
        const instanceList: Instance[] = Object.keys(instances)
            .filter(k => k !== 'Physical' && k !== 'OS')
            .map(id => {
                const isProd = id.toUpperCase().includes('PROD');
                const isTest = id.toUpperCase().includes('TEST');
                return {
                    id,
                    type: isProd ? 'PROD' : (isTest ? 'TEST' : 'DEV'),
                    weight: 1.0,
                    priority: isProd ? 10 : (isTest ? 50 : 100)
                };
            });

        const input = {
            geometry,
            coreNumaMap,
            l3Groups,
            netNumaNodes,
            coreLoads,
            instances: instanceList
        };

        // Run in timeout to allow UI update
        setTimeout(() => {
            try {
                const res = optimizeTopology(input);
                setResult(res);
            } catch (e) {
                console.error(e);
                alert('Optimization failed: ' + (e as Error).message);
            } finally {
                setIsRunning(false);
            }
        }, 100);
    };

    const allocationsToConfig = (allocs: CoreAllocation[]): InstanceConfig => {
        const newInstances: InstanceConfig = {
            Physical: {}
        };

        // Initialize instance maps
        const instanceNames = new Set(allocs.map(a => a.instance).filter(Boolean));
        instanceNames.forEach(name => {
            if (name) newInstances[name] = {};
        });

        // Populate maps
        allocs.forEach(alloc => {
            const cpuStr = String(alloc.coreId);

            // Physical map (all roles)
            if (!newInstances.Physical[cpuStr]) newInstances.Physical[cpuStr] = [];
            newInstances.Physical[cpuStr].push(alloc.role);

            // Instance map
            if (alloc.instance) {
                if (!newInstances[alloc.instance][cpuStr]) newInstances[alloc.instance][cpuStr] = [];
                newInstances[alloc.instance][cpuStr].push(alloc.role);
            }
        });
        return newInstances;
    };

    const handleApply = () => {
        if (!result) return;

        // 1. Save current state as previous (for Ghost Diff)
        setPreviousInstances(instances);

        // 2. Convert allocations to InstanceConfig
        const newInstances = allocationsToConfig(result.allocations);

        // 3. Apply changes
        setInstances(newInstances);
        setIsolatedCores(result.isolatedCores);

        alert('Optimization applied! Previous state saved for comparison.');
    };

    const handleExport = () => {
        if (!result) return;
        const conf = allocationsToConfig(result.allocations);
        const yaml = exportToBender(conf, result.isolatedCores);
        downloadYaml(`${serverName || 'server'}_optimized.yaml`, yaml);
    };

    if (!hasData) {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-muted)' }}>
                Please load topology data first.
            </div>
        );
    }

    return (
        <div className="auto-optimize" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            {/* Header / Toolbar */}
            <div style={{
                padding: '16px',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'var(--bg-panel)'
            }}>
                <div>
                    <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0, color: 'var(--text-main)' }}>
                        HFT Strategy Optimizer
                    </h2>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        Algorithm: 4-Step Allocation (Zoning → Tax → Critical → Robots)
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                    <button
                        onClick={handleOptimize}
                        disabled={isRunning}
                        style={{
                            padding: '8px 16px',
                            background: 'var(--color-primary)',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            cursor: isRunning ? 'wait' : 'pointer',
                            opacity: isRunning ? 0.7 : 1,
                            fontWeight: 600
                        }}
                    >
                        {isRunning ? 'Analyzing...' : 'Run Analyzer'}
                    </button>

                    {result && (
                        <button
                            onClick={handleApply}
                            style={{
                                padding: '8px 16px',
                                background: 'transparent',
                                border: '1px solid var(--color-success)',
                                color: 'var(--color-success)',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontWeight: 600
                            }}
                        >
                            Apply Strategy
                        </button>
                    )}

                    {result && (
                        <button
                            onClick={handleExport}
                            style={{
                                padding: '8px 16px',
                                background: 'transparent',
                                border: '1px solid var(--text-muted)',
                                color: 'var(--text-main)',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontWeight: 600
                            }}
                        >
                            Export YAML
                        </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>
                {result ? (
                    <>
                        {/* Results View */}
                        <div style={{ flex: 1, overflow: 'auto', padding: '20px' }}>

                            {/* Summary Section */}
                            <div style={{ marginBottom: '24px' }}>
                                <h3 style={{ fontSize: '14px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '12px' }}>
                                    Strategy Summary
                                </h3>
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(4, 1fr)',
                                    gap: '12px',
                                    background: 'var(--bg-input)',
                                    padding: '16px',
                                    borderRadius: '8px'
                                }}>
                                    <div style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-main)' }}>{result.summary.osCount}</div>
                                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>OS Cores</div>
                                    </div>
                                    <div style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: '20px', fontWeight: 700, color: '#f59e0b' }}>{result.summary.gwCount}</div>
                                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Gateways</div>
                                    </div>
                                    <div style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: '20px', fontWeight: 700, color: '#10b981' }}>{result.summary.irqCount}</div>
                                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>IRQ/Poll</div>
                                    </div>
                                    <div style={{ textAlign: 'center' }}>
                                        <div style={{ fontSize: '20px', fontWeight: 700, color: '#3b82f6' }}>{result.summary.robotCount}</div>
                                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Robots</div>
                                    </div>
                                </div>
                            </div>

                            {/* Warnings Section */}
                            {result.warnings.length > 0 && (
                                <div style={{ marginBottom: '24px' }}>
                                    <h3 style={{ fontSize: '14px', textTransform: 'uppercase', color: 'var(--color-warning)', marginBottom: '12px' }}>
                                        Warnings & Risks
                                    </h3>
                                    <div style={{
                                        background: 'rgba(245, 158, 11, 0.1)',
                                        border: '1px solid var(--color-warning)',
                                        padding: '16px',
                                        borderRadius: '8px'
                                    }}>
                                        {result.warnings.map((line, i) => (
                                            <div key={i} style={{ marginBottom: '4px', fontSize: '12px', display: 'flex', gap: '8px' }}>
                                                <span>⚠️</span>
                                                <span>{line}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* L3 Distribution Visualization */}
                            <div>
                                <h3 style={{ fontSize: '14px', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '12px' }}>
                                    Proposed L3 Layout
                                </h3>
                                {result.l3Zones.map((l3) => (
                                    <L3Island
                                        key={l3.id}
                                        l3Id={l3.id}
                                        zone={l3.zone}
                                        numa={l3.numa}
                                        coreCount={l3.cores.length}
                                    >
                                        <div className="cores-grid" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                                            {l3.cores.map(cpuId => {
                                                const alloc = result.allocations.find(a => a.coreId === cpuId);
                                                const role = alloc?.role || 'free';
                                                const instance = alloc?.instance;

                                                return (
                                                    <Core
                                                        key={cpuId}
                                                        cpuId={cpuId}
                                                        roles={[role]}
                                                        ownerInstance={instance || (role === 'sys_os' ? 'OS' : undefined)}
                                                        isIsolated={result.isolatedCores.includes(cpuId)}
                                                        load={coreLoads[cpuId]}
                                                        onMouseDown={() => { }}
                                                        onMouseEnter={() => { }}
                                                        onDrop={() => { }} // No drop in preview
                                                    />
                                                );
                                            })}
                                        </div>
                                    </L3Island>
                                ))}
                            </div>
                        </div>
                    </>
                ) : (
                    <div style={{
                        flex: 1,
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        flexDirection: 'column',
                        color: 'var(--text-muted)',
                        gap: '16px'
                    }}>
                        <div style={{ fontSize: '48px', opacity: 0.2 }}>🧠</div>
                        <div>Ready to analyze {serverName} topology</div>
                    </div>
                )}
            </div>
        </div>
    );
}

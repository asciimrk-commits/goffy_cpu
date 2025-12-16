import { useState, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { L3Island } from './L3Island';
import { Core } from './Core';
import type { L3Zone } from '../lib/hftOptimizer';

// Instance colors
const INSTANCE_COLORS: Record<string, string> = {
    'Physical': '#64748b',
    'OS': '#64748b',
};

const PREDEFINED_INSTANCE_COLORS = [
    '#3b82f6', // Blue
    '#8b5cf6', // Violet
    '#10b981', // Emerald
    '#f59e0b', // Amber
    '#ec4899', // Pink
    '#06b6d4', // Cyan
];

function getInstanceColor(instanceName: string, index: number): string {
    if (INSTANCE_COLORS[instanceName]) return INSTANCE_COLORS[instanceName];
    return PREDEFINED_INSTANCE_COLORS[index % PREDEFINED_INSTANCE_COLORS.length];
}

// Core component was here
// It has been moved to Core.tsx

export function TopologyMap() {
    const {
        geometry,
        instances,
        previousInstances,
        isolatedCores,
        coreLoads,
        activeTool,
        paintCore,
        eraseCore,
        netNumaNodes,
        assignInstanceToL3
    } = useAppStore();
    const isolatedSet = new Set(isolatedCores);

    const [isDragging, setIsDragging] = useState(false);
    const [showDiff, setShowDiff] = useState(false);

    // Auto-enable diff if previousInstances exists
    useEffect(() => {
        if (previousInstances) setShowDiff(true);
    }, [previousInstances]);
    const [dragMode, setDragMode] = useState<'paint' | 'erase'>('paint');

    useEffect(() => {
        const handleMouseUp = () => setIsDragging(false);
        window.addEventListener('mouseup', handleMouseUp);
        return () => window.removeEventListener('mouseup', handleMouseUp);
    }, []);

    // Get unique instance names (excluding Physical)
    const instanceNames = Object.keys(instances).filter(n => n !== 'Physical' && n !== 'OS');

    if (Object.keys(geometry).length === 0) {
        return (
            <div className="topology-empty" style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--text-muted)',
                padding: '40px'
            }}>
                <p>Вставьте вывод cpu-map.sh и нажмите "Build Map" для визуализации топологии</p>
            </div>
        );
    }

    const handleAction = (cpuId: number, isCtrl: boolean) => {
        if (!activeTool) return;
        if (isCtrl) {
            eraseCore(cpuId, activeTool);
        } else {
            paintCore(cpuId, activeTool);
        }
    };

    const onCoreMouseDown = (cpuId: number, e: React.MouseEvent) => {
        if (!activeTool) return;
        setIsDragging(true);
        const isErase = e.ctrlKey || e.metaKey;
        setDragMode(isErase ? 'erase' : 'paint');
        handleAction(cpuId, isErase);
    };

    const onCoreMouseEnter = (cpuId: number) => {
        if (isDragging && activeTool) {
            handleAction(cpuId, dragMode === 'erase');
        }
    };

    // Helper to aggregate roles and find owner
    const getCoreData = (cpuId: number) => {
        const cpuStr = String(cpuId);
        let allRoles: string[] = [];
        let owner = '';
        let ownerIndex = -1;

        Object.entries(instances).forEach(([instName, map]) => {
            const roles = map[cpuStr];
            if (roles && roles.length > 0) {
                allRoles = [...allRoles, ...roles];
                if (instName !== 'Physical') {
                    owner = instName;
                    ownerIndex = instanceNames.indexOf(instName);
                } else if (!owner) {
                    owner = 'Physical';
                }
            }
        });

        return {
            roles: [...new Set(allRoles)],
            owner,
            instanceColor: owner ? getInstanceColor(owner, ownerIndex >= 0 ? ownerIndex : 0) : undefined
        };
    };

    // Count totals
    const totalCores = Object.values(geometry).flatMap(s =>
        Object.values(s).flatMap(n => Object.values(n).flat())
    ).length;
    const isolatedCount = isolatedCores.length;

    return (
        <div className="topology-container" style={{ padding: '16px', overflow: 'auto', height: '100%' }}>
            {/* Header stats */}
            <div style={{
                display: 'flex',
                gap: '24px',
                marginBottom: '16px',
                padding: '8px 16px',
                background: 'var(--bg-input)',
                borderRadius: '8px',
                fontSize: '12px',
                alignItems: 'center',
                justifyContent: 'space-between'
            }}>
                <div style={{ display: 'flex', gap: '24px' }}>
                    <div><strong>Всего ядер:</strong> {totalCores}</div>
                    <div><strong>Изолировано:</strong> {isolatedCount}</div>
                    <div><strong>Сокетов:</strong> {Object.keys(geometry).length}</div>
                    <div><strong>NUMA узлов:</strong> {Object.values(geometry).reduce((acc, s) => acc + Object.keys(s).length, 0)}</div>
                </div>
                {previousInstances && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Ghost Diff</span>
                        <div
                            onClick={() => setShowDiff(!showDiff)}
                            style={{
                                width: '32px',
                                height: '18px',
                                background: showDiff ? 'var(--color-primary)' : 'var(--bg-input)',
                                borderRadius: '10px',
                                position: 'relative',
                                cursor: 'pointer',
                                transition: 'background 0.2s',
                                border: '1px solid var(--border-color)'
                            }}
                        >
                            <div style={{
                                width: '14px',
                                height: '14px',
                                background: 'white',
                                borderRadius: '50%',
                                position: 'absolute',
                                top: '1px',
                                left: showDiff ? '15px' : '1px',
                                transition: 'left 0.2s',
                                boxShadow: '0 1px 2px rgba(0,0,0,0.2)'
                            }} />
                        </div>
                    </div>
                )}
            </div>

            {/* Topology grid - matching reference design */}
            <div className="topology-grid" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {Object.entries(geometry).map(([socketId, numaData]) => (
                    <div
                        key={socketId}
                        className="socket-card"
                        style={{
                            border: '1px solid var(--border-color)',
                            borderRadius: '8px',
                            background: 'rgba(30, 41, 59, 0.5)',
                            overflow: 'hidden'
                        }}
                    >
                        {/* Socket header - centered like reference */}
                        <div style={{
                            textAlign: 'center',
                            padding: '10px',
                            background: 'rgba(0,0,0,0.2)',
                            borderBottom: '1px solid var(--border-color)',
                            fontSize: '13px',
                            fontWeight: 600,
                            letterSpacing: '1px',
                            textTransform: 'uppercase',
                            color: 'var(--text-muted)'
                        }}>
                            SOCKET {socketId}
                        </div>

                        {/* NUMAs in row with scroll if needed */}
                        <div style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '12px',
                            padding: '12px'
                        }}>
                            {Object.entries(numaData).map(([numaId, l3Data]) => (
                                <div
                                    key={numaId}
                                    className="numa-section"
                                    style={{
                                        border: '1px solid var(--border-color)',
                                        borderRadius: '8px',
                                        padding: '12px',
                                        background: 'rgba(30, 41, 59, 0.3)',
                                        flex: '1 1 300px',
                                        minWidth: '280px',
                                    }}
                                >
                                    <div style={{
                                        fontSize: '12px',
                                        fontWeight: 600,
                                        color: 'var(--text-secondary)',
                                        marginBottom: '10px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '6px'
                                    }}>
                                        <span style={{
                                            background: netNumaNodes.includes(parseInt(numaId)) ? '#10b981' : 'var(--color-accent)',
                                            color: 'white',
                                            padding: '2px 8px',
                                            borderRadius: '4px',
                                            fontSize: '10px'
                                        }}>
                                            NUMA {numaId}
                                        </span>
                                        {netNumaNodes.includes(parseInt(numaId)) && (
                                            <span style={{
                                                background: '#10b981',
                                                color: 'white',
                                                padding: '2px 6px',
                                                borderRadius: '4px',
                                                fontSize: '9px',
                                                fontWeight: 700
                                            }}>
                                                NET
                                            </span>
                                        )}
                                    </div>

                                    {Object.entries(l3Data).map(([l3Id, cores]) => {
                                        // Determine L3 zone
                                        const hasCore0 = cores.includes(0);
                                        const isNetNuma = netNumaNodes.includes(parseInt(numaId));
                                        let zone: L3Zone = 'silver';
                                        if (hasCore0) zone = 'dirty';
                                        else if (isNetNuma) zone = 'gold';

                                        return (
                                            <L3Island
                                                key={l3Id}
                                                l3Id={l3Id}
                                                zone={zone}
                                                numa={parseInt(numaId)}
                                                coreCount={cores.length}
                                                onDropInstance={(instanceId) => assignInstanceToL3(instanceId, l3Id)}
                                            >
                                                <div className="cores-grid" style={{
                                                    display: 'flex',
                                                    flexWrap: 'wrap',
                                                    gap: '6px'
                                                }}>
                                                    {cores.map(cpuId => {
                                                        const { roles } = getCoreData(cpuId);
                                                        const owner = Object.entries(instances).find(([name, instCores]) => {
                                                            if (name === 'Physical') return false;
                                                            return !!(instCores as Record<string, string[]>)[String(cpuId)];
                                                        })?.[0];

                                                        // Find previous owner for ghost diff
                                                        let ghostOwner: string | undefined;
                                                        if (showDiff && previousInstances) {
                                                            ghostOwner = Object.entries(previousInstances).find(([name, instCores]) => {
                                                                if (name === 'Physical') return false;
                                                                return !!(instCores as Record<string, string[]>)[String(cpuId)];
                                                            })?.[0];

                                                            // Only show ghost if different from current
                                                            if (ghostOwner === owner) ghostOwner = undefined;
                                                        }

                                                        const instanceColor = owner ? getInstanceColor(owner, 0) : undefined;
                                                        const ghostColor = ghostOwner ? getInstanceColor(ghostOwner, 0) : undefined;

                                                        return (
                                                            <Core
                                                                key={cpuId}
                                                                cpuId={cpuId}
                                                                roles={roles}
                                                                ownerInstance={owner}
                                                                instanceColor={instanceColor}
                                                                ghostOwner={ghostOwner}
                                                                ghostColor={ghostColor}
                                                                isIsolated={isolatedSet.has(cpuId)}
                                                                load={coreLoads[cpuId]}
                                                                onMouseDown={(e) => onCoreMouseDown(cpuId, e)}
                                                                onMouseEnter={() => onCoreMouseEnter(cpuId)}
                                                                onDrop={(roleId) => paintCore(cpuId, roleId)}
                                                            />
                                                        );
                                                    })}
                                                </div>
                                            </L3Island>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

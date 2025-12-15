import { useState, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';
import { CoreTooltip } from './Tooltip';

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

interface CoreProps {
    cpuId: number;
    roles: string[];
    ownerInstance?: string;
    instanceColor?: string;
    isIsolated: boolean;
    load?: number;
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseEnter: (e: React.MouseEvent) => void;
}

function Core({ cpuId, roles, ownerInstance, instanceColor, isIsolated, load, onMouseDown, onMouseEnter }: CoreProps) {
    const { activeTool } = useAppStore();

    const primaryRole = roles[0];
    const roleColor = primaryRole ? ROLES[primaryRole]?.color || '#64748b' : '#1e293b';
    const hasMultipleRoles = roles.length > 1;

    // Build background based on roles
    let background = roleColor;
    if (hasMultipleRoles) {
        const colors = roles.slice(0, 3).map(r => ROLES[r]?.color || '#64748b');
        if (colors.length === 2) {
            background = `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)`;
        } else if (colors.length >= 3) {
            background = `linear-gradient(135deg, ${colors[0]} 33%, ${colors[1]} 33% 66%, ${colors[2]} 66%)`;
        }
    }

    // Border for isolated cores
    const borderStyle = isIsolated
        ? '2px solid rgba(255,255,255,0.4)'
        : '1px solid rgba(255,255,255,0.1)';

    return (
        <CoreTooltip cpuId={cpuId} roles={roles} load={load} isIsolated={isIsolated} instanceName={ownerInstance}>
            <div
                onMouseDown={onMouseDown}
                onMouseEnter={onMouseEnter}
                className={`core ${hasMultipleRoles ? 'multi-role' : ''}`}
                style={{
                    background,
                    border: borderStyle,
                    cursor: activeTool ? 'pointer' : 'default',
                    position: 'relative',
                    width: '40px',
                    height: '40px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: '#fff',
                    transition: 'transform 0.1s, box-shadow 0.1s'
                }}
            >
                <span className="core-id">{cpuId}</span>
                {/* Instance badge */}
                {ownerInstance && ownerInstance !== 'Physical' && (
                    <div style={{
                        position: 'absolute',
                        top: '-6px',
                        right: '-6px',
                        fontSize: '8px',
                        background: instanceColor || '#8b5cf6',
                        color: 'white',
                        padding: '1px 4px',
                        borderRadius: '3px',
                        fontWeight: 700,
                        whiteSpace: 'nowrap',
                        maxWidth: '30px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.3)'
                    }}>
                        {ownerInstance.slice(0, 4)}
                    </div>
                )}
                {/* Load indicator */}
                {load !== undefined && load > 0 && (
                    <div style={{
                        position: 'absolute',
                        bottom: '2px',
                        left: '2px',
                        right: '2px',
                        height: '3px',
                        background: 'rgba(0,0,0,0.3)',
                        borderRadius: '2px',
                        overflow: 'hidden'
                    }}>
                        <div style={{
                            width: `${Math.min(100, load)}%`,
                            height: '100%',
                            background: load > 70 ? '#ef4444' : load > 40 ? '#f59e0b' : '#10b981',
                            borderRadius: '2px'
                        }} />
                    </div>
                )}
            </div>
        </CoreTooltip>
    );
}

// Palette component - clickable role selector
function Palette({ instances }: { instances: string[] }) {
    const { activeTool, setActiveTool } = useAppStore();

    return (
        <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            padding: '12px 16px',
            background: 'var(--bg-input)',
            borderRadius: '8px',
            marginBottom: '16px',
            alignItems: 'center'
        }}>
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginRight: '4px' }}>
                Роли:
            </div>
            {Object.entries(ROLES).slice(0, 9).map(([id, role]) => {
                const isActive = activeTool === id;
                return (
                    <div
                        key={id}
                        onClick={() => setActiveTool(isActive ? null : id)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            fontSize: '10px',
                            padding: '4px 8px',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            background: isActive ? role.color : 'transparent',
                            color: isActive ? 'white' : 'var(--text-primary)',
                            border: isActive ? `2px solid ${role.color}` : '1px solid var(--border-color)',
                            fontWeight: isActive ? 600 : 400,
                            transition: 'all 0.15s ease'
                        }}
                    >
                        <div style={{
                            width: '10px',
                            height: '10px',
                            background: role.color,
                            borderRadius: '2px',
                            border: '1px solid rgba(255,255,255,0.3)'
                        }} />
                        <span>{role.name}</span>
                    </div>
                );
            })}

            {/* Clear tool button */}
            <div
                onClick={() => setActiveTool(null)}
                style={{
                    fontSize: '10px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    background: activeTool === null ? 'var(--bg-panel)' : 'transparent',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-muted)'
                }}
            >
                ✖ Сброс
            </div>

            {instances.length > 0 && (
                <>
                    <div style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 4px' }} />
                    <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginRight: '4px' }}>
                        Инстансы:
                    </div>
                    {instances.map((inst, idx) => (
                        <div key={inst} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px' }}>
                            <div style={{
                                width: '10px',
                                height: '10px',
                                background: getInstanceColor(inst, idx),
                                borderRadius: '2px'
                            }} />
                            <span>{inst}</span>
                        </div>
                    ))}
                </>
            )}

            {/* Hint */}
            <div style={{
                marginLeft: 'auto',
                fontSize: '10px',
                color: 'var(--text-muted)',
                fontStyle: 'italic'
            }}>
                Click = paint • Ctrl+Click = erase
            </div>
        </div>
    );
}

export function TopologyMap() {
    const { geometry, instances, isolatedCores, coreLoads, activeTool, paintCore, eraseCore, netNumaNodes } = useAppStore();
    const isolatedSet = new Set(isolatedCores);

    const [isDragging, setIsDragging] = useState(false);
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
                fontSize: '12px'
            }}>
                <div><strong>Всего ядер:</strong> {totalCores}</div>
                <div><strong>Изолировано:</strong> {isolatedCount}</div>
                <div><strong>Сокетов:</strong> {Object.keys(geometry).length}</div>
                <div><strong>NUMA узлов:</strong> {Object.values(geometry).reduce((acc, s) => acc + Object.keys(s).length, 0)}</div>
            </div>

            {/* Palette - clickable role selector */}
            <Palette instances={instanceNames} />

            {/* Topology grid */}
            <div className="topology-grid">
                {Object.entries(geometry).map(([socketId, numaData]) => (
                    <div
                        key={socketId}
                        className="socket-card"
                        style={{
                            border: '2px solid var(--color-primary)',
                            borderRadius: '12px',
                            padding: '16px',
                            marginBottom: '16px',
                            background: 'var(--bg-panel)'
                        }}
                    >
                        <div style={{
                            display: 'inline-block',
                            background: 'var(--color-primary)',
                            color: 'white',
                            padding: '6px 16px',
                            borderRadius: '6px',
                            fontSize: '13px',
                            fontWeight: 700,
                            marginBottom: '12px'
                        }}>
                            Socket {socketId}
                        </div>

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                            {Object.entries(numaData).map(([numaId, l3Data]) => (
                                <div
                                    key={numaId}
                                    className="numa-section"
                                    style={{
                                        border: '1px dashed var(--border-color)',
                                        borderRadius: '10px',
                                        padding: '12px',
                                        background: 'rgba(100,100,150,0.05)',
                                        flex: '1 1 auto',
                                        minWidth: '200px'
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

                                    {Object.entries(l3Data).map(([l3Id, cores]) => (
                                        <div
                                            key={l3Id}
                                            className="l3-group"
                                            style={{
                                                background: 'var(--bg-input)',
                                                borderRadius: '8px',
                                                padding: '10px',
                                                marginBottom: '8px'
                                            }}
                                        >
                                            <div style={{
                                                fontSize: '10px',
                                                color: 'var(--text-muted)',
                                                marginBottom: '8px',
                                                fontWeight: 500
                                            }}>
                                                L3 Cache #{l3Id} ({cores.length} ядер)
                                            </div>
                                            <div className="cores-grid" style={{
                                                display: 'flex',
                                                flexWrap: 'wrap',
                                                gap: '6px'
                                            }}>
                                                {cores.map(cpuId => {
                                                    const { roles, owner, instanceColor } = getCoreData(cpuId);
                                                    return (
                                                        <Core
                                                            key={cpuId}
                                                            cpuId={cpuId}
                                                            roles={roles}
                                                            ownerInstance={owner}
                                                            instanceColor={instanceColor}
                                                            isIsolated={isolatedSet.has(cpuId)}
                                                            load={coreLoads[cpuId]}
                                                            onMouseDown={(e) => onCoreMouseDown(cpuId, e)}
                                                            onMouseEnter={() => onCoreMouseEnter(cpuId)}
                                                        />
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
        </div>
    );
}

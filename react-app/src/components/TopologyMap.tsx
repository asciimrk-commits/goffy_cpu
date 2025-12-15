import { useState, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';
import { CoreTooltip } from './Tooltip';

interface CoreProps {
    cpuId: number;
    roles: string[];
    ownerInstance?: string;
    isIsolated: boolean;
    load?: number;
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseEnter: (e: React.MouseEvent) => void;
}

function Core({ cpuId, roles, ownerInstance, isIsolated, load, onMouseDown, onMouseEnter }: CoreProps) {
    const { activeTool } = useAppStore();

    const primaryRole = roles[0];
    const roleColor = primaryRole ? ROLES[primaryRole]?.color || '#64748b' : '#1e293b';
    const borderColor = isIsolated ? '#606080' : 'transparent';
    const hasMultipleRoles = roles.length > 1;

    // Instance coloring override if owner exists? 
    // If owner is specific, maybe use a specific border or indicator?
    // For now, keep role color but use tooltip for instance name.

    // For multi-role: show gradient
    let background = roleColor;
    if (hasMultipleRoles) {
        const colors = roles.slice(0, 3).map(r => ROLES[r]?.color || '#64748b');
        if (colors.length === 2) {
            background = `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)`;
        } else if (colors.length >= 3) {
            background = `linear-gradient(135deg, ${colors[0]} 33%, ${colors[1]} 33% 66%, ${colors[2]} 66%)`;
        }
    }

    return (
        <CoreTooltip cpuId={cpuId} roles={roles} load={load} isIsolated={isIsolated} instanceName={ownerInstance}>
            <div
                onMouseDown={onMouseDown}
                onMouseEnter={onMouseEnter}
                className={`core ${hasMultipleRoles ? 'multi-role' : ''}`}
                title={ownerInstance ? `Instance: ${ownerInstance}` : undefined}
                style={{
                    background,
                    borderColor,
                    cursor: activeTool ? 'pointer' : 'default',
                    position: 'relative'
                }}
            >
                <span className="core-id">{cpuId}</span>
                {ownerInstance && ownerInstance !== 'Physical' && (
                    <div style={{
                        position: 'absolute',
                        bottom: '1px',
                        right: '1px',
                        width: '4px',
                        height: '4px',
                        borderRadius: '50%',
                        backgroundColor: '#fff',
                        opacity: 0.7
                    }} />
                )}
            </div>
        </CoreTooltip>
    );
}

export function TopologyMap() {
    const { geometry, instances, isolatedCores, coreLoads, activeTool, paintCore, eraseCore } = useAppStore();
    const isolatedSet = new Set(isolatedCores);

    const [isDragging, setIsDragging] = useState(false);
    const [dragMode, setDragMode] = useState<'paint' | 'erase'>('paint');

    useEffect(() => {
        const handleMouseUp = () => setIsDragging(false);
        window.addEventListener('mouseup', handleMouseUp);
        return () => window.removeEventListener('mouseup', handleMouseUp);
    }, []);

    if (Object.keys(geometry).length === 0) {
        return (
            <div className="topology-empty">
                <p>Paste cpu-map.sh output and click "Build Map" to visualize topology</p>
            </div>
        );
    }

    const handleAction = (cpuId: number, isCtrl: boolean) => {
        if (!activeTool) return;

        // Determine mode if starting drag
        // If simply called, use current mode if dragging, or deduce from keys

        // Logic:
        // If dragging, use dragMode.
        // If not dragging (click/start), set dragMode based on keys.

        // Actually this handler is called by child.
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

    // Helper to aggregate roles
    const getCoreData = (cpuId: number) => {
        const cpuStr = String(cpuId);
        let allRoles: string[] = [];
        let owner = '';

        // Check all instances
        Object.entries(instances).forEach(([instName, map]) => {
            const roles = map[cpuStr];
            if (roles && roles.length > 0) {
                allRoles = [...allRoles, ...roles];
                if (instName !== 'Physical') {
                    owner = instName; // Prioritize named instances
                } else if (!owner) {
                    owner = 'Physical';
                }
            }
        });

        return { roles: [...new Set(allRoles)], owner };
    };

    return (
        <div className="topology-grid">
            {Object.entries(geometry).map(([socketId, numaData]) => (
                <div key={socketId} className="socket-card">
                    <div className="socket-header">Socket {socketId}</div>
                    {Object.entries(numaData).map(([numaId, l3Data]) => (
                        <div key={numaId} className="numa-section">
                            <div className="numa-header">NUMA {numaId}</div>
                            {Object.entries(l3Data).map(([l3Id, cores]) => (
                                <div key={l3Id} className="l3-group">
                                    <div className="l3-label">L3: {l3Id}</div>
                                    <div className="cores-grid">
                                        {cores.map(cpuId => {
                                            const { roles, owner } = getCoreData(cpuId);
                                            return (
                                                <Core
                                                    key={cpuId}
                                                    cpuId={cpuId}
                                                    roles={roles}
                                                    ownerInstance={owner}
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
            ))}
        </div>
    );
}

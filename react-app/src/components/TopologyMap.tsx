import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';
import { CoreTooltip } from './Tooltip';

interface CoreProps {
    cpuId: number;
    roles: string[];
    isIsolated: boolean;
    load?: number;
}

function Core({ cpuId, roles, isIsolated, load }: CoreProps) {
    const { activeTool, paintCore, eraseCore } = useAppStore();

    const handleClick = (e: React.MouseEvent) => {
        if (!activeTool) return;

        if (e.ctrlKey || e.metaKey) {
            eraseCore(cpuId, activeTool);
        } else {
            paintCore(cpuId, activeTool);
        }
    };

    const primaryRole = roles[0];
    const roleColor = primaryRole ? ROLES[primaryRole]?.color || '#64748b' : '#1e293b';
    const borderColor = isIsolated ? '#f59e0b' : 'transparent';
    const hasMultipleRoles = roles.length > 1;

    // For multi-role: show gradient or split colors
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
        <CoreTooltip cpuId={cpuId} roles={roles} load={load} isIsolated={isIsolated}>
            <div
                onClick={handleClick}
                className={`core ${hasMultipleRoles ? 'multi-role' : ''}`}
                style={{
                    background,
                    borderColor,
                    cursor: activeTool ? 'pointer' : 'default',
                }}
            >
                <span className="core-id">{cpuId}</span>
            </div>
        </CoreTooltip>
    );
}

export function TopologyMap() {
    const { geometry, instances, isolatedCores, coreLoads } = useAppStore();
    const isolatedSet = new Set(isolatedCores);

    if (Object.keys(geometry).length === 0) {
        return (
            <div className="topology-empty">
                <p>Paste cpu-map.sh output and click "Build Map" to visualize topology</p>
            </div>
        );
    }

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
                                        {cores.map(cpuId => (
                                            <Core
                                                key={cpuId}
                                                cpuId={cpuId}
                                                roles={instances.Physical[String(cpuId)] || []}
                                                isIsolated={isolatedSet.has(cpuId)}
                                                load={coreLoads[cpuId]}
                                            />
                                        ))}
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

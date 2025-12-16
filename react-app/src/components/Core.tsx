import { useDrop } from 'react-dnd';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';
import { CoreTooltip } from './Tooltip';

interface CoreProps {
    cpuId: number;
    roles: string[];
    ownerInstance?: string;
    instanceColor?: string;
    ghostOwner?: string;
    ghostColor?: string;
    isIsolated: boolean;
    load?: number;
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseEnter: (e: React.MouseEvent) => void;
    onDrop: (roleId: string) => void;
}

export function Core({ cpuId, roles, ownerInstance, instanceColor, ghostOwner, ghostColor, isIsolated, load, onMouseDown, onMouseEnter, onDrop }: CoreProps) {
    const { activeTool } = useAppStore();

    const [{ isOver, canDrop }, drop] = useDrop(() => ({
        accept: 'ROLE',
        drop: (item: { roleId: string }) => {
            onDrop(item.roleId);
        },
        collect: (monitor) => ({
            isOver: !!monitor.isOver(),
            canDrop: !!monitor.canDrop(),
        }),
    }));

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
                ref={drop as unknown as React.RefObject<HTMLDivElement>}
                onMouseDown={onMouseDown}
                onMouseEnter={onMouseEnter}
                className={`core ${hasMultipleRoles ? 'multi-role' : ''}`}
                style={{
                    background,
                    border: isOver ? '2px solid white' : (canDrop ? '1px dashed rgba(255,255,255,0.5)' : borderStyle),
                    transform: isOver ? 'scale(1.1)' : 'scale(1)',
                    zIndex: isOver ? 10 : 1,
                    cursor: activeTool ? 'pointer' : 'default',
                    position: 'relative',
                    width: '48px',
                    height: '48px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'var(--radius-md)',
                    fontFamily: 'var(--font-mono)',
                    color: '#fff',
                    transition: 'transform 0.1s, box-shadow 0.1s',
                    boxShadow: 'var(--shadow-sm)'
                }}
            >
                {/* Physical ID - Large */}
                <span style={{ fontSize: '14px', fontWeight: 700, lineHeight: 1 }}>{cpuId}</span>
                {/* Role indicator - Small */}
                {primaryRole && (
                    <span style={{ fontSize: '8px', opacity: 0.8, textTransform: 'uppercase', marginTop: '2px' }}>
                        {ROLES[primaryRole]?.name?.substring(0, 3) || ''}
                    </span>
                )}
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
                {/* Ghost Badge (if different) */}
                {ghostOwner && (
                    <div style={{
                        position: 'absolute',
                        bottom: '-4px',
                        right: '-4px',
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        background: 'transparent',
                        border: `2px dashed ${ghostColor || '#fff'}`,
                        zIndex: 20
                    }} title={`Previously: ${ghostOwner}`} />
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

import { useState } from 'react';
import { useDrag } from 'react-dnd';
import { InputPanel } from './InputPanel';
import { TopologyMap } from './TopologyMap';
import { ConfigOutput } from './ConfigOutput';
import { ValidationPanel } from './ValidationPanel';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';

interface DraggableRoleProps {
    id: string;
    role: { name: string; color: string };
    isActive: boolean;
    onClick: () => void;
}

function DraggableRole({ id, role, isActive, onClick }: DraggableRoleProps) {
    const [{ isDragging }, drag] = useDrag(() => ({
        type: 'ROLE',
        item: { roleId: id },
        collect: (monitor) => ({
            isDragging: !!monitor.isDragging(),
        }),
    }));

    return (
        <div
            ref={drag as unknown as React.RefObject<HTMLDivElement>}
            onClick={onClick}
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 10px',
                borderRadius: '6px',
                cursor: 'grab',
                background: isActive ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                border: isActive ? '1px solid var(--color-primary)' : '1px solid transparent',
                transition: 'all 0.15s',
                opacity: isDragging ? 0.5 : 1
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{
                    width: '16px',
                    height: '16px',
                    borderRadius: '4px',
                    background: role.color,
                    border: '1px solid rgba(255,255,255,0.2)'
                }} />
                <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-main)' }}>{role.name}</span>
            </div>

            <div style={{ position: 'relative', width: '32px', height: '18px' }}>
                <div style={{
                    position: 'absolute',
                    top: '2px',
                    left: '0',
                    width: '32px',
                    height: '14px',
                    background: isActive ? 'var(--color-primary)' : 'var(--bg-input)',
                    borderRadius: '7px',
                    border: isActive ? 'none' : '1px solid var(--border-color)',
                    transition: 'background 0.2s'
                }} />
                <div style={{
                    position: 'absolute',
                    top: '0',
                    left: isActive ? '14px' : '0',
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    background: 'white',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                    transition: 'left 0.2s'
                }} />
            </div>
        </div>
    );
}

// Tags & Legend panel with toggle switches
function TagsLegend() {
    const { activeTool, setActiveTool } = useAppStore();

    const roleEntries = Object.entries(ROLES).slice(0, 10);

    return (
        <div style={{
            width: '220px',
            background: 'var(--bg-panel)',
            borderLeft: '1px solid var(--border-color)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            overflowY: 'auto'
        }}>
            <div style={{
                fontSize: '12px',
                fontWeight: 700,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px'
            }}>
                Tags & Legend
            </div>

            {roleEntries.map(([id, role]) => (
                <DraggableRole
                    key={id}
                    id={id}
                    role={role}
                    isActive={activeTool === id}
                    onClick={() => setActiveTool(activeTool === id ? null : id)}
                />
            ))}

            {/* Clear button */}
            <button
                onClick={() => setActiveTool(null)}
                style={{
                    marginTop: '8px',
                    padding: '8px 12px',
                    fontSize: '11px',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    cursor: 'pointer'
                }}
            >
                ✖ Clear Selection
            </button>

            <div style={{
                fontSize: '10px',
                color: 'var(--text-muted)',
                marginTop: '8px',
                paddingTop: '8px',
                borderTop: '1px solid var(--border-color)',
                lineHeight: 1.5
            }}>
                Click = paint core<br />
                Ctrl+Click = erase
            </div>

            {/* Validation Panel */}
            <div style={{
                marginTop: '16px',
                paddingTop: '16px',
                borderTop: '1px solid var(--border-color)'
            }}>
                <div style={{
                    fontSize: '12px',
                    fontWeight: 700,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    marginBottom: '12px'
                }}>
                    L3 Guard
                </div>
                <ValidationPanel />
            </div>
        </div>
    );
}

export function MapperLayout() {
    const [showInput, setShowInput] = useState(true);

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            width: '100%',
            overflow: 'hidden'
        }}>
            {/* Main content area */}
            <div style={{
                display: 'flex',
                flex: 1,
                minHeight: 0,
                overflow: 'hidden'
            }}>
                {/* Left: Input Panel (collapsible) */}
                {showInput && (
                    <div style={{
                        width: '280px',
                        minWidth: '280px',
                        borderRight: '1px solid var(--border-color)',
                        padding: '12px',
                        overflow: 'auto',
                        background: 'var(--bg-panel)'
                    }}>
                        <InputPanel />
                    </div>
                )}

                {/* Toggle input button */}
                <button
                    onClick={() => setShowInput(!showInput)}
                    style={{
                        position: 'absolute',
                        left: showInput ? '268px' : '0',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        width: '24px',
                        height: '48px',
                        background: 'var(--bg-panel)',
                        border: '1px solid var(--border-color)',
                        borderRadius: showInput ? '0 6px 6px 0' : '0 6px 6px 0',
                        cursor: 'pointer',
                        zIndex: 10,
                        transition: 'left 0.3s',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '12px'
                    }}
                >
                    {showInput ? '◀' : '▶'}
                </button>

                {/* Center: Topology */}
                <div style={{
                    flex: 1,
                    overflow: 'auto',
                    padding: '16px',
                    minWidth: 0
                }}>
                    <TopologyMap />
                </div>

                {/* Right: Tags & Legend */}
                <TagsLegend />
            </div>

            {/* Bottom: Config Output - smaller */}
            <div style={{
                borderTop: '1px solid var(--border-color)',
                background: 'var(--bg-panel)',
                maxHeight: '150px',
                minHeight: '40px',
                overflow: 'auto',
                fontSize: '11px'
            }}>
                <ConfigOutput />
            </div>
        </div>
    );
}

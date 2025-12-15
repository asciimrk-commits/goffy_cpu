import { useState } from 'react';
import { InputPanel } from './InputPanel';
import { TopologyMap } from './TopologyMap';
import { ConfigOutput } from './ConfigOutput';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';

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

            {roleEntries.map(([id, role]) => {
                const isActive = activeTool === id;
                return (
                    <div
                        key={id}
                        onClick={() => setActiveTool(isActive ? null : id)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 10px',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            background: isActive ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                            border: isActive ? '1px solid var(--color-primary)' : '1px solid transparent',
                            transition: 'all 0.15s'
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
                            <span style={{
                                fontSize: '12px',
                                fontWeight: isActive ? 600 : 400,
                                color: isActive ? 'var(--color-primary)' : 'var(--text-primary)'
                            }}>
                                {role.name}
                            </span>
                        </div>

                        {/* Toggle switch */}
                        <div style={{
                            width: '36px',
                            height: '20px',
                            borderRadius: '10px',
                            background: isActive ? 'var(--color-primary)' : 'var(--bg-input)',
                            position: 'relative',
                            transition: 'background 0.2s'
                        }}>
                            <div style={{
                                position: 'absolute',
                                top: '2px',
                                left: isActive ? '18px' : '2px',
                                width: '16px',
                                height: '16px',
                                borderRadius: '50%',
                                background: 'white',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                                transition: 'left 0.2s'
                            }} />
                        </div>
                    </div>
                );
            })}

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
                marginTop: 'auto',
                lineHeight: 1.5
            }}>
                Click = paint core<br />
                Ctrl+Click = erase
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

            {/* Bottom: Config Output (collapsible) */}
            <div style={{
                borderTop: '1px solid var(--border-color)',
                background: 'var(--bg-panel)',
                maxHeight: '200px',
                overflow: 'auto'
            }}>
                <ConfigOutput />
            </div>
        </div>
    );
}

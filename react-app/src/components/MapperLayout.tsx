import { useState } from 'react';
import { InputPanel } from './InputPanel';
import { TopologyMap } from './TopologyMap';
import { ConfigOutput } from './ConfigOutput';

export function MapperLayout() {
    const [leftPanelOpen, setLeftPanelOpen] = useState(true);
    const [rightPanelOpen, setRightPanelOpen] = useState(false);

    const panelWidth = 280;

    return (
        <div style={{
            display: 'flex',
            height: '100%',
            width: '100%',
            overflow: 'hidden',
            position: 'relative'
        }}>
            {/* Left Panel - Input */}
            <div style={{
                width: leftPanelOpen ? panelWidth : 0,
                minWidth: leftPanelOpen ? panelWidth : 0,
                transition: 'all 0.3s ease',
                overflow: 'hidden',
                borderRight: leftPanelOpen ? '1px solid var(--border-color)' : 'none'
            }}>
                <div style={{ width: panelWidth, height: '100%', padding: '12px' }}>
                    <InputPanel />
                </div>
            </div>

            {/* Left Toggle Button */}
            <button
                onClick={() => setLeftPanelOpen(!leftPanelOpen)}
                style={{
                    position: 'absolute',
                    left: leftPanelOpen ? panelWidth - 12 : 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: '24px',
                    height: '48px',
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--border-color)',
                    borderRadius: leftPanelOpen ? '0 6px 6px 0' : '0 6px 6px 0',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10,
                    transition: 'left 0.3s ease',
                    color: 'var(--text-primary)',
                    fontSize: '12px'
                }}
                title={leftPanelOpen ? 'Hide Input' : 'Show Input'}
            >
                {leftPanelOpen ? '◀' : '▶'}
            </button>

            {/* Center - Topology */}
            <div style={{
                flex: 1,
                overflow: 'auto',
                padding: '12px',
                minWidth: 0
            }}>
                <TopologyMap />
            </div>

            {/* Right Toggle Button */}
            <button
                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                style={{
                    position: 'absolute',
                    right: rightPanelOpen ? panelWidth - 12 : 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: '24px',
                    height: '48px',
                    background: 'var(--bg-panel)',
                    border: '1px solid var(--border-color)',
                    borderRadius: rightPanelOpen ? '6px 0 0 6px' : '6px 0 0 6px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 10,
                    transition: 'right 0.3s ease',
                    color: 'var(--text-primary)',
                    fontSize: '12px'
                }}
                title={rightPanelOpen ? 'Hide Config' : 'Show Config'}
            >
                {rightPanelOpen ? '▶' : '◀'}
            </button>

            {/* Right Panel - Config Output */}
            <div style={{
                width: rightPanelOpen ? panelWidth : 0,
                minWidth: rightPanelOpen ? panelWidth : 0,
                transition: 'all 0.3s ease',
                overflow: 'hidden',
                borderLeft: rightPanelOpen ? '1px solid var(--border-color)' : 'none'
            }}>
                <div style={{ width: panelWidth, height: '100%', padding: '12px' }}>
                    <ConfigOutput />
                </div>
            </div>
        </div>
    );
}

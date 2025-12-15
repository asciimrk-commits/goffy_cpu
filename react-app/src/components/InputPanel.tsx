import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { parseTopology } from '../lib/parser';

export function InputPanel() {
    const {
        rawInput,
        setRawInput,
        setServerInfo,
        setGeometry,
        setIsolatedCores,
        setCoreNumaMap,
        setL3Groups,
        setNetworkInterfaces,
        setNetNumaNodes,
        setCoreLoads,
        setInstances
    } = useAppStore();

    const [isExpanded, setIsExpanded] = useState(true);
    const hasData = rawInput.trim().length > 0;

    const handleBuild = () => {
        if (!rawInput.trim()) return;
        try {
            const result = parseTopology(rawInput);
            setServerInfo(result.serverName, result.date);
            setGeometry(result.geometry);
            setIsolatedCores(result.isolatedCores);
            setCoreNumaMap(result.coreNumaMap);
            setL3Groups(result.l3Groups);
            setNetworkInterfaces(result.networkInterfaces);
            setNetNumaNodes(result.netNumaNodes);
            setCoreLoads(result.coreLoads);
            setInstances(result.instances);
            // Collapse after successful build
            setIsExpanded(false);
        } catch (e) {
            console.error(e);
            alert('Error parsing input');
        }
    };

    const handleClear = () => {
        setRawInput('');
    };

    return (
        <div className="input-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Collapsible header */}
            <div
                onClick={() => setIsExpanded(!isExpanded)}
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 12px',
                    cursor: 'pointer',
                    background: 'var(--bg-input)',
                    borderRadius: isExpanded ? '8px 8px 0 0' : '8px',
                    marginBottom: isExpanded ? 0 : '0'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>📥 Input Data</span>
                    {hasData && !isExpanded && (
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                            ({rawInput.split('\n').length} lines)
                        </span>
                    )}
                </div>
                <span style={{
                    transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                    fontSize: '10px'
                }}>▼</span>
            </div>

            {/* Collapsible content */}
            {isExpanded && (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    flex: 1,
                    padding: '12px',
                    background: 'var(--bg-input)',
                    borderRadius: '0 0 8px 8px'
                }}>
                    <textarea
                        className="input-area"
                        value={rawInput}
                        onChange={(e) => setRawInput(e.target.value)}
                        placeholder="Paste cpu-map.sh output here..."
                        style={{
                            flex: 1,
                            minHeight: '120px',
                            resize: 'none',
                            fontFamily: 'monospace',
                            fontSize: '10px',
                            padding: '10px',
                            background: 'var(--bg-panel)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '6px',
                            color: 'var(--text-main)',
                            outline: 'none'
                        }}
                    />

                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button className="btn-primary" onClick={handleBuild} style={{ flex: 1, padding: '8px' }}>
                            Build
                        </button>
                        <button
                            onClick={handleClear}
                            style={{ padding: '8px 12px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '12px' }}
                        >
                            Clear
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

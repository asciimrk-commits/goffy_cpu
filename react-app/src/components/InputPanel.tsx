import { useState } from 'react';
import { useDrag } from 'react-dnd';
import { useAppStore } from '../store/appStore';
import { parseTopology } from '../lib/parser';

function DraggableInstance({ name, count }: { name: string; count: number }) {
    const [{ isDragging }, drag] = useDrag(() => ({
        type: 'INSTANCE',
        item: { instanceId: name },
        collect: (monitor) => ({
            isDragging: !!monitor.isDragging(),
        }),
    }));

    return (
        <div
            ref={drag as unknown as React.RefObject<HTMLDivElement>}
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                marginBottom: '8px',
                cursor: 'grab',
                opacity: isDragging ? 0.5 : 1,
                fontSize: '12px'
            }}
        >
            <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>{name}</span>
            <span style={{
                color: 'var(--text-muted)',
                background: 'rgba(255,255,255,0.05)',
                padding: '2px 6px',
                borderRadius: '4px',
                fontSize: '10px'
            }}>{count} cores</span>
        </div>
    );
}

export function InputPanel() {
    const {
        rawInput,
        instances,
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
            {/* Instance List */}
            {hasData && (
                <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0' }}>
                    <div style={{
                        fontSize: '12px',
                        fontWeight: 700,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        marginBottom: '12px'
                    }}>
                        Instances ({Object.keys(instances).length - 1})
                    </div>

                    {Object.entries(instances)
                        .filter(([name]) => name !== 'Physical')
                        .map(([name, cores]) => (
                            <DraggableInstance
                                key={name}
                                name={name}
                                count={Object.keys(cores).length}
                            />
                        ))
                    }

                    {Object.keys(instances).length <= 1 && (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                            No instances found.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

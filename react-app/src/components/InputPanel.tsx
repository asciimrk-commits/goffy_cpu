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
        } catch (e) {
            console.error(e);
            alert('Error parsing input');
        }
    };

    const handleClear = () => {
        setRawInput('');
    };

    return (
        <div className="input-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
            <div className="panel-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', marginBottom: '4px' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600 }}>Input Data</h3>
            </div>

            <textarea
                className="input-area"
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                placeholder="Paste cpu-map.sh output here..."
                style={{
                    flex: 1,
                    resize: 'none',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    padding: '12px',
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    color: 'var(--text-main)',
                    outline: 'none'
                }}
            />

            <div className="button-group" style={{ display: 'flex', gap: '12px' }}>
                <button className="btn-primary" onClick={handleBuild} style={{ flex: 1 }}>Build</button>
                <button onClick={handleClear} style={{ background: 'transparent', border: '1px solid var(--border-color)' }}>Clear</button>
            </div>

            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                Supports <code>cpu-map.sh</code> output.
            </div>
        </div>
    );
}

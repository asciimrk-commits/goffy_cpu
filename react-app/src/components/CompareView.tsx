import { useState } from 'react';
import { parseTopology } from '../lib/parser';
import { ROLES } from '../types/topology';
import type { Geometry, InstanceConfig } from '../types/topology';

interface ConfigData {
    serverName: string;
    geometry: Geometry;
    isolatedCores: number[];
    instances: InstanceConfig;
}

function ComparePanel({ config }: { config: ConfigData | null }) {
    if (!config) {
        return (
            <div className="compare-panel empty">
                <p>Paste config and click Parse</p>
            </div>
        );
    }

    const isolatedSet = new Set(config.isolatedCores);

    return (
        <div className="compare-panel">
            <h4>{config.serverName}</h4>
            {Object.entries(config.geometry).map(([socketId, numaData]) => (
                <div key={socketId} className="cmp-socket">
                    <div className="cmp-socket-header">Socket {socketId}</div>
                    {Object.entries(numaData).map(([numaId, l3Data]) => (
                        <div key={numaId} className="cmp-numa">
                            <div className="cmp-numa-header">NUMA {numaId}</div>
                            <div className="cmp-cores">
                                {Object.values(l3Data).flat().map(cpuId => {
                                    const roles = config.instances.Physical[String(cpuId)] || [];
                                    const primaryRole = roles[0];
                                    const color = primaryRole ? ROLES[primaryRole]?.color || '#64748b' : '#1e293b';
                                    const isIsolated = isolatedSet.has(cpuId);
                                    const roleNames = roles.map(r => ROLES[r]?.name || r).join(', ');

                                    return (
                                        <div
                                            key={cpuId}
                                            className={`cmp-core ${roles.length > 1 ? 'multi-role' : ''}`}
                                            style={{
                                                backgroundColor: color,
                                                borderColor: isIsolated ? '#f59e0b' : 'transparent',
                                            }}
                                            title={`CPU ${cpuId}: ${roleNames || 'none'}`}
                                        >
                                            <span className="core-id">{cpuId}</span>
                                            {roles.length > 1 && (
                                                <div className="role-dots">
                                                    {roles.slice(0, 3).map((r, i) => (
                                                        <span
                                                            key={i}
                                                            className="role-dot"
                                                            style={{ backgroundColor: ROLES[r]?.color || '#64748b' }}
                                                        />
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

export function CompareView() {
    const [oldText, setOldText] = useState('');
    const [newText, setNewText] = useState('');
    const [oldServerName, setOldServerName] = useState('');
    const [newServerName, setNewServerName] = useState('');
    const [oldConfig, setOldConfig] = useState<ConfigData | null>(null);
    const [newConfig, setNewConfig] = useState<ConfigData | null>(null);

    const handleParse = (side: 'old' | 'new') => {
        const text = side === 'old' ? oldText : newText;
        const result = parseTopology(text);

        const serverName = result.serverName || `Config ${side.toUpperCase()}`;

        const config: ConfigData = {
            serverName,
            geometry: result.geometry,
            isolatedCores: result.isolatedCores,
            instances: result.instances,
        };

        if (side === 'old') {
            setOldConfig(config);
            setOldServerName(serverName); // Auto-fill server name field
        } else {
            setNewConfig(config);
            setNewServerName(serverName); // Auto-fill server name field
        }
    };

    return (
        <div className="compare-view">
            <div className="compare-grid">
                {/* Old Config */}
                <div className="compare-side">
                    <div className="compare-input">
                        <input
                            type="text"
                            placeholder="Server name (old)"
                            className="input-server"
                            value={oldServerName}
                            onChange={(e) => setOldServerName(e.target.value)}
                        />
                        <textarea
                            value={oldText}
                            onChange={(e) => setOldText(e.target.value)}
                            placeholder="Paste old cpu-map.sh output..."
                            className="compare-textarea"
                        />
                        <button className="btn btn-primary" onClick={() => handleParse('old')}>
                            Parse Old
                        </button>
                    </div>
                    <ComparePanel config={oldConfig} />
                </div>

                {/* New Config */}
                <div className="compare-side">
                    <div className="compare-input">
                        <input
                            type="text"
                            placeholder="Server name (new)"
                            className="input-server"
                            value={newServerName}
                            onChange={(e) => setNewServerName(e.target.value)}
                        />
                        <textarea
                            value={newText}
                            onChange={(e) => setNewText(e.target.value)}
                            placeholder="Paste new cpu-map.sh output..."
                            className="compare-textarea"
                        />
                        <button className="btn btn-primary" onClick={() => handleParse('new')}>
                            Parse New
                        </button>
                    </div>
                    <ComparePanel config={newConfig} />
                </div>
            </div>
        </div>
    );
}

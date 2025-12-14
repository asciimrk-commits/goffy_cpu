import { useState, useRef } from 'react';
import { parseTopology, parseYamlConfig } from '../lib/parser';
import { ROLES } from '../types/topology';
import type { Geometry, InstanceConfig } from '../types/topology';
import { CoreTooltip } from './Tooltip';

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
        <p>Paste config or load file, then click Parse</p>
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
                  const hasMultipleRoles = roles.length > 1;

                  let background = color;
                  if (hasMultipleRoles) {
                    const colors = roles.slice(0, 3).map(r => ROLES[r]?.color || '#64748b');
                    if (colors.length === 2) {
                      background = `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)`;
                    } else if (colors.length >= 3) {
                      background = `linear-gradient(135deg, ${colors[0]} 33%, ${colors[1]} 33% 66%, ${colors[2]} 66%)`;
                    }
                  }

                  return (
                    <CoreTooltip
                      key={cpuId}
                      cpuId={cpuId}
                      roles={roles}
                      isIsolated={isIsolated}
                    >
                      <div
                        className={`cmp-core ${hasMultipleRoles ? 'multi-role' : ''}`}
                        style={{
                          background,
                          borderColor: isIsolated ? '#606080' : 'transparent',
                        }}
                      >
                        <span className="core-id">{cpuId}</span>
                      </div>
                    </CoreTooltip>
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

  const oldFileRef = useRef<HTMLInputElement>(null);
  const newFileRef = useRef<HTMLInputElement>(null);

  const handleFileLoad = (side: 'old' | 'new') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (side === 'old') {
        setOldText(content);
      } else {
        setNewText(content);
      }
    };
    reader.readAsText(file);
  };

  const handleParse = (side: 'old' | 'new') => {
    const text = side === 'old' ? oldText : newText;

    // Try YAML config parser first, fall back to cpu-map.sh parser
    let result = parseYamlConfig(text);
    if (!result) {
      result = parseTopology(text);
    }

    const serverName = result.serverName || `Config ${side.toUpperCase()}`;

    const config: ConfigData = {
      serverName,
      geometry: result.geometry,
      isolatedCores: result.isolatedCores,
      instances: result.instances,
    };

    if (side === 'old') {
      setOldConfig(config);
      setOldServerName(serverName);
    } else {
      setNewConfig(config);
      setNewServerName(serverName);
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
            <div className="file-input-row">
              <input
                type="file"
                ref={oldFileRef}
                onChange={handleFileLoad('old')}
                accept=".txt,.log,.sh,.yaml,.yml"
                style={{ display: 'none' }}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => oldFileRef.current?.click()}
              >
                Load File
              </button>
            </div>
            <textarea
              value={oldText}
              onChange={(e) => setOldText(e.target.value)}
              placeholder="Paste cpu-map.sh output or load file..."
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
            <div className="file-input-row">
              <input
                type="file"
                ref={newFileRef}
                onChange={handleFileLoad('new')}
                accept=".txt,.log,.sh,.yaml,.yml"
                style={{ display: 'none' }}
              />
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => newFileRef.current?.click()}
              >
                Load File
              </button>
            </div>
            <textarea
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              placeholder="Paste cpu-map.sh output or load file..."
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

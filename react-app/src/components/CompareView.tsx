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
      <div className="compare-panel empty" style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '200px',
        color: 'var(--text-muted)'
      }}>
        <p>Вставьте конфиг или загрузите файл, затем нажмите Parse</p>
      </div>
    );
  }

  const isolatedSet = new Set(config.isolatedCores);

  // Calculate stats
  const totalCores = Object.values(config.geometry).flatMap(s =>
    Object.values(s).flatMap(n => Object.values(n).flat())
  ).length;

  return (
    <div className="compare-panel">
      {/* Header with server name and stats */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px',
        padding: '8px 12px',
        background: 'var(--bg-input)',
        borderRadius: '8px'
      }}>
        <h4 style={{ margin: 0, fontSize: '14px' }}>{config.serverName || 'Конфигурация'}</h4>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Ядер: {totalCores} | Изолировано: {config.isolatedCores.length}
        </div>
      </div>

      {Object.entries(config.geometry).map(([socketId, numaData]) => (
        <div
          key={socketId}
          className="socket-card"
          style={{
            border: '2px solid var(--color-primary)',
            borderRadius: '12px',
            padding: '12px',
            marginBottom: '12px',
            background: 'var(--bg-panel)'
          }}
        >
          <div style={{
            display: 'inline-block',
            background: 'var(--color-primary)',
            color: 'white',
            padding: '4px 12px',
            borderRadius: '6px',
            fontSize: '11px',
            fontWeight: 700,
            marginBottom: '10px'
          }}>
            Socket {socketId}
          </div>

          {Object.entries(numaData).map(([numaId, l3Data]) => (
            <div
              key={numaId}
              className="numa-section"
              style={{
                border: '1px dashed var(--border-color)',
                borderRadius: '8px',
                padding: '10px',
                marginBottom: '8px',
                background: 'rgba(100,100,150,0.03)'
              }}
            >
              <div style={{
                fontSize: '10px',
                fontWeight: 600,
                marginBottom: '8px'
              }}>
                <span style={{
                  background: 'var(--color-accent)',
                  color: 'white',
                  padding: '2px 6px',
                  borderRadius: '4px'
                }}>
                  NUMA {numaId}
                </span>
              </div>

              {Object.entries(l3Data).map(([l3Id, cores]) => (
                <div
                  key={l3Id}
                  style={{
                    background: 'var(--bg-input)',
                    borderRadius: '6px',
                    padding: '8px',
                    marginBottom: '6px'
                  }}
                >
                  <div style={{
                    fontSize: '9px',
                    color: 'var(--text-muted)',
                    marginBottom: '6px'
                  }}>
                    L3 #{l3Id} ({cores.length} ядер)
                  </div>
                  <div className="cmp-cores" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {cores.map(cpuId => {
                      const roles = config.instances.Physical[String(cpuId)] || [];
                      const primaryRole = roles[0];
                      const color = primaryRole ? ROLES[primaryRole]?.color || '#64748b' : '#334155';
                      const isIsolated = isolatedSet.has(cpuId);
                      const hasMultipleRoles = roles.length > 1;

                      let background = color;
                      if (hasMultipleRoles) {
                        const colors = roles.slice(0, 3).map(r => ROLES[r]?.color || '#64748b');
                        if (colors.length === 2) background = `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)`;
                        else if (colors.length >= 3) background = `linear-gradient(135deg, ${colors[0]} 33%, ${colors[1]} 33% 66%, ${colors[2]} 66%)`;
                      }

                      return (
                        <CoreTooltip
                          key={cpuId}
                          cpuId={cpuId}
                          roles={roles}
                          isIsolated={isIsolated}
                        >
                          <div
                            className={`core ${hasMultipleRoles ? 'multi-role' : ''}`}
                            style={{
                              width: '32px',
                              height: '32px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              background,
                              border: isIsolated ? '2px solid rgba(255,255,255,0.4)' : '1px solid rgba(255,255,255,0.1)',
                              borderRadius: '4px',
                              color: '#fff',
                              fontSize: '10px',
                              fontWeight: 600,
                              opacity: roles.length > 0 || isIsolated ? 1 : 0.3
                            }}
                          >
                            {cpuId}
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

  // Inline styles for cleaner layout
  const inputCardStyle: React.CSSProperties = {
    background: 'var(--bg-panel)',
    borderRadius: '12px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px'
  };

  const inputRowStyle: React.CSSProperties = {
    display: 'flex',
    gap: '8px',
    alignItems: 'center'
  };

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    height: '120px',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    padding: '10px',
    fontSize: '11px',
    fontFamily: 'monospace',
    color: 'var(--text-primary)',
    resize: 'vertical'
  };

  const serverInputStyle: React.CSSProperties = {
    flex: 1,
    padding: '8px 12px',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    fontSize: '13px',
    color: 'var(--text-primary)'
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
      padding: '16px',
      gap: '16px'
    }}>
      {/* Input Section */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '16px',
        flexShrink: 0
      }}>
        {/* Old Config Input */}
        <div style={inputCardStyle}>
          <div style={{ fontWeight: 600, fontSize: '13px', color: '#f59e0b' }}>OLD Config</div>
          <div style={inputRowStyle}>
            <input
              type="text"
              placeholder="Server name (old)"
              style={serverInputStyle}
              value={oldServerName}
              onChange={(e) => setOldServerName(e.target.value)}
            />
            <input
              type="file"
              ref={oldFileRef}
              onChange={handleFileLoad('old')}
              accept=".txt,.log,.sh,.yaml,.yml"
              style={{ display: 'none' }}
            />
            <button
              className="btn-ghost"
              style={{ padding: '8px 12px', fontSize: '11px' }}
              onClick={() => oldFileRef.current?.click()}
            >
              Load File
            </button>
          </div>
          <textarea
            value={oldText}
            onChange={(e) => setOldText(e.target.value)}
            placeholder="Paste cpu-map.sh output or load file..."
            style={textareaStyle}
          />
          <button
            className="btn-primary"
            style={{ padding: '10px', fontSize: '12px' }}
            onClick={() => handleParse('old')}
          >
            Parse Old
          </button>
        </div>

        {/* New Config Input */}
        <div style={inputCardStyle}>
          <div style={{ fontWeight: 600, fontSize: '13px', color: '#10b981' }}>NEW Config</div>
          <div style={inputRowStyle}>
            <input
              type="text"
              placeholder="Server name (new)"
              style={serverInputStyle}
              value={newServerName}
              onChange={(e) => setNewServerName(e.target.value)}
            />
            <input
              type="file"
              ref={newFileRef}
              onChange={handleFileLoad('new')}
              accept=".txt,.log,.sh,.yaml,.yml"
              style={{ display: 'none' }}
            />
            <button
              className="btn-ghost"
              style={{ padding: '8px 12px', fontSize: '11px' }}
              onClick={() => newFileRef.current?.click()}
            >
              Load File
            </button>
          </div>
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder="Paste cpu-map.sh output or load file..."
            style={textareaStyle}
          />
          <button
            className="btn-primary"
            style={{ padding: '10px', fontSize: '12px' }}
            onClick={() => handleParse('new')}
          >
            Parse New
          </button>
        </div>
      </div>

      {/* Results Section */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '16px',
        flex: 1,
        overflow: 'auto',
        minHeight: 0
      }}>
        <div style={{
          background: 'var(--bg-panel)',
          borderRadius: '12px',
          padding: '16px',
          overflow: 'auto',
          border: oldConfig ? '2px solid #f59e0b' : '1px solid var(--border-color)'
        }}>
          <ComparePanel config={oldConfig} />
        </div>
        <div style={{
          background: 'var(--bg-panel)',
          borderRadius: '12px',
          padding: '16px',
          overflow: 'auto',
          border: newConfig ? '2px solid #10b981' : '1px solid var(--border-color)'
        }}>
          <ComparePanel config={newConfig} />
        </div>
      </div>
    </div>
  );
}


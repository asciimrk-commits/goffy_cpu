import { useState, useRef, useMemo } from 'react';
import { parseTopology, parseYamlConfig } from '../lib/parser';

import type { Geometry, InstanceConfig } from '../types/topology';
import { Core } from './Core';
import { L3Island } from './L3Island';
import { classifyL3Zones } from '../lib/hftOptimizer';

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

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { socketGroups, totalCores, isolatedSet } = useMemo(() => {
    if (!config) return { socketGroups: {}, totalCores: 0, isolatedSet: new Set<number>() };

    // 1. Rebuild maps for classifier
    const coreNumaMap: Record<string, number> = {};
    const l3Groups: Record<string, number[]> = {};

    // Parse geometry
    let tCores = 0;
    Object.entries(config.geometry).forEach(([, numas]) => {
      Object.entries(numas).forEach(([numaId, l3s]) => {
        const nId = Number(numaId);
        Object.entries(l3s).forEach(([l3Id, cores]) => {
          l3Groups[l3Id] = cores;
          cores.forEach(c => coreNumaMap[String(c)] = nId);
          tCores += cores.length;
        });
      });
    });

    // 2. Infer OS cores
    const instancePhysical = config.instances.Physical || {};
    const osCores = Object.entries(instancePhysical)
      .filter(([, roles]) => roles.includes('sys_os'))
      .map(([id]) => Number(id));

    // 3. Classify Zones (assume Net NUMA = 0)
    const l3List = classifyL3Zones(l3Groups, coreNumaMap, 0, osCores);

    // 4. Group by Socket for display
    // Map L3 ID back to Socket? We can use coreNumaMap -> NUMA -> Socket?
    // Geometry is Socket -> Numa -> L3.
    // Let's iterate Geometry and attach Zone info.

    // Create a map of L3ID -> Zone
    const zoneMap = new Map(l3List.map(l3 => [l3.id, l3]));

    const sGroups: Record<string, typeof config.geometry[string]> = config.geometry;
    const iSet = new Set(config.isolatedCores);

    return { socketGroups: sGroups, totalCores: tCores, zoneMap, isolatedSet: iSet };
  }, [config]);

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

  // Helper to find instance owner
  const getOwner = (cpuId: number) => {
    return Object.entries(config.instances).find(([name, coreMap]) => {
      if (name === 'Physical') return false;
      return !!coreMap[String(cpuId)];
    })?.[0];
  };

  // Helper for colors
  const PREDEFINED = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4'];
  const getInstColor = (name?: string) => {
    if (!name) return undefined;
    // Simple hash for consistency
    const idx = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return PREDEFINED[idx % PREDEFINED.length];
  };

  return (
    <div className="compare-panel">
      {/* Header */}
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

      {/* Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {Object.entries(socketGroups).map(([socketId, numas]) => (
          <div key={socketId} style={{
            border: '1px solid var(--border-color)',
            borderRadius: '8px',
            padding: '12px',
            background: 'var(--bg-panel)'
          }}>
            <div style={{ fontSize: '10px', fontWeight: 700, marginBottom: '8px', color: 'var(--text-muted)' }}>
              SOCKET {socketId}
            </div>

            {Object.entries(numas).map(([numaId, l3s]) => (
              <div key={numaId} style={{ marginBottom: '8px' }}>
                {Object.entries(l3s).map(([l3Id, cores]) => {
                  // Find classified zone
                  // Reconstruct core list or look up in calculated L3 list?
                  // classifyL3Zones takes l3Groups.
                  // We can just find the relevant L3Cache object
                  const nId = Number(numaId);
                  // We need to match Logic with UI
                  // Let's use the classified zone if available, else silver
                  // But map logic in useMemo is complex.

                  // Let's just re-classify on fly or use lookups?
                  // Better: Pass `zoneMap` from useMemo

                  return (
                    <div key={l3Id} style={{ marginBottom: '8px' }}>
                      {/* We need to wrap it in a way L3Island expects */}
                      {/* But L3Island includes styles for visual box */}
                      {/* Let's render L3Island directly */}
                      <L3Config
                        l3Id={l3Id}
                        cores={cores}
                        numaId={nId}
                        config={config}
                        isolatedSet={isolatedSet}
                        getOwner={getOwner}
                        getInstColor={getInstColor}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// Helper component to separate logic
function L3Config({ l3Id, cores, numaId, config, isolatedSet, getOwner, getInstColor }: any) {
  const hasOs = cores.some((c: number) => (config.instances.Physical[String(c)] || []).includes('sys_os'));
  const isNetwork = numaId === 0; // Assumption
  const zone = hasOs ? 'dirty' : (isNetwork ? 'gold' : 'silver');

  return (
    <L3Island l3Id={l3Id} zone={zone} numa={numaId} coreCount={cores.length}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        {cores.map((cpuId: number) => {
          const roles = config.instances.Physical[String(cpuId)] || [];
          const owner = getOwner(cpuId);
          const isIso = isolatedSet.has(cpuId);

          return (
            <Core
              key={cpuId}
              cpuId={cpuId}
              roles={roles}
              ownerInstance={owner}
              instanceColor={getInstColor(owner)}
              isIsolated={isIso}
              load={0} // No load in static config
              onMouseDown={() => { }}
              onMouseEnter={() => { }}
              onDrop={() => { }}
            />
          );
        })}
      </div>
    </L3Island>
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

  // State for collapsible sections
  const [inputsExpanded, setInputsExpanded] = useState(true);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
      padding: '16px',
      gap: '16px'
    }}>
      {/* Collapsible Input Section */}
      <div style={{
        background: 'var(--bg-panel)',
        borderRadius: '12px',
        overflow: 'hidden',
        flexShrink: 0
      }}>
        {/* Header - clickable to collapse */}
        <div
          onClick={() => setInputsExpanded(!inputsExpanded)}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
            cursor: 'pointer',
            background: 'var(--bg-input)',
            borderBottom: inputsExpanded ? '1px solid var(--border-color)' : 'none'
          }}
        >
          <div style={{ fontWeight: 600, fontSize: '14px' }}>
            📥 Загрузка конфигураций
          </div>
          <div style={{
            transform: inputsExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s'
          }}>
            ▼
          </div>
        </div>

        {/* Collapsible content */}
        {inputsExpanded && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '16px',
            padding: '16px'
          }}>
            {/* Old Config Input */}
            <div style={inputCardStyle}>
              <div style={{ fontWeight: 600, fontSize: '13px', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ background: '#f59e0b', color: 'white', padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>OLD</span>
                {oldConfig && <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>✓ Загружено</span>}
              </div>
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
                  📁 File
                </button>
              </div>
              <textarea
                value={oldText}
                onChange={(e) => setOldText(e.target.value)}
                placeholder="Вставьте сюда вывод cpu-map.sh или Bender YAML конфиг..."
                style={{ ...textareaStyle, minHeight: '100px' }}
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
              <div style={{ fontWeight: 600, fontSize: '13px', color: '#10b981', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ background: '#10b981', color: 'white', padding: '2px 8px', borderRadius: '4px', fontSize: '11px' }}>NEW</span>
                {newConfig && <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>✓ Загружено</span>}
              </div>
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
                  📁 File
                </button>
              </div>
              <textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="Вставьте сюда вывод cpu-map.sh или Bender YAML конфиг..."
                style={{ ...textareaStyle, minHeight: '100px' }}
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
        )}
      </div>

      {/* Results Section - now takes more space */}
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


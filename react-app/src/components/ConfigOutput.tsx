import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { formatCoreRange } from '../lib/parser';

export function ConfigOutput() {
    const {
        serverName,
        instances,
        isolatedCores,
        coreNumaMap,
    } = useAppStore();

    const [isExpanded, setIsExpanded] = useState(false);

    const generateConfig = () => {
        const physicalRoles: Record<string, number[]> = {};

        Object.entries(instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!physicalRoles[t]) physicalRoles[t] = [];
                physicalRoles[t].push(parseInt(cpu));
            });
        });

        // Sort all role cores
        Object.keys(physicalRoles).forEach(role => {
            physicalRoles[role].sort((a, b) => a - b);
        });

        const instanceName = serverName?.toUpperCase() || 'INSTANCE';

        // Get all NUMAs for membind
        const trashCpu = physicalRoles['trash']?.[0] || '';
        const allNumas = [...new Set(Object.values(coreNumaMap))].sort((a, b) => a - b);
        const membind = allNumas.join(',');

        // Build YAML-style config
        let txt = 'bs_instances:\n';
        txt += `  ${instanceName}:\n`;
        txt += `    path: bender2-${instanceName}\n`;
        txt += `    name: ${instanceName}\n`;
        txt += `    id: 0\n`;
        txt += `    membind: "${membind}"\n`;
        txt += `    taskset: "${trashCpu}"\n`;
        txt += `    trash_cpu: "${trashCpu}"\n`;

        const arCpu = physicalRoles['ar']?.[0] || '';
        txt += `    allrobots_cpu: "${arCpu}"\n`;

        const rfCpu = physicalRoles['rf']?.[0] || physicalRoles['trash']?.[0] || '';
        txt += `    remoteformula_cpu: "${rfCpu}"\n`;

        const gwCores = physicalRoles['gateway'] || [];
        txt += `    gateways_cpu: ${gwCores.join(',')}\n`;

        const robotsCores = physicalRoles['robot_default'] || [];
        txt += `    robots_cpu: ${robotsCores.join(',')}\n`;

        const udpCores = physicalRoles['udp'] || [];
        txt += `    udpsend_cpu: "${udpCores[0] || ''}"\n`;
        txt += `    udpreceive_cpu: "${udpCores[0] || ''}"\n`;

        txt += `    cpualias_custom:\n`;

        const formulaCpu = physicalRoles['formula']?.[0] || physicalRoles['trash']?.[0] || '';
        if (formulaCpu) {
            txt += `      - <CPUAlias Name="Formula" Cores="${formulaCpu}" />\n`;
        }

        const pool1 = physicalRoles['pool1'] || [];
        if (pool1.length > 0) {
            txt += `      - <CPUAlias Name="RobotsNode1" Cores="${pool1.join(',')}" />\n`;
        }

        const pool2 = physicalRoles['pool2'] || [];
        if (pool2.length > 0) {
            txt += `      - <CPUAlias Name="RobotsNode2" Cores="${pool2.join(',')}" />\n`;
        }

        txt += '\n---\n';
        if (isolatedCores.length > 0) {
            txt += `isol_cpus: ${formatCoreRange(isolatedCores)}\n`;
        }

        const sysCores = (physicalRoles['sys_os'] || []).sort((a, b) => a - b);
        if (sysCores.length > 0) {
            txt += `irqaffinity_cpus: ${formatCoreRange(sysCores)}\n`;
        }

        const netCores = physicalRoles['net_irq'] || [];
        if (netCores.length > 0) {
            txt += `net_cpus: [${netCores.join(', ')}]\n`;
        }

        return txt;
    };

    const handleCopy = async () => {
        const config = generateConfig();
        await navigator.clipboard.writeText(config);
        alert('Copied!');
    };

    const config = generateConfig();
    const hasData = Object.keys(instances.Physical || {}).length > 0;

    return (
        <div className="config-output" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
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
                    borderRadius: isExpanded ? '8px 8px 0 0' : '8px'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>📋 Config Output</span>
                    {hasData && (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                            style={{
                                padding: '3px 8px',
                                fontSize: '10px',
                                background: 'var(--color-primary)',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer'
                            }}
                        >
                            Copy
                        </button>
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
                    flex: 1,
                    overflow: 'auto',
                    padding: '12px',
                    background: 'var(--bg-input)',
                    borderRadius: '0 0 8px 8px'
                }}>
                    {hasData ? (
                        <pre style={{
                            margin: 0,
                            fontSize: '10px',
                            fontFamily: 'monospace',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all'
                        }}>
                            {config}
                        </pre>
                    ) : (
                        <p style={{ color: 'var(--text-muted)', fontSize: '11px', margin: 0 }}>
                            No configuration data yet
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

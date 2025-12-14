import type { Geometry, InstanceConfig } from '../types/topology';
import { BENDER_TO_ROLE } from '../types/topology';

interface ParseResult {
    serverName: string;
    date: string;
    geometry: Geometry;
    isolatedCores: number[];
    coreNumaMap: Record<string, number>;
    l3Groups: Record<string, number[]>;
    networkInterfaces: string[];
    netNumaNodes: number[];
    coreLoads: Record<number, number>;
    instances: InstanceConfig;
}

export function parseTopology(text: string): ParseResult {
    const result: ParseResult = {
        serverName: '',
        date: '',
        geometry: {},
        isolatedCores: [],
        coreNumaMap: {},
        l3Groups: {},
        networkInterfaces: [],
        netNumaNodes: [],
        coreLoads: {},
        instances: { Physical: {} },
    };

    if (!text.trim()) return result;

    const lines = text.split('\n');
    let currentSection = '';
    const lscpuData: Record<string, { socket: number; numa: number; l3: number }> = {};

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Section markers
        if (trimmed.startsWith('@@') && trimmed.endsWith('@@')) {
            const section = trimmed.replace(/@@/g, '').toLowerCase();
            currentSection = section;
            continue;
        }

        // Parse HOST
        if (trimmed.startsWith('HOST:')) {
            result.serverName = trimmed.substring(5).trim();
            continue;
        }

        // Parse DATE
        if (trimmed.startsWith('DATE:')) {
            result.date = trimmed.substring(5).trim();
            continue;
        }

        // Parse LSCPU section
        if (currentSection === 'lscpu') {
            const parts = trimmed.split(',');
            if (parts.length >= 5) {
                const cpu = parseInt(parts[0]);
                const numa = parseInt(parts[1]);
                const socket = parseInt(parts[2]);
                const l3 = parseInt(parts[4]);

                if (!isNaN(cpu)) {
                    lscpuData[cpu] = { socket, numa, l3 };
                    result.coreNumaMap[String(cpu)] = numa;
                }
            }
            continue;
        }

        // Parse ISOLATED section
        if (currentSection === 'isolated') {
            const cores = parseCoreRange(trimmed);
            result.isolatedCores = [...result.isolatedCores, ...cores];
            continue;
        }

        // Parse NETWORK section
        if (currentSection === 'network') {
            // IF:net0|NUMA:1|DRV:ena|IRQ:
            const match = trimmed.match(/IF:(\w+)\|NUMA:(\d+)/);
            if (match) {
                const ifName = match[1];
                const numa = parseInt(match[2]);
                if (!result.networkInterfaces.includes(ifName)) {
                    result.networkInterfaces.push(ifName);
                }
                if (!result.netNumaNodes.includes(numa)) {
                    result.netNumaNodes.push(numa);
                }
            }
            continue;
        }

        // Parse BENDER section
        if (currentSection === 'bender') {
            if (trimmed.startsWith('{') && trimmed.includes('cpu_id')) {
                const cpuMatch = trimmed.match(/['"]?cpu_id['"]?\s*:\s*(\d+)/);
                if (cpuMatch) {
                    const cpu = parseInt(cpuMatch[1]);
                    const cpuStr = String(cpu);

                    // Extract server name from [NAME] pattern if not already set
                    if (!result.serverName) {
                        const nameMatch = trimmed.match(/\[([A-Z0-9]+)\]/);
                        if (nameMatch) {
                            result.serverName = nameMatch[1];
                        }
                    }

                    // Find role assignments
                    const rolePattern = /['"]?(\w+)['"]?\s*:\s*\[/g;
                    let match;
                    while ((match = rolePattern.exec(trimmed)) !== null) {
                        const benderName = match[1];
                        if (['cpu_id', 'isolated'].includes(benderName)) continue;

                        if (benderName === 'net_cpu') {
                            if (!result.instances.Physical[cpuStr]) result.instances.Physical[cpuStr] = [];
                            if (!result.instances.Physical[cpuStr].includes('net_irq')) {
                                result.instances.Physical[cpuStr].push('net_irq');
                            }
                            continue;
                        }

                        const roleId = BENDER_TO_ROLE[benderName];
                        if (roleId) {
                            if (!result.instances.Physical[cpuStr]) result.instances.Physical[cpuStr] = [];
                            if (!result.instances.Physical[cpuStr].includes(roleId)) {
                                result.instances.Physical[cpuStr].push(roleId);
                            }
                        }
                    }
                }
            }
            continue;
        }

        // Parse LOAD section
        if (currentSection === 'load') {
            const loadMatch = trimmed.match(/^(\d+):(\d+\.?\d*)$/);
            if (loadMatch) {
                const cpu = parseInt(loadMatch[1]);
                const load = parseFloat(loadMatch[2]);
                result.coreLoads[cpu] = load;
            }
            continue;
        }
    }

    // Build geometry from LSCPU data
    if (Object.keys(lscpuData).length > 0) {
        Object.entries(lscpuData).forEach(([cpu, data]) => {
            const socketId = String(data.socket);
            const numaId = String(data.numa);
            const l3Id = String(data.l3);

            if (!result.geometry[socketId]) result.geometry[socketId] = {};
            if (!result.geometry[socketId][numaId]) result.geometry[socketId][numaId] = {};
            if (!result.geometry[socketId][numaId][l3Id]) result.geometry[socketId][numaId][l3Id] = [];

            result.geometry[socketId][numaId][l3Id].push(parseInt(cpu));
        });

        // Sort cores within each L3
        Object.values(result.geometry).forEach(socket => {
            Object.values(socket).forEach(numa => {
                Object.keys(numa).forEach(l3 => {
                    numa[l3].sort((a, b) => a - b);
                });
            });
        });
    }

    // Build L3 groups
    Object.values(result.geometry).forEach(socket => {
        Object.values(socket).forEach(numa => {
            Object.entries(numa).forEach(([l3Id, cores]) => {
                result.l3Groups[l3Id] = cores;
            });
        });
    });

    // Infer OS cores
    const isolatedSet = new Set(result.isolatedCores.map(String));
    Object.values(result.geometry).forEach(socket => {
        Object.values(socket).forEach(numa => {
            Object.values(numa).forEach(cores => {
                cores.forEach(cpu => {
                    const cpuStr = String(cpu);
                    const hasRole = result.instances.Physical[cpuStr]?.length > 0;
                    const isIsolated = isolatedSet.has(cpuStr);

                    if (!hasRole && !isIsolated) {
                        if (!result.instances.Physical[cpuStr]) result.instances.Physical[cpuStr] = [];
                        result.instances.Physical[cpuStr].push('sys_os');
                    }
                });
            });
        });
    });

    return result;
}

export function parseCoreRange(str: string): number[] {
    const cores: number[] = [];
    str.split(',').forEach(part => {
        part = part.trim();
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(s => parseInt(s.trim()));
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = start; i <= end; i++) cores.push(i);
            }
        } else {
            const num = parseInt(part);
            if (!isNaN(num)) cores.push(num);
        }
    });
    return cores;
}

export function formatCoreRange(cores: number[]): string {
    if (cores.length === 0) return '';
    const sorted = [...cores].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0], end = sorted[0];

    for (let i = 1; i <= sorted.length; i++) {
        if (i < sorted.length && sorted[i] === end + 1) {
            end = sorted[i];
        } else {
            ranges.push(start === end ? String(start) : `${start}-${end}`);
            if (i < sorted.length) {
                start = sorted[i];
                end = sorted[i];
            }
        }
    }
    return ranges.join(',');
}

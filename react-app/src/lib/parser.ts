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

                    // Find role assignments with instance names
                    // Pattern: RoleName:[INSTANCE] or RoleName:[value]
                    const roleInstancePattern = /['"]?(\w+)['"]?\s*:\s*\[([^\]]+)\]/g;
                    let match;
                    while ((match = roleInstancePattern.exec(trimmed)) !== null) {
                        const benderName = match[1];
                        const instanceValue = match[2];

                        if (['cpu_id', 'isolated'].includes(benderName)) continue;

                        // Check if instanceValue is an instance name (uppercase/numbers, looser check)
                        // Allow anything starting with uppercase and alphanumeric, minimum 2 chars
                        const instanceMatch = instanceValue.match(/^[A-Z][A-Z0-9]+$/);
                        let instanceName = instanceMatch ? instanceMatch[0] : null; // Use full match

                        // Explicit check: If value contains commas, it's a CPU list, not an instance name.
                        if (instanceValue.includes(',')) instanceName = null;

                        // Handle net_cpu specially (shared IRQ)
                        if (benderName === 'net_cpu') {
                            if (!result.instances.Physical[cpuStr]) result.instances.Physical[cpuStr] = [];
                            if (!result.instances.Physical[cpuStr].includes('net_irq')) {
                                result.instances.Physical[cpuStr].push('net_irq');
                            }
                            continue;
                        }

                        const roleId = BENDER_TO_ROLE[benderName];
                        if (roleId) {
                            // Store in Physical for backward compat
                            if (!result.instances.Physical[cpuStr]) result.instances.Physical[cpuStr] = [];
                            if (!result.instances.Physical[cpuStr].includes(roleId)) {
                                result.instances.Physical[cpuStr].push(roleId);
                            }

                            // Also store per-instance if we detected an instance name
                            if (instanceName) {
                                if (!result.instances[instanceName]) {
                                    result.instances[instanceName] = {};
                                }
                                if (!result.instances[instanceName][cpuStr]) {
                                    result.instances[instanceName][cpuStr] = [];
                                }
                                if (!result.instances[instanceName][cpuStr].includes(roleId)) {
                                    result.instances[instanceName][cpuStr].push(roleId);
                                }
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

// Parse YAML bs_instances config format
export function parseYamlConfig(text: string): ParseResult | null {
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

    // Check if it's a YAML config (has bs_instances or standard yaml fields)
    if (!text.includes('bs_instances') && !text.includes('trash_cpu') && !text.includes('gateways_cpu')) {
        return null;
    }

    const lines = text.split('\n');
    let serverName = '';
    const allCores: number[] = [];

    // Role mapping from YAML fields to internal roles
    const roleMap: Record<string, string> = {
        'trash_cpu': 'trash',
        'taskset': 'trash',
        'allrobots_cpu': 'allrobots_th',
        'remoteformula_cpu': 'remoteformula',
        'gateways_cpu': 'gateway',
        'robots_cpu': 'robot_default',
        'udpsend_cpu': 'udp',
        'udpreceive_cpu': 'udp',
        'clickhouse': 'clickhouse',
    };

    for (const line of lines) {
        const trimmed = line.trim();

        // Extract server name from YAML
        const nameMatch = trimmed.match(/^name:\s*(.+)/);
        if (nameMatch) {
            serverName = nameMatch[1].trim();
            result.serverName = serverName;
        }

        // Parse isol_cpus
        const isolMatch = trimmed.match(/^isol_cpus:\s*(.+)/);
        if (isolMatch) {
            result.isolatedCores = parseCoreRange(isolMatch[1]);
        }

        // Parse net_cpus (net0: [42, 43, ...])
        const netMatch = trimmed.match(/^(net\d+):\s*\[([^\]]+)\]/);
        if (netMatch) {
            result.networkInterfaces.push(netMatch[1]);
            const netCores = netMatch[2].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            netCores.forEach(core => {
                if (!result.instances.Physical[String(core)]) result.instances.Physical[String(core)] = [];
                if (!result.instances.Physical[String(core)].includes('net_irq')) {
                    result.instances.Physical[String(core)].push('net_irq');
                }
                allCores.push(core);
            });
        }

        // Parse role fields
        for (const [field, role] of Object.entries(roleMap)) {
            const regex = new RegExp(`^${field}:\\s*["']?([^"'\\n]+)["']?`);
            const match = trimmed.match(regex);
            if (match) {
                const value = match[1].trim();
                const cores = parseCoreRange(value);
                cores.forEach(core => {
                    if (!result.instances.Physical[String(core)]) result.instances.Physical[String(core)] = [];
                    if (!result.instances.Physical[String(core)].includes(role)) {
                        result.instances.Physical[String(core)].push(role);
                    }
                    allCores.push(core);
                });
            }
        }

        // Parse CPUAlias entries (e.g., <CPUAlias Name="RobotsNode1" Cores="48-71">)
        const aliasMatch = trimmed.match(/CPUAlias\s+Name="([^"]+)"\s+Cores="([^"]+)"/);
        if (aliasMatch) {
            const aliasName = aliasMatch[1];
            const cores = parseCoreRange(aliasMatch[2]);

            let role = 'isolated';
            if (aliasName.toLowerCase().includes('formula')) role = 'formula';
            else if (aliasName === 'RobotsNode1' || aliasName.includes('Pool1')) role = 'pool1';
            else if (aliasName === 'RobotsNode2' || aliasName.includes('Pool2')) role = 'pool2';
            else if (aliasName === 'RobotsNode3' || aliasName.includes('Pool3')) role = 'pool2';
            else if (aliasName.includes('IsolatedRobots')) role = 'isolated_robots';
            else if (aliasName.includes('RobotsDefault')) role = 'robot_default';
            else if (aliasName.toLowerCase().includes('robot')) role = 'robot_default';
            else if (aliasName.toLowerCase().includes('isolated')) role = 'isolated';

            cores.forEach(core => {
                if (!result.instances.Physical[String(core)]) result.instances.Physical[String(core)] = [];
                if (!result.instances.Physical[String(core)].includes(role)) {
                    result.instances.Physical[String(core)].push(role);
                }
                allCores.push(core);
            });
        }
    }

    // Parse irqaffinity_cpus to get OS cores (adds to total core count)
    let irqAffinityCores: number[] = [];
    let membindNodes: number[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Parse irqaffinity_cpus
        const irqMatch = trimmed.match(/^irqaffinity_cpus:\s*(.+)/);
        if (irqMatch) {
            irqAffinityCores = parseCoreRange(irqMatch[1]);
        }

        // Parse membind to determine NUMA count (e.g., membind: "0,1,2,3")
        const membindMatch = trimmed.match(/^membind:\s*["']?([^"'\n]+)["']?/);
        if (membindMatch) {
            const membindVal = membindMatch[1].trim();
            membindNodes = membindVal.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        }
    }

    // Find max core from all sources
    const allKnownCores = [...allCores, ...result.isolatedCores, ...irqAffinityCores];
    if (allKnownCores.length === 0) return null;

    const maxCore = Math.max(...allKnownCores);

    // Determine NUMA count from membind (unique values)
    const numNumas = membindNodes.length > 0 ? Math.max(...membindNodes) + 1 : 2;
    const coresPerNuma = Math.ceil((maxCore + 1) / numNumas);

    // Build geometry based on NUMA count from membind
    for (let n = 0; n < numNumas; n++) {
        const socketId = Math.floor(n / 2); // 2 NUMAs per socket typically
        if (!result.geometry[socketId]) result.geometry[socketId] = {};
        result.geometry[socketId][n] = {};
        result.geometry[socketId][n][n] = [];

        for (let c = n * coresPerNuma; c < Math.min((n + 1) * coresPerNuma, maxCore + 1); c++) {
            result.geometry[socketId][n][n].push(c);
            result.coreNumaMap[String(c)] = n;
        }
    }

    // IMPORTANT: Respect isol_cpus - non-isolated cores are ALWAYS sys_os
    // Remove roles from non-isolated cores and mark as OS
    for (let c = 0; c <= maxCore; c++) {
        const isIsolated = result.isolatedCores.includes(c);

        if (!isIsolated) {
            // Non-isolated core = OS core, remove any other roles
            result.instances.Physical[String(c)] = ['sys_os'];
        } else {
            // Isolated core - keep its roles, or mark as generic isolated if no roles
            const hasRole = result.instances.Physical[String(c)]?.length > 0;
            if (!hasRole) {
                result.instances.Physical[String(c)] = ['isolated'];
            }
        }
    }

    return result;
}

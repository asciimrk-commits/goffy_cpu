/**
 * HFT CPU Mapper - Data Parser Module v2.0
 * Handles parsing of BENDER configurations and CPU topology data
 * Updated to support bender-cpuinfo.py human output format
 */

const Parser = {
    // Role mapping from BENDER keys to internal role IDs
    ROLE_MAP: {
        'GatewaysDefault': 'gateway',
        'RobotsDefault': 'robot_default',
        'RobotsNode1': 'pool1',
        'RobotsNode2': 'pool2',
        'AllRobotsThCPU': 'ar',
        'RemoteFormulaCPU': 'rf',
        'ClickHouseCores': 'click',
        'TrashCPU': 'trash',
        'UdpReceiveCores': 'udp',
        'UdpSendCores': 'udp',
        'Formula': 'formula'
    },

    // BENDER name to role ID mapping (for parsing)
    benderToRole: {
        'UdpReceiveCores': 'udp',
        'UdpSendCores': 'udp',
        'TrashCPU': 'trash',
        'GatewaysDefault': 'gateway',
        'Gateways': 'gateway',
        'IsolatedRobots': 'isolated_robots',
        'RobotsPool1': 'pool1',
        'RobotsPool2': 'pool2',
        'RobotsDefault': 'robot_default',
        'RobotsNode1': 'pool1',
        'RobotsNode2': 'pool2',
        'RobotsNode3': 'pool2',
        'AllRobotsThCPU': 'ar',
        'RemoteFormulaCPU': 'rf',
        'Formula': 'formula',
        'ClickHouseCores': 'click',
        'Isolated': 'isolated'
    },

    /**
     * Parse complete input text into state object
     * @param {string} text - Input text from cpu-map.sh or BENDER config
     * @returns {Object} Parsed state object
     */
    parse(text) {
        const initialState = {
            serverName: '',
            geometry: {},
            coreNumaMap: {},
            coreSocketMap: {},
            l3Groups: {},
            netNumaNodes: new Set(),
            isolatedCores: new Set(),
            coreIRQMap: {},
            cpuLoadMap: {},
            instances: { Physical: {} },
            networkInterfaces: [],
            coreBenderMap: {},
            instanceToInterface: {},
            selectedInstance: 'Physical'
        };

        const lines = text.split('\n');
        let mode = 'none';

        // Temporary structures for BENDER parsing
        const benderCpuInfo = {};
        const benderNetCpus = new Set();
        
        // Average current loads from multiple measurements
        const currentLoadAccumulator = {};
        const currentLoadCounts = {};

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            // Section detection
            if (line === '@@HFT_CPU_MAP_V4@@' || line === '@@HFT_CPU_MAP_V5@@') {
                mode = 'v4';
                continue;
            }
            if (line.startsWith('@@') && line.endsWith('@@')) {
                mode = line.replace(/@@/g, '').toLowerCase();
                continue;
            }
            if (line.startsWith('HOST:')) {
                initialState.serverName = line.split(':')[1].trim();
                continue;
            }

            // Parse LSCPU section: CPU,NODE,SOCKET,CORE,L3
            if (mode === 'lscpu') {
                if (line.startsWith('CPU') || line.startsWith('#')) continue;
                
                const parts = line.split(',');
                if (parts.length < 5) continue;
                
                const [cpu, node, socket, core, l3id] = parts.map(p => p.trim());
                
                if (node === '-' || socket === '-') continue;

                // Build coreNumaMap
                initialState.coreNumaMap[cpu] = node;
                
                // Build coreSocketMap
                initialState.coreSocketMap[cpu] = socket;

                // Build geometry hierarchy
                if (!initialState.geometry[socket]) {
                    initialState.geometry[socket] = {};
                }
                if (!initialState.geometry[socket][node]) {
                    initialState.geometry[socket][node] = {};
                }
                
                const l3 = l3id || node;
                if (!initialState.geometry[socket][node][l3]) {
                    initialState.geometry[socket][node][l3] = [];
                }
                
                if (!initialState.geometry[socket][node][l3].includes(cpu)) {
                    initialState.geometry[socket][node][l3].push(cpu);
                }

                // Build L3 groups
                const l3Key = `${socket}-${node}-${l3}`;
                if (!initialState.l3Groups[l3Key]) {
                    initialState.l3Groups[l3Key] = [];
                }
                if (!initialState.l3Groups[l3Key].includes(cpu)) {
                    initialState.l3Groups[l3Key].push(cpu);
                }
            }

            // NUMA fallback - build topology if LSCPU is empty
            if (mode === 'numa') {
                const numaMatch = line.match(/node\s+(\d+)\s+cpus?:\s*([\d\s,\-]+)/i);
                if (numaMatch) {
                    const node = numaMatch[1];
                    const cpuList = numaMatch[2];
                    
                    const cores = Utils.parseRange(cpuList);
                    
                    cores.forEach(cpu => {
                        const cpuStr = cpu.toString();
                        
                        // Skip if already mapped
                        if (initialState.coreNumaMap[cpuStr]) {
                            return;
                        }

                        initialState.coreNumaMap[cpuStr] = node;

                        // Determine socket (2 NUMA per socket typically)
                        const socket = Math.floor(parseInt(node) / 2).toString();
                        const l3id = node;

                        if (!initialState.geometry[socket]) {
                            initialState.geometry[socket] = {};
                        }
                        if (!initialState.geometry[socket][node]) {
                            initialState.geometry[socket][node] = {};
                        }
                        if (!initialState.geometry[socket][node][l3id]) {
                            initialState.geometry[socket][node][l3id] = [];
                        }
                        
                        initialState.geometry[socket][node][l3id].push(cpuStr);

                        const l3Key = `${socket}-${node}-${l3id}`;
                        if (!initialState.l3Groups[l3Key]) {
                            initialState.l3Groups[l3Key] = [];
                        }
                        initialState.l3Groups[l3Key].push(cpuStr);
                    });
                }
            }

            // ISOLATED cores
            if (mode === 'isolated' && line !== 'none' && line !== 'N/A') {
                Utils.parseRange(line).forEach(c => {
                    initialState.isolatedCores.add(c.toString());
                });
            }

            // NETWORK interfaces from script
            if (mode === 'network') {
                if (line.startsWith('IF:')) {
                    const parts = {};
                    line.split('|').forEach(p => {
                        const [k, v] = p.split(':');
                        parts[k] = v;
                    });
                    
                    if (parts.NUMA && parts.NUMA !== '-1') {
                        initialState.netNumaNodes.add(parts.NUMA);
                    }
                    
                    if (parts.IF) {
                        initialState.networkInterfaces.push({
                            name: parts.IF,
                            numaNode: parseInt(parts.NUMA || 0)
                        });
                    }
                }
            }

            // BENDER - Parse human output format from bender-cpuinfo.py
            if (mode === 'bender' || mode === 'runtime') {
                // Skip lines that are not CPU lines (like "Cpus overview:", "Instance overview:", etc.)
                // Support both formats: {'cpu_id': 0, ...} and {cpu_id:0, ...}
                if (!line.startsWith('{') || (!line.includes('cpu_id') && !line.includes("'cpu_id'"))) {
                    continue;
                }

                // Match both formats: 'cpu_id': 0 and cpu_id:0
                const cpuIdMatch = line.match(/['"]?cpu_id['"]?\s*[:\s]\s*(\d+)/);
                if (cpuIdMatch) {
                    const cpu = cpuIdMatch[1];
                    if (!benderCpuInfo[cpu]) {
                        benderCpuInfo[cpu] = { isolated: false, net_cpu: false, roles: [] };
                    }

                    // Check isolated: 'isolated': True or isolated:True (with capital T)
                    if (/['"]?isolated['"]?\s*[:\s=]\s*True/i.test(line)) {
                        benderCpuInfo[cpu].isolated = true;
                        initialState.isolatedCores.add(cpu);
                    }

                    // Check net_cpu: 'net_cpu': ['net0'] or net_cpu:[net0]
                    const netCpuMatch = line.match(/['"]?net_cpu['"]?\s*:\s*\[['"]?([^'"\]]+)['"]?\]/);
                    if (netCpuMatch) {
                        benderCpuInfo[cpu].net_cpu = true;
                        benderCpuInfo[cpu].net_interface = netCpuMatch[1];
                    }

                    // Extract roles from all keys - support both quoted and unquoted formats
                    Object.entries(this.ROLE_MAP).forEach(([key, role]) => {
                        // Match pattern: 'Key': ['Instance1', 'Instance2'] or Key:[Instance]
                        const pattern = new RegExp("['\"']?" + key + "['\"']?\\s*:\\s*\\[([^\\]]+)\\]", 'i');
                        const match = line.match(pattern);
                        if (match) {
                            // Parse the instance list
                            const instanceListStr = match[1];
                            const instances = instanceListStr.split(/['",\s]+/).filter(s => s && s !== '' && s !== "'");
                            
                            instances.forEach(instanceName => {
                                if (instanceName) {
                                    benderCpuInfo[cpu].roles.push({
                                        id: role,
                                        instance: instanceName
                                    });
                                    initialState.coreBenderMap[cpu] = instanceName;
                                }
                            });
                        }
                    });

                    // Check if this is an OS core (no roles, not isolated)
                    const hasRoles = Object.keys(this.ROLE_MAP).some(key => 
                        new RegExp("['\"']?" + key + "['\"']?\\s*:", 'i').test(line)
                    );
                    if (!hasRoles && !benderCpuInfo[cpu].isolated) {
                        benderCpuInfo[cpu].isOS = true;
                    }
                }
            }

            // BENDER_NET - Parse network core assignments
            if (mode === 'bender_net') {
                // Accept both short and long records
                const netMatch = line.match(/^((net|eth|hit)\d+)[:\s]*([\d,\s\-]+)$/);
                if (netMatch) {
                    const cpus = Utils.parseRange(netMatch[3]);
                    cpus.forEach(c => benderNetCpus.add(c.toString()));
                    // Determine network NUMA
                    if (cpus.length > 0) {
                        const numa = initialState.coreNumaMap[cpus[0].toString()];
                        if (numa) initialState.netNumaNodes.add(numa);
                    }
                }
            }

            // LOAD - Current load measurements
            if (mode === 'load' || mode === 'cpuload' || mode === 'load_avg_current') {
                const loadMatch = line.match(/^(\d+)[:\s]*([\d.]+)$/);
                if (loadMatch) {
                    const cpu = loadMatch[1];
                    const load = parseFloat(loadMatch[2]);
                    
                    // Accumulate for averaging if multiple measurements
                    if (!currentLoadAccumulator[cpu]) {
                        currentLoadAccumulator[cpu] = 0;
                        currentLoadCounts[cpu] = 0;
                    }
                    currentLoadAccumulator[cpu] += load;
                    currentLoadCounts[cpu]++;
                }
            }

            // Historical 30-day load (fallback)
            if (mode === 'load_avg_30d') {
                const loadMatch = line.match(/^(\d+)[:\s]*([\d.]+)$/);
                if (loadMatch) {
                    // Only use historical load if we don't have current load data
                    if (!currentLoadAccumulator[loadMatch[1]]) {
                        initialState.cpuLoadMap[loadMatch[1]] = Utils.round(parseFloat(loadMatch[2]), 1);
                    }
                }
            }
        }

        // Average current load measurements
        Object.keys(currentLoadAccumulator).forEach(cpu => {
            const avgLoad = currentLoadAccumulator[cpu] / currentLoadCounts[cpu];
            initialState.cpuLoadMap[cpu] = Utils.round(avgLoad, 1);
        });

        // Post-processing: Apply BENDER information
        Object.entries(benderCpuInfo).forEach(([cpu, info]) => {
            const cpuStr = cpu.toString();

            // IRQ cores: net_cpu:True OR in BENDER_NET list
            if (info.net_cpu || benderNetCpus.has(cpuStr)) {
                Parser._addTag(initialState, 'Physical', cpuStr, 'net_irq');
                const numa = initialState.coreNumaMap[cpuStr];
                if (numa) initialState.netNumaNodes.add(numa);
            }

            // OS cores: empty (no isolated, no roles)
            if (info.isOS && !info.isolated && info.roles.length === 0) {
                Parser._addTag(initialState, 'Physical', cpuStr, 'sys_os');
            }

            // Apply roles
            info.roles.forEach(roleObj => {
                const instanceName = roleObj.instance || 'Physical';
                Parser._addTag(initialState, instanceName, cpuStr, roleObj.id);
            });
        });

        return initialState;
    },

    /**
     * Helper: Add tag to instance
     * @private
     */
    _addTag(state, instanceName, cpu, tag) {
        if (!cpu) return;
        if (!state.instances[instanceName]) {
            state.instances[instanceName] = {};
        }
        if (!state.instances[instanceName][cpu]) {
            state.instances[instanceName][cpu] = new Set();
        }
        state.instances[instanceName][cpu].add(tag);
    },

    /**
     * Parse BENDER config for comparison mode
     * @param {string} text - BENDER config text
     * @param {string} serverName - Server name
     * @returns {Object} Parsed config object
     */
    parseBenderConfig(text, serverName) {
        const config = {
            serverName: serverName,
            geometry: {},
            netNumaNodes: [],
            isolatedCores: [],
            instances: { Physical: {} },
            interfaceNumaMap: {},
            cpuLoadMap: {}
        };

        const lines = text.split('\n');
        const lscpuData = {};
        const numaRanges = {};
        let currentSection = '';

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;

            // Detect sections
            if (trimmed.startsWith('@@')) {
                if (trimmed.includes('LSCPU')) currentSection = 'lscpu';
                else if (trimmed.includes('NUMA') && !trimmed.includes('NET')) currentSection = 'numa';
                else if (trimmed.includes('ISOLATED')) currentSection = 'isolated';
                else if (trimmed.includes('NETWORK')) currentSection = 'network';
                else if (trimmed.includes('BENDER_NET')) currentSection = 'bender_net';
                else if (trimmed.includes('BENDER')) currentSection = 'bender';
                else if (trimmed.includes('LOAD_AVG') || trimmed.includes('END_LOAD')) currentSection = 'load';
                return;
            }

            // Parse LSCPU section
            if (currentSection === 'lscpu') {
                const parts = trimmed.split(',');
                if (parts.length >= 5) {
                    const cpu = parseInt(parts[0]);
                    if (!isNaN(cpu)) {
                        lscpuData[cpu] = {
                            numa: parseInt(parts[1]),
                            socket: parseInt(parts[2]),
                            core: parseInt(parts[3]),
                            l3: parseInt(parts[4])
                        };
                    }
                }
                return;
            }

            // Parse NUMA section: "node 0 cpus: 0 1 2 3..."
            if (currentSection === 'numa') {
                const match = trimmed.match(/node\s*(\d+)\s*cpus?:\s*(.+)/i);
                if (match) {
                    const numaId = match[1];
                    const cores = match[2].trim().split(/\s+/).map(c => parseInt(c)).filter(c => !isNaN(c));
                    numaRanges[numaId] = cores;
                }
                return;
            }

            // Parse ISOLATED section
            if (currentSection === 'isolated') {
                if (!trimmed.includes('size:') && !trimmed.includes('node')) {
                    const cores = Utils.parseRange(trimmed);
                    cores.forEach(c => {
                        if (!config.isolatedCores.includes(c)) {
                            config.isolatedCores.push(c);
                        }
                    });
                }
                return;
            }

            // Parse NETWORK section
            if (currentSection === 'network') {
                const ifMatch = trimmed.match(/IF:([^|]+)/i);
                const numaMatch = trimmed.match(/NUMA:(\d+)/i);
                
                if (ifMatch && numaMatch) {
                    const ifName = ifMatch[1].trim();
                    const numaId = numaMatch[1];
                    
                    config.interfaceNumaMap[ifName] = numaId;
                    
                    if (!config.netNumaNodes.includes(numaId)) {
                        config.netNumaNodes.push(numaId);
                    }
                }
                return;
            }

            // Parse BENDER section - Human output format
            if (currentSection === 'bender') {
                // Skip non-CPU lines - support both formats
                if (!trimmed.startsWith('{') || (!trimmed.includes('cpu_id') && !trimmed.includes("'cpu_id'"))) {
                    return;
                }

                // Match both formats: 'cpu_id': 0 and cpu_id:0
                const cpuMatch = trimmed.match(/['"]?cpu_id['"]?\s*[:\s]\s*(\d+)/);
                if (cpuMatch) {
                    const cpu = parseInt(cpuMatch[1]);
                    const cpuStr = String(cpu);
                    
                    // Check if isolated - support various formats
                    const isIsolated = /['"]?isolated['"]?\s*[:\s=]\s*True/i.test(trimmed);
                    
                    // If NOT isolated, it's an OS core
                    if (!isIsolated) {
                        if (!config.instances.Physical[cpuStr]) {
                            config.instances.Physical[cpuStr] = [];
                        }
                        if (!config.instances.Physical[cpuStr].includes('sys_os')) {
                            config.instances.Physical[cpuStr].push('sys_os');
                        }
                        return;
                    }

                    // Mark as isolated
                    if (!config.isolatedCores.includes(cpu)) {
                        config.isolatedCores.push(cpu);
                    }

                    // If isolated, check for net_cpu first (IRQ cores)
                    const netCpuMatch = trimmed.match(/['"]?net_cpu['"]?\s*:\s*\[['"]?([^'"\]]+)['"]?\]/);
                    if (netCpuMatch) {
                        const ifName = netCpuMatch[1];
                        if (!config.instances.Physical[cpuStr]) {
                            config.instances.Physical[cpuStr] = [];
                        }
                        if (!config.instances.Physical[cpuStr].includes('net_irq')) {
                            config.instances.Physical[cpuStr].push('net_irq');
                        }
                        config.interfaceNumaMap[ifName] = config.interfaceNumaMap[ifName] || '0';
                    }

                    // Find all service assignments - extract instance names too
                    Object.keys(this.benderToRole).forEach(benderName => {
                        if (['cpu_id', 'isolated', 'net_cpu', 'Isolated'].includes(benderName)) {
                            return;
                        }
                        
                        // Match both quoted and unquoted formats with instance list
                        const pattern = new RegExp("['\"']?" + benderName + "['\"']?\\s*:\\s*\\[([^\\]]+)\\]", 'i');
                        const match = trimmed.match(pattern);
                        
                        if (match) {
                            const roleId = this.benderToRole[benderName];
                            const instanceListStr = match[1];
                            
                            // Parse instance names from the list
                            const instanceNames = instanceListStr.split(/['",\s]+/).filter(s => s && s !== '' && s !== "'");
                            
                            // Add role to each instance
                            instanceNames.forEach(instanceName => {
                                if (instanceName) {
                                    // Create instance if not exists
                                    if (!config.instances[instanceName]) {
                                        config.instances[instanceName] = {};
                                    }
                                    if (!config.instances[instanceName][cpuStr]) {
                                        config.instances[instanceName][cpuStr] = [];
                                    }
                                    if (!config.instances[instanceName][cpuStr].includes(roleId)) {
                                        config.instances[instanceName][cpuStr].push(roleId);
                                    }
                                    
                                    // Also add to Physical for backward compatibility
                                    if (!config.instances.Physical[cpuStr]) {
                                        config.instances.Physical[cpuStr] = [];
                                    }
                                    if (!config.instances.Physical[cpuStr].includes(roleId)) {
                                        config.instances.Physical[cpuStr].push(roleId);
                                    }
                                }
                            });
                        }
                    });
                }
                return;
            }

            // Parse LOAD_AVG section
            if (currentSection === 'load') {
                if (trimmed.match(/^cpu\d+:/)) {
                    const match = trimmed.match(/^(cpu\d+):([\d.]+)/);
                    if (match) {
                        const cpuName = match[1];
                        const load = parseFloat(match[2]);
                        if (!isNaN(load)) {
                            config.cpuLoadMap[cpuName] = load;
                        }
                    }
                }
                return;
            }
        });

        // Build geometry
        if (Object.keys(lscpuData).length > 0) {
            // Use LSCPU for precise mapping
            Object.entries(lscpuData).forEach(([cpu, data]) => {
                const socketId = String(data.socket);
                const numaId = String(data.numa);
                const l3Id = String(data.l3);

                if (!config.geometry[socketId]) config.geometry[socketId] = {};
                if (!config.geometry[socketId][numaId]) config.geometry[socketId][numaId] = {};
                if (!config.geometry[socketId][numaId][l3Id]) config.geometry[socketId][numaId][l3Id] = [];

                config.geometry[socketId][numaId][l3Id].push(parseInt(cpu));
            });

            // Sort cores
            Object.values(config.geometry).forEach(socket => {
                Object.values(socket).forEach(numa => {
                    Object.keys(numa).forEach(l3 => {
                        numa[l3].sort((a, b) => a - b);
                    });
                });
            });
        } else if (Object.keys(numaRanges).length > 0) {
            // Use NUMA ranges, assume 2 NUMA per socket
            const numaIds = Object.keys(numaRanges).sort((a, b) => parseInt(a) - parseInt(b));
            numaIds.forEach((numaId) => {
                const socketId = String(Math.floor(parseInt(numaId) / 2));
                if (!config.geometry[socketId]) config.geometry[socketId] = {};
                
                const cores = numaRanges[numaId];
                config.geometry[socketId][numaId] = {
                    '0': cores.sort((a, b) => a - b)
                };
            });
        } else {
            // Fallback: create from max core
            const maxCore = Math.max(
                ...config.isolatedCores,
                ...Object.keys(config.instances.Physical || {}).map(c => parseInt(c)),
                95
            );
            const cpuCount = maxCore + 1;
            const coresPerNuma = Math.ceil(cpuCount / 4);

            for (let numa = 0; numa < 4; numa++) {
                const socketId = String(Math.floor(numa / 2));
                const start = numa * coresPerNuma;
                const end = Math.min(start + coresPerNuma, cpuCount);
                const cores = [];
                for (let i = start; i < end; i++) cores.push(i);

                if (!config.geometry[socketId]) config.geometry[socketId] = {};
                config.geometry[socketId][String(numa)] = { '0': cores };
            }
        }

        // Post-processing: Infer OS cores
        const isolatedSet = new Set(config.isolatedCores.map(String));
        Object.values(config.geometry).forEach(socket => {
            Object.values(socket).forEach(numa => {
                Object.values(numa).forEach(cores => {
                    cores.forEach(cpu => {
                        const cpuStr = String(cpu);
                        const hasRole = config.instances.Physical[cpuStr]?.length > 0;
                        const isIsolated = isolatedSet.has(cpuStr);

                        if (!hasRole && !isIsolated) {
                            if (!config.instances.Physical[cpuStr]) {
                                config.instances.Physical[cpuStr] = [];
                            }
                            if (!config.instances.Physical[cpuStr].includes('sys_os')) {
                                config.instances.Physical[cpuStr].push('sys_os');
                            }
                        }
                    });
                });
            });
        });

        return config;
    }
};

// Export for browser
if (typeof window !== 'undefined') {
    window.Parser = Parser;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Parser;
}

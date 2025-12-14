/**
 * HFT CPU Mapper - Main Application v4.5
 * Fixed: BENDER parsing (IRQ, OS cores), socket detection, UI responsiveness
 */

const HFT = {
    state: {
        serverName: '',
        geometry: {},       // socket -> numa -> l3 -> [cores]
        coreNumaMap: {},    // cpu -> numa
        l3Groups: {},       // l3Key -> [cores]
        netNumaNodes: new Set(),
        isolatedCores: new Set(),
        coreIRQMap: {},     // cpu -> [irq numbers]
        cpuLoadMap: {},     // cpu -> load%
        instances: { Physical: {} },
        networkInterfaces: []
    },
    
    activeTool: null,
    isMouseDown: false,
    compareOld: null,
    compareNew: null,
    proposedConfig: null,
    
    init() {
        this.initPalette();
        this.initTabs();
        this.initDragDrop();
        this.initKeyboard();
        this.initSidebar();
        this.activeTool = HFT_RULES.roles.robot_default;
    },
    
    initPalette() {
        const container = document.getElementById('palette');
        if (!container) return;
        
        let html = '';
        const categories = ['system', 'network', 'gateway', 'logic'];
        
        categories.forEach(catId => {
            const cat = HFT_RULES.categories[catId];
            html += `<div class="palette-category">${cat.name}</div>`;
            
            cat.roles.forEach(roleId => {
                const role = HFT_RULES.roles[roleId];
                if (role && !role.isStateFlag) {
                    html += `
                        <div class="palette-item" data-role="${role.id}" onclick="HFT.selectTool('${role.id}')">
                            <div class="palette-swatch" style="background:${role.color}"></div>
                            <span>${role.name}</span>
                        </div>`;
                }
            });
        });
        
        const isolated = HFT_RULES.roles.isolated;
        html += `<div class="palette-category">State</div>`;
        html += `<div class="palette-item" data-role="isolated" onclick="HFT.selectTool('isolated')">
            <div class="palette-swatch" style="background:transparent;border:2px dashed ${isolated.color}"></div>
            <span>${isolated.name}</span>
        </div>`;
        
        container.innerHTML = html;
    },
    
    initTabs() {
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabId = tab.dataset.tab;
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                document.getElementById(`tab-${tabId}`)?.classList.add('active');
            });
        });
    },
    
    initDragDrop() {
        ['compare-old', 'compare-new'].forEach(id => {
            const container = document.getElementById(id);
            if (!container) return;
            container.addEventListener('dragover', (e) => { e.preventDefault(); container.querySelector('.drop-zone')?.classList.add('dragover'); });
            container.addEventListener('dragleave', () => { container.querySelector('.drop-zone')?.classList.remove('dragover'); });
            container.addEventListener('drop', (e) => {
                e.preventDefault();
                container.querySelector('.drop-zone')?.classList.remove('dragover');
                const file = e.dataTransfer.files[0];
                if (file?.name.endsWith('.json')) this.readCompareFile(file, id === 'compare-old' ? 'old' : 'new');
            });
        });
    },
    
    initKeyboard() {
        document.addEventListener('keydown', (e) => { if (e.key === '[') this.toggleSidebar(); });
        document.addEventListener('mouseup', () => { this.isMouseDown = false; });
    },
    
    initSidebar() {
        document.getElementById('sidebarToggle')?.addEventListener('click', () => this.toggleSidebar());
    },
    
    toggleSidebar() {
        document.getElementById('sidebar')?.classList.toggle('collapsed');
    },
    
    selectTool(roleId) {
        this.activeTool = HFT_RULES.roles[roleId];
        document.querySelectorAll('.palette-item').forEach(item => item.classList.toggle('active', item.dataset.role === roleId));
    },
    
    // =========================================================================
    // PARSING - v4.5 Fixed BENDER parsing
    // =========================================================================
    parse(text) {
        this.state = {
            serverName: '', geometry: {}, coreNumaMap: {}, l3Groups: {},
            netNumaNodes: new Set(), isolatedCores: new Set(), coreIRQMap: {},
            cpuLoadMap: {}, instances: { Physical: {} }, networkInterfaces: []
        };
        
        const lines = text.split('\n');
        let mode = 'none';
        
        // Role mapping from BENDER keys
        const ROLE_MAP = {
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
        };
        
        // Временные структуры для парсинга BENDER
        const benderCpuInfo = {}; // cpu -> { isolated, net_cpu, roles: [] }
        const benderNetCpus = new Set(); // IRQ ядра из BENDER_NET (только короткие записи)
        
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            
            // Section detection
            if (line === '@@HFT_CPU_MAP_V4@@') { mode = 'v4'; continue; }
            if (line.startsWith('@@') && line.endsWith('@@')) {
                mode = line.replace(/@@/g, '').toLowerCase();
                continue;
            }
            if (line.startsWith('HOST:')) { this.state.serverName = line.split(':')[1]; continue; }
            
            // LSCPU parsing
            if (mode === 'lscpu') {
                if (line.startsWith('CPU') || line.startsWith('#')) continue;
                const parts = line.split(',');
                if (parts.length < 5) continue;
                const [cpu, node, socket, , l3id] = parts.map(p => p.trim());
                if (node === '-' || socket === '-') continue;
                
                this.state.coreNumaMap[cpu] = node;
                if (!this.state.geometry[socket]) this.state.geometry[socket] = {};
                if (!this.state.geometry[socket][node]) this.state.geometry[socket][node] = {};
                const l3 = l3id || node;
                if (!this.state.geometry[socket][node][l3]) this.state.geometry[socket][node][l3] = [];
                this.state.geometry[socket][node][l3].push(cpu);
                
                const l3Key = `${socket}-${node}-${l3}`;
                if (!this.state.l3Groups[l3Key]) this.state.l3Groups[l3Key] = [];
                this.state.l3Groups[l3Key].push(cpu);
            }
            
            // NUMA fallback - строим топологию если LSCPU пустой
            if (mode === 'numa') {
                const numaMatch = line.match(/node\s+(\d+)\s+cpus?:\s*([\d\s,\-]+)/i);
                if (numaMatch) {
                    const node = numaMatch[1];
                    const cpuList = numaMatch[2].replace(/\s+/g, ',');
                    
                    this.parseRange(cpuList).forEach(cpu => {
                        const cpuStr = cpu.toString();
                        if (!this.state.coreNumaMap[cpuStr]) {
                            this.state.coreNumaMap[cpuStr] = node;
                            
                            // Определяем socket по номеру NUMA (2 NUMA на сокет обычно)
                            const socket = Math.floor(parseInt(node) / 2).toString();
                            const l3id = node; // L3 = NUMA в fallback режиме
                            
                            if (!this.state.geometry[socket]) this.state.geometry[socket] = {};
                            if (!this.state.geometry[socket][node]) this.state.geometry[socket][node] = {};
                            if (!this.state.geometry[socket][node][l3id]) this.state.geometry[socket][node][l3id] = [];
                            if (!this.state.geometry[socket][node][l3id].includes(cpuStr)) {
                                this.state.geometry[socket][node][l3id].push(cpuStr);
                            }
                            
                            const l3Key = `${socket}-${node}-${l3id}`;
                            if (!this.state.l3Groups[l3Key]) this.state.l3Groups[l3Key] = [];
                            if (!this.state.l3Groups[l3Key].includes(cpuStr)) {
                                this.state.l3Groups[l3Key].push(cpuStr);
                            }
                        }
                    });
                }
            }
            
            // ISOLATED
            if (mode === 'isolated' && line !== 'none' && line !== 'N/A') {
                this.parseRange(line).forEach(c => this.state.isolatedCores.add(c.toString()));
            }
            
            // NETWORK (from script)
            if (mode === 'network') {
                if (line.startsWith('IF:')) {
                    const parts = {};
                    line.split('|').forEach(p => { const [k, v] = p.split(':'); parts[k] = v; });
                    if (parts.NUMA && parts.NUMA !== '-1') this.state.netNumaNodes.add(parts.NUMA);
                }
            }
            
            // BENDER - Parse cpu_id lines
            if (mode === 'bender' || mode === 'runtime') {
                const cpuIdMatch = line.match(/\{?\s*cpu_id[:\s]*(\d+)/);
                if (cpuIdMatch) {
                    const cpu = cpuIdMatch[1];
                    if (!benderCpuInfo[cpu]) benderCpuInfo[cpu] = { isolated: false, net_cpu: false, roles: [] };
                    
                    // Проверяем isolated
                    if (/isolated[:\s]*True/i.test(line)) {
                        benderCpuInfo[cpu].isolated = true;
                        this.state.isolatedCores.add(cpu);
                    }
                    
                    // Проверяем net_cpu (это IRQ ядра!)
                    if (/net_cpu[:\s]*\[/i.test(line)) {
                        benderCpuInfo[cpu].net_cpu = true;
                    }
                    
                    // Извлекаем роли
                    Object.entries(ROLE_MAP).forEach(([key, role]) => {
                        const pattern = new RegExp(key + '[:\\s]*\\[', 'i');
                        if (pattern.test(line)) {
                            benderCpuInfo[cpu].roles.push(role);
                        }
                    });
                    
                    // Пустое ядро (только cpu_id, без ролей и без isolated) = OS
                    const hasContent = /isolated|net_cpu|Gateways|Robots|AllRobots|Remote|Click|Trash|Udp|Formula/i.test(line);
                    if (!hasContent) {
                        benderCpuInfo[cpu].isOS = true;
                    }
                }
            }
            
            // BENDER_NET - ТОЛЬКО короткие записи это IRQ ядра
            if (mode === 'bender_net') {
                // net0: 2,4 - это IRQ ядра (короткий список)
                // net0: 0-31 - это ВСЕ ядра на сетевой NUMA, игнорируем
                const netMatch = line.match(/^(net\d+|eth\d+)[:\s]*([\d,\s\-]+)$/);
                if (netMatch) {
                    const cpus = this.parseRange(netMatch[2]);
                    // Если это короткий список (< 8 ядер), то это IRQ
                    // Если длинный (вся NUMA нода), то игнорируем
                    if (cpus.length <= 8) {
                        cpus.forEach(c => benderNetCpus.add(c.toString()));
                        // Определяем сетевую NUMA
                        if (cpus.length > 0) {
                            const numa = this.state.coreNumaMap[cpus[0].toString()];
                            if (numa) this.state.netNumaNodes.add(numa);
                        }
                    }
                }
            }
            
            // LOAD
            if (mode === 'load' || mode === 'cpuload') {
                const loadMatch = line.match(/^(\d+)[:\s]*([\d.]+)$/);
                if (loadMatch) {
                    this.state.cpuLoadMap[loadMatch[1]] = parseFloat(loadMatch[2]).toFixed(1);
                }
            }
        }
        
        // =====================================================================
        // POST-PROCESSING: Применяем собранную информацию из BENDER
        // =====================================================================
        
        Object.entries(benderCpuInfo).forEach(([cpu, info]) => {
            // IRQ ядра: net_cpu:True ИЛИ в списке BENDER_NET
            if (info.net_cpu || benderNetCpus.has(cpu)) {
                this.addTag('Physical', cpu, 'net_irq');
                const numa = this.state.coreNumaMap[cpu];
                if (numa) this.state.netNumaNodes.add(numa);
            }
            
            // OS ядра: пустые (без isolated, без ролей)
            if (info.isOS && !info.isolated && info.roles.length === 0) {
                this.addTag('Physical', cpu, 'sys_os');
            }
            
            // Применяем роли
            info.roles.forEach(role => {
                this.addTag('Physical', cpu, role);
            });
        });
        
        return this.state.geometry;
    },
    
    parseRange(str) {
        const result = [];
        if (!str) return result;
        str.toString().split(',').forEach(part => {
            part = part.trim();
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(x => parseInt(x.trim()));
                if (!isNaN(start) && !isNaN(end)) for (let i = start; i <= end; i++) result.push(i);
            } else {
                const val = parseInt(part);
                if (!isNaN(val)) result.push(val);
            }
        });
        return result;
    },
    
    addTag(instanceName, cpu, tag) {
        if (!cpu) return;
        if (!this.state.instances[instanceName]) this.state.instances[instanceName] = {};
        if (!this.state.instances[instanceName][cpu]) this.state.instances[instanceName][cpu] = new Set();
        this.state.instances[instanceName][cpu].add(tag);
    },
    
    // =========================================================================
    // RENDERING
    // =========================================================================
    render() {
        const input = document.getElementById('inputData')?.value || '';
        const geometry = this.parse(input);
        
        if (Object.keys(geometry).length === 0) {
            document.getElementById('canvas').innerHTML = `
                <div class="canvas-empty"><div class="empty-icon">⚠</div>
                <p>No valid CPU data found</p></div>`;
            return;
        }
        
        this.updateHeader();
        this.renderBlueprint();
        this.updateStats();
        this.calculateSizing();
    },
    
    updateHeader() {
        const subtitle = document.getElementById('header-subtitle');
        if (subtitle) {
            subtitle.textContent = this.state.serverName 
                ? `${this.state.serverName}.qb.loc | ${new Date().toLocaleString()}` : 'Ready';
        }
        
        const allCores = Object.keys(this.state.coreNumaMap);
        const usedCores = Object.keys(this.state.instances.Physical || {})
            .filter(cpu => this.state.instances.Physical[cpu]?.size > 0);
        
        let totalLoad = 0, loadCount = 0;
        allCores.forEach(cpu => {
            const load = parseFloat(this.state.cpuLoadMap[cpu] || 0);
            if (load > 0) { totalLoad += load; loadCount++; }
        });
        
        const numSockets = Object.keys(this.state.geometry).length;
        
        document.getElementById('stat-total').textContent = allCores.length;
        document.getElementById('stat-used').textContent = usedCores.length;
        document.getElementById('stat-free').textContent = allCores.length - usedCores.length;
        document.getElementById('stat-sockets').textContent = numSockets > 0 ? numSockets : '—';
        document.getElementById('stat-net').textContent = this.state.netNumaNodes.size > 0 ? [...this.state.netNumaNodes].join(',') : '—';
        document.getElementById('stat-load').textContent = loadCount > 0 ? (totalLoad / loadCount).toFixed(0) + '%' : '—';
    },
    
    renderBlueprint() {
        const canvas = document.getElementById('canvas');
        const geometry = this.state.geometry;
        
        const totalCores = Object.keys(this.state.coreNumaMap).length;
        let sizeClass = totalCores > 128 ? 'cores-small' : (totalCores > 64 ? 'cores-medium' : (totalCores <= 24 ? 'cores-xlarge' : 'cores-large'));
        
        let html = `<div class="blueprint ${sizeClass}">`;
        const sockets = Object.keys(geometry).sort((a, b) => parseInt(a) - parseInt(b));
        
        for (let i = 0; i < sockets.length; i += 2) {
            html += '<div class="sockets-row">';
            for (let j = i; j < Math.min(i + 2, sockets.length); j++) {
                html += this.renderSocket(sockets[j], geometry[sockets[j]]);
            }
            html += '</div>';
        }
        
        html += '</div>';
        canvas.innerHTML = html;
        Object.keys(this.state.coreNumaMap).forEach(cpu => this.updateCoreVisual('Physical', cpu));
    },
    
    renderSocket(socketId, numaData) {
        let html = `<div class="socket" data-socket="${socketId}">`;
        html += `<div class="socket-label">SOCKET ${socketId}</div><div class="socket-content">`;
        
        Object.keys(numaData).sort((a, b) => parseInt(a) - parseInt(b)).forEach(numaId => {
            const isNetwork = this.state.netNumaNodes.has(numaId);
            html += `<div class="numa ${isNetwork ? 'is-network' : ''}" data-numa="${numaId}">`;
            html += `<div class="numa-label">NUMA ${numaId}</div>`;
            if (isNetwork) html += '<div class="network-badge">NET</div>';
            
            Object.keys(numaData[numaId]).sort((a, b) => parseInt(a) - parseInt(b)).forEach(l3Id => {
                html += `<div class="l3"><div class="l3-label">L3 #${l3Id}</div><div class="cores-grid">`;
                numaData[numaId][l3Id].forEach(cpu => { html += this.renderCore('Physical', cpu); });
                html += '</div></div>';
            });
            html += '</div>';
        });
        
        html += '</div></div>';
        return html;
    },
    
    renderCore(instanceName, cpu) {
        const load = parseFloat(this.state.cpuLoadMap[cpu] || 0);
        const loadColor = load > 80 ? '#ef4444' : (load > 50 ? '#f59e0b' : '#22c55e');
        const hasIRQ = this.state.coreIRQMap[cpu]?.length > 0;
        
        return `<div class="core" id="core-${instanceName}-${cpu}" data-cpu="${cpu}"
                 onmousedown="HFT.onCoreMouseDown(event, '${instanceName}', '${cpu}')"
                 onmouseenter="HFT.onCoreMouseEnter(event, '${instanceName}', '${cpu}')"
                 onmousemove="HFT.moveTooltip(event)" onmouseleave="HFT.hideTooltip()">
            ${cpu}
            <div class="load-bar"><div class="load-fill" style="width:${load}%;background:${loadColor}"></div></div>
            ${hasIRQ ? '<div class="irq-dot"></div>' : ''}
        </div>`;
    },
    
    getDisplayTags(instanceName, cpu) {
        const allTags = new Set();
        if (this.state.instances.Physical?.[cpu]) this.state.instances.Physical[cpu].forEach(t => allTags.add(t));
        Object.keys(this.state.instances).forEach(instName => {
            if (instName !== 'Physical' && this.state.instances[instName]?.[cpu]) {
                this.state.instances[instName][cpu].forEach(t => allTags.add(t));
            }
        });
        return Array.from(allTags).sort((a, b) => (HFT_RULES.roles[b]?.priority || 0) - (HFT_RULES.roles[a]?.priority || 0));
    },
    
    updateCoreVisual(instanceName, cpu) {
        const el = document.getElementById(`core-${instanceName}-${cpu}`);
        if (!el) return;
        
        const tags = this.getDisplayTags(instanceName, cpu);
        const fillTags = tags.filter(t => t !== 'isolated');
        const isIsolated = tags.includes('isolated') || this.state.isolatedCores.has(cpu);
        
        el.classList.remove('has-role', 'isolated');
        el.style.background = '';
        el.style.borderColor = '';
        
        if (fillTags.length > 0) el.classList.add('has-role');
        if (isIsolated) el.classList.add('isolated');
        
        if (fillTags.length === 1) {
            const role = HFT_RULES.roles[fillTags[0]];
            if (role) { el.style.background = role.color; el.style.borderColor = role.color; }
        } else if (fillTags.length > 1) {
            const colors = fillTags.map(t => HFT_RULES.roles[t]?.color || '#555');
            const step = 100 / colors.length;
            const stops = colors.map((col, idx) => `${col} ${idx * step}%, ${col} ${(idx + 1) * step}%`).join(', ');
            el.style.background = `linear-gradient(135deg, ${stops})`;
            el.style.borderColor = 'rgba(255,255,255,0.3)';
        }
    },
    
    // =========================================================================
    // INTERACTIONS
    // =========================================================================
    onCoreMouseDown(event, instanceName, cpu) {
        this.isMouseDown = true;
        this.applyTool(instanceName, cpu, false, event.ctrlKey || event.metaKey);
    },
    
    onCoreMouseEnter(event, instanceName, cpu) {
        if (this.isMouseDown) this.applyTool(instanceName, cpu, true, event.ctrlKey || event.metaKey);
        this.showTooltip(event, instanceName, cpu);
    },
    
    applyTool(instanceName, cpu, forceAdd, isEraser) {
        if (!this.activeTool) return;
        if (!this.state.instances[instanceName]) this.state.instances[instanceName] = {};
        if (!this.state.instances[instanceName][cpu]) this.state.instances[instanceName][cpu] = new Set();
        
        const tags = this.state.instances[instanceName][cpu];
        
        if (isEraser) { tags.clear(); }
        else if (this.activeTool.id === 'isolated') {
            if (this.state.isolatedCores.has(cpu)) this.state.isolatedCores.delete(cpu);
            else this.state.isolatedCores.add(cpu);
        }
        else if (tags.has(this.activeTool.id) && !forceAdd) tags.delete(this.activeTool.id);
        else tags.add(this.activeTool.id);
        
        this.updateCoreVisual(instanceName, cpu);
        this.updateStats();
        this.calculateSizing();
    },
    
    // =========================================================================
    // TOOLTIP
    // =========================================================================
    showTooltip(event, instanceName, cpu) {
        const tooltip = document.getElementById('tooltip');
        const tags = this.getDisplayTags(instanceName, cpu);
        const load = this.state.cpuLoadMap[cpu];
        const irqs = this.state.coreIRQMap[cpu];
        const isIsolated = this.state.isolatedCores.has(cpu);
        
        let html = `<div class="tooltip-header">Core ${cpu}</div>`;
        if (load !== undefined) {
            const color = parseFloat(load) > 80 ? '#ef4444' : (parseFloat(load) > 50 ? '#f59e0b' : '#22c55e');
            html += `<div class="tooltip-load" style="color:${color}">Load: ${load}%</div>`;
        }
        if (irqs?.length > 0) html += `<div class="tooltip-irq">IRQ: ${irqs.join(', ')}</div>`;
        if (isIsolated) html += `<div class="tooltip-irq" style="color:#fff">⬡ Isolated</div>`;
        if (tags.length > 0) {
            html += '<div class="tooltip-roles">';
            tags.filter(t => t !== 'isolated').forEach(tid => {
                const role = HFT_RULES.roles[tid];
                if (role) html += `<div class="tooltip-role"><div class="tooltip-swatch" style="background:${role.color}"></div>${role.name}</div>`;
            });
            html += '</div>';
        }
        
        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        this.moveTooltip(event);
    },
    
    moveTooltip(event) {
        const tooltip = document.getElementById('tooltip');
        tooltip.style.left = (event.clientX + 15) + 'px';
        tooltip.style.top = (event.clientY + 15) + 'px';
    },
    
    hideTooltip() { document.getElementById('tooltip').style.display = 'none'; },
    
    // =========================================================================
    // STATS & OUTPUT
    // =========================================================================
    // Role ID to BENDER config name mapping
    roleToBender: {
        'sys_os': null,  // Отдельно выводится как System cpus
        'net_irq': null, // Пропускается в основном выводе
        'udp': 'UdpReceiveCores',
        'trash': 'TrashCPU',
        'gateway': 'GatewaysDefault',
        'isolated_robots': 'IsolatedRobots',
        'pool1': 'RobotsPool1',
        'pool2': 'RobotsPool2',
        'robot_default': 'RobotsDefault',
        'ar': 'AllRobotsThCPU',
        'rf': 'RemoteFormulaCPU',
        'formula': 'Formula',
        'click': 'ClickHouseCores'
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
    
    updateStats() {
        const physicalRoles = {};
        const allCpus = new Set();
        
        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => {
            allCpus.add(parseInt(cpu));
            tags.forEach(t => { 
                if (!physicalRoles[t]) physicalRoles[t] = []; 
                physicalRoles[t].push(parseInt(cpu)); 
            });
        });
        
        // Collect system cores (OS)
        const sysCores = (physicalRoles['sys_os'] || []).sort((a,b) => a-b);
        
        // Collect isolated cores
        const isolatedCores = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a,b) => a-b);
        
        // Build BENDER format output
        let txt = '{';
        const entries = [];
        
        // Add roles in BENDER format
        Object.entries(this.roleToBender).forEach(([roleId, benderName]) => {
            if (benderName && physicalRoles[roleId]?.length > 0) {
                const cores = physicalRoles[roleId].sort((a,b) => a-b);
                entries.push(`'${benderName}': [${cores.join(', ')}]`);
            }
        });
        
        // Add Isolated
        if (isolatedCores.length > 0) {
            entries.push(`'Isolated': [${isolatedCores.join(', ')}]`);
        }
        
        txt += entries.join(',\n ');
        txt += '}\n';
        
        // Add stats
        const cpuCount = Object.keys(this.state.coreNumaMap).length;
        txt += `Cpu count: ${cpuCount}\n`;
        txt += `System cpus count: ${sysCores.length}\n`;
        
        // Format system cpus as range
        if (sysCores.length > 0) {
            txt += `System cpus: ${this.formatCoreRange(sysCores)}\n`;
        }
        
        // Find unused isolated cpus (isolated but no role)
        const usedCores = new Set();
        Object.values(physicalRoles).forEach(cores => cores.forEach(c => usedCores.add(c)));
        const unusedIsolated = isolatedCores.filter(c => !usedCores.has(c));
        if (unusedIsolated.length > 0) {
            txt += `Unused bender isolated cpus: ${this.formatCoreRange(unusedIsolated)}\n`;
        }
        
        // Add NUMA info
        const numaRanges = {};
        Object.entries(this.state.geometry).forEach(([socket, numaData]) => {
            Object.entries(numaData).forEach(([numa, l3Data]) => {
                const cores = [];
                Object.values(l3Data).forEach(l3Cores => cores.push(...l3Cores));
                numaRanges[numa] = cores.sort((a,b) => a-b);
            });
        });
        
        Object.keys(numaRanges).sort((a,b) => parseInt(a) - parseInt(b)).forEach(numa => {
            txt += `node${numa}: ${this.formatCoreRange(numaRanges[numa])}\n`;
        });
        
        // Add NET NUMA info
        if (this.state.netNumaNodes.size > 0) {
            txt += '@@BENDER_NET@@\n';
            [...this.state.netNumaNodes].sort().forEach(numa => {
                if (numaRanges[numa]) {
                    txt += `net${numa}: ${this.formatCoreRange(numaRanges[numa])}\n`;
                }
            });
        }
        
        document.getElementById('output').textContent = txt;
    },
    
    formatCoreRange(cores) {
        if (cores.length === 0) return '';
        const sorted = [...cores].sort((a,b) => a-b);
        const ranges = [];
        let start = sorted[0], end = sorted[0];
        
        for (let i = 1; i <= sorted.length; i++) {
            if (i < sorted.length && sorted[i] === end + 1) {
                end = sorted[i];
            } else {
                ranges.push(start === end ? `${start}` : `${start}-${end}`);
                if (i < sorted.length) { start = sorted[i]; end = sorted[i]; }
            }
        }
        return ranges.join(',');
    },
    
    calculateSizing() {
        const osCores = [];
        let totalLoad = 0;
        
        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => {
            if (tags.has('sys_os')) { osCores.push(cpu); totalLoad += parseFloat(this.state.cpuLoadMap[cpu] || 0); }
        });
        
        document.getElementById('calc-cores').textContent = osCores.length || '—';
        const avgLoad = osCores.length > 0 ? (totalLoad / osCores.length).toFixed(1) : '—';
        document.getElementById('calc-load').textContent = avgLoad !== '—' ? avgLoad + '%' : '—';
        
        const target = parseFloat(document.getElementById('calc-target')?.value || 3);
        if (osCores.length > 0 && avgLoad !== '—') {
            const needed = Math.ceil((parseFloat(avgLoad) * osCores.length) / target);
            if (needed > osCores.length) {
                document.getElementById('calc-result').textContent = `Need ${needed}`;
                document.getElementById('calc-result').style.color = '#f59e0b';
            } else {
                document.getElementById('calc-result').textContent = `OK`;
                document.getElementById('calc-result').style.color = '#22c55e';
            }
        } else document.getElementById('calc-result').textContent = '—';
    },
    
    // =========================================================================
    // EXPORT / IMPORT
    // =========================================================================
    copyConfig() { navigator.clipboard.writeText(document.getElementById('output')?.textContent || ''); },
    
    exportConfig() {
        const config = {
            version: '4.5',
            serverName: this.state.serverName,
            timestamp: new Date().toISOString(),
            geometry: this.state.geometry,
            netNumaNodes: [...this.state.netNumaNodes],
            isolatedCores: [...this.state.isolatedCores],
            instances: {}
        };
        Object.keys(this.state.instances).forEach(instName => {
            config.instances[instName] = {};
            Object.keys(this.state.instances[instName]).forEach(cpu => {
                config.instances[instName][cpu] = [...this.state.instances[instName][cpu]];
            });
        });
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `cpu-config-${this.state.serverName || 'unknown'}-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
    },
    
    importConfig() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (evt) => {
                try { this.loadConfig(JSON.parse(evt.target.result)); }
                catch (err) { alert('Error: ' + err.message); }
            };
            reader.readAsText(file);
        };
        input.click();
    },
    
    loadConfig(config) {
        this.state.serverName = config.serverName || '';
        this.state.geometry = config.geometry || {};
        this.state.netNumaNodes = new Set(config.netNumaNodes || []);
        this.state.isolatedCores = new Set(config.isolatedCores || []);
        this.state.instances = {};
        this.state.coreNumaMap = {};
        
        Object.entries(this.state.geometry).forEach(([socket, numaData]) => {
            Object.entries(numaData).forEach(([numa, l3Data]) => {
                Object.entries(l3Data).forEach(([l3, cores]) => {
                    cores.forEach(cpu => { this.state.coreNumaMap[cpu] = numa; });
                });
            });
        });
        
        Object.keys(config.instances || {}).forEach(instName => {
            this.state.instances[instName] = {};
            Object.keys(config.instances[instName]).forEach(cpu => {
                this.state.instances[instName][cpu] = new Set(config.instances[instName][cpu]);
            });
        });
        
        this.updateHeader();
        this.renderBlueprint();
        this.updateStats();
        this.calculateSizing();
    },
    
    // =========================================================================
    // VALIDATION
    // =========================================================================
    validate() {
        const output = document.getElementById('validation-output');
        if (!output) return;
        
        if (Object.keys(this.state.coreNumaMap).length === 0) {
            output.innerHTML = '<span class="muted">No data</span>';
            return;
        }
        
        const issues = HFT_RULES.runValidation(this.state);
        if (issues.length === 0) {
            output.innerHTML = '<span class="val-ok">✓ All OK</span>';
            return;
        }
        
        output.innerHTML = issues.map(i => {
            const cls = i.severity === 'error' ? 'val-error' : (i.severity === 'warning' ? 'val-warn' : 'val-info');
            const icon = i.severity === 'error' ? '✗' : (i.severity === 'warning' ? '⚠' : 'ℹ');
            return `<div class="${cls}">${icon} ${i.message}</div>`;
        }).join('');
    },
    
    // =========================================================================
    // COMPARE
    // =========================================================================
    loadCompareFile(side) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.log,.conf,.cfg';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (evt) => {
                const text = evt.target.result;
                document.getElementById(`cmp-text-${side}`).value = text;
                
                // Auto-set server name from filename
                const serverInput = document.getElementById(`cmp-server-${side}`);
                if (serverInput && !serverInput.value) {
                    const name = file.name.replace(/\.(txt|log|conf|cfg)$/i, '');
                    serverInput.value = name;
                }
            };
            reader.readAsText(file);
        };
        input.click();
    },
    
    parseCompareText(side) {
        const textArea = document.getElementById(`cmp-text-${side}`);
        const serverInput = document.getElementById(`cmp-server-${side}`);
        const text = textArea?.value || '';
        const serverName = serverInput?.value || `Config ${side.toUpperCase()}`;
        
        if (!text.trim()) {
            alert('Paste BENDER config text first');
            return;
        }
        
        try {
            const config = this.parseBenderConfig(text, serverName);
            if (side === 'old') this.compareOld = config;
            else this.compareNew = config;
            this.renderComparePanel(side, config);
            if (this.compareOld && this.compareNew) this.calculateDiff();
        } catch (err) {
            alert('Parse error: ' + err.message);
        }
    },
    
    parseBenderConfig(text, serverName) {
        const config = {
            serverName: serverName,
            geometry: {},
            netNumaNodes: [],
            isolatedCores: [],
            instances: { Physical: {} }
        };
        
        const lines = text.split('\n');
        const lscpuData = {}; // cpu -> {numa, socket, core, l3}
        const numaRanges = {};
        let currentSection = '';
        
        // First pass: parse all sections
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
                return;
            }
            
            // Parse LSCPU section: CPU,NODE,SOCKET,CORE,L3
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
            
            // Parse ISOLATED section: "8-95" or "5-93"
            if (currentSection === 'isolated') {
                if (!trimmed.includes('size:') && !trimmed.includes('node')) {
                    const cores = this.parseCoreRange(trimmed);
                    cores.forEach(c => {
                        if (!config.isolatedCores.includes(c)) config.isolatedCores.push(c);
                    });
                }
                return;
            }
            
            // Parse NETWORK section: "IF:net0|NUMA:1|..."
            if (currentSection === 'network') {
                const numaMatch = trimmed.match(/NUMA:(\d+)/i);
                if (numaMatch) {
                    const numaId = numaMatch[1];
                    if (!config.netNumaNodes.includes(numaId)) {
                        config.netNumaNodes.push(numaId);
                    }
                }
                return;
            }
            
            // Parse BENDER section
            if (currentSection === 'bender') {
                // Format: {'cpu_id': 0, 'isolated': True, 'RobotsDefault': ['OTT4']}
                // or: {cpu_id:0,isolated:True,RobotsDefault:[OTT4]}
                if (trimmed.startsWith('{') && trimmed.includes('cpu_id')) {
                    // Extract cpu_id
                    const cpuMatch = trimmed.match(/['"]?cpu_id['"]?\s*:\s*(\d+)/);
                    if (cpuMatch) {
                        const cpu = parseInt(cpuMatch[1]);
                        const cpuStr = String(cpu);
                        
                        // Find all role assignments
                        // Match patterns like: 'RobotsDefault': ['OTT4'] or RobotsDefault:[OTT4]
                        const rolePattern = /['"]?(\w+)['"]?\s*:\s*\[/g;
                        let match;
                        while ((match = rolePattern.exec(trimmed)) !== null) {
                            const benderName = match[1];
                            // Skip non-role fields
                            if (['cpu_id', 'isolated', 'net_cpu'].includes(benderName)) continue;
                            
                            const roleId = this.benderToRole[benderName];
                            if (roleId) {
                                if (!config.instances.Physical[cpuStr]) config.instances.Physical[cpuStr] = [];
                                if (!config.instances.Physical[cpuStr].includes(roleId)) {
                                    config.instances.Physical[cpuStr].push(roleId);
                                }
                            }
                        }
                    }
                    return;
                }
                
                // Summary block: {'AllRobotsThCPU': [40], ...} or multiline
                // Match role: [cores] patterns
                const summaryPattern = /['"]?(\w+)['"]?\s*:\s*\[([^\]]*)/g;
                let match;
                while ((match = summaryPattern.exec(trimmed)) !== null) {
                    const benderName = match[1];
                    const coresStr = match[2];
                    
                    // Skip if it looks like instance names like ['OTT4']
                    if (coresStr.includes("'") || coresStr.includes('"')) continue;
                    
                    const cores = this.parseCoreList(coresStr);
                    if (cores.length === 0) continue;
                    
                    if (benderName === 'Isolated') {
                        cores.forEach(c => {
                            if (!config.isolatedCores.includes(c)) config.isolatedCores.push(c);
                        });
                    } else {
                        const roleId = this.benderToRole[benderName];
                        if (roleId) {
                            cores.forEach(cpu => {
                                const cpuStr = String(cpu);
                                if (!config.instances.Physical[cpuStr]) config.instances.Physical[cpuStr] = [];
                                if (!config.instances.Physical[cpuStr].includes(roleId)) {
                                    config.instances.Physical[cpuStr].push(roleId);
                                }
                            });
                        }
                    }
                }
                return;
            }
            
            // BENDER_NET section - skip, we got net numa from NETWORK
            if (currentSection === 'bender_net') return;
        });
        
        // Build geometry
        // Priority: LSCPU data > NUMA ranges > fallback
        if (Object.keys(lscpuData).length > 0) {
            // Use LSCPU for precise socket/numa/l3 mapping
            Object.entries(lscpuData).forEach(([cpu, data]) => {
                const socketId = String(data.socket);
                const numaId = String(data.numa);
                const l3Id = String(data.l3);
                
                if (!config.geometry[socketId]) config.geometry[socketId] = {};
                if (!config.geometry[socketId][numaId]) config.geometry[socketId][numaId] = {};
                if (!config.geometry[socketId][numaId][l3Id]) config.geometry[socketId][numaId][l3Id] = [];
                
                config.geometry[socketId][numaId][l3Id].push(parseInt(cpu));
            });
            
            // Sort cores within each L3
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
            numaIds.forEach((numaId, idx) => {
                const socketId = String(Math.floor(parseInt(numaId) / 2));
                if (!config.geometry[socketId]) config.geometry[socketId] = {};
                config.geometry[socketId][numaId] = {
                    '0': numaRanges[numaId].sort((a, b) => a - b)
                };
            });
        } else {
            // Fallback: create 4 NUMA from max core
            const maxCore = Math.max(
                ...config.isolatedCores,
                ...Object.keys(config.instances.Physical).map(c => parseInt(c)),
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
        
        return config;
    },
    
    parseCoreList(str) {
        // Parse "1, 2, 3" or "1,2,3" or multiline
        const cores = [];
        const cleaned = str.replace(/\s+/g, ' ').trim();
        if (!cleaned) return cores;
        
        cleaned.split(/[,\s]+/).forEach(part => {
            const num = parseInt(part);
            if (!isNaN(num)) cores.push(num);
        });
        return cores;
    },
    
    parseCoreRange(str) {
        // Parse "0-23" or "0-4,94-95" 
        const cores = [];
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
    },
    
    clearCompare(side) {
        if (side === 'old') this.compareOld = null;
        else this.compareNew = null;
        
        document.getElementById(`compare-${side}`).innerHTML = '';
        document.getElementById(`cmp-text-${side}`).value = '';
        document.getElementById(`cmp-server-${side}`).value = '';
        ['added', 'removed', 'changed'].forEach(k => document.getElementById(`diff-${k}`).textContent = '0');
    },
    
    renderComparePanel(side, config) {
        const container = document.getElementById(`compare-${side}`);
        const geom = config.geometry || {};
        const netNumas = new Set((config.netNumaNodes || []).map(String));
        const isolatedCores = new Set((config.isolatedCores || []).map(String));
        const insts = config.instances || {};
        
        // Collect all used roles for legend
        const usedRoles = new Set();
        
        // Count sockets
        const numSockets = Object.keys(geom).length;
        
        let html = `<div class="cmp-info">Sockets: ${numSockets} | NUMAs: ${Object.values(geom).reduce((acc, s) => acc + Object.keys(s).length, 0)}</div>`;
        html += '<div class="cmp-blueprint">';
        
        Object.keys(geom).sort((a, b) => parseInt(a) - parseInt(b)).forEach(socketId => {
            html += `<div class="cmp-socket">
                <div class="cmp-socket-hdr">Socket ${socketId}</div>
                <div class="cmp-socket-body">`;
            
            Object.keys(geom[socketId]).sort((a, b) => parseInt(a) - parseInt(b)).forEach(numaId => {
                const isNet = netNumas.has(String(numaId));
                const l3Groups = geom[socketId][numaId];
                const l3Count = Object.keys(l3Groups).length;
                
                html += `<div class="cmp-numa ${isNet ? 'is-net' : ''}">
                    <div class="cmp-numa-hdr">
                        <span>NUMA ${numaId}</span>
                        ${l3Count > 1 ? `<span class="l3-count">${l3Count} L3</span>` : ''}
                        ${isNet ? '<span class="net-tag">NET</span>' : ''}
                    </div>`;
                
                // Render L3 groups
                Object.keys(l3Groups).sort((a, b) => parseInt(a) - parseInt(b)).forEach(l3Id => {
                    const hasMultipleL3 = l3Count > 1;
                    html += `<div class="cmp-l3 ${hasMultipleL3 ? 'has-label' : ''}">`;
                    if (hasMultipleL3) {
                        html += `<div class="cmp-l3-label">L3 #${l3Id}</div>`;
                    }
                    html += '<div class="cmp-cores">';
                    
                    l3Groups[l3Id].forEach(cpu => {
                        const cpuStr = String(cpu);
                        const tags = [];
                        
                        // Collect tags from all instances
                        Object.keys(insts).forEach(inst => {
                            const cpuTags = insts[inst][cpuStr] || insts[inst][cpu];
                            if (cpuTags) {
                                if (Array.isArray(cpuTags)) tags.push(...cpuTags);
                                else if (cpuTags instanceof Set) tags.push(...cpuTags);
                            }
                        });
                        
                        const fillTags = tags.filter(t => t !== 'isolated');
                        const isIsolated = isolatedCores.has(cpuStr) || tags.includes('isolated');
                        
                        let bg = '';
                        let hasRole = false;
                        if (fillTags.length > 0) {
                            const roleId = fillTags[0];
                            const role = HFT_RULES.roles[roleId];
                            if (role) { 
                                bg = `background:${role.color};`; 
                                hasRole = true;
                                usedRoles.add(roleId);
                            }
                        }
                        
                        html += `<div class="cmp-core ${hasRole ? 'has-role' : ''} ${isIsolated ? 'is-isolated' : ''}" 
                            data-cpu="${cpuStr}" data-side="${side}" style="${bg}"
                            onmouseenter="HFT.showCompareTooltip(event,'${side}','${cpuStr}')"
                            onmousemove="HFT.moveTooltip(event)"
                            onmouseleave="HFT.hideTooltip()">${cpu}</div>`;
                    });
                    
                    html += '</div></div>';
                });
                html += '</div>';
            });
            html += '</div></div>';
        });
        });
        
        html += '</div>';
        
        // Add legend if there are roles
        if (usedRoles.size > 0) {
            html += '<div class="cmp-legend">';
            usedRoles.forEach(roleId => {
                const role = HFT_RULES.roles[roleId];
                if (role) {
                    html += `<div class="cmp-legend-item">
                        <div class="cmp-legend-color" style="background:${role.color}"></div>
                        <span>${role.name}</span>
                    </div>`;
                }
            });
            html += '</div>';
        }
        
        container.innerHTML = html;
    },
    
    showCompareTooltip(event, side, cpu) {
        const config = side === 'old' ? this.compareOld : this.compareNew;
        if (!config) return;
        
        const cpuStr = String(cpu);
        const allTags = new Set();
        
        if (config.instances) {
            Object.keys(config.instances).forEach(inst => {
                const cpuTags = config.instances[inst][cpuStr] || config.instances[inst][cpu];
                if (cpuTags) {
                    if (Array.isArray(cpuTags)) {
                        cpuTags.forEach(t => allTags.add(t));
                    } else if (cpuTags instanceof Set) {
                        cpuTags.forEach(t => allTags.add(t));
                    }
                }
            });
        }
        
        // Check isolated
        const isolatedCores = new Set((config.isolatedCores || []).map(String));
        const isIsolated = isolatedCores.has(cpuStr);
        
        let html = `<div class="tooltip-header">Core ${cpu} (${side.toUpperCase()})</div>`;
        if (isIsolated) {
            html += '<div style="font-size:10px;color:var(--accent);margin-bottom:4px;">⬡ Isolated</div>';
        }
        if (allTags.size > 0) {
            html += '<div class="tooltip-roles">';
            allTags.forEach(tid => {
                const role = HFT_RULES.roles[tid];
                if (role) html += `<div class="tooltip-role"><div class="tooltip-swatch" style="background:${role.color}"></div>${role.name}</div>`;
            });
            html += '</div>';
        } else if (!isIsolated) {
            html += '<div style="color:var(--text-muted)">No roles</div>';
        }
        
        const tooltip = document.getElementById('tooltip');
        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        this.moveTooltip(event);
    },
    
    calculateDiff() {
        if (!this.compareOld || !this.compareNew) return;
        
        const getTags = (cfg, cpu) => {
            const cpuStr = String(cpu);
            const t = new Set();
            if (cfg.instances) {
                Object.keys(cfg.instances).forEach(inst => {
                    const cpuTags = cfg.instances[inst][cpuStr] || cfg.instances[inst][cpu];
                    if (cpuTags) {
                        if (Array.isArray(cpuTags)) {
                            cpuTags.forEach(x => t.add(x));
                        } else if (cpuTags instanceof Set) {
                            cpuTags.forEach(x => t.add(x));
                        }
                    }
                });
            }
            return t;
        };
        
        const allCpus = new Set();
        [this.compareOld, this.compareNew].forEach(cfg => {
            if (cfg.instances) Object.values(cfg.instances).forEach(inst => Object.keys(inst).forEach(cpu => allCpus.add(cpu)));
        });
        
        let added = 0, removed = 0, changed = 0;
        allCpus.forEach(cpu => {
            const oldTags = getTags(this.compareOld, cpu);
            const newTags = getTags(this.compareNew, cpu);
            const oldEl = document.querySelector(`.cmp-core[data-cpu="${cpu}"][data-side="old"]`);
            const newEl = document.querySelector(`.cmp-core[data-cpu="${cpu}"][data-side="new"]`);
            
            oldEl?.classList.remove('diff-added', 'diff-removed', 'diff-changed');
            newEl?.classList.remove('diff-added', 'diff-removed', 'diff-changed');
            
            if (oldTags.size === 0 && newTags.size > 0) { added++; newEl?.classList.add('diff-added'); }
            else if (oldTags.size > 0 && newTags.size === 0) { removed++; oldEl?.classList.add('diff-removed'); }
            else if (oldTags.size > 0 && newTags.size > 0) {
                const same = oldTags.size === newTags.size && [...oldTags].every(t => newTags.has(t));
                if (!same) { changed++; oldEl?.classList.add('diff-changed'); newEl?.classList.add('diff-changed'); }
            }
        });
        
        document.getElementById('diff-added').textContent = added;
        document.getElementById('diff-removed').textContent = removed;
        document.getElementById('diff-changed').textContent = changed;
    },
    
    // =========================================================================
    // RECOMMENDATIONS
    // =========================================================================
    generateRecommendation() {
        const output = document.getElementById('recommend-output');
        const btnApply = document.getElementById('btn-apply');
        
        if (Object.keys(this.state.coreNumaMap).length === 0) {
            output.innerHTML = '<div class="recommend-placeholder"><p style="color:#f59e0b;">⚠ Load server data first</p></div>';
            return;
        }
        
        const result = HFT_RULES.generateRecommendation(this.state);
        this.proposedConfig = result.proposedConfig;
        
        output.innerHTML = result.html;
        btnApply.disabled = !result.proposedConfig;
    },
    
    applyRecommendation() {
        if (!this.proposedConfig) return;
        
        // Clear existing roles
        this.state.instances = { Physical: {} };
        
        // Apply proposed config
        Object.entries(this.proposedConfig.instances?.Physical || {}).forEach(([cpu, roles]) => {
            if (!this.state.instances.Physical[cpu]) this.state.instances.Physical[cpu] = new Set();
            roles.forEach(role => this.state.instances.Physical[cpu].add(role));
        });
        
        this.renderBlueprint();
        this.updateStats();
        document.querySelector('.tab[data-tab="mapper"]')?.click();
    },
    
    // =========================================================================
    // DEMO
    // =========================================================================
    loadDemo() {
        document.getElementById('inputData').value = `@@HFT_CPU_MAP_V4@@
HOST:demo-server
DATE:2025-12-13T12:00:00Z
@@LSCPU@@
@@NUMA@@
node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
node 0 size: 64000 MB
node 1 cpus: 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31
node 1 size: 64000 MB
@@ISOLATED@@
2-29
@@NETWORK@@
IF:net0|NUMA:0|DRV:ena|IRQ:
@@BENDER@@
{cpu_id:0}
{cpu_id:1}
{cpu_id:2,isolated:True,net_cpu:[net0]}
{cpu_id:3,isolated:True,UdpSendCores:[TRA0]}
{cpu_id:4,isolated:True,net_cpu:[net0]}
{cpu_id:5,isolated:True,TrashCPU:[TRA0]}
{cpu_id:6,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:7,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:8,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:9,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:10,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:11,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:12,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:13,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:14,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:15,isolated:True,GatewaysDefault:[TRA0]}
{cpu_id:16,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:17,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:18,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:19,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:20,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:21,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:22,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:23,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:24,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:25,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:26,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:27,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:28,isolated:True,AllRobotsThCPU:[TRA0]}
{cpu_id:29,isolated:True,RemoteFormulaCPU:[TRA0],ClickHouseCores:[TRA0]}
{cpu_id:30}
{cpu_id:31}
@@BENDER_NET@@
net0: 2,4
net0: 0-31
@@LOAD@@
0:25.0
1:24.0
2:6.0
3:5.0
4:5.0
5:3.0
6:4.0
7:4.0
8:3.0
9:3.0
10:3.0
11:3.0
12:4.0
13:4.0
14:4.0
15:3.0
16:5.0
17:5.0
18:5.0
19:5.0
20:5.0
21:5.0
22:5.0
23:5.0
24:6.0
25:6.0
26:6.0
27:6.0
28:1.0
29:1.0
30:25.0
31:25.0
@@END@@`;
        this.render();
    }
};

document.addEventListener('DOMContentLoaded', () => HFT.init());

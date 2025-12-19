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
        networkInterfaces: [],
        selectedInstance: 'Physical'
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
        this.initMainDragDrop();
        this.initInstanceManager();
        this.activeTool = HFT_RULES.roles.robot_default;

        // Phase 1: Try to load from URL hash first, then localStorage
        if (!this.loadFromUrlHash()) {
            this.restoreFromLocalStorage();
        }
    },

    initInstanceManager() {
        this.updateInstanceSelect();
    },

    updateInstanceSelect() {
        const select = document.getElementById('instance-select');
        const ansibleSelect = document.getElementById('ansible-instance-select');

        [select, ansibleSelect].forEach(sel => {
            if (!sel) return;
            sel.innerHTML = '';
            Object.keys(this.state.instances).forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name === 'Physical' ? 'Physical (System)' : name;
                opt.selected = name === this.state.selectedInstance;
                sel.appendChild(opt);
            });
        });
    },

    selectInstance(name) {
        this.state.selectedInstance = name;
    },

    addInstance() {
        const input = document.getElementById('new-instance-name');
        const name = input?.value?.trim().toUpperCase();
        if (name && !this.state.instances[name]) {
            this.state.instances[name] = {};
            this.state.selectedInstance = name;
            this.updateInstanceSelect();
            input.value = '';
            this.renderBlueprint(); // Refresh map
        }
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
        document.addEventListener('keydown', (e) => {
            // Toggle sidebar
            if (e.key === '[') this.toggleSidebar();

            // Escape - deselect tool
            if (e.key === 'Escape') {
                this.activeTool = null;
                document.querySelectorAll('.palette-item').forEach(item => item.classList.remove('active'));
            }

            // Ctrl+S - Export config
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                this.exportConfig();
            }

            // Ctrl+O - Import config
            if (e.ctrlKey && e.key === 'o') {
                e.preventDefault();
                this.importConfig();
            }

            // Ctrl+L - Copy shareable link
            if (e.ctrlKey && e.key === 'l') {
                e.preventDefault();
                this.copyShareLink();
            }
        });
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
        // Preserve selected instance if it exists in the new parse, otherwise Physical
        const currentSelection = this.state && this.state.selectedInstance ? this.state.selectedInstance : 'Physical';

        this.state = {
            serverName: '', geometry: {}, coreNumaMap: {}, l3Groups: {},
            netNumaNodes: new Set(), isolatedCores: new Set(), coreIRQMap: {},
            cpuLoadMap: {}, instances: { Physical: {} }, networkInterfaces: [],
            coreBenderMap: {}, instanceToInterface: {},
            selectedInstance: 'Physical' // Will be updated after parse if possible
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
            if (line === '@@HFT_CPU_MAP_V4@@' || line === '@@HFT_CPU_MAP_V5@@') { mode = 'v4'; continue; }
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
                    if (parts.NUMA && parts.NUMA !== '-1') {
                        this.state.netNumaNodes.add(parts.NUMA);
                    }
                    if (parts.IF) {
                        this.state.networkInterfaces.push({
                            name: parts.IF,
                            numaNode: parseInt(parts.NUMA || 0)
                        });
                    }
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
                        // Match key:[val1,val2] or key: [val]
                        const pattern = new RegExp(key + '[:\\s]*\\[([^\\]]*)\\]', 'i');
                        const match = line.match(pattern);
                        if (match) {
                            // Store role with its associated instance
                            const serverName = match[1].trim();
                            benderCpuInfo[cpu].roles.push({
                                id: role,
                                instance: serverName
                            });

                            // Store primary instance for this core
                            if (serverName) {
                                this.state.coreBenderMap[cpu] = serverName;
                            }
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
                // If the core has a known instance (from other roles), use it. Otherwise 'Physical'.
                // Often IRQ cores are shared or belong to network stack, 'Physical' is fine for visual
                // But if they have instance mapping in Bender, use it.
                // However, parsing logic below handles roles. IRQ is a special role.
                // We'll assign to 'Physical' for now as it's often system-wide or we don't know yet which instance owns 'net0'.
                // If we extracted net_cpu:[net0], we might map net0 to instances later.
                this.addTag('Physical', cpu, 'net_irq');
                const numa = this.state.coreNumaMap[cpu];
                if (numa) this.state.netNumaNodes.add(numa);
            }

            // OS ядра: пустые (без isolated, без ролей)
            if (info.isOS && !info.isolated && info.roles.length === 0) {
                this.addTag('Physical', cpu, 'sys_os');
            }

            // Применяем роли (role is now object {id, instance})
            info.roles.forEach(roleObj => {
                const instanceName = roleObj.instance || 'Physical';
                // Also ensure core is added to Physical for backward compatibility/global view if needed
                // But our visualizer aggregates all instances so we just add to specific instance
                this.addTag(instanceName, cpu, roleObj.id);
            });
        });

        // Restore selected instance if valid, otherwise Physical
        if (this.state.instances[currentSelection]) {
            this.state.selectedInstance = currentSelection;
        } else {
            this.state.selectedInstance = 'Physical';
        }

        // Refresh instance selector
        this.updateInstanceSelect();

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

        // Auto-save to localStorage
        this.saveToLocalStorage();
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

        if (!geometry || Object.keys(geometry).length === 0) {
            canvas.innerHTML = `<div class="canvas-empty"><p>No data to render</p></div>`;
            return;
        }

        // Grid Container
        let html = `<div class="blueprint">`;

        const sockets = Object.keys(geometry).sort((a, b) => parseInt(a) - parseInt(b));
        sockets.forEach(socketId => {
            html += this.renderSocket(socketId, geometry[socketId]);
        });

        html += '</div>';
        canvas.innerHTML = html;

        // Apply colors after render
        Object.keys(this.state.coreNumaMap).forEach(cpu => this.updateCoreVisual('Physical', cpu));
    },

    renderSocket(socketId, numaData) {
        let html = `<div class="socket">
            <div class="socket-label">Socket ${socketId}</div>
            <div class="socket-content">`;

        Object.keys(numaData).sort((a, b) => parseInt(a) - parseInt(b)).forEach(numaId => {
            const isNetwork = this.state.netNumaNodes.has(numaId);
            html += `<div class="numa ${isNetwork ? 'is-network' : ''}">
                <div class="numa-label">
                    <span>NUMA ${numaId}</span>
                    ${isNetwork ? '<span class="network-badge">NET</span>' : ''}
                </div>`;

            // L3 Groups
            Object.keys(numaData[numaId]).sort((a, b) => parseInt(a) - parseInt(b)).forEach(l3Id => {
                html += `<div class="l3">
                    <div class="l3-label">L3 Cache #${l3Id}</div>
                    <div class="cores-grid">`;

                numaData[numaId][l3Id].forEach(cpu => {
                    html += this.renderCore('Physical', cpu);
                });

                html += `</div></div>`;
            });
            html += `</div>`;
        });

        html += `</div></div>`;
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
            <div class="core-label"></div>
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
        el.querySelector('.core-label').textContent = '';

        // Determine Instance Label
        let activeInst = null;
        Object.keys(this.state.instances).forEach(inst => {
            if (inst !== 'Physical' && this.state.instances[inst][cpu]?.size > 0) {
                activeInst = inst;
            }
        });
        if (activeInst) {
            el.querySelector('.core-label').textContent = activeInst;
        }

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
    onCoreMouseDown(event, _instanceName, cpu) {
        this.isMouseDown = true;
        this.applyTool(this.state.selectedInstance, cpu, false, event.ctrlKey || event.metaKey);
    },

    onCoreMouseEnter(event, _instanceName, cpu) {
        if (this.isMouseDown) this.applyTool(this.state.selectedInstance, cpu, true, event.ctrlKey || event.metaKey);
        this.showTooltip(event, this.state.selectedInstance, cpu);
    },

    applyTool(instanceName, cpu, forceAdd, isEraser) {
        if (!this.activeTool) return;
        if (!this.state.instances[instanceName]) this.state.instances[instanceName] = {};
        if (!this.state.instances[instanceName][cpu]) this.state.instances[instanceName][cpu] = new Set();

        const tags = this.state.instances[instanceName][cpu];

        if (isEraser) {
            // Global Clean: Remove this core from ALL instances and clear isolation
            Object.keys(this.state.instances).forEach(inst => {
                if (this.state.instances[inst][cpu]) {
                    this.state.instances[inst][cpu].clear();
                }
            });
            this.state.isolatedCores.delete(cpu);
        }
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

        // Bender Source
        if (this.state.coreBenderMap && this.state.coreBenderMap[cpu]) {
            html += `<div class="tooltip-bender">Bender: ${this.state.coreBenderMap[cpu]}</div>`;
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
        let txt = '---\n';
        txt += 'hft_tunels: true\n\n';

        // 1. Host Vars (isol_cpus, net_cpus, irqaffinity)
        const isolatedCores = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a, b) => a - b);
        if (isolatedCores.length > 0) {
            txt += `isol_cpus: ${this.formatCoreRange(isolatedCores)}\n`;
        }

        // net_cpus
        const physicalRoles = {};
        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!physicalRoles[t]) physicalRoles[t] = [];
                physicalRoles[t].push(parseInt(cpu));
            });
        });
        const netCores = (physicalRoles['net_irq'] || []).sort((a, b) => a - b);
        if (netCores.length > 0) {
            txt += 'net_cpus:\n';
            // Use collected network interfaces or fallback to net0
            const netInterfaces = this.state.networkInterfaces || [];
            if (netInterfaces.length > 0) {
                netInterfaces.forEach(iface => {
                    // Check if we have specific mapping for this interface
                    txt += `  ${iface.name || iface}: [${netCores.join(', ')}]\n`;
                });
            } else {
                txt += `  net0: [${netCores.join(', ')}]\n`;
            }
        }

        // irqaffinity_cpus (sys_os)
        const sysCores = (physicalRoles['sys_os'] || []).sort((a, b) => a - b);
        if (sysCores.length > 0) {
            txt += `irqaffinity_cpus: ${this.formatCoreRange(sysCores)}\n`;
        }

        // 2. bs_instances
        txt += '\n\nbs_instances:\n';

        // Iterate over all instances (skipping 'Physical')
        // If only 'Physical' exists, we might treat it as a default instance if it has services assigned
        const instances = Object.keys(this.state.instances).filter(k => k !== 'Physical');

        // If no explicit instances, check if Physical has services that imply an instance
        if (instances.length === 0) {
            // Fallback: Create one instance named after server or default
            const instanceName = this.state.serverName?.toUpperCase() || 'INSTANCE';
            instances.push(instanceName);
        }

        instances.forEach((instName, idx) => {
            const instRoles = {};
            // If it's the fallback instance, use Physical roles. Otherwise use instance roles.
            const sourceInst = this.state.instances[instName] ? instName : 'Physical';

            Object.entries(this.state.instances[sourceInst] || {}).forEach(([cpu, tags]) => {
                tags.forEach(t => {
                    if (!instRoles[t]) instRoles[t] = [];
                    instRoles[t].push(parseInt(cpu));
                });
            });

            // Helper to get cores
            const getCores = (role) => (instRoles[role] || []).sort((a, b) => a - b);
            const getOne = (role) => getCores(role)[0] || '';

            const trashCpu = getOne('trash');
            let membind = '';
            if (trashCpu !== '') {
                const numa = this.state.coreNumaMap[String(trashCpu)];
                if (numa !== undefined) membind = String(numa);
            }
            if (!membind) {
                // Fallback: all NUMAs
                membind = [...new Set(Object.values(Object.fromEntries(this.state.coreNumaMap)))].sort().join(',');
            }

            txt += `  ${instName}:\n`;
            txt += `    name: ${instName}\n`;
            txt += `    id: ${idx}\n`;
            txt += `    daemon_pri: dmx1.qb.loc:8050\n`;
            txt += `    daemon_sec: dmx2.qb.loc:8050\n`;
            txt += `    membind: "${membind}"\n`;
            txt += `    taskset: "${trashCpu}"\n`;
            txt += `    trash_cpu: "${trashCpu}"\n`;
            txt += `    allrobots_cpu: "${getOne('ar')}"\n`;
            txt += `    remoteformula_cpu: "${getOne('rf') || trashCpu}"\n`;
            txt += `    gateways_cpu: ${getCores('gateway').join(',')}\n`;
            txt += `    robots_cpu: ${getCores('robot_default').join(',')}\n`;
            txt += `    udpsend_cpu: "${getOne('udp')}"\n`;
            txt += `    udpreceive_cpu: "${getOne('udp')}"\n`;
            txt += `    udp_emitstats: true\n`;
            txt += `    udp_stats_mw_interval: "100ms"\n`;

            // Custom Alias
            const formula = getOne('formula');
            const iso = getCores('isolated_robots');
            const pool1 = getCores('pool1');
            const pool2 = getCores('pool2');

            if (formula || iso.length > 0 || pool1.length > 0 || pool2.length > 0) {
                txt += `    cpualias_custom:\n`;
                if (formula) txt += `      - <CPUAlias Name="Formula" Cores="${formula}" IoService="true" Debug="false" />\n`;
                if (iso.length > 0) txt += `      - <CPUAlias Name="Isolated" Cores="${iso.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO" />\n`;
                if (pool1.length > 0) txt += `      - <CPUAlias Name="RobotsNode1" Cores="${pool1.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO" />\n`;
                if (pool2.length > 0) txt += `      - <CPUAlias Name="RobotsNode2" Cores="${pool2.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO" />\n`;
            }

            // Clickhouse (custom field in screenshot)
            // It seems clickhouse might be top level or inside? Screenshot 2 doesn't show it.
            // Screenshot 1 is host vars.
            // I'll keep clickhouse inside if it's per instance, or separate?
            // User screenshot shows `bs_instances` end.
            // I'll assume clickhouse config might be separate or part of it.
            // For now, I won't put it in `bs_instances` unless I see it there.
            // The previous code put it at the end. I'll stick to that but outside the block if it's not standard.
        });

        document.getElementById('output').textContent = txt;

        // Update Ansible export preview
        this.updateAnsiblePreview();
    },

    formatCoreRange(cores) {
        if (cores.length === 0) return '';
        const sorted = [...cores].sort((a, b) => a - b);
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
    copyConfig() {
        const text = document.getElementById('output')?.textContent || '';
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.querySelector('button[onclick="HFT.copyConfig()"]');
            if (btn) {
                const original = btn.innerHTML;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.innerHTML = original, 1000);
            }
        }).catch(err => {
            console.error('Copy failed:', err);
            alert('Copy failed: ' + err);
        });
    },

    exportConfig() {
        try {
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
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
        } catch (e) {
            console.error('Export failed:', e);
            alert('Export failed: ' + e.message);
        }
    },

    // =========================================================================
    // ANSIBLE EXPORT - Generate YAML-compatible output for Ansible configs
    // =========================================================================

    /**
     * Generate Ansible-compatible instance config (bender_instances.yml format)
     * @param {string} instanceName - Name of the instance to export
     * @returns {string} YAML-formatted config
     */
    generateAnsibleInstanceConfig(instanceName) {
        if (!instanceName || instanceName === 'Physical') {
            // Use first non-Physical instance or fallback
            const instances = Object.keys(this.state.instances).filter(k => k !== 'Physical');
            instanceName = instances[0] || 'INSTANCE';
        }

        const instRoles = {};
        const sourceInst = this.state.instances[instanceName] || this.state.instances.Physical || {};

        Object.entries(sourceInst).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!instRoles[t]) instRoles[t] = [];
                instRoles[t].push(parseInt(cpu));
            });
        });

        const getCores = (role) => (instRoles[role] || []).sort((a, b) => a - b);
        const getOne = (role) => getCores(role)[0] ?? '';

        const trashCpu = getOne('trash');
        const udpCpu = getOne('udp');
        const arCpu = getOne('ar');
        const rfCpu = getOne('rf') || trashCpu;
        const formulaCpu = getOne('formula');
        const gatewayCores = getCores('gateway');
        const robotDefaultCores = getCores('robot_default');
        const isolatedRobotCores = getCores('isolated_robots');
        const pool1Cores = getCores('pool1');
        const pool2Cores = getCores('pool2');

        let txt = '';
        txt += `    taskset: ${trashCpu}\n`;
        txt += `    trash_cpu: ${trashCpu}\n`;
        txt += `    allrobots_cpu: ${arCpu}\n`;
        txt += `    remoteformula_cpu: ${rfCpu}\n`;
        txt += `    gateways_cpu: ${gatewayCores.join(',')}\n`;
        txt += `    robots_cpu: ${robotDefaultCores.join(',')}\n`;
        txt += `    udpsend_cpu: ${udpCpu}\n`;
        txt += `    udpreceive_cpu: ${udpCpu}\n`;

        // CPUAlias custom section
        const aliases = [];
        if (formulaCpu !== '') {
            aliases.push(`      - <CPUAlias Name="Formula" Cores="${formulaCpu}" IoService="true" Debug="false" />`);
        }
        if (isolatedRobotCores.length > 0) {
            aliases.push(`      - <CPUAlias Name="Isolated" Cores="${isolatedRobotCores.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO" />`);
        }
        if (pool1Cores.length > 0) {
            aliases.push(`      - <CPUAlias Name="RobotsNode1" Cores="${pool1Cores.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO" />`);
        }
        if (pool2Cores.length > 0) {
            aliases.push(`      - <CPUAlias Name="RobotsNode2" Cores="${pool2Cores.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO" />`);
        }

        if (aliases.length > 0) {
            txt += `    cpualias_custom:\n`;
            txt += aliases.join('\n') + '\n';
        }

        return txt;
    },

    /**
     * Generate Ansible-compatible host vars (vars.yml format)
     * @returns {string} YAML-formatted host vars
     */
    generateAnsibleHostVars() {
        let txt = '';

        // isol_cpus - all isolated cores as range
        const isolatedCores = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a, b) => a - b);
        if (isolatedCores.length > 0) {
            txt += `isol_cpus: ${this.formatCoreRange(isolatedCores)}\n`;
        }

        // irqaffinity_cpus - non-isolated cores (sys_os)
        const physicalRoles = {};
        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!physicalRoles[t]) physicalRoles[t] = [];
                physicalRoles[t].push(parseInt(cpu));
            });
        });
        const sysCores = (physicalRoles['sys_os'] || []).sort((a, b) => a - b);
        if (sysCores.length > 0) {
            txt += `irqaffinity_cpus: ${this.formatCoreRange(sysCores)}\n`;
        }

        // net_cpus - IRQ cores grouped by interface
        const netCores = (physicalRoles['net_irq'] || []).sort((a, b) => a - b);
        if (netCores.length > 0) {
            txt += `net_cpus:\n`;
            // Use collected network interfaces or fallback to generic names
            const netInterfaces = this.state.networkInterfaces || [];
            if (netInterfaces.length > 0) {
                // Group interfaces by NUMA node
                const numaGroups = {};
                netInterfaces.forEach(iface => {
                    const numa = iface.numaNode?.toString() || '0';
                    if (!numaGroups[numa]) numaGroups[numa] = [];
                    numaGroups[numa].push(iface.name || iface);
                });

                // Get cores for each NUMA
                Object.entries(numaGroups).forEach(([numa, interfaces]) => {
                    const numaCores = netCores.filter(c =>
                        this.state.coreNumaMap[c.toString()] === numa
                    );
                    if (numaCores.length > 0) {
                        interfaces.forEach(ifaceName => {
                            txt += `  ${ifaceName}: [${numaCores.join(', ')}]\n`;
                        });
                    }
                });
            } else {
                // Fallback: generic net0, net1
                txt += `  net0: [${netCores.join(', ')}]\n`;
                txt += `  net1: [${netCores.join(', ')}]\n`;
            }
        }

        return txt;
    },

    /**
     * Copy instance config to clipboard
     */
    copyAnsibleInstanceConfig() {
        const instanceSelect = document.getElementById('ansible-instance-select');
        const instanceName = instanceSelect?.value || this.state.selectedInstance;
        const text = this.generateAnsibleInstanceConfig(instanceName);

        if (!text.trim()) {
            alert('No instance config to copy. Please assign cores first.');
            return;
        }

        navigator.clipboard.writeText(text).then(() => {
            const btn = document.querySelector('button[onclick="HFT.copyAnsibleInstanceConfig()"]');
            if (btn) {
                const original = btn.innerHTML;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.innerHTML = original, 1000);
            }
        }).catch(err => {
            console.error('Copy failed:', err);
            alert('Copy failed: ' + err);
        });
    },

    /**
     * Copy host vars to clipboard
     */
    copyAnsibleHostVars() {
        const text = this.generateAnsibleHostVars();

        if (!text.trim()) {
            alert('No host vars to copy. Please load data first.');
            return;
        }

        navigator.clipboard.writeText(text).then(() => {
            const btn = document.querySelector('button[onclick="HFT.copyAnsibleHostVars()"]');
            if (btn) {
                const original = btn.innerHTML;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.innerHTML = original, 1000);
            }
        }).catch(err => {
            console.error('Copy failed:', err);
            alert('Copy failed: ' + err);
        });
    },

    /**
     * Update Ansible export preview
     */
    updateAnsiblePreview() {
        const instanceSelect = document.getElementById('ansible-instance-select');
        const instanceName = instanceSelect?.value || this.state.selectedInstance;
        const preview = document.getElementById('ansible-output');

        if (!preview) return;

        let txt = '# Instance Config (bender_instances.yml)\n';
        txt += this.generateAnsibleInstanceConfig(instanceName);
        txt += '\n# Host Vars (vars.yml)\n';
        txt += this.generateAnsibleHostVars();

        preview.textContent = txt;
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
        this.state.coreBenderMap = config.coreBenderMap || {};


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
                else if (trimmed.includes('LOAD_AVG') || trimmed.includes('END_LOAD')) currentSection = 'load';
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
                const ifMatch = trimmed.match(/IF:([^|]+)/i);
                const numaMatch = trimmed.match(/NUMA:(\d+)/i);

                if (ifMatch && numaMatch) {
                    const ifName = ifMatch[1].trim();
                    const numaId = numaMatch[1];

                    // Save interface to NUMA mapping
                    if (!config.interfaceNumaMap) config.interfaceNumaMap = {};
                    config.interfaceNumaMap[ifName] = numaId;

                    // Also collect unique network NUMA nodes
                    if (!config.netNumaNodes.includes(numaId)) {
                        config.netNumaNodes.push(numaId);
                    }
                }
                return;
            }

            // Parse BENDER section - V5 Format
            if (currentSection === 'bender') {
                // Format: {cpu_id: 0} or {cpu_id: 9, isolated: True, TrashCPU: [OMM0]}
                if (trimmed.startsWith('{') && trimmed.includes('cpu_id')) {
                    // Extract cpu_id
                    const cpuMatch = trimmed.match(/cpu_id\s*:\s*(\d+)/);
                    if (cpuMatch) {
                        const cpu = parseInt(cpuMatch[1]);
                        const cpuStr = String(cpu);

                        // Check if this core is isolated
                        const isIsolated = /isolated\s*:\s*True/i.test(trimmed);

                        // If NOT isolated, it's an OS core
                        if (!isIsolated) {
                            if (!config.instances.Physical[cpuStr]) config.instances.Physical[cpuStr] = [];
                            if (!config.instances.Physical[cpuStr].includes('sys_os')) {
                                config.instances.Physical[cpuStr].push('sys_os');
                            }
                            return;
                        }

                        // If isolated, check for net_cpu first (IRQ cores)
                        const netCpuMatch = trimmed.match(/net_cpu\s*:\s*\[([^\]]+)\]/);
                        if (netCpuMatch) {
                            if (!config.instances.Physical[cpuStr]) config.instances.Physical[cpuStr] = [];
                            if (!config.instances.Physical[cpuStr].includes('net_irq')) {
                                config.instances.Physical[cpuStr].push('net_irq');
                            }
                            // Continue to check for other services too (in case there are multiple roles)
                        }

                        // Find all service assignments (pattern: ServiceName: [InstanceID])
                        // Match patterns like: GatewaysDefault: [OMM0] or RobotsDefault:[OTC1]
                        const rolePattern = /(\w+)\s*:\s*\[([^\]]*)\]/g;
                        let match;
                        const instancesOnThisCore = new Set();

                        while ((match = rolePattern.exec(trimmed)) !== null) {
                            const benderName = match[1];
                            const instanceList = match[2];

                            // Skip non-role fields
                            if (['cpu_id', 'isolated'].includes(benderName)) continue;

                            // Track net_cpu interface for instances
                            if (benderName === 'net_cpu' && instanceList) {
                                const ifName = instanceList.trim();
                                // For each service instance on this core, associate with this interface
                                // We'll do this in second pass
                                if (!config.coreToInterface) config.coreToInterface = {};
                                config.coreToInterface[cpuStr] = ifName;
                            }

                            // Map bender name to role ID
                            const roleId = this.benderToRole[benderName];
                            if (roleId) {
                                if (!config.instances.Physical[cpuStr]) config.instances.Physical[cpuStr] = [];
                                if (!config.instances.Physical[cpuStr].includes(roleId)) {
                                    config.instances.Physical[cpuStr].push(roleId);
                                }

                                // Track which instance this is for interface mapping
                                if (instanceList) {
                                    instancesOnThisCore.add(instanceList.trim());
                                }
                            }
                        }

                        // If this core has net_cpu, map all instances on it to that interface
                        if (netCpuMatch && instancesOnThisCore.size > 0) {
                            const ifName = netCpuMatch[1].trim();
                            if (!config.instanceToInterface) config.instanceToInterface = {};
                            instancesOnThisCore.forEach(inst => {
                                if (!config.instanceToInterface[inst]) {
                                    config.instanceToInterface[inst] = ifName;
                                }
                            });
                        }

                        // If isolated but no specific role assigned (just {cpu_id: X, isolated: True})
                        // Don't add any tag - it's just isolated, which is fine
                    }
                    return;
                }

                return;
            }

            // Parse LOAD_AVG section: cpu0:6.37
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

        // Post-processing: Infer OS cores
        // Any core in geometry that is NOT isolated and has no role = OS core
        const isolatedSet = new Set(config.isolatedCores.map(String));
        Object.values(config.geometry).forEach(socket => {
            Object.values(socket).forEach(numa => {
                Object.values(numa).forEach(cores => {
                    cores.forEach(cpu => {
                        const cpuStr = String(cpu);
                        const hasRole = config.instances.Physical[cpuStr]?.length > 0;
                        const isIsolated = isolatedSet.has(cpuStr);

                        if (!hasRole && !isIsolated) {
                            if (!config.instances.Physical[cpuStr]) config.instances.Physical[cpuStr] = [];
                            config.instances.Physical[cpuStr].push('sys_os');
                        }
                    });
                });
            });
        });

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

        try {
            // Adapter: Convert state to Optimizer Snapshot
            const snapshot = this.createOptimizerSnapshot();

            // Optimize
            const result = CPU_OPTIMIZER.optimize(snapshot);
            this.proposedConfig = result; // Store full result for apply

            // Render
            const html = this.renderOptimizationResults(result);
            output.innerHTML = html;
            btnApply.disabled = false;
        } catch (e) {
            console.error(e);
            output.innerHTML = `<div class="val-error">Error during optimization: ${e.message}</div>`;
        }
    },

    createOptimizerSnapshot() {
        const s = this.state;
        const topology = [];

        // Build topology from geometry (hierarchical)
        Object.entries(s.geometry).forEach(([socketId, numaData]) => {
            Object.entries(numaData).forEach(([numaId, l3Data]) => {
                Object.entries(l3Data).forEach(([l3Id, cores]) => {
                    cores.forEach(cpu => {
                        const cpuStr = String(cpu);
                        const services = [];
                        const load = parseFloat(s.cpuLoadMap[cpuStr] || 0);

                        // Find services on this core across all instances
                        Object.entries(s.instances).forEach(([instName, coreMap]) => {
                            if (coreMap[cpuStr]) {
                                coreMap[cpuStr].forEach(roleId => {
                                    // Map roleId to Optimizer Service Name
                                    // 'gateway' -> 'Gateway', etc.
                                    let svcName = null;
                                    const r = HFT_RULES.roles[roleId];
                                    if (!r) return;

                                    // Manual mapping or based on role props
                                    if (roleId === 'gateway') svcName = 'Gateway';
                                    else if (roleId.includes('robot') || roleId.includes('pool')) svcName = 'Robot';
                                    else if (roleId === 'trash') svcName = 'Trash';
                                    else if (roleId === 'udp') svcName = 'UDP';
                                    else if (roleId === 'ar') svcName = 'AR';
                                    else if (roleId === 'rf') svcName = 'RF';
                                    else if (roleId === 'formula') svcName = 'Formula';
                                    else if (roleId === 'click') svcName = 'ClickHouse';
                                    else if (roleId === 'net_irq') svcName = 'IRQ';
                                    else if (roleId === 'sys_os') svcName = 'System';

                                    if (svcName) {
                                        services.push({
                                            name: svcName,
                                            instanceId: instName === 'Physical' ? 'SYSTEM' : instName,
                                            currentCoreIds: [parseInt(cpu)] // Identify this core belongs to service
                                        });
                                    }
                                });
                            }
                        });

                        topology.push({
                            id: parseInt(cpu),
                            socketId: parseInt(socketId),
                            numaNodeId: parseInt(numaId),
                            l3CacheId: parseInt(l3Id),
                            currentLoad: load,
                            services: services
                        });
                    });
                });
            });
        });

        return {
            topology: topology,
            network: s.networkInterfaces.map(n => ({ name: n.name, numaNode: n.numaNode })),
            instanceToInterface: s.instanceToInterface || {},
            interfaceNumaMap: s.networkInterfaces.reduce((acc, n) => { acc[n.name] = n.numaNode; return acc; }, {})
        };
    },

    renderOptimizationResults(result) {
        let html = '<div class="opt-results">';

        // Header Stats
        html += `<div class="opt-stats">
            <div class="opt-stat-item"><span>Total Cores</span><strong>${result.totalCores}</strong></div>
            <div class="opt-stat-item"><span>OS Cores</span><strong>${result.osCores.length}</strong></div>
            <div class="opt-stat-item"><span>IRQ Cores</span><strong>${result.irqCores}</strong></div>
        </div>`;

        // Instances breakdown
        result.instances.forEach(inst => {
            const isAllocated = inst.allocatedCores > 0;
            const score = inst.totalScore || 0;

            html += `<div class="opt-instance">
                <div class="opt-inst-header">
                    <h3>${inst.instanceId}</h3>
                    <div class="opt-inst-score">Score: ${score}</div>
                </div>
                <div class="opt-inst-details">
                    <div>Allocated: <strong>${inst.allocatedCores}</strong> cores</div>
                    <div>Needs: GW:${inst.gateway} | Rob:${inst.robot}</div>
                </div>`;

            // Placement details
            if (inst.numaPlacement && inst.numaPlacement.breakdown) {
                html += `<div class="opt-placement">`;
                Object.values(inst.numaPlacement.breakdown).forEach(bd => {
                    const type = bd.isNetwork ? 'Network' : 'Remote';
                    html += `<div class="opt-numa-bd ${bd.isNetwork ? 'is-net' : ''}">
                        NUMA ${bd.numaId} (${type}): ${bd.services.join(', ')}
                    </div>`;
                });
                html += `</div>`;
            }

            // Assigned Cores
            if (inst.coreAssignments) {
                html += `<div class="opt-cores-list">`;
                inst.coreAssignments.forEach(assign => {
                    const coresStr = this.formatCoreRange(assign.cores);
                    const svc = assign.service.toLowerCase();
                    let roleId = 'sys_os';

                    if (svc === 'gateway') roleId = 'gateway';
                    else if (svc === 'robot') roleId = 'robot_default';
                    else if (svc === 'trash' || svc === 'trash_combo') roleId = 'trash';
                    else if (svc === 'udp') roleId = 'udp';
                    else if (svc === 'ar' || svc === 'ar_combo') roleId = 'ar';
                    else if (svc === 'rf') roleId = 'rf';
                    else if (svc === 'formula') roleId = 'formula';
                    else if (svc === 'click') roleId = 'click'; // clickhouse maps to click
                    else if (svc === 'clickhouse') roleId = 'click';
                    else if (svc === 'irq') roleId = 'net_irq';
                    else if (svc === 'os') roleId = 'sys_os';

                    const roleColor = HFT_RULES.roles[roleId]?.color || '#888';

                    html += `<div class="opt-core-group" style="border-left: 3px solid ${roleColor}">
                        <span class="opt-svc-name">${assign.service}</span>
                        <span class="opt-svc-cores">${coresStr}</span>
                    </div>`;
                });
                html += `</div>`;
            }

            html += `</div>`;
        });

        // Global Recommendations
        if (result.recommendations && result.recommendations.length > 0) {
            html += `<div class="opt-recs"><h3>Recommendations</h3>`;
            result.recommendations.forEach(rec => {
                rec.changes.forEach(change => {
                    html += `<div class="opt-rec-item ${rec.priorities.includes('critical') ? 'critical' : ''}">
                        <strong>${rec.instanceId}</strong>: ${change.service} - ${change.reason}
                    </div>`;
                });
            });
            html += `</div>`;
        }

        html += '</div>';
        return html;
    },

    applyRecommendation() {
        if (!this.proposedConfig) return;

        // Clear existing roles
        this.state.instances = { Physical: {} };
        this.state.isolatedCores.clear(); // Clear isolation

        // Apply new config
        // First, mark all OS cores (implicitly 0-N)
        // Actually, we should set isolated=true for all NON-OS cores first?
        // Or just set isolated=true based on assignments.
        // Logic: cores 0-N are OS, everything else is Isolated.
        // Wait, optimizer returns strict OS set.
        const osSet = new Set(this.proposedConfig.osCores.map(c => String(c)));
        const allCores = Object.keys(this.state.coreNumaMap);

        allCores.forEach(cpu => {
            if (!osSet.has(String(cpu))) {
                this.state.isolatedCores.add(String(cpu));
            }
        });

        this.proposedConfig.instances.forEach(instPlan => {
            const instName = instPlan.instanceId;
            // if (instName === 'SYSTEM') return; // SYSTEM tasks handled separately?

            // SYSTEM tasks usually map to Physical or just IRQ
            const targetInst = instName === 'SYSTEM' ? 'Physical' : instName;
            if (!this.state.instances[targetInst]) this.state.instances[targetInst] = {};

            if (instPlan.coreAssignments) {
                instPlan.coreAssignments.forEach(assign => {
                    // Map Service Name to Role ID
                    let roleId = null;
                    const svc = assign.service.toLowerCase();
                    const rolesToApply = [];

                    if (svc === 'gateway') rolesToApply.push('gateway');
                    else if (svc === 'robot') {
                        rolesToApply.push('robot_default'); // Default, specific pools logic removed for simplicity or handled by optimizer tiering
                    }
                    else if (svc === 'trash_combo') {
                        rolesToApply.push('trash');
                        rolesToApply.push('click');
                        rolesToApply.push('rf');
                    }
                    else if (svc === 'ar_combo') {
                        rolesToApply.push('ar');
                        rolesToApply.push('formula');
                    }
                    else if (svc === 'udp') rolesToApply.push('udp');
                    else if (svc === 'irq') rolesToApply.push('net_irq');

                    // Apply all roles
                    if (rolesToApply.length > 0) {
                        assign.cores.forEach(cpu => {
                            const cpuStr = String(cpu);
                            rolesToApply.forEach(r => this.addTag(targetInst, cpuStr, r));
                        });
                    }
                });
            }
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
    },

    // =========================================================================
    // PHASE 1: LocalStorage Persistence
    // =========================================================================
    STORAGE_KEY: 'hft-cpu-mapper-config',

    saveToLocalStorage() {
        try {
            const config = {
                version: '5.0',
                savedAt: new Date().toISOString(),
                serverName: this.state.serverName,
                geometry: this.state.geometry,
                coreNumaMap: this.state.coreNumaMap,
                coreSocketMap: this.state.coreSocketMap,
                isolatedCores: [...this.state.isolatedCores],
                netNumaNodes: [...this.state.netNumaNodes],
                l3Groups: this.state.l3Groups,
                cpuLoadMap: this.state.cpuLoadMap,
                instances: {
                    Physical: Object.fromEntries(
                        Object.entries(this.state.instances.Physical || {}).map(([cpu, tags]) =>
                            [cpu, tags instanceof Set ? [...tags] : tags]
                        )
                    )
                }
            };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(config));
            console.log('[Storage] Config saved');
        } catch (e) {
            console.warn('[Storage] Failed to save:', e);
        }
    },

    restoreFromLocalStorage() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (!saved) return false;

            const config = JSON.parse(saved);
            if (config && config.geometry && Object.keys(config.geometry).length > 0) {
                this.loadConfig(config);
                console.log('[Storage] Config restored from', config.savedAt);
                return true;
            }
        } catch (e) {
            console.warn('[Storage] Failed to restore:', e);
        }
        return false;
    },

    clearLocalStorage() {
        localStorage.removeItem(this.STORAGE_KEY);
        console.log('[Storage] Cleared');
    },

    // =========================================================================
    // PHASE 1: URL Hash Config Sharing
    // =========================================================================
    loadFromUrlHash() {
        try {
            const hash = window.location.hash;
            if (!hash || !hash.startsWith('#cfg=')) return false;

            const encoded = hash.substring(5); // Remove '#cfg='
            const json = this.decompressConfig(encoded);
            if (json) {
                const config = JSON.parse(json);
                this.loadConfig(config);
                console.log('[URL] Config loaded from hash');
                // Clear hash to avoid confusion
                history.replaceState(null, '', window.location.pathname);
                return true;
            }
        } catch (e) {
            console.warn('[URL] Failed to load from hash:', e);
        }
        return false;
    },

    copyShareLink() {
        try {
            const config = {
                v: '5',
                s: this.state.serverName,
                g: this.state.geometry,
                cn: Object.fromEntries(this.state.coreNumaMap),
                cs: Object.fromEntries(this.state.coreSocketMap),
                ic: [...this.state.isolatedCores],
                nn: [...this.state.netNumaNodes],
                l3: this.state.l3Groups,
                i: Object.fromEntries(
                    Object.entries(this.state.instances.Physical || {}).map(([cpu, tags]) =>
                        [cpu, tags instanceof Set ? [...tags] : tags]
                    )
                )
            };

            const compressed = this.compressConfig(JSON.stringify(config));
            const url = `${window.location.origin}${window.location.pathname}#cfg=${compressed}`;

            navigator.clipboard.writeText(url).then(() => {
                alert('✓ Link copied!\n\nShare this URL to let others view your config.');
            });
        } catch (e) {
            console.warn('[URL] Failed to create share link:', e);
            alert('Failed to create share link');
        }
    },

    compressConfig(json) {
        // Simple base64 encoding (works for moderate configs)
        // For larger configs, could use pako.js for gzip
        return btoa(encodeURIComponent(json));
    },

    decompressConfig(encoded) {
        try {
            return decodeURIComponent(atob(encoded));
        } catch (e) {
            return null;
        }
    },

    // =========================================================================
    // PHASE 1: Main Input Drag & Drop
    // =========================================================================
    initMainDragDrop() {
        const inputArea = document.getElementById('inputData');
        if (!inputArea) return;

        const container = inputArea.parentElement;

        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            container.classList.add('drag-active');
        });

        container.addEventListener('dragleave', () => {
            container.classList.remove('drag-active');
        });

        container.addEventListener('drop', (e) => {
            e.preventDefault();
            container.classList.remove('drag-active');

            const file = e.dataTransfer.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (evt) => {
                    inputArea.value = evt.target.result;
                    // Auto-parse if it looks like valid data
                    if (evt.target.result.includes('@@')) {
                        this.render();
                    }
                };
                reader.readAsText(file);
            }
        });
    },

    // =========================================================================
    // PHASE 2: Command Generation
    // =========================================================================

    generateCommands() {
        const commands = {
            kernel: this.generateKernelParams(),
            taskset: this.generateTasksetCommands(),
            numactl: this.generateNumactlCommands(),
            irqbalance: this.generateIrqbalanceBan(),
            script: ''
        };

        // Generate full shell script
        commands.script = this.generateShellScript(commands);
        return commands;
    },

    generateKernelParams() {
        const isolated = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a, b) => a - b);
        if (isolated.length === 0) return '';

        const range = this.formatCoreRange(isolated);
        return `isolcpus=${range} nohz_full=${range} rcu_nocbs=${range}`;
    },

    generateTasksetCommands() {
        const commands = [];
        const physicalRoles = {};

        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!physicalRoles[t]) physicalRoles[t] = [];
                physicalRoles[t].push(parseInt(cpu));
            });
        });

        const roleNames = {
            'sys_os': 'OS processes',
            'net_irq': 'IRQ handlers',
            'udp': 'UDP handler',
            'trash': 'Trash/RF/Click',
            'gateway': 'Gateways',
            'isolated_robots': 'Isolated Robots',
            'pool1': 'Robot Pool 1',
            'pool2': 'Robot Pool 2',
            'robot_default': 'Default Robots',
            'ar': 'AllRobotsTh',
            'rf': 'RemoteFormula',
            'formula': 'Formula',
            'click': 'ClickHouse'
        };

        Object.entries(physicalRoles).forEach(([role, cores]) => {
            if (role === 'isolated') return;
            const sorted = cores.sort((a, b) => a - b);
            const name = roleNames[role] || role;
            const mask = this.coresToMask(sorted);
            commands.push({
                role: name,
                cores: this.formatCoreRange(sorted),
                mask,
                cmd: `taskset -p ${mask} $PID  # ${name}`
            });
        });

        return commands;
    },

    generateNumactlCommands() {
        const commands = [];
        const numaRoles = {};

        // Group cores by NUMA
        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => {
            const numa = this.state.coreNumaMap[cpu] || this.state.coreNumaMap[parseInt(cpu)];
            if (numa === undefined) return;

            tags.forEach(role => {
                if (role === 'isolated') return;
                const key = `${role}_${numa}`;
                if (!numaRoles[key]) numaRoles[key] = { role, numa, cores: [] };
                numaRoles[key].cores.push(parseInt(cpu));
            });
        });

        Object.values(numaRoles).forEach(({ role, numa, cores }) => {
            const sorted = cores.sort((a, b) => a - b);
            commands.push({
                role,
                numa,
                cores: this.formatCoreRange(sorted),
                cmd: `numactl --cpunodebind=${numa} --membind=${numa} ./app  # ${role}`
            });
        });

        return commands;
    },

    generateIrqbalanceBan() {
        const isolated = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a, b) => a - b);
        if (isolated.length === 0) return '';

        const mask = this.coresToMask(isolated);
        return `IRQBALANCE_BANNED_CPUS="${mask}"`;
    },

    coresToMask(cores) {
        // Generate hex CPU mask
        let mask = BigInt(0);
        cores.forEach(c => {
            mask |= BigInt(1) << BigInt(c);
        });
        return '0x' + mask.toString(16).toUpperCase();
    },

    generateShellScript(commands) {
        let script = `#!/bin/bash
# HFT CPU Mapper - Generated Configuration Script
# Server: ${this.state.serverName || 'unknown'}
# Generated: ${new Date().toISOString()}

# ==============================================================================
# KERNEL PARAMETERS (add to GRUB_CMDLINE_LINUX in /etc/default/grub)
# ==============================================================================
# ${commands.kernel}

# ==============================================================================
# IRQBALANCE CONFIGURATION (/etc/sysconfig/irqbalance or /etc/default/irqbalance)
# ==============================================================================
${commands.irqbalance}

# ==============================================================================
# TASKSET EXAMPLES (bind processes to specific CPUs)
# ==============================================================================
`;
        commands.taskset.forEach(t => {
            script += `# ${t.role}: cores ${t.cores}\n`;
            script += `# ${t.cmd}\n\n`;
        });

        script += `
# ==============================================================================
# NUMACTL EXAMPLES (NUMA-aware process binding)
# ==============================================================================
`;
        commands.numactl.forEach(n => {
            script += `# ${n.role} on NUMA ${n.numa}: cores ${n.cores}\n`;
            script += `# ${n.cmd}\n\n`;
        });

        return script;
    },

    showCommands() {
        const commands = this.generateCommands();

        let html = '<div class="commands-panel">';
        html += '<h3>📋 Kernel Parameters</h3>';
        html += `<div class="cmd-block" onclick="HFT.copyCommand(this)">
            <code>${commands.kernel || 'No isolated cores configured'}</code>
            <span class="copy-hint">Click to copy</span>
        </div>`;

        html += '<h3>🔒 IRQBalance Ban</h3>';
        html += `<div class="cmd-block" onclick="HFT.copyCommand(this)">
            <code>${commands.irqbalance || 'No isolated cores'}</code>
            <span class="copy-hint">Click to copy</span>
        </div>`;

        html += '<h3>⚙️ Taskset Commands</h3>';
        commands.taskset.forEach(t => {
            html += `<div class="cmd-block" onclick="HFT.copyCommand(this)">
                <div class="cmd-label">${t.role} (${t.cores})</div>
                <code>${t.cmd}</code>
                <span class="copy-hint">Click to copy</span>
            </div>`;
        });

        html += '<h3>📦 Full Shell Script</h3>';
        html += `<button class="btn btn-primary" onclick="HFT.downloadScript()">Download Script</button>`;

        html += '</div>';

        // Show in modal or panel
        const modal = document.createElement('div');
        modal.className = 'commands-modal';
        modal.innerHTML = `
            <div class="commands-modal-content">
                <div class="commands-modal-header">
                    <h2>Generated Commands</h2>
                    <button class="btn btn-ghost" onclick="this.closest('.commands-modal').remove()">✕</button>
                </div>
                <div class="commands-modal-body">${html}</div>
            </div>
        `;
        document.body.appendChild(modal);
    },

    copyCommand(el) {
        const code = el.querySelector('code');
        if (code) {
            navigator.clipboard.writeText(code.textContent);
            el.classList.add('copied');
            setTimeout(() => el.classList.remove('copied'), 1500);
        }
    },

    downloadScript() {
        const commands = this.generateCommands();
        const blob = new Blob([commands.script], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cpu-config-${this.state.serverName || 'server'}.sh`;
        a.click();
        URL.revokeObjectURL(url);
    }
};

document.addEventListener('DOMContentLoaded', () => HFT.init());

/**
 * HFT CPU Mapper - Main Application v4.6
 * Fixed: Isolation persistence, Config output filtering, UI Cleanup
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

        if (!this.loadFromUrlHash()) {
            this.restoreFromLocalStorage();
        }
    },

    initInstanceManager() {
        this.updateInstanceSelect();
    },

    updateInstanceSelect() {
        const select = document.getElementById('instance-select');
        // Removed ansible select

        [select].forEach(sel => {
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
            this.renderBlueprint();
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
            if (e.key === '[') this.toggleSidebar();
            if (e.key === 'Escape') {
                this.activeTool = null;
                document.querySelectorAll('.palette-item').forEach(item => item.classList.remove('active'));
            }
            if (e.ctrlKey && e.key === 's') { e.preventDefault(); this.exportConfig(); }
            if (e.ctrlKey && e.key === 'o') { e.preventDefault(); this.importConfig(); }
            if (e.ctrlKey && e.key === 'l') { e.preventDefault(); this.copyShareLink(); }
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
    // PARSING
    // =========================================================================
    parse(text) {
        const currentSelection = this.state && this.state.selectedInstance ? this.state.selectedInstance : 'Physical';

        this.state = {
            serverName: '', geometry: {}, coreNumaMap: {}, l3Groups: {},
            netNumaNodes: new Set(), isolatedCores: new Set(), coreIRQMap: {},
            cpuLoadMap: {}, instances: { Physical: {} }, networkInterfaces: [],
            coreBenderMap: {}, instanceToInterface: {},
            selectedInstance: 'Physical'
        };

        const lines = text.split('\n');
        let mode = 'none';

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

        const benderCpuInfo = {};
        const benderNetCpus = new Set();

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;

            if (line === '@@HFT_CPU_MAP_V4@@' || line === '@@HFT_CPU_MAP_V5@@') { mode = 'v4'; continue; }
            if (line.startsWith('@@') && line.endsWith('@@')) {
                mode = line.replace(/@@/g, '').toLowerCase();
                continue;
            }
            if (line.startsWith('HOST:')) { this.state.serverName = line.split(':')[1]; continue; }

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

            if (mode === 'numa') {
                const numaMatch = line.match(/node\s+(\d+)\s+cpus?:\s*([\d\s,\-]+)/i);
                if (numaMatch) {
                    const node = numaMatch[1];
                    const cpuList = numaMatch[2].replace(/\s+/g, ',');

                    this.parseRange(cpuList).forEach(cpu => {
                        const cpuStr = cpu.toString();
                        if (!this.state.coreNumaMap[cpuStr]) {
                            this.state.coreNumaMap[cpuStr] = node;
                            const socket = Math.floor(parseInt(node) / 2).toString();
                            const l3id = node;

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

            if (mode === 'isolated' && line !== 'none' && line !== 'N/A') {
                this.parseRange(line).forEach(c => this.state.isolatedCores.add(c.toString()));
            }

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

            if (mode === 'bender' || mode === 'runtime') {
                const cpuIdMatch = line.match(/\{?\s*cpu_id[:\s]*(\d+)/);
                if (cpuIdMatch) {
                    const cpu = cpuIdMatch[1];
                    if (!benderCpuInfo[cpu]) benderCpuInfo[cpu] = { isolated: false, net_cpu: false, roles: [] };

                    if (/isolated[:\s]*True/i.test(line)) {
                        benderCpuInfo[cpu].isolated = true;
                        this.state.isolatedCores.add(cpu);
                    }

                    if (/net_cpu[:\s]*\[/i.test(line)) {
                        benderCpuInfo[cpu].net_cpu = true;
                    }

                    Object.entries(ROLE_MAP).forEach(([key, role]) => {
                        const pattern = new RegExp(key + '[:\\s]*\\[([^\\]]*)\\]', 'i');
                        const match = line.match(pattern);
                        if (match) {
                            const serverName = match[1].trim();
                            benderCpuInfo[cpu].roles.push({
                                id: role,
                                instance: serverName
                            });
                            if (serverName) {
                                this.state.coreBenderMap[cpu] = serverName;
                            }
                        }
                    });

                    const hasContent = /isolated|net_cpu|Gateways|Robots|AllRobots|Remote|Click|Trash|Udp|Formula/i.test(line);
                    if (!hasContent) {
                        benderCpuInfo[cpu].isOS = true;
                    }
                }
            }

            if (mode === 'bender_net') {
                const netMatch = line.match(/^(net\d+|eth\d+)[:\s]*([\d,\s\-]+)$/);
                if (netMatch) {
                    const cpus = this.parseRange(netMatch[2]);
                    if (cpus.length <= 8) {
                        cpus.forEach(c => benderNetCpus.add(c.toString()));
                        if (cpus.length > 0) {
                            const numa = this.state.coreNumaMap[cpus[0].toString()];
                            if (numa) this.state.netNumaNodes.add(numa);
                        }
                    }
                }
            }

            if (mode === 'load' || mode === 'cpuload') {
                const loadMatch = line.match(/^(\d+)[:\s]*([\d.]+)$/);
                if (loadMatch) {
                    this.state.cpuLoadMap[loadMatch[1]] = parseFloat(loadMatch[2]).toFixed(1);
                }
            }
        }

        Object.entries(benderCpuInfo).forEach(([cpu, info]) => {
            if (info.net_cpu || benderNetCpus.has(cpu)) {
                this.addTag('Physical', cpu, 'net_irq');
                const numa = this.state.coreNumaMap[cpu];
                if (numa) this.state.netNumaNodes.add(numa);
            }

            if (info.isOS && !info.isolated && info.roles.length === 0) {
                this.addTag('Physical', cpu, 'sys_os');
            }

            info.roles.forEach(roleObj => {
                const instanceName = roleObj.instance || 'Physical';
                this.addTag(instanceName, cpu, roleObj.id);
            });
        });

        if (this.state.instances[currentSelection]) {
            this.state.selectedInstance = currentSelection;
        } else {
            this.state.selectedInstance = 'Physical';
        }

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

        let html = `<div class="blueprint">`;

        const sockets = Object.keys(geometry).sort((a, b) => parseInt(a) - parseInt(b));
        sockets.forEach(socketId => {
            html += this.renderSocket(socketId, geometry[socketId]);
        });

        html += '</div>';
        canvas.innerHTML = html;

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
            // Global Clean: Remove this core from ALL instances
            Object.keys(this.state.instances).forEach(inst => {
                if (this.state.instances[inst][cpu]) {
                    this.state.instances[inst][cpu].clear();
                }
            });
            // FIX: Do NOT remove isolation status when erasing, unless specifically handled
            // User requirement: "Isolated tag should NOT be removed when clearing services"
            // Isolation is persistent unless OS is assigned or Toggle is used.
        }
        else if (this.activeTool.id === 'isolated') {
            if (this.state.isolatedCores.has(cpu)) this.state.isolatedCores.delete(cpu);
            else this.state.isolatedCores.add(cpu);
        }
        else if (this.activeTool.id === 'sys_os') {
            // Assigning OS removes isolation
            if (this.state.isolatedCores.has(cpu)) this.state.isolatedCores.delete(cpu);
            tags.add(this.activeTool.id);
        }
        else {
            // Assigning other roles (Robot, Gateway etc)
            if (tags.has(this.activeTool.id) && !forceAdd) tags.delete(this.activeTool.id);
            else tags.add(this.activeTool.id);

            // Ensure isolated if not OS?
            // "All cores that are not OS are by default isolated".
            // So if we paint a Robot, we ensure it is isolated.
            if (!this.state.isolatedCores.has(cpu)) {
                // Check if it has OS role? If so, don't isolate.
                // Assuming we don't mix OS + Robot on same core usually.
                // If it was OS, and we paint Robot, should it become Isolated?
                // Usually yes. But let's keep it simple: Ensure isolation on paint.
                this.state.isolatedCores.add(cpu);
            }
        }

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

    updateStats() {
        let txt = '---\n';
        txt += 'hft_tunels: true\n\n';

        const isolatedCores = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a, b) => a - b);
        if (isolatedCores.length > 0) {
            txt += `isol_cpus: ${this.formatCoreRange(isolatedCores)}\n`;
        }

        // net_cpus: Filter and Map by Topology
        const physicalRoles = {};
        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!physicalRoles[t]) physicalRoles[t] = [];
                physicalRoles[t].push(parseInt(cpu));
            });
        });

        const allNetCores = (physicalRoles['net_irq'] || []).sort((a, b) => a - b);

        if (allNetCores.length > 0) {
            txt += 'net_cpus:\n';
            const netInterfaces = this.state.networkInterfaces || [];

            // Filter: Only net* and hit*
            const relevantInterfaces = netInterfaces.filter(iface =>
                /^(net|hit)\d+/.test(iface.name)
            );

            if (relevantInterfaces.length > 0) {
                relevantInterfaces.forEach(iface => {
                    const ifaceNuma = iface.numaNode;
                    // Filter IRQ cores that belong to this NUMA node
                    const assignedCores = allNetCores.filter(c => {
                        const coreNuma = parseInt(this.state.coreNumaMap[String(c)]);
                        return coreNuma === ifaceNuma;
                    });

                    if (assignedCores.length > 0) {
                        txt += `  ${iface.name}: [${assignedCores.join(', ')}]\n`;
                    }
                });
            } else {
                // Fallback if no specific interfaces found or topology mismatch
                // Just dump all cores to generic net0 (legacy behavior fallback)
                txt += `  net0: [${allNetCores.join(', ')}]\n`;
            }
        }

        const sysCores = (physicalRoles['sys_os'] || []).sort((a, b) => a - b);
        if (sysCores.length > 0) {
            txt += `irqaffinity_cpus: ${this.formatCoreRange(sysCores)}\n`;
        }

        txt += '\n\nbs_instances:\n';

        const instances = Object.keys(this.state.instances).filter(k => k !== 'Physical');

        if (instances.length === 0) {
            const instanceName = this.state.serverName?.toUpperCase() || 'INSTANCE';
            instances.push(instanceName);
        }

        instances.forEach((instName, idx) => {
            const instRoles = {};
            const sourceInst = this.state.instances[instName] ? instName : 'Physical';

            Object.entries(this.state.instances[sourceInst] || {}).forEach(([cpu, tags]) => {
                tags.forEach(t => {
                    if (!instRoles[t]) instRoles[t] = [];
                    instRoles[t].push(parseInt(cpu));
                });
            });

            const getCores = (role) => (instRoles[role] || []).sort((a, b) => a - b);
            const getOne = (role) => getCores(role)[0] || '';

            const trashCpu = getOne('trash');
            let membind = '';
            if (trashCpu !== '') {
                const numa = this.state.coreNumaMap[String(trashCpu)];
                if (numa !== undefined) membind = String(numa);
            }
            if (!membind) {
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
        });

        document.getElementById('output').textContent = txt;
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

    generateAnsibleInstanceConfig(instanceName) {
        if (!instanceName || instanceName === 'Physical') {
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

    generateAnsibleHostVars() {
        let txt = '';

        const isolatedCores = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a, b) => a - b);
        if (isolatedCores.length > 0) {
            txt += `isol_cpus: ${this.formatCoreRange(isolatedCores)}\n`;
        }

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

        const netCores = (physicalRoles['net_irq'] || []).sort((a, b) => a - b);
        if (netCores.length > 0) {
            txt += `net_cpus:\n`;
            const netInterfaces = this.state.networkInterfaces || [];
            if (netInterfaces.length > 0) {
                const numaGroups = {};
                netInterfaces.forEach(iface => {
                    const numa = iface.numaNode?.toString() || '0';
                    if (!numaGroups[numa]) numaGroups[numa] = [];
                    numaGroups[numa].push(iface.name || iface);
                });

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
                txt += `  net0: [${netCores.join(', ')}]\n`;
                txt += `  net1: [${netCores.join(', ')}]\n`;
            }
        }

        return txt;
    },

    updateAnsiblePreview() {
        // Stubbed out - panel removed
    },

    copyAnsibleInstanceConfig() {},
    copyAnsibleHostVars() {}
};

document.addEventListener('DOMContentLoaded', () => HFT.init());

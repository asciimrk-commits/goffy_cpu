/**
 * HFT CPU Mapper - Main Application v4.0
 */

const HFT = {
    state: {
        serverName: '', geometry: {}, coreNumaMap: {}, l3Groups: {},
        netNumaNodes: new Set(), isolatedCores: new Set(), coreIRQMap: {},
        cpuLoadMap: {}, instances: { Physical: {} }, networkInterfaces: []
    },
    
    activeTool: null, isMouseDown: false,
    compareOld: null, compareNew: null, proposedConfig: null,
    
    init() {
        this.initPalette(); this.initTabs(); this.initDragDrop();
        this.initKeyboard(); this.initSidebar();
        this.activeTool = HFT_RULES.roles.robot;
    },
    
    initPalette() {
        const container = document.getElementById('palette');
        if (!container) return;
        let html = '';
        ['system', 'network', 'gateway', 'logic'].forEach(catId => {
            const cat = HFT_RULES.categories[catId];
            html += `<div class="palette-category">${cat.name}</div>`;
            cat.roles.forEach(roleId => {
                const role = HFT_RULES.roles[roleId];
                if (role && !role.isStateFlag) {
                    html += `<div class="palette-item" data-role="${role.id}" onclick="HFT.selectTool('${role.id}')">
                        <div class="palette-swatch" style="background:${role.color}"></div><span>${role.name}</span></div>`;
                }
            });
        });
        html += `<div class="palette-category">State</div>`;
        html += `<div class="palette-item" data-role="isolated" onclick="HFT.selectTool('isolated')">
            <div class="palette-swatch" style="background:transparent;border:2px dashed #fff"></div><span>Isolated</span></div>`;
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
    
    initSidebar() { document.getElementById('sidebarToggle')?.addEventListener('click', () => this.toggleSidebar()); },
    toggleSidebar() { document.getElementById('sidebar')?.classList.toggle('collapsed'); },
    
    selectTool(roleId) {
        this.activeTool = HFT_RULES.roles[roleId];
        document.querySelectorAll('.palette-item').forEach(item => item.classList.toggle('active', item.dataset.role === roleId));
    },
    
    parse(text) {
        this.state = { serverName: '', geometry: {}, coreNumaMap: {}, l3Groups: {},
            netNumaNodes: new Set(), isolatedCores: new Set(), coreIRQMap: {},
            cpuLoadMap: {}, instances: { Physical: {} }, networkInterfaces: [] };
        
        const lines = text.split('\n');
        let mode = 'none', currentIface = null;
        
        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            
            if (line === '@@HFT_CPU_MAP_V4@@') { mode = 'v4'; continue; }
            if (line.startsWith('@@') && line.endsWith('@@')) { mode = line.replace(/@@/g, '').toLowerCase(); continue; }
            if (line.startsWith('HOST:')) { this.state.serverName = line.split(':')[1]; continue; }
            
            const serverMatch = line.match(/Подключение к\s+([^\s=]+)/);
            if (serverMatch) this.state.serverName = serverMatch[1].replace('.qb.loc', '').replace('===', '').trim();
            
            if (line.includes('>>> 1. LSCPU')) { mode = 'lscpu'; continue; }
            if (line.includes('>>> 2. NUMA')) { mode = 'numa'; continue; }
            if (line.includes('>>> 3. ISOLATED')) { mode = 'isolated'; continue; }
            if (line.includes('>>> 4. NETWORK')) { mode = 'network'; continue; }
            if (line.includes('>>> 5. RUNTIME')) { mode = 'runtime'; continue; }
            if (line.includes('>>> 6. TOP')) { mode = 'interrupts'; continue; }
            if (line.includes('>>> 7. CPU LOAD')) { mode = 'cpuload'; continue; }
            
            if (mode === 'lscpu') {
                if (line.startsWith('CPU') || line.startsWith('#')) continue;
                const parts = line.split(',');
                if (parts.length < 5) continue;
                const [cpu, node, socket, , l3id] = parts.map(p => p.trim());
                if (node === '-' || socket === '-') continue;
                
                this.state.coreNumaMap[cpu] = node;
                if (!this.state.geometry[socket]) this.state.geometry[socket] = {};
                if (!this.state.geometry[socket][node]) this.state.geometry[socket][node] = {};
                if (!this.state.geometry[socket][node][l3id || 'U']) this.state.geometry[socket][node][l3id || 'U'] = [];
                this.state.geometry[socket][node][l3id || 'U'].push(cpu);
                
                const l3Key = `${socket}-${node}-${l3id || 'U'}`;
                if (!this.state.l3Groups[l3Key]) this.state.l3Groups[l3Key] = [];
                this.state.l3Groups[l3Key].push(cpu);
                
                if (parseInt(cpu) === 0) this.addTag('Physical', cpu, 'sys_os');
            }
            
            if (mode === 'isolated' && line !== 'none' && line !== 'N/A') {
                this.parseRange(line).forEach(c => this.state.isolatedCores.add(c.toString()));
            }
            
            if (mode === 'network') {
                if (line.startsWith('IF:')) {
                    const parts = {}; line.split('|').forEach(p => { const [k, v] = p.split(':'); parts[k] = v; });
                    if (parts.NUMA && parts.NUMA !== '-1') this.state.netNumaNodes.add(parts.NUMA);
                    if (parts.IRQ) {
                        parts.IRQ.split(',').forEach(irqStr => {
                            if (!irqStr) return;
                            const [irq, cpus] = irqStr.split(':');
                            this.parseRange(cpus || '').forEach(cpu => {
                                const cStr = cpu.toString();
                                this.addTag('Physical', cStr, 'net_irq');
                                if (!this.state.coreIRQMap[cStr]) this.state.coreIRQMap[cStr] = [];
                                this.state.coreIRQMap[cStr].push(irq);
                            });
                        });
                    }
                }
                if (line.includes('Interface:')) {
                    const match = line.match(/Interface:\s*(\S+)/);
                    if (match) { currentIface = { name: match[1], numaNode: null }; this.state.networkInterfaces.push(currentIface); }
                }
                if (currentIface) {
                    const numaMatch = line.match(/NUMA Node:\s*(-?\d+)/);
                    if (numaMatch) { currentIface.numaNode = numaMatch[1]; if (numaMatch[1] !== '-1') this.state.netNumaNodes.add(numaMatch[1]); }
                    const irqMatch = line.match(/^\s*IRQ\s+(\d+):\s*CPUs?\s*\[?([\d,\s-]+)\]?/i);
                    if (irqMatch) {
                        this.parseRange(irqMatch[2]).forEach(cpu => {
                            const cStr = cpu.toString();
                            this.addTag('Physical', cStr, 'net_irq');
                            if (!this.state.coreIRQMap[cStr]) this.state.coreIRQMap[cStr] = [];
                            this.state.coreIRQMap[cStr].push(irqMatch[1]);
                        });
                    }
                }
            }
            
            if (mode === 'runtime' || mode === 'bender') {
                const cpuIdMatch = line.match(/cpu_id:(\d+)/);
                if (cpuIdMatch) {
                    const cpu = cpuIdMatch[1];
                    if (line.includes('net_cpu:True')) { this.addTag('Physical', cpu, 'net_irq'); const n = this.state.coreNumaMap[cpu]; if (n) this.state.netNumaNodes.add(n); }
                    if (line.includes('isolated:True')) this.state.isolatedCores.add(cpu);
                }
                if (line.startsWith('System cpus:')) this.parseRange(line.replace(/System\s*cpus:\s*/i, '')).forEach(c => this.addTag('Physical', c.toString(), 'sys_os'));
                const netCpuMatch = line.match(/^(net\d+|eth\d+|eni\d+):\s*([\d,\s-]+)$/);
                if (netCpuMatch) this.parseRange(netCpuMatch[2]).forEach(c => { this.addTag('Physical', c.toString(), 'net_irq'); const n = this.state.coreNumaMap[c.toString()]; if (n) this.state.netNumaNodes.add(n); });
            }
            
            if (mode === 'cpuload' || mode === 'load') {
                const v4Match = line.match(/^(\d+):([\d.]+)$/);
                if (v4Match) this.state.cpuLoadMap[v4Match[1]] = parseFloat(v4Match[2]).toFixed(1);
                const mpstatMatch = line.match(/(\d+)\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+([\d.]+)$/);
                if (mpstatMatch) this.state.cpuLoadMap[mpstatMatch[1]] = (100 - parseFloat(mpstatMatch[2])).toFixed(1);
            }
        }
        return this.state.geometry;
    },
    
    parseRange(str) {
        const result = [];
        if (!str) return result;
        str.split(',').forEach(part => {
            part = part.trim();
            if (part.includes('-')) {
                const [start, end] = part.split('-').map(x => parseInt(x.trim()));
                if (!isNaN(start) && !isNaN(end)) for (let i = start; i <= end; i++) result.push(i);
            } else { const val = parseInt(part); if (!isNaN(val)) result.push(val); }
        });
        return result;
    },
    
    addTag(instanceName, cpu, tag) {
        if (!cpu) return;
        if (!this.state.instances[instanceName]) this.state.instances[instanceName] = {};
        if (!this.state.instances[instanceName][cpu]) this.state.instances[instanceName][cpu] = new Set();
        this.state.instances[instanceName][cpu].add(tag);
    },
    
    render() {
        const input = document.getElementById('inputData')?.value || '';
        const geometry = this.parse(input);
        if (Object.keys(geometry).length === 0) {
            document.getElementById('canvas').innerHTML = '<div class="canvas-empty"><div class="empty-icon">⚠</div><p>No valid CPU data found</p></div>';
            return;
        }
        this.updateHeader(); this.renderBlueprint(); this.updateStats(); this.calculateSizing();
    },
    
    updateHeader() {
        const subtitle = document.getElementById('header-subtitle');
        if (subtitle) subtitle.textContent = this.state.serverName ? `${this.state.serverName}.qb.loc | ${new Date().toLocaleString()}` : 'Ready';
        
        const allCores = Object.keys(this.state.coreNumaMap);
        const usedCores = Object.keys(this.state.instances.Physical || {}).filter(cpu => this.state.instances.Physical[cpu]?.size > 0);
        let totalLoad = 0, loadCount = 0;
        allCores.forEach(cpu => { const load = parseFloat(this.state.cpuLoadMap[cpu] || 0); if (load > 0) { totalLoad += load; loadCount++; } });
        
        document.getElementById('stat-total').textContent = allCores.length;
        document.getElementById('stat-used').textContent = usedCores.length;
        document.getElementById('stat-free').textContent = allCores.length - usedCores.length;
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
            for (let j = i; j < Math.min(i + 2, sockets.length); j++) html += this.renderSocket(sockets[j], geometry[sockets[j]]);
            html += '</div>';
        }
        html += '</div>';
        canvas.innerHTML = html;
        Object.keys(this.state.coreNumaMap).forEach(cpu => this.updateCoreVisual('Physical', cpu));
    },
    
    renderSocket(socketId, numaData) {
        let html = `<div class="socket" data-socket="${socketId}"><div class="socket-label">SOCKET ${socketId}</div><div class="socket-content">`;
        Object.keys(numaData).sort((a, b) => parseInt(a) - parseInt(b)).forEach(numaId => {
            const isNetwork = this.state.netNumaNodes.has(numaId);
            html += `<div class="numa ${isNetwork ? 'is-network' : ''}" data-numa="${numaId}">`;
            html += `<div class="numa-label">NUMA ${numaId}</div>`;
            if (isNetwork) html += '<div class="network-badge">NET</div>';
            Object.keys(numaData[numaId]).sort((a, b) => parseInt(a) - parseInt(b)).forEach(l3Id => {
                html += `<div class="l3"><div class="l3-label">L3 #${l3Id}</div><div class="cores-grid">`;
                numaData[numaId][l3Id].forEach(cpu => html += this.renderCore('Physical', cpu));
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
            onmousedown="HFT.onCoreMouseDown(event,'${instanceName}','${cpu}')"
            onmouseenter="HFT.onCoreMouseEnter(event,'${instanceName}','${cpu}')"
            onmousemove="HFT.moveTooltip(event)" onmouseleave="HFT.hideTooltip()">
            ${cpu}<div class="load-bar"><div class="load-fill" style="width:${load}%;background:${loadColor}"></div></div>
            ${hasIRQ ? '<div class="irq-dot"></div>' : ''}</div>`;
    },
    
    getDisplayTags(instanceName, cpu) {
        const allTags = new Set();
        if (this.state.instances.Physical?.[cpu]) this.state.instances.Physical[cpu].forEach(t => allTags.add(t));
        Object.keys(this.state.instances).forEach(instName => {
            if (instName !== 'Physical' && this.state.instances[instName]?.[cpu]) this.state.instances[instName][cpu].forEach(t => allTags.add(t));
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
        el.style.background = ''; el.style.borderColor = '';
        if (tags.length > 0) el.classList.add('has-role');
        if (isIsolated) el.classList.add('isolated');
        
        if (fillTags.length === 1) {
            const role = HFT_RULES.roles[fillTags[0]];
            if (role) { el.style.background = role.color; el.style.borderColor = role.color; }
        } else if (fillTags.length > 1) {
            const colors = fillTags.map(t => HFT_RULES.roles[t]?.color || '#555');
            const step = 100 / colors.length;
            el.style.background = `linear-gradient(135deg, ${colors.map((col, idx) => `${col} ${idx * step}%, ${col} ${(idx + 1) * step}%`).join(', ')})`;
            el.style.borderColor = 'rgba(255,255,255,0.3)';
        }
    },
    
    onCoreMouseDown(event, instanceName, cpu) { this.isMouseDown = true; this.applyTool(instanceName, cpu, false, event.ctrlKey || event.metaKey); },
    onCoreMouseEnter(event, instanceName, cpu) { if (this.isMouseDown) this.applyTool(instanceName, cpu, true, event.ctrlKey || event.metaKey); this.showTooltip(event, instanceName, cpu); },
    
    applyTool(instanceName, cpu, forceAdd, isEraser) {
        if (!this.activeTool) return;
        if (!this.state.instances[instanceName]) this.state.instances[instanceName] = {};
        if (!this.state.instances[instanceName][cpu]) this.state.instances[instanceName][cpu] = new Set();
        const tags = this.state.instances[instanceName][cpu];
        
        if (isEraser) tags.clear();
        else if (this.activeTool.id === 'isolated') {
            if (this.state.isolatedCores.has(cpu)) this.state.isolatedCores.delete(cpu); else this.state.isolatedCores.add(cpu);
        }
        else if (tags.has(this.activeTool.id) && !forceAdd) tags.delete(this.activeTool.id);
        else tags.add(this.activeTool.id);
        
        this.updateCoreVisual(instanceName, cpu); this.updateStats(); this.calculateSizing();
    },
    
    showTooltip(event, instanceName, cpu) {
        const tooltip = document.getElementById('tooltip');
        const tags = this.getDisplayTags(instanceName, cpu);
        const load = this.state.cpuLoadMap[cpu];
        const irqs = this.state.coreIRQMap[cpu];
        const isIsolated = this.state.isolatedCores.has(cpu);
        
        let html = `<div class="tooltip-header">Core ${cpu}</div>`;
        if (load !== undefined) { const color = parseFloat(load) > 80 ? '#ef4444' : (parseFloat(load) > 50 ? '#f59e0b' : '#22c55e'); html += `<div class="tooltip-load" style="color:${color}">Load: ${load}%</div>`; }
        if (irqs?.length > 0) html += `<div class="tooltip-irq">IRQ: ${irqs.join(', ')}</div>`;
        if (isIsolated) html += `<div class="tooltip-irq" style="color:#fff">⬡ Isolated</div>`;
        if (tags.length > 0) {
            html += '<div class="tooltip-roles">';
            tags.filter(t => t !== 'isolated').forEach(tid => { const role = HFT_RULES.roles[tid]; if (role) html += `<div class="tooltip-role"><div class="tooltip-swatch" style="background:${role.color}"></div>${role.name}</div>`; });
            html += '</div>';
        }
        tooltip.innerHTML = html; tooltip.style.display = 'block'; this.moveTooltip(event);
    },
    
    moveTooltip(event) { const tooltip = document.getElementById('tooltip'); tooltip.style.left = (event.clientX + 15) + 'px'; tooltip.style.top = (event.clientY + 15) + 'px'; },
    hideTooltip() { document.getElementById('tooltip').style.display = 'none'; },
    
    updateStats() {
        let txt = this.state.serverName ? `# ${this.state.serverName}\n` : '';
        const physicalRoles = {};
        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => tags.forEach(t => { if (!physicalRoles[t]) physicalRoles[t] = []; physicalRoles[t].push(parseInt(cpu)); }));
        txt += '\n### Physical ###\n';
        Object.entries(HFT_RULES.roles).forEach(([id, role]) => { if (physicalRoles[id]?.length > 0) txt += `${role.name}: [${physicalRoles[id].sort((a,b) => a-b).join(', ')}]\n`; });
        if (this.state.isolatedCores.size > 0) txt += `Isolated: [${[...this.state.isolatedCores].map(c => parseInt(c)).sort((a,b) => a-b).join(', ')}]\n`;
        document.getElementById('output').textContent = txt;
    },
    
    calculateSizing() {
        const osCores = []; let totalLoad = 0;
        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => { if (tags.has('sys_os')) { osCores.push(cpu); totalLoad += parseFloat(this.state.cpuLoadMap[cpu] || 0); } });
        document.getElementById('calc-cores').textContent = osCores.length || '—';
        const avgLoad = osCores.length > 0 ? (totalLoad / osCores.length).toFixed(1) : '—';
        document.getElementById('calc-load').textContent = avgLoad !== '—' ? avgLoad + '%' : '—';
        const target = parseFloat(document.getElementById('calc-target')?.value || 3);
        if (osCores.length > 0 && avgLoad !== '—') {
            const needed = Math.ceil((parseFloat(avgLoad) * osCores.length) / target);
            if (needed > osCores.length) { document.getElementById('calc-result').textContent = `Need ${needed}`; document.getElementById('calc-result').style.color = '#f59e0b'; }
            else { document.getElementById('calc-result').textContent = `OK`; document.getElementById('calc-result').style.color = '#22c55e'; }
        } else document.getElementById('calc-result').textContent = '—';
    },
    
    copyConfig() { navigator.clipboard.writeText(document.getElementById('output')?.textContent || ''); },
    
    exportConfig() {
        const config = { version: '4.0', serverName: this.state.serverName, timestamp: new Date().toISOString(), geometry: this.state.geometry, netNumaNodes: [...this.state.netNumaNodes], isolatedCores: [...this.state.isolatedCores], instances: {} };
        Object.keys(this.state.instances).forEach(instName => { config.instances[instName] = {}; Object.keys(this.state.instances[instName]).forEach(cpu => { config.instances[instName][cpu] = [...this.state.instances[instName][cpu]]; }); });
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `cpu-config-${this.state.serverName || 'unknown'}-${new Date().toISOString().split('T')[0]}.json`; a.click();
    },
    
    importConfig() {
        const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
        input.onchange = (e) => { const file = e.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (evt) => { try { this.loadConfig(JSON.parse(evt.target.result)); } catch (err) { alert('Error: ' + err.message); } }; reader.readAsText(file); };
        input.click();
    },
    
    loadConfig(config) {
        this.state.serverName = config.serverName || '';
        this.state.geometry = config.geometry || {};
        this.state.netNumaNodes = new Set(config.netNumaNodes || []);
        this.state.isolatedCores = new Set(config.isolatedCores || []);
        this.state.instances = {}; this.state.coreNumaMap = {};
        Object.entries(this.state.geometry).forEach(([socket, numaData]) => Object.entries(numaData).forEach(([numa, l3Data]) => Object.entries(l3Data).forEach(([l3, cores]) => cores.forEach(cpu => { this.state.coreNumaMap[cpu] = numa; }))));
        Object.keys(config.instances || {}).forEach(instName => { this.state.instances[instName] = {}; Object.keys(config.instances[instName]).forEach(cpu => { this.state.instances[instName][cpu] = new Set(config.instances[instName][cpu]); }); });
        this.updateHeader(); this.renderBlueprint(); this.updateStats(); this.calculateSizing();
    },
    
    validate() {
        const output = document.getElementById('validation-output');
        if (!output) return;
        if (Object.keys(this.state.coreNumaMap).length === 0) { output.innerHTML = '<span class="muted">No data</span>'; return; }
        const issues = HFT_RULES.runValidation(this.state);
        if (issues.length === 0) { output.innerHTML = '<span class="val-ok">✓ All OK</span>'; return; }
        output.innerHTML = issues.map(i => `<div class="${i.severity === 'error' ? 'val-error' : 'val-warn'}">${i.severity === 'error' ? '✗' : '⚠'} ${i.message}</div>`).join('');
    },
    
    loadCompareFile(side) { const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'; input.onchange = (e) => { if (e.target.files[0]) this.readCompareFile(e.target.files[0], side); }; input.click(); },
    
    readCompareFile(file, side) {
        const reader = new FileReader();
        reader.onload = (e) => { try { const config = JSON.parse(e.target.result); if (side === 'old') this.compareOld = config; else this.compareNew = config; this.renderComparePanel(side, config); if (this.compareOld && this.compareNew) this.calculateDiff(); } catch (err) { alert('Error: ' + err.message); } };
        reader.readAsText(file);
    },
    
    clearCompare(side) {
        if (side === 'old') this.compareOld = null; else this.compareNew = null;
        document.getElementById(`compare-${side}`).innerHTML = `<div class="drop-zone" onclick="HFT.loadCompareFile('${side}')"><div class="drop-icon">📁</div><p>Drop JSON</p></div>`;
        ['added', 'removed', 'changed'].forEach(k => document.getElementById(`diff-${k}`).textContent = '0');
    },
    
    renderComparePanel(side, config) {
        const container = document.getElementById(`compare-${side}`);
        const geom = config.geometry || {}, netNumas = new Set(config.netNumaNodes || []), insts = config.instances || {};
        let html = `<div style="margin-bottom:10px;font-size:11px;color:var(--text-muted);">Server: <strong>${config.serverName || '?'}</strong></div><div class="blueprint cores-small" style="transform:scale(0.8);transform-origin:top left;">`;
        Object.keys(geom).sort((a, b) => a - b).forEach(socketId => {
            html += `<div class="socket" data-socket="${socketId}" style="padding:10px;"><div class="socket-label" style="font-size:9px;">S${socketId}</div><div class="socket-content">`;
            Object.keys(geom[socketId]).sort((a, b) => a - b).forEach(numaId => {
                const isNet = netNumas.has(numaId);
                html += `<div class="numa ${isNet ? 'is-network' : ''}" style="padding:6px;min-width:auto;"><div class="numa-label" style="font-size:8px;">N${numaId}</div>`;
                Object.keys(geom[socketId][numaId]).sort((a, b) => parseInt(a) - parseInt(b)).forEach(l3Id => {
                    html += '<div class="cores-grid" style="margin-top:6px;">';
                    geom[socketId][numaId][l3Id].forEach(cpu => {
                        const tags = []; Object.keys(insts).forEach(inst => { if (insts[inst][cpu]) tags.push(...insts[inst][cpu]); });
                        const fillTags = tags.filter(t => t !== 'isolated');
                        let bg = 'var(--bg-tertiary)', border = 'var(--border-subtle)';
                        if (fillTags.length > 0) { const role = HFT_RULES.roles[fillTags[0]]; if (role) { bg = role.color; border = role.color; } }
                        html += `<div class="core compare-core" data-cpu="${cpu}" data-side="${side}" style="background:${bg};border-color:${border};${fillTags.length > 0 ? 'color:#fff;' : ''}" onmouseenter="HFT.showCompareTooltip(event,'${side}','${cpu}')" onmousemove="HFT.moveTooltip(event)" onmouseleave="HFT.hideTooltip()">${cpu}</div>`;
                    });
                    html += '</div>';
                });
                html += '</div>';
            });
            html += '</div></div>';
        });
        html += '</div>';
        container.innerHTML = html;
    },
    
    showCompareTooltip(event, side, cpu) {
        const config = side === 'old' ? this.compareOld : this.compareNew; if (!config) return;
        const allTags = new Set(); if (config.instances) Object.keys(config.instances).forEach(inst => { if (config.instances[inst][cpu]) config.instances[inst][cpu].forEach(t => allTags.add(t)); });
        let html = `<div class="tooltip-header">Core ${cpu} (${side.toUpperCase()})</div>`;
        if (allTags.size > 0) { html += '<div class="tooltip-roles">'; allTags.forEach(tid => { const role = HFT_RULES.roles[tid]; if (role) html += `<div class="tooltip-role"><div class="tooltip-swatch" style="background:${role.color}"></div>${role.name}</div>`; }); html += '</div>'; }
        else html += '<div style="color:var(--text-muted)">No roles</div>';
        const tooltip = document.getElementById('tooltip'); tooltip.innerHTML = html; tooltip.style.display = 'block'; this.moveTooltip(event);
    },
    
    calculateDiff() {
        if (!this.compareOld || !this.compareNew) return;
        const getTags = (cfg, cpu) => { const t = new Set(); if (cfg.instances) Object.keys(cfg.instances).forEach(inst => { if (cfg.instances[inst][cpu]) cfg.instances[inst][cpu].forEach(x => t.add(x)); }); return t; };
        const allCpus = new Set(); [this.compareOld, this.compareNew].forEach(cfg => { if (cfg.instances) Object.values(cfg.instances).forEach(inst => Object.keys(inst).forEach(cpu => allCpus.add(cpu))); });
        let added = 0, removed = 0, changed = 0;
        allCpus.forEach(cpu => {
            const oldTags = getTags(this.compareOld, cpu), newTags = getTags(this.compareNew, cpu);
            const oldEl = document.querySelector(`.compare-core[data-cpu="${cpu}"][data-side="old"]`), newEl = document.querySelector(`.compare-core[data-cpu="${cpu}"][data-side="new"]`);
            oldEl?.classList.remove('diff-added', 'diff-removed', 'diff-changed'); newEl?.classList.remove('diff-added', 'diff-removed', 'diff-changed');
            if (oldTags.size === 0 && newTags.size > 0) { added++; newEl?.classList.add('diff-added'); }
            else if (oldTags.size > 0 && newTags.size === 0) { removed++; oldEl?.classList.add('diff-removed'); }
            else if (oldTags.size > 0 && newTags.size > 0 && !(oldTags.size === newTags.size && [...oldTags].every(t => newTags.has(t)))) { changed++; oldEl?.classList.add('diff-changed'); newEl?.classList.add('diff-changed'); }
        });
        document.getElementById('diff-added').textContent = added;
        document.getElementById('diff-removed').textContent = removed;
        document.getElementById('diff-changed').textContent = changed;
    },
    
    generateRecommendation() {
        const output = document.getElementById('recommend-output'), btnApply = document.getElementById('btn-apply');
        if (Object.keys(this.state.coreNumaMap).length === 0) { output.innerHTML = '<div class="recommend-placeholder"><p style="color:#f59e0b;">⚠ No data loaded</p></div>'; return; }
        const result = HFT_RULES.generateRecommendation(this.state); this.proposedConfig = result.proposedConfig;
        let html = '<div class="recommend-result">';
        html += `<div class="recommend-section"><h3>Current State</h3><div class="recommend-card"><p>Cores: <strong>${result.current.totalCores}</strong> | NUMA: <strong>${result.current.numaNodes}</strong> | Net: <strong>${result.current.networkNumas.join(',') || '?'}</strong></p></div></div>`;
        if (result.issues.length > 0) { html += '<div class="recommend-section"><h3>Issues</h3>'; result.issues.forEach(i => html += `<div class="recommend-card ${i.severity === 'error' ? 'warning' : ''}"><h4>${i.severity.toUpperCase()}</h4><p>${i.message}</p><p style="color:var(--accent)">Fix: ${i.fix}</p></div>`); html += '</div>'; }
        else html += '<div class="recommend-section"><h3>Issues</h3><div class="recommend-card success"><h4>✓ No issues</h4></div></div>';
        html += '<div class="recommend-section"><h3>Recommendations</h3>'; result.recommendations.forEach(r => html += `<div class="recommend-card"><h4>${r.title}</h4><p>${r.description}</p><p style="font-size:10px;color:var(--text-muted)">${r.rationale}</p>${r.cores?.length > 0 ? `<div class="recommend-cores">${r.cores.map(c => `<div class="recommend-core">${c}</div>`).join('')}</div>` : ''}</div>`); html += '</div>';
        html += `<div class="recommend-section"><h3>Outcome</h3><div class="recommend-card success"><h4>Est. Improvement: ${result.metrics.estimatedImprovement}</h4></div></div></div>`;
        output.innerHTML = html; btnApply.disabled = false;
    },
    
    applyRecommendation() {
        if (!this.proposedConfig) return;
        Object.entries(this.proposedConfig.instances || {}).forEach(([instName, cores]) => { if (!this.state.instances[instName]) this.state.instances[instName] = {}; Object.entries(cores).forEach(([cpu, tags]) => { if (!this.state.instances[instName][cpu]) this.state.instances[instName][cpu] = new Set(); tags.forEach(t => this.state.instances[instName][cpu].add(t)); }); });
        this.renderBlueprint(); this.updateStats(); document.querySelector('.tab[data-tab="mapper"]')?.click();
    },
    
    loadDemo() {
        document.getElementById('inputData').value = `=== Подключение к demo-server ===

>>> 1. LSCPU
0,0,0,0,0,Y
1,0,0,1,0,Y
2,0,0,2,0,Y
3,0,0,3,0,Y
4,0,0,4,1,Y
5,0,0,5,1,Y
6,0,0,6,1,Y
7,0,0,7,1,Y
8,1,1,8,2,Y
9,1,1,9,2,Y
10,1,1,10,2,Y
11,1,1,11,2,Y
12,1,1,12,3,Y
13,1,1,13,3,Y
14,1,1,14,3,Y
15,1,1,15,3,Y

>>> 2. NUMA TOPOLOGY
node 0 cpus: 0 1 2 3 4 5 6 7
node 1 cpus: 8 9 10 11 12 13 14 15

>>> 3. ISOLATED CORES
1-15

>>> 4. NETWORK
--- Interface: eth0 ---
NUMA Node: 0
Driver: ena
IRQ 42: CPUs [1,2]
IRQ 43: CPUs [3]

>>> 5. RUNTIME CONFIG
System cpus: 0

>>> 7. CPU LOAD (MPSTAT)
0:15.2
1:8.5
2:12.3
3:6.1
4:22.4
5:18.7
6:25.1
7:19.8
8:5.2
9:3.1
10:8.9
11:7.2
12:4.5
13:2.8
14:6.3
15:3.9`;
        this.render();
    }
};

document.addEventListener('DOMContentLoaded', () => HFT.init());

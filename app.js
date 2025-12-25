/**
 * HFT CPU Mapper - Main Application v5.5
 * Refactored with modular architecture (utils, parser, renderer)
 */

const HFT = {
    state: {
        serverName: '',
        geometry: {},       // socket -> numa -> l3 -> [cores]
        coreNumaMap: {},    // cpu -> numa
        coreSocketMap: {},  // cpu -> socket
        l3Groups: {},       // l3Key -> [cores]
        netNumaNodes: new Set(),
        isolatedCores: new Set(),
        coreIRQMap: {},     // cpu -> [irq numbers]
        cpuLoadMap: {},     // cpu -> load%
        instances: { Physical: {} },
        networkInterfaces: [],
        coreBenderMap: {},     // cpu -> instance name from BENDER
        instanceToInterface: {},
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

        // Try to load from URL hash first, then localStorage
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
        this.renderBlueprint();
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
                    html += `<div class="palette-item" data-role="${role.id}" onclick="HFT.selectTool('${role.id}')">
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
            container.addEventListener('dragover', (e) => { e.preventDefault(); });
            container.addEventListener('dragleave', () => {});
            container.addEventListener('drop', (e) => {
                e.preventDefault();
                const file = e.dataTransfer.files[0];
                if (file?.name.endsWith('.json') || file?.name.endsWith('.txt') || file?.name.endsWith('.conf') || file?.name.endsWith('.cfg')) {
                    Utils.readFileAsText(file).then(text => {
                        this.parseCompareText(id === 'compare-old' ? 'old' : 'new', text);
                    }).catch(err => {
                        console.error('File read error:', err);
                    });
                }
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
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                this.exportConfig();
            }
            if (e.ctrlKey && e.key === 'o') {
                e.preventDefault();
                this.importConfig();
            }
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
    // PARSING
    // =========================================================================
    parse(text) {
        this.state = Parser.parse(text);
        return this.state.geometry;
    },

    // =========================================================================
    // RENDERING
    // =========================================================================
    render() {
        const input = Utils.getElement('inputData')?.value || '';
        const geometry = this.parse(input);

        if (Object.keys(geometry).length === 0) {
            document.getElementById('canvas').innerHTML = Renderer.renderEmptyState();
            return;
        }

        this.updateHeader();
        document.getElementById('canvas').innerHTML = Renderer.renderBlueprint(this.state);
        this.updateStats();
        this.calculateSizing();
        
        // Update instance manager dropdown after parsing
        this.updateInstanceSelect();

        // Auto-save to localStorage
        this.saveToLocalStorage();
    },

    updateHeader() {
        const subtitle = Utils.getElement('header-subtitle');
        if (subtitle) {
            subtitle.textContent = this.state.serverName
                ? `${this.state.serverName} | ${new Date().toLocaleString()}` : 'Ready';
        }

        Renderer.updateHeaderStats(this.state);
    },

    renderBlueprint() {
        const canvas = Utils.getElement('canvas');
        if (!canvas) return;

        const geometry = this.state.geometry;
        if (!geometry || Object.keys(geometry).length === 0) {
            canvas.innerHTML = Renderer.renderEmptyState();
            return;
        }

        canvas.innerHTML = Renderer.renderBlueprint(this.state);

        // Apply colors after render
        Object.keys(this.state.coreNumaMap).forEach(cpu => {
            Renderer.updateCoreVisual(this.state.selectedInstance, cpu, this.state);
        });

        // Auto-fit
        requestAnimationFrame(() => Renderer.scaleToFit());
    },

    // =========================================================================
    // INTERACTIONS
    // =========================================================================
    onCoreMouseDown(event, instanceName, cpu) {
        this.isMouseDown = true;
        this.applyTool(this.state.selectedInstance, cpu, false, event.ctrlKey || event.metaKey);
    },

    onCoreMouseEnter(event, instanceName, cpu) {
        if (this.isMouseDown) {
            this.applyTool(this.state.selectedInstance, cpu, true, event.ctrlKey || event.metaKey);
        }
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
            if (this.activeTool.id === 'isolated') {
                this.state.isolatedCores.delete(cpu);
            } else {
                this.state.isolatedCores.add(cpu);
            }
        } else if (this.activeTool.id === 'isolated') {
            if (this.state.isolatedCores.has(cpu)) this.state.isolatedCores.delete(cpu);
            else this.state.isolatedCores.add(cpu);
        } else if (tags.has(this.activeTool.id) && !forceAdd) {
            tags.delete(this.activeTool.id);
        } else {
            tags.add(this.activeTool.id);
        }

        Renderer.updateCoreVisual(instanceName, cpu, this.state);
        this.updateStats();
        this.calculateSizing();
    },

    // =========================================================================
    // TOOLTIP
    // =========================================================================
    showTooltip(event, instanceName, cpu) {
        const tooltip = Utils.getElement('tooltip');
        if (!tooltip) return;

        tooltip.innerHTML = Renderer.renderTooltip(instanceName, cpu, this.state);
        tooltip.style.display = 'block';
        this.moveTooltip(event);
    },

    moveTooltip(event) {
        const tooltip = Utils.getElement('tooltip');
        if (tooltip) {
            tooltip.style.left = (event.clientX + 15) + 'px';
            tooltip.style.top = (event.clientY + 15) + 'px';
        }
    },

    hideTooltip() {
        const tooltip = Utils.getElement('tooltip');
        if (tooltip) tooltip.style.display = 'none';
    },

    // =========================================================================
    // STATS & OUTPUT
    // =========================================================================
    updateStats() {
        let txt = '---\n';
        txt += 'hft_tunels: true\n\n';

        // Host Vars (isol_cpus, net_cpus, irqaffinity)
        const isolatedCores = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a, b) => a - b);
        if (isolatedCores.length > 0) {
            txt += `isol_cpus: ${Utils.formatCoreRange(isolatedCores)}\n`;
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
            const irqByNuma = {};
            netCores.forEach(c => {
                const numa = this.state.coreNumaMap[c.toString()] || '0';
                if (!irqByNuma[numa]) irqByNuma[numa] = [];
                irqByNuma[numa].push(c);
            });

            const interestingInterfaces = (this.state.networkInterfaces || [])
                .filter(iface => {
                    const name = iface.name || iface;
                    return /^(net|hit|eth)/.test(name) && !/^enp/.test(name);
                });

            if (interestingInterfaces.length > 0) {
                txt += 'net_cpus:\n';
                interestingInterfaces.forEach(iface => {
                    const name = iface.name || iface;
                    const numa = (iface.numaNode !== undefined ? iface.numaNode : 0).toString();
                    const cores = irqByNuma[numa] || [];
                    if (cores.length > 0) {
                        txt += `  ${name}: [${cores.join(', ')}]\n`;
                    } else {
                        txt += `  ${name}: []\n`;
                    }
                });
            } else if (netCores.length > 0) {
                txt += 'net_cpus:\n';
                txt += `  net0: [${netCores.join(', ')}]\n`;
            }
        }

        // irqaffinity_cpus (sys_os)
        const sysCores = (physicalRoles['sys_os'] || []).sort((a, b) => a - b);
        if (sysCores.length > 0) {
            txt += `irqaffinity_cpus: ${Utils.formatCoreRange(sysCores)}\n`;
        }

        // bs_instances
        txt += '\n\nbs_instances:\n';

        const instances = Object.keys(this.state.instances).filter(k => k !== 'Physical');
        if (instances.length === 0) {
            const instanceName = this.state.serverName?.toUpperCase() || 'INSTANCE';
            instances.push(instanceName);
        }

        instances.forEach((instName, idx) => {
            const instRoles = {};
            const sourceInst = this.state.instances[instName] || this.state.instances.Physical || {};

            Object.entries(sourceInst).forEach(([cpu, tags]) => {
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

        Utils.getElement('output').textContent = txt;
        this.updateAnsiblePreview();
    },

    // =========================================================================
    // EXPORT / IMPORT
    // =========================================================================
    copyConfig() {
        const text = Utils.getElement('output')?.textContent || '';
        if (!text) return;
        Utils.copyToClipboard(text).then(() => {
            const btn = document.querySelector('button[onclick="HFT.copyConfig()"]');
            if (btn) {
                const original = btn.innerHTML;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.innerHTML = original, 1000);
            }
        });
    },

    exportConfig() {
        try {
            const config = {
                version: '5.0',
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
    // ANSIBLE EXPORT
    // =========================================================================
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
        const getOne = (role) => getCores(role)[0] || '';

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
        if (formulaCpu) {
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
            txt += `    cpualias_custom:\n${aliases.join('\n')}\n`;
        }

        return txt;
    },

    generateAnsibleHostVars() {
        let txt = '';

        const isolatedCores = [...this.state.isolatedCores].map(c => parseInt(c)).sort((a, b) => a - b);
        if (isolatedCores.length > 0) {
            txt += `isol_cpus: ${Utils.formatCoreRange(isolatedCores)}\n`;
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
            txt += `irqaffinity_cpus: ${Utils.formatCoreRange(sysCores)}\n`;
        }

        const netCores = (physicalRoles['net_irq'] || []).sort((a, b) => a - b);
        if (netCores.length > 0) {
            txt += `net_cpus:\n`;
            const irqByNuma = {};
            netCores.forEach(c => {
                const numa = this.state.coreNumaMap[c.toString()];
                if (numa !== undefined) {
                    if (!irqByNuma[numa]) irqByNuma[numa] = [];
                    irqByNuma[numa].push(c);
                }
            });

            const netInterfaces = this.state.networkInterfaces || [];
            if (netInterfaces.length > 0) {
                netInterfaces.forEach(iface => {
                    const numa = iface.numaNode || '0';
                    const cores = irqByNuma[numa] || [];
                    if (cores.length > 0) {
                        txt += `  ${iface.name}: [${cores.join(', ')}]\n`;
                    }
                });
            } else if (netCores.length > 0) {
                txt += `  net0: [${netCores.join(', ')}]\n`;
            }
        }

        return txt;
    },

    copyAnsibleInstanceConfig() {
        const instanceSelect = document.getElementById('ansible-instance-select');
        const instanceName = instanceSelect?.value || this.state.selectedInstance || 'Physical';
        const text = this.generateAnsibleInstanceConfig(instanceName);

        if (!text.trim()) {
            alert('No instance config to copy.');
            return;
        }

        Utils.copyToClipboard(text).then(() => {
            const btn = document.querySelector('button[onclick="HFT.copyAnsibleInstanceConfig()"]');
            if (btn) {
                const original = btn.innerHTML;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.innerHTML = original, 1000);
            }
        });
    },

    copyAnsibleHostVars() {
        const text = this.generateAnsibleHostVars();

        if (!text.trim()) {
            alert('No host vars to copy.');
            return;
        }

        Utils.copyToClipboard(text).then(() => {
            const btn = document.querySelector('button[onclick="HFT.copyAnsibleHostVars()"]');
            if (btn) {
                const original = btn.innerHTML;
                btn.textContent = 'Copied!';
                setTimeout(() => btn.innerHTML = original, 1000);
            }
        });
    },

    updateAnsiblePreview() {
        const instanceSelect = document.getElementById('ansible-instance-select');
        const instanceName = instanceSelect?.value || this.state.selectedInstance || 'Physical';
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
            Utils.readFileAsText(file).then(text => {
                try {
                    this.loadConfig(JSON.parse(text));
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            });
        };
        input.click();
    },

    loadConfig(config) {
        this.state.serverName = config.serverName || '';
        this.state.geometry = config.geometry || {};
        this.state.coreNumaMap = config.coreNumaMap || {};
        this.state.coreSocketMap = config.coreSocketMap || {};
        this.state.l3Groups = config.l3Groups || {};
        this.state.netNumaNodes = new Set(config.netNumaNodes || []);
        this.state.isolatedCores = new Set(config.isolatedCores || []);
        this.state.cpuLoadMap = config.cpuLoadMap || {};
        this.state.instances = {};
        this.state.selectedInstance = 'Physical';

        Object.entries(config.instances || {}).forEach(instName => {
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
            Utils.readFileAsText(file).then(text => {
                document.getElementById(`cmp-text-${side}`).value = text;
                const serverInput = document.getElementById(`cmp-server-${side}`);
                if (serverInput && !serverInput.value) {
                    const name = file.name.replace(/\.(txt|log|conf|cfg)$/i, '');
                    serverInput.value = name;
                }
            });
        };
        input.click();
    },

    parseCompareText(side, text) {
        const serverInput = document.getElementById(`cmp-server-${side}`);
        const serverName = serverInput?.value || `Config ${side.toUpperCase()}`;

        if (!text || !text.trim()) {
            alert('Paste BENDER config text first');
            return;
        }

        try {
            const config = Parser.parseBenderConfig(text, serverName);
            if (side === 'old') this.compareOld = config;
            else this.compareNew = config;
            this.renderComparePanel(side, config);
            if (this.compareOld && this.compareNew) this.calculateDiff();
        } catch (err) {
            alert('Parse error: ' + err.message);
        }
    },

    renderComparePanel(side, config) {
        const container = document.getElementById(`compare-${side}`);
        if (!container) return;
        container.innerHTML = Renderer.renderComparePanel(config, side);
    },

    clearCompare(side) {
        if (side === 'old') this.compareOld = null;
        else this.compareNew = null;

        document.getElementById(`compare-${side}`).innerHTML = '';
        document.getElementById(`cmp-text-${side}`).value = '';
        document.getElementById(`cmp-server-${side}`).value = '';
        ['added', 'removed', 'changed'].forEach(k => {
            document.getElementById(`diff-${k}`).textContent = '0';
        });
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
                        if (Array.isArray(cpuTags)) cpuTags.forEach(x => t.add(x));
                        else if (cpuTags instanceof Set) cpuTags.forEach(x => t.add(x));
                    }
                });
            }
            return t;
        };

        const allCpus = new Set();
        [this.compareOld, this.compareNew].forEach(cfg => {
            if (cfg.instances) {
                Object.values(cfg.instances).forEach(inst => {
                    Object.keys(inst).forEach(cpu => allCpus.add(cpu));
                });
            }
        });

        let added = 0, removed = 0, changed = 0;
        allCpus.forEach(cpu => {
            const oldTags = getTags(this.compareOld, cpu);
            const newTags = getTags(this.compareNew, cpu);

            const oldEl = document.querySelector(`.cmp-core[data-cpu="${cpu}"][data-side="old"]`);
            const newEl = document.querySelector(`.cmp-core[data-cpu="${cpu}"][data-side="new"]`);

            oldEl?.classList.remove('diff-added', 'diff-removed', 'diff-changed');
            newEl?.classList.remove('diff-added', 'diff-removed', 'diff-changed');

            if (oldTags.size === 0 && newTags.size > 0) {
                added++;
                newEl?.classList.add('diff-added');
            } else if (oldTags.size > 0 && newTags.size === 0) {
                removed++;
                oldEl?.classList.add('diff-removed');
            } else if (oldTags.size > 0 && newTags.size > 0) {
                const oldArr = Array.from(oldTags).sort();
                const newArr = Array.from(newTags).sort();
                const same = oldArr.length === newArr.length && oldArr.every((t, i) => t === newArr[i]);
                if (!same) {
                    changed++;
                    oldEl?.classList.add('diff-changed');
                    newEl?.classList.add('diff-changed');
                }
            }
        });

        document.getElementById('diff-added').textContent = added;
        document.getElementById('diff-removed').textContent = removed;
        document.getElementById('diff-changed').textContent = changed;
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
                    if (Array.isArray(cpuTags)) cpuTags.forEach(t => allTags.add(t));
                    else if (cpuTags instanceof Set) cpuTags.forEach(t => allTags.add(t));
                }
            });
        }

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
                if (role) {
                    html += `<div class="tooltip-role"><div class="tooltip-swatch" style="background:${role.color}"></div>${role.name}</div>`;
                }
            });
            html += '</div>';
        } else if (!isIsolated) {
            html += '<div style="color:var(--text-muted)">No roles</div>';
        }

        const tooltip = Utils.getElement('tooltip');
        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        this.moveTooltip(event);
    },

    // =========================================================================
    // RECOMMENDATIONS
    // =========================================================================
    generateRecommendation() {
        const output = document.getElementById('recommend-output');
        const btnApply = document.getElementById('btn-apply');

        if (Object.keys(this.state.coreNumaMap).length === 0) {
            output.innerHTML = '<div class="recommend-placeholder"><p style="color:#f59e0b;">⚠ Load server data first</p></div>';
            btnApply.disabled = true;
            return;
        }

        try {
            const snapshot = this._createOptimizerSnapshot();
            const result = CPU_OPTIMIZER.optimize(snapshot);
            this.proposedConfig = result;

            const html = Renderer.renderOptimizationResults(result);
            output.innerHTML = html;
            btnApply.disabled = false;
        } catch (e) {
            console.error(e);
            output.innerHTML = `<div class="val-error">Error during optimization: ${e.message}</div>`;
            btnApply.disabled = true;
        }
    },

    _createOptimizerSnapshot() {
        const s = this.state;
        const topology = [];

        Object.entries(s.geometry).forEach(([socketId, numaData]) => {
            Object.entries(numaData).forEach(([numaId, l3Data]) => {
                Object.entries(l3Data).forEach(([l3Id, cores]) => {
                    cores.forEach(cpu => {
                        const cpuStr = String(cpu);
                        const services = [];

                        Object.entries(s.instances).forEach(([instName, coreMap]) => {
                            if (coreMap[cpuStr]) {
                                coreMap[cpuStr].forEach(tag => {
                                    const role = HFT_RULES.roles[tag];
                                    if (role) {
                                        let svcName = '';
                                        if (tag === 'net_irq') svcName = 'IRQ';
                                        else if (tag === 'sys_os') svcName = 'System';
                                        else if (tag === 'gateway') svcName = 'Gateway';
                                        else if (tag === 'robot_default') svcName = 'Robot';
                                        else if (tag === 'trash') svcName = 'Trash';
                                        else if (tag === 'udp') svcName = 'UDP';
                                        else if (tag === 'ar') svcName = 'AR';
                                        else if (tag === 'rf') svcName = 'RF';
                                        else if (tag === 'formula') svcName = 'Formula';
                                        else if (tag === 'click') svcName = 'ClickHouse';
                                        else svcName = tag.toUpperCase();

                                        if (svcName) {
                                            services.push({
                                                name: svcName,
                                                instanceId: instName === 'Physical' ? 'SYSTEM' : instName,
                                                currentCoreIds: [parseInt(cpu)]
                                            });
                                        }
                                    }
                                });
                            }
                        });

                        topology.push({
                            id: parseInt(cpu),
                            socketId: parseInt(socketId),
                            numaNodeId: parseInt(numaId),
                            l3CacheId: parseInt(l3Id),
                            currentLoad: parseFloat(s.cpuLoadMap[cpu] || 0),
                            services: services
                        });
                    });
                });
            });
        });

        // Infer instanceToInterface
        const instanceToInterface = { ...s.instanceToInterface };
        const instances = new Set();
        topology.forEach(c => c.services.forEach(svc => instances.add(svc.instanceId)));
        instances.forEach(instId => {
            if (instId === 'SYSTEM') return;

            if (instanceToInterface[instId]) return;

            const numaCounts = {};
            let maxCount = 0;
            let bestNuma = -1;

            topology.forEach(c => {
                c.services.forEach(s => {
                    if (s.instanceId === instId) {
                        const numa = c.numaNodeId;
                        numaCounts[numa] = (numaCounts[numa] || 0) + 1;
                    }
                });
            });

            Object.entries(numaCounts).forEach(([numa, count]) => {
                if (count > maxCount) {
                    maxCount = count;
                    bestNuma = parseInt(numa);
                }
            });

            const iface = s.networkInterfaces.find(n => n.numaNode === bestNuma);
            if (iface) {
                instanceToInterface[instId] = iface.name;
            }
        });

        // Build interface NUMA map
        const interfaceNumaMap = s.networkInterfaces.reduce((acc, n) => {
            acc[n.name] = n.numaNode;
            return acc;
        }, {});

        return {
            topology: topology,
            network: s.networkInterfaces,
            instanceToInterface: instanceToInterface,
            interfaceNumaMap: interfaceNumaMap
        };
    },

    applyRecommendation() {
        if (!this.proposedConfig) return;

        // Clear existing roles
        this.state.instances = { Physical: {} };
        this.state.isolatedCores = new Set();

        // Apply OS Cores
        const osCores = this.proposedConfig.osCores || [];
        osCores.forEach(cpu => {
            const cpuStr = String(cpu);
            if (!this.state.instances.Physical[cpuStr]) this.state.instances.Physical[cpuStr] = new Set();
            this.state.instances.Physical[cpuStr].add('sys_os');
        });

        // Apply IRQ Cores
        const irqCores = this.proposedConfig.irqCores || [];
        irqCores.forEach(cpu => {
            const cpuStr = String(cpu);
            if (!this.state.instances.Physical[cpuStr]) this.state.instances.Physical[cpuStr] = new Set();
            this.state.instances.Physical[cpuStr].add('net_irq');
            this.state.isolatedCores.add(cpuStr);
        });

        // Apply Instance Roles
        if (this.proposedConfig.instances) {
            this.proposedConfig.instances.forEach(instPlan => {
                const instName = instPlan.instanceId;
                if (instName === 'SYSTEM') return;

                if (!this.state.instances[instName]) this.state.instances[instName] = {};

                if (instPlan.coreAssignments) {
                    instPlan.coreAssignments.forEach(assign => {
                        let roleId = '';
                        const svc = assign.service.toLowerCase();

                        if (svc === 'gateway') roleId = 'gateway';
                        else if (svc === 'robot') roleId = 'robot_default';
                        else if (svc === 'trash_combo') {
                            assign.cores.forEach(cpu => {
                                const cpuStr = String(cpu);
                                if (!this.state.instances[instName][cpuStr]) this.state.instances[instName][cpuStr] = new Set();
                                this.state.instances[instName][cpuStr].add('trash');
                                this.state.instances[instName][cpuStr].add('rf');
                                this.state.instances[instName][cpuStr].add('click');
                                this.state.isolatedCores.add(cpuStr);
                            });
                            return;
                        }
                        else if (svc === 'ar_combo') roleId = 'ar';
                        else if (svc === 'udp') roleId = 'udp';
                        else if (svc === 'irq') roleId = 'net_irq';

                        if (roleId) {
                            assign.cores.forEach(cpu => {
                                const cpuStr = String(cpu);
                                if (!this.state.instances[instName][cpuStr]) this.state.instances[instName][cpuStr] = new Set();
                                this.state.instances[instName][cpuStr].add(roleId);
                                this.state.isolatedCores.add(cpuStr);
                            });
                        }
                    });
                }
            });
        }

        this.updateInstanceSelect();
        this.renderBlueprint();
        this.updateStats();
        this.calculateSizing();
        this.saveToLocalStorage();
        document.querySelector('.tab[data-tab="mapper"]')?.click();
    },

    // =========================================================================
    // DEMO
    // =========================================================================
    loadDemo() {
        Utils.getElement('inputData').value = `@@HFT_CPU_MAP_V4@@
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
{cpu_id:11,isolated,True,GatewaysDefault:[TRA0]}
{cpu_id:12,isolated,True,GatewaysDefault:[TRA0]}
{cpu_id:13,isolated,True,GatewaysDefault:[TRA0]}
{cpu_id:14,isolated,True,GatewaysDefault:[TRA0]}
{cpu_id:15,isolated,True,GatewaysDefault:[TRA0]}
{cpu_id:16,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:17,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:18,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:19,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:20,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:21,isolated,True,RobotsDefault:[TRA0]}
{cpu_id:22,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:23,isolated=True,RobotsDefault:[TRA0]}
{cpu_id:24,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:25,isolated:True,RobotsDefault:[TRA0]}
{cpu_id:26,isolated,True,RobotsDefault:[TRA0]}
{cpu_id:27,isolated,True,RobotsDefault:[TRA0]}
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
    // LOCAL STORAGE & PERSISTENCE
    // =========================================================================
    STORAGE_KEY: 'hft-cpu-mapper-config',

    saveToLocalStorage() {
        try {
            // Save ALL instances, not just Physical
            const instancesData = {};
            Object.keys(this.state.instances).forEach(instName => {
                instancesData[instName] = Object.fromEntries(
                    Object.entries(this.state.instances[instName] || {}).map(([cpu, tags]) =>
                        [cpu, tags instanceof Set ? [...tags] : tags]
                    )
                );
            });
            
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
                instances: instancesData
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
    // URL HASH CONFIG SHARING
    // =========================================================================
    loadFromUrlHash() {
        try {
            const hash = window.location.hash;
            if (!hash || !hash.startsWith('#cfg=')) return false;

            const encoded = hash.substring(5);
            const json = Utils.base64Decode(encoded);
            if (json) {
                const config = JSON.parse(json);
                this.loadConfig(config);
                console.log('[URL] Config loaded from hash');
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
                g: Utils.base64Encode(JSON.stringify(this.state.geometry)),
                cn: Object.fromEntries(this.state.coreNumaMap),
                ic: [...this.state.isolatedCores],
                nn: [...this.state.netNumaNodes],
                l3: this.state.l3Groups,
                i: Object.entries(this.state.instances.Physical || {}).map(([k, v]) =>
                    [k, [...v]]
                )
            };

            const encoded = Utils.base64Encode(JSON.stringify(config));
            const url = `${window.location.origin}${window.location.pathname}#cfg=${encoded}`;

            navigator.clipboard.writeText(url).then(() => {
                alert('✓ Link copied!\n\nShare this URL to let others view your config.');
            });
        } catch (e) {
            console.warn('[URL] Failed to create share link:', e);
            alert('Failed to create share link');
        }
    },

    // =========================================================================
    // DRAG & DROP
    // =========================================================================
    initMainDragDrop() {
        const inputArea = Utils.getElement('inputData');
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
                Utils.readFileAsText(file).then(text => {
                    inputArea.value = text;
                    if (text.includes('@@')) {
                        this.render();
                    }
                });
            }
        });
    },

    // =========================================================================
    // CALCULATIONS
    // =========================================================================
    calculateSizing() {
        const osCores = [];
        let totalLoad = 0;

        Object.entries(this.state.instances.Physical || {}).forEach(([cpu, tags]) => {
            if (tags.has('sys_os')) {
                osCores.push(cpu);
                totalLoad += parseFloat(this.state.cpuLoadMap[cpu] || 0);
            }
        });

        Utils.getElement('calc-cores').textContent = osCores.length || '—';
        const avgLoad = osCores.length > 0 ? (totalLoad / osCores.length).toFixed(1) : '—';
        Utils.getElement('calc-load').textContent = avgLoad !== '—' ? avgLoad + '%' : '—';

        const target = parseFloat(Utils.getElement('calc-target')?.value || 3);
        if (osCores.length > 0 && avgLoad !== '—') {
            const needed = Math.ceil((parseFloat(avgLoad) * osCores.length) / target);
            const resultEl = Utils.getElement('calc-result');
            if (resultEl) {
                if (needed > osCores.length) {
                    resultEl.textContent = `Need ${needed}`;
                    resultEl.style.color = '#f59e0b';
                } else {
                    resultEl.textContent = `OK`;
                    resultEl.style.color = '#22c55e';
                }
            }
        }
    },

    // Add helper for adding tags (used by Parser)
    addTag(instanceName, cpu, tag) {
        if (!cpu) return;
        if (!this.state.instances[instanceName]) this.state.instances[instanceName] = {};
        if (!this.state.instances[instanceName][cpu]) this.state.instances[instanceName][cpu] = new Set();
        this.state.instances[instanceName][cpu].add(tag);
    }
};

document.addEventListener('DOMContentLoaded', () => HFT.init());

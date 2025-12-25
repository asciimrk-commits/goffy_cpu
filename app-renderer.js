/**
 * HFT CPU Mapper - DOM Renderer Module
 * Handles all DOM manipulation and visualization rendering
 */

const Renderer = {
    /**
     * Render the complete CPU topology map
     * @param {Object} state - Application state
     * @returns {string} HTML string for the blueprint
     */
    renderBlueprint(state) {
        const geometry = state.geometry || {};
        const netNumaNodes = state.netNumaNodes || new Set();
        const selectedInstance = state.selectedInstance || 'Physical';
        const isolatedCores = state.isolatedCores || new Set();
        const instances = state.instances || { Physical: {} };

        if (Object.keys(geometry).length === 0) {
            return this.renderEmptyState();
        }

        const totalCores = Object.keys(state.coreNumaMap || {}).length;

        // Machine Container
        let html = `<div class="lstopo-machine" id="blueprint">
            <span class="lstopo-label">Machine (Total Cores: ${totalCores})</span>
            <div style="display:flex; flex-wrap:wrap; align-items:flex-start;">`;

        // Render sockets
        const sockets = Object.keys(geometry).sort((a, b) => parseInt(a) - parseInt(b));
        sockets.forEach(socketId => {
            html += this.renderSocket(socketId, geometry[socketId], netNumaNodes, selectedInstance, instances, isolatedCores, state.coreNumaMap, state.cpuLoadMap, state.coreBenderMap);
        });

        html += '</div></div>';
        return html;
    },

    /**
     * Render a socket container
     * @private
     */
    renderSocket(socketId, numaData, netNumaNodes, selectedInstance, instances, isolatedCores, coreNumaMap, cpuLoadMap, coreBenderMap) {
        let html = `<div class="lstopo-socket">
            <span class="lstopo-label">Socket P#${socketId}</span>`;

        // Render NUMA nodes
        const numaIds = Object.keys(numaData).sort((a, b) => parseInt(a) - parseInt(b));
        numaIds.forEach(numaId => {
            const isNetwork = netNumaNodes.has(numaId);
            html += this.renderNuma(numaId, numaData[numaId], isNetwork, selectedInstance, instances, isolatedCores, coreNumaMap, cpuLoadMap, coreBenderMap);
        });

        html += '</div>';
        return html;
    },

    /**
     * Render a NUMA node
     * @private
     */
    renderNuma(numaId, l3Data, isNetwork, selectedInstance, instances, isolatedCores, coreNumaMap, cpuLoadMap, coreBenderMap) {
        let html = `<div class="lstopo-numa ${isNetwork ? 'is-network' : ''}">
            <span class="lstopo-label">NUMANode P#${numaId}</span>`;

        // Render L3 groups
        const l3Ids = Object.keys(l3Data).sort((a, b) => parseInt(a) - parseInt(b));
        l3Ids.forEach(l3Id => {
            html += this.renderL3(l3Id, l3Data[l3Id], selectedInstance, instances, isolatedCores, coreNumaMap, cpuLoadMap, coreBenderMap);
        });

        html += '</div>';
        return html;
    },

    /**
     * Render an L3 cache group with cores
     * @private
     */
    renderL3(l3Id, cores, selectedInstance, instances, isolatedCores, coreNumaMap, cpuLoadMap, coreBenderMap) {
        let html = `<div class="lstopo-l3">
            <span class="lstopo-l3-label">L3 (${l3Id})</span>
            <div class="lstopo-core-group">`;

        cores.forEach(cpu => {
            const cpuStr = String(cpu);
            html += this.renderCore(cpuStr, selectedInstance, instances, isolatedCores, coreNumaMap, cpuLoadMap, coreBenderMap);
        });

        html += '</div></div>';
        return html;
    },

    /**
     * Render a single CPU core (PU)
     * @private
     */
    renderCore(cpu, selectedInstance, instances, isolatedCores, coreNumaMap, cpuLoadMap, coreBenderMap) {
        const load = parseFloat(cpuLoadMap?.[cpu] || 0);
        const loadColor = load > 80 ? '#ef4444' : (load > 50 ? '#f59e0b' : '#22c55e');

        // Check for IRQ
        let hasIRQ = false;
        Object.values(instances).forEach(inst => {
            if (inst[cpu]?.has('net_irq')) hasIRQ = true;
        });

        // Collect ALL tags from ALL instances for this CPU (for coloring)
        const allTags = new Set();
        Object.keys(instances).forEach(instName => {
            const instTags = instances[instName]?.[cpu];
            if (instTags) {
                instTags.forEach(t => allTags.add(t));
            }
        });
        
        // Get fill tags (exclude 'isolated' from coloring)
        const fillTags = Array.from(allTags).filter(t => t !== 'isolated');
        const isIsolated = isolatedCores.has(cpu) || allTags.has('isolated');

        // Determine instance label - show which instance(s) own this core
        let instanceLabels = [];
        Object.keys(instances).forEach(inst => {
            if (inst !== 'Physical' && instances[inst][cpu]?.size > 0) {
                // Get role tags for this instance (excluding isolated)
                const roleTags = Array.from(instances[inst][cpu]).filter(t => t !== 'isolated');
                if (roleTags.length > 0) {
                    instanceLabels.push(inst);
                }
            }
        });
        const instanceLabel = instanceLabels.join(', ');

        // Instance highlighting classes
        let highlightClass = '';
        const belongsToSelected = selectedInstance !== 'Physical' && instances[selectedInstance]?.[cpu]?.size > 0;
        if (selectedInstance !== 'Physical') {
            highlightClass = belongsToSelected ? 'instance-active' : 'instance-dimmed';
        }

        // Build style - color based on ALL tags
        let style = '';
        if (fillTags.length > 0) {
            // Sort by priority for consistent color order
            const sortedTags = fillTags.sort((a, b) => {
                const priorityA = HFT_RULES.roles[a]?.priority || 0;
                const priorityB = HFT_RULES.roles[b]?.priority || 0;
                return priorityB - priorityA;
            });
            
            if (sortedTags.length === 1) {
                const role = HFT_RULES.roles[sortedTags[0]];
                if (role) {
                    style = `background:${role.color};border-color:${role.color}`;
                }
            } else if (sortedTags.length > 1) {
                const colors = sortedTags.map(t => HFT_RULES.roles[t]?.color || '#555');
                const step = 100 / colors.length;
                const stops = colors.map((col, idx) => `${col} ${idx * step}%, ${col} ${(idx + 1) * step}%`).join(', ');
                style = `background:linear-gradient(135deg, ${stops});border-color:rgba(255,255,255,0.3)`;
            }
        }

        let classes = 'lstopo-pu';
        if (fillTags.length > 0) classes += ' has-role';
        if (isIsolated) classes += ' isolated';
        if (highlightClass) classes += ` ${highlightClass}`;

        return `<div class="${classes}" style="${style}" 
            id="core-${selectedInstance}-${cpu}" 
            data-cpu="${cpu}"
            onmousedown="HFT.onCoreMouseDown(event, '${selectedInstance}', '${cpu}')"
            onmouseenter="HFT.onCoreMouseEnter(event, '${selectedInstance}', '${cpu}')"
            onmousemove="HFT.moveTooltip(event)" 
            onmouseleave="HFT.hideTooltip()">
            <span>${cpu}</span>
            <div class="lstopo-load-bar"><div class="lstopo-load-fill" style="width:${load}%;background:${loadColor}"></div></div>
            ${hasIRQ ? '<div class="irq-dot"></div>' : ''}
            ${instanceLabel ? `<div class="core-label">${instanceLabel}</div>` : ''}
        </div>`;
    },

    /**
     * Render empty state placeholder
     * @returns {string} HTML for empty state
     */
    renderEmptyState() {
        return `<div class="canvas-empty">
            <div class="empty-icon-bg">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect>
                    <rect x="9" y="9" width="6" height="6"></rect>
                    <line x1="9" y1="1" x2="9" y2="4"></line>
                    <line x1="9" y1="20" x2="9" y2="23"></line>
                    <line x1="4" y1="12" x2="8" y2="12"></line>
                    <line x1="16" y1="12" x2="20" y2="12"></line>
                </svg>
            </div>
            <p class="empty-title">No CPU Data</p>
            <p class="empty-desc">Paste <code>cpu-map.sh</code> output into the sidebar or load a demo</p>
            <button class="btn btn-primary btn-lg" onclick="HFT.loadDemo()">Load Demo Data</button>
        </div>`;
    },

    /**
     * Update visual state of a single core
     * @param {string} instanceName - Instance name
     * @param {string} cpu - Core number
     * @param {Object} state - Application state
     */
    updateCoreVisual(instanceName, cpu, state) {
        const el = Utils.getElement(`core-${instanceName}-${cpu}`);
        if (!el) return;

        const tags = Renderer._getDisplayTags(instanceName, cpu, state);
        const fillTags = tags.filter(t => t !== 'isolated');
        const isIsolated = tags.includes('isolated') || state.isolatedCores?.has(cpu);

        el.classList.remove('has-role', 'isolated', 'instance-active', 'instance-dimmed');
        el.style.background = '';
        el.style.borderColor = '';

        // Update instance label
        const labelEl = el.querySelector('.core-label');
        if (labelEl) labelEl.textContent = '';

        // Determine instance label
        let instanceLabel = '';
        Object.keys(state.instances || {}).forEach(inst => {
            if (inst !== 'Physical' && state.instances[inst][cpu]?.size > 0) {
                instanceLabel = inst;
            }
        });
        if (instanceLabel) {
            if (labelEl) labelEl.textContent = instanceLabel;
        }

        // Instance highlighting
        if (state.selectedInstance !== 'Physical') {
            const belongsToSelected = state.instances[state.selectedInstance]?.[cpu]?.size > 0;
            if (belongsToSelected) {
                el.classList.add('instance-active');
            } else {
                el.classList.add('instance-dimmed');
            }
        }

        if (fillTags.length > 0) el.classList.add('has-role');
        if (isIsolated) el.classList.add('isolated');

        if (fillTags.length === 1) {
            const role = HFT_RULES.roles[fillTags[0]];
            if (role) {
                el.style.background = role.color;
                if (!el.classList.contains('instance-active')) {
                    el.style.borderColor = role.color;
                }
            }
        } else if (fillTags.length > 1) {
            const colors = fillTags.map(t => HFT_RULES.roles[t]?.color || '#555');
            const step = 100 / colors.length;
            const stops = colors.map((col, idx) => `${col} ${idx * step}%, ${col} ${(idx + 1) * step}%`).join(', ');
            el.style.background = `linear-gradient(135deg, ${stops})`;
            if (!el.classList.contains('instance-active')) {
                el.style.borderColor = 'rgba(255,255,255,0.3)';
            }
        }
    },

    /**
     * Get display tags for a core
     * @private
     */
    _getDisplayTags(instanceName, cpu, state) {
        const allTags = new Set();
        
        // Add Physical tags
        if (state.instances?.Physical?.[cpu]) {
            state.instances.Physical[cpu].forEach(t => allTags.add(t));
        }
        
        // Add instance-specific tags
        Object.keys(state.instances || {}).forEach(inst => {
            if (inst !== 'Physical' && state.instances[inst]?.[cpu]) {
                state.instances[inst][cpu].forEach(t => allTags.add(t));
            }
        });

        return Array.from(allTags).sort((a, b) => {
            const priorityA = HFT_RULES.roles[a]?.priority || 0;
            const priorityB = HFT_RULES.roles[b]?.priority || 0;
            return priorityB - priorityA;
        });
    },

    /**
     * Render comparison panel
     * @param {Object} config - Configuration object
     * @param {string} side - 'old' or 'new'
     * @returns {string} HTML for the panel
     */
    renderComparePanel(config, side) {
        const geom = config.geometry || {};
        const netNumas = new Set((config.netNumaNodes || []).map(String));
        const isolatedCores = new Set((config.isolatedCores || []).map(String));
        const insts = config.instances || {};

        // Collect used roles for legend
        const usedRoles = new Set();

        // Count sockets
        const numSockets = Object.keys(geom).length;

        let html = `<div class="cmp-info">Sockets: ${numSockets} | NUMAs: ${Object.values(geom).reduce((acc, s) => acc + Object.keys(s).length, 0)}</div>`;
        html += '<div class="cmp-blueprint">';

        Object.keys(geom).sort((a, b) => parseInt(a) - parseInt(b)).forEach(socketId => {
            html += this._renderCmpSocket(socketId, geom[socketId], netNumas, isolatedCores, insts, usedRoles);
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

        return html;
    },

    /**
     * Render socket for comparison panel
     * @private
     */
    _renderCmpSocket(socketId, numaData, netNumas, isolatedCores, insts, usedRoles) {
        let html = `<div class="cmp-socket">
            <div class="cmp-socket-hdr">Socket ${socketId}</div>
            <div class="cmp-socket-body">`;

        Object.keys(numaData).sort((a, b) => parseInt(a) - parseInt(b)).forEach(numaId => {
            const isNet = netNumas.has(numaId);
            html += this._renderCmpNuma(numaId, numaData[numaId], isNet, isolatedCores, insts, usedRoles);
        });

        html += '</div></div>';
        return html;
    },

    /**
     * Render NUMA for comparison panel
     * @private
     */
    _renderCmpNuma(numaId, l3Data, isNet, isolatedCores, insts, usedRoles) {
        const l3Count = Object.keys(l3Data).length;
        
        let html = `<div class="cmp-numa ${isNet ? 'is-net' : ''}">
            <div class="cmp-numa-hdr">
                <span>NUMA ${numaId}</span>
                ${l3Count > 1 ? `<span class="l3-count">${l3Count} L3</span>` : ''}
                ${isNet ? '<span class="net-tag">NET</span>' : ''}
            </div>`;

        Object.keys(l3Data).sort((a, b) => parseInt(a) - parseInt(b)).forEach(l3Id => {
            html += this._renderCmpL3(l3Id, l3Data[l3Id], isolatedCores, insts, usedRoles);
        });

        html += '</div>';
        return html;
    },

    /**
     * Render L3 for comparison panel
     * @private
     */
    _renderCmpL3(l3Id, cores, isolatedCores, insts, usedRoles) {
        let html = `<div class="cmp-l3 ${cores.length > 0 ? 'has-label' : ''}">
            ${cores.length > 1 ? `<div class="cmp-l3-label">L3 #${l3Id}</div>` : ''}
            <div class="cmp-cores">`;

        cores.forEach(cpu => {
            const cpuStr = String(cpu);
            const tags = Renderer._getCmpTags(cpuStr, insts);
            const fillTags = tags.filter(t => t !== 'isolated');
            const isIsolated = isolatedCores.has(cpuStr) || tags.includes('isolated');

            let bg = '';
            let classes = 'cmp-core';
            
            if (fillTags.length > 0) {
                const roleId = fillTags[0];
                const role = HFT_RULES.roles[roleId];
                if (role) {
                    bg = `background:${role.color}`;
                    classes += ' has-role';
                    usedRoles.add(roleId);
                }
            }
            
            if (isIsolated) classes += ' is-isolated';

            html += `<div class="${classes}" data-cpu="${cpuStr}" data-side="cmp" style="${bg}">${cpu}</div>`;
        });

        html += '</div></div>';
        return html;
    },

    /**
     * Get tags for comparison panel
     * @private
     */
    _getCmpTags(cpu, insts) {
        const allTags = new Set();
        Object.keys(insts).forEach(inst => {
            const cpuTags = insts[inst][cpu] || insts[inst][String(cpu)];
            if (cpuTags) {
                if (Array.isArray(cpuTags)) {
                    cpuTags.forEach(t => allTags.add(t));
                } else if (cpuTags instanceof Set) {
                    cpuTags.forEach(t => allTags.add(t));
                }
            }
        });
        return Array.from(allTags).filter(t => t !== 'isolated');
    },

    /**
     * Render tooltip content
     * @param {string} instanceName - Instance name
     * @param {string} cpu - Core number
     * @param {Object} state - Application state
     * @returns {string} HTML for tooltip
     */
    renderTooltip(instanceName, cpu, state) {
        const tags = Renderer._getDisplayTags(instanceName, cpu, state);
        const load = state.cpuLoadMap?.[cpu];
        const isIsolated = tags.includes('isolated') || state.isolatedCores?.has(cpu);

        let html = `<div class="tooltip-header">Core ${cpu}</div>`;
        
        if (load !== undefined) {
            const color = parseFloat(load) > 80 ? '#ef4444' : (parseFloat(load) > 50 ? '#f59e0b' : '#22c55e');
            html += `<div class="tooltip-load" style="color:${color}">Load: ${load}%</div>`;
        }

        if (isIsolated) {
            html += '<div class="tooltip-irq" style="color:#3b82f6">⬡ Isolated</div>';
        }

        if (tags.length > 0) {
            const fillTags = tags.filter(t => t !== 'isolated');
            if (fillTags.length > 0) {
                html += '<div class="tooltip-roles">';
                fillTags.forEach(tid => {
                    const role = HFT_RULES.roles[tid];
                    if (role) {
                        html += `<div class="tooltip-role">
                            <div class="tooltip-swatch" style="background:${role.color}"></div>
                            ${role.name}
                        </div>`;
                    }
                });
                html += '</div>';
            }
        }

        // Bender Source
        if (state.coreBenderMap?.[cpu]) {
            html += `<div class="tooltip-bender">Bender: ${state.coreBenderMap[cpu]}</div>`;
        }

        return html;
    },

    /**
     * Update header statistics
     * @param {Object} state - Application state
     */
    updateHeaderStats(state) {
        const allCores = Object.keys(state.coreNumaMap || {});
        const usedCores = Object.keys(state.instances?.Physical || {}).filter(cpu => 
            state.instances.Physical[cpu]?.size > 0
        );

        let totalLoad = 0, loadCount = 0;
        allCores.forEach(cpu => {
            const load = parseFloat(state.cpuLoadMap?.[cpu] || 0);
            if (load > 0) {
                totalLoad += load;
                loadCount++;
            }
        });

        const numSockets = Object.keys(state.geometry || {}).length;
        const netNumas = state.netNumaNodes ? [...state.netNumaNodes].sort((a, b) => parseInt(a) - parseInt(b)).join(',') : '—';

        Utils.getElement('stat-total').textContent = allCores.length;
        Utils.getElement('stat-used').textContent = usedCores.length;
        Utils.getElement('stat-free').textContent = allCores.length - usedCores.length;
        Utils.getElement('stat-sockets').textContent = numSockets > 0 ? numSockets : '—';
        Utils.getElement('stat-net').textContent = netNumas;
        Utils.getElement('stat-load').textContent = loadCount > 0 ? Utils.round(totalLoad / loadCount) + '%' : '—';
    },

    /**
     * Scale blueprint to fit viewport
     */
    scaleToFit() {
        const wrapper = Utils.querySelector('.canvas-wrapper');
        const blueprint = Utils.getElement('blueprint');

        if (!wrapper || !blueprint) return;

        // Reset transform completely before measuring
        blueprint.style.transform = 'none';
        blueprint.style.transformOrigin = 'top left';
        
        // Force layout recalculation
        blueprint.offsetHeight; // Trigger reflow

        const padding = 32;
        const availWidth = wrapper.clientWidth - padding;
        const availHeight = wrapper.clientHeight - padding;

        const contentWidth = blueprint.scrollWidth || blueprint.offsetWidth;
        const contentHeight = blueprint.scrollHeight || blueprint.offsetHeight;

        if (contentWidth === 0 || contentHeight === 0) return;

        // Calculate scale to fit both width and height, min scale 0.5, max scale 1.0
        const scaleX = availWidth / contentWidth;
        const scaleY = availHeight / contentHeight;
        let scale = Math.min(scaleX, scaleY);
        
        // Clamp scale between 0.5 and 1.0
        if (scale < 0.5) scale = 0.5;
        if (scale > 1.0) scale = 1.0;

        blueprint.style.transform = `scale(${scale})`;
    },

    /**
     * Render optimization results
     * @param {Object} result - Optimization result from CPU_OPTIMIZER
     * @returns {string} HTML for results
     */
    renderOptimizationResults(result) {
        const totalCores = result.totalCores || 0;
        const osCount = (result.osCores || []).length;
        const irqCount = (result.irqCores || []).length;
        let totalRobots = 0;
        let totalGateway = 0;
        let totalInstanceCores = 0;
        const numInstances = (result.instances || []).length;
        
        // Count from instances
        if (result.instances) {
            result.instances.forEach(inst => {
                const gw = inst.gateway || 0;
                const robot = inst.robot || 0;
                totalGateway += gw;
                totalRobots += robot;
                totalInstanceCores += inst.allocatedCores || 0;
            });
        }
        
        // Total used includes OS + IRQ + all instance allocations
        const totalUsed = osCount + irqCount + totalInstanceCores;
        const freeCores = totalCores - totalUsed;

        return `<div class="opt-results">
            <div class="opt-stats">
                <div class="opt-stat-item"><span>Total Cores</span><strong>${totalCores}</strong></div>
                <div class="opt-stat-item"><span>Instances</span><strong>${numInstances}</strong></div>
                <div class="opt-stat-item"><span>Gateway</span><strong>${totalGateway}</strong></div>
                <div class="opt-stat-item"><span>Robots</span><strong>${totalRobots}</strong></div>
            </div>
            <div class="opt-visual-map">
                <h3>Proposed Configuration</h3>
                <div class="proposed-map">
                    <div style="padding:16px;color:#666;font-size:11px;">
                        <strong>OS Cores:</strong> ${osCount} | 
                        <strong>IRQ Cores:</strong> ${irqCount} | 
                        <strong>Instance Cores:</strong> ${totalInstanceCores} |
                        <strong>Total Used:</strong> ${totalUsed} |
                        <strong>Free:</strong> ${freeCores}
                    </div>
                </div>
            </div>
            <div class="opt-grid">
                ${(result.instances || []).map(inst => `
                    <div class="opt-instance">
                        <div class="opt-inst-header">
                            <h3>${inst.instanceId}</h3>
                            <span class="opt-inst-score">${inst.allocatedCores} cores</span>
                        </div>
                        <div class="opt-inst-details">
                            <strong>Fixed:</strong> 3 (Trash+UDP+AR)<br>
                            <strong>Gateway:</strong> ${inst.gateway}<br>
                            <strong>Robots:</strong> ${inst.robot}
                        </div>
                        <div class="opt-cores-list">
                            ${(inst.coreAssignments || []).map(assign => `
                                <div class="opt-core-group">
                                    <span class="opt-svc-name">${assign.service}</span>
                                    <span class="opt-svc-cores">${assign.cores.join(', ')}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>`;
    }
};

// Export for browser
if (typeof window !== 'undefined') {
    window.Renderer = Renderer;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Renderer;
}

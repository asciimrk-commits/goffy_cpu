/**
 * HFT CPU Mapper - Optimization Rules Engine v4.5
 */

const HFT_RULES = {
    version: '4.5',
    
    categories: {
        system: { name: 'System', roles: ['sys_os'] },
        network: { name: 'Network Stack', roles: ['net_irq', 'udp', 'trash'] },
        gateway: { name: 'Gateways', roles: ['gateway'] },
        logic: { name: 'Trading Logic', roles: ['isolated_robots', 'pool1', 'pool2', 'robot_default', 'ar', 'rf', 'formula', 'click'] }
    },
    
    roles: {
        sys_os: { id: 'sys_os', name: 'System (OS)', category: 'system', color: '#5c6b7a', priority: 100 },
        net_irq: { id: 'net_irq', name: 'IRQ (Network)', category: 'network', color: '#e63946', priority: 95 },
        udp: { id: 'udp', name: 'UDP Handler', category: 'network', color: '#f4a261', priority: 70 },
        trash: { id: 'trash', name: 'Trash', category: 'network', color: '#8b6914', priority: 20 },
        gateway: { id: 'gateway', name: 'Gateway', category: 'gateway', color: '#ffd60a', priority: 90 },
        isolated_robots: { id: 'isolated_robots', name: '💎 Isolated Robots', category: 'logic', color: '#10b981', priority: 89, tier: 1 },
        pool1: { id: 'pool1', name: 'Robot Pool 1', category: 'logic', color: '#3b82f6', priority: 85, tier: 2 },
        pool2: { id: 'pool2', name: 'Robot Pool 2', category: 'logic', color: '#6366f1', priority: 80, tier: 3 },
        robot_default: { id: 'robot_default', name: 'Robot Default', category: 'logic', color: '#2ec4b6', priority: 75, tier: 4 },
        ar: { id: 'ar', name: 'AllRobots', category: 'logic', color: '#a855f7', priority: 60 },
        rf: { id: 'rf', name: 'RemoteFormula', category: 'logic', color: '#22d3ee', priority: 50 },
        formula: { id: 'formula', name: 'Formula', category: 'logic', color: '#94a3b8', priority: 30 },
        click: { id: 'click', name: 'ClickHouse', category: 'logic', color: '#4f46e5', priority: 40 },
        isolated: { id: 'isolated', name: 'Isolated', category: 'state', color: '#ffffff', priority: 1, isStateFlag: true }
    },
    
    rules: [
        { id: 'irq-isolated', severity: 'error', check: (s) => {
            const issues = [];
            Object.entries(s.instances?.Physical || {}).forEach(([cpu, tags]) => {
                if (tags.has('net_irq') && !s.isolatedCores.has(cpu)) issues.push({ message: `IRQ ${cpu} не изолировано!` });
            });
            return issues;
        }},
        { id: 'trash-single', severity: 'error', check: (s) => {
            const cores = []; Object.entries(s.instances?.Physical || {}).forEach(([cpu, tags]) => { if (tags.has('trash')) cores.push(cpu); });
            return cores.length > 1 ? [{ message: `Trash на ${cores.length} ядрах!` }] : [];
        }},
        { id: 'ar-trash', severity: 'error', check: (s) => {
            const issues = [];
            Object.entries(s.instances?.Physical || {}).forEach(([cpu, tags]) => {
                if (tags.has('ar') && tags.has('trash')) issues.push({ message: `${cpu}: AR+Trash!` });
            });
            return issues;
        }},
        { id: 'gateway-dedicated', severity: 'error', check: (s) => {
            const issues = [];
            Object.entries(s.instances?.Physical || {}).forEach(([cpu, tags]) => {
                if (tags.has('gateway')) {
                    const other = [...tags].filter(t => t !== 'gateway' && t !== 'isolated');
                    if (other.length > 0) issues.push({ message: `Gateway ${cpu} + ${other.join(',')}` });
                }
            });
            return issues;
        }},
        { id: 'robot-dedicated', severity: 'error', check: (s) => {
            const issues = [], rr = ['isolated_robots', 'pool1', 'pool2', 'robot_default'];
            Object.entries(s.instances?.Physical || {}).forEach(([cpu, tags]) => {
                if (rr.some(r => tags.has(r))) {
                    const other = [...tags].filter(t => !rr.includes(t) && t !== 'isolated');
                    if (other.length > 0) issues.push({ message: `Robot ${cpu} + ${other.join(',')}` });
                }
            });
            return issues;
        }},
        { id: 'os-nothing', severity: 'error', check: (s) => {
            const issues = [];
            Object.entries(s.instances?.Physical || {}).forEach(([cpu, tags]) => {
                if (tags.has('sys_os')) {
                    const other = [...tags].filter(t => t !== 'sys_os');
                    if (other.length > 0) issues.push({ message: `OS ${cpu} + ${other.join(',')}` });
                }
            });
            return issues;
        }},
        { id: 'robots-exist', severity: 'error', check: (s) => {
            const rr = ['isolated_robots', 'pool1', 'pool2', 'robot_default'];
            let found = false;
            Object.entries(s.instances?.Physical || {}).forEach(([cpu, tags]) => { if (rr.some(r => tags.has(r))) found = true; });
            return (Object.keys(s.coreNumaMap).length > 0 && !found) ? [{ message: 'Нет роботов!' }] : [];
        }}
    ],
    
    getCoreL3(state, cpu) {
        for (const [key, cores] of Object.entries(state.l3Groups || {})) {
            if (cores.includes(cpu) || cores.includes(cpu.toString())) return key;
        }
        return `numa-${state.coreNumaMap[cpu] || '0'}`;
    },
    
    runValidation(state) {
        const issues = [];
        this.rules.forEach(r => r.check(state).forEach(i => issues.push({ ruleId: r.id, severity: r.severity, message: i.message })));
        return issues;
    },
    
    generateRecommendation(state) {
        const totalCores = Object.keys(state.coreNumaMap).length;
        const netNuma = [...state.netNumaNodes][0] || '0';
        const isolatedCores = [...state.isolatedCores];
        const topology = this.analyzeTopology(state);
        
        const currentRoles = {};
        Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => { if (!currentRoles[t]) currentRoles[t] = []; currentRoles[t].push(cpu); });
        });
        
        const getLoad = (cores) => !cores?.length ? 0 : cores.reduce((s, c) => s + parseFloat(state.cpuLoadMap[c] || 0), 0) / cores.length;
        const getTotalLoad = (cores) => !cores?.length ? 0 : cores.reduce((s, c) => s + parseFloat(state.cpuLoadMap[c] || 0), 0);
        const calcNeeded = (cores, target = 25) => { const t = getTotalLoad(cores); return t === 0 ? (cores?.length || 1) : Math.max(1, Math.ceil(t / target)); };
        
        const proposed = { Physical: {} };
        const recommendations = [];
        const warnings = [];
        
        const assignRole = (cpu, role) => { if (!proposed.Physical[cpu]) proposed.Physical[cpu] = []; if (!proposed.Physical[cpu].includes(role)) proposed.Physical[cpu].push(role); };
        const isAssigned = (cpu) => proposed.Physical[cpu]?.length > 0;
        
        const netNumaCores = topology.byNuma[netNuma] || [];
        const netL3Pools = topology.byNumaL3[netNuma] || {};
        const netL3Keys = Object.keys(netL3Pools).sort((a, b) => (parseInt(a.split('-').pop()) || 0) - (parseInt(b.split('-').pop()) || 0));
        const numSockets = Object.keys(state.geometry || {}).length;
        const numNumas = Object.keys(topology.byNuma).length;
        
        // OS
        const osCores = netNumaCores.filter(c => !isolatedCores.includes(c));
        const osLoad = getLoad(currentRoles['sys_os'] || osCores);
        let osNeeded = Math.max(2, Math.ceil(osLoad * (currentRoles['sys_os']?.length || osCores.length) / 25));
        osNeeded = Math.min(osNeeded, osCores.length);
        const assignedOsCores = osCores.slice(0, osNeeded);
        assignedOsCores.forEach(cpu => assignRole(cpu, 'sys_os'));
        
        let serviceL3 = null;
        for (const l3 of netL3Keys) { if (netL3Pools[l3].some(c => assignedOsCores.includes(c))) { serviceL3 = l3; break; } }
        if (!serviceL3 && netL3Keys.length > 0) serviceL3 = netL3Keys[0];
        const workL3Keys = netL3Keys.filter(k => k !== serviceL3);
        
        recommendations.push({ title: '🖥️ OS', cores: assignedOsCores, description: `${assignedOsCores.length} ядер`, rationale: `~${osLoad.toFixed(0)}%` });
        
        // Service cores
        const servicePool = (netL3Pools[serviceL3] || []).filter(c => isolatedCores.includes(c) && !isAssigned(c)).sort((a, b) => parseInt(a) - parseInt(b));
        let svcIdx = 0;
        const getSvc = () => svcIdx < servicePool.length ? servicePool[svcIdx++] : null;
        
        const trashCore = getSvc();
        if (trashCore) { assignRole(trashCore, 'trash'); assignRole(trashCore, 'rf'); assignRole(trashCore, 'click'); recommendations.push({ title: '🗑️ Trash+RF+Click', cores: [trashCore], description: `Ядро ${trashCore}`, rationale: 'Сервисный L3' }); }
        
        if ((currentRoles['udp']?.length || 0) > 0) { const c = getSvc(); if (c) { assignRole(c, 'udp'); recommendations.push({ title: '📡 UDP', cores: [c], description: `Ядро ${c}`, rationale: 'Макс 1' }); } }
        
        const arCore = getSvc();
        if (arCore) { assignRole(arCore, 'ar'); assignRole(arCore, 'formula'); recommendations.push({ title: '🔄 AR+Formula', cores: [arCore], description: `Ядро ${arCore}`, rationale: 'НЕ на Trash!' }); }
        
        // IRQ + Gateways
        const neededIrq = Math.max(2, currentRoles['net_irq']?.length || 2);
        const neededGw = calcNeeded(currentRoles['gateway']);
        const gwLoad = getLoad(currentRoles['gateway']);
        
        const workPool = {};
        workL3Keys.forEach(l3 => { workPool[l3] = (netL3Pools[l3] || []).filter(c => isolatedCores.includes(c) && !isAssigned(c)).sort((a, b) => parseInt(a) - parseInt(b)); });
        
        const irqCores = [], irqPerL3 = {};
        let irqN = neededIrq, l3i = 0;
        while (irqN > 0 && l3i < neededIrq * workL3Keys.length) {
            const l3 = workL3Keys[l3i % workL3Keys.length];
            if (workPool[l3]?.length > 0) { const c = workPool[l3].shift(); assignRole(c, 'net_irq'); irqCores.push(c); if (!irqPerL3[l3]) irqPerL3[l3] = []; irqPerL3[l3].push(c); irqN--; }
            l3i++;
        }
        if (irqCores.length > 0) recommendations.push({ title: '⚡ IRQ', cores: irqCores, description: `${irqCores.length} ядер`, rationale: `L3: ${Object.entries(irqPerL3).map(([l, c]) => `${l}:${c.length}`).join(', ')}` });
        
        const gwCores = [], gwPerL3 = {};
        let gwN = neededGw; l3i = 0;
        while (gwN > 0 && l3i < neededGw * workL3Keys.length) {
            const l3 = workL3Keys[l3i % workL3Keys.length];
            if (workPool[l3]?.length > 0) { const c = workPool[l3].shift(); assignRole(c, 'gateway'); gwCores.push(c); if (!gwPerL3[l3]) gwPerL3[l3] = []; gwPerL3[l3].push(c); gwN--; }
            l3i++;
        }
        if (gwCores.length > 0) recommendations.push({ title: '🚪 Gateways', cores: gwCores, description: `${gwCores.length} ядер`, rationale: `~${gwLoad.toFixed(0)}%`, warning: gwCores.length < neededGw ? `Нужно ${neededGw}!` : null });
        
        // Isolated robots
        const isoRobots = [];
        workL3Keys.forEach(l3 => { (workPool[l3] || []).forEach(c => { if (!isAssigned(c)) isoRobots.push(c); }); });
        const MIN_ISO = 4;
        if (isoRobots.length >= MIN_ISO) { isoRobots.forEach(c => assignRole(c, 'isolated_robots')); recommendations.push({ title: '💎 Isolated Robots', cores: isoRobots, description: `${isoRobots.length} ядер`, rationale: 'ЛУЧШИЙ! Tier 1' }); }
        else if (isoRobots.length > 0) warnings.push(`${isoRobots.length} свободных < 4 для Isolated`);
        
        // Robot pools
        const pool1 = [], pool2 = [], defCores = [];
        const otherNumas = Object.keys(topology.byNuma).filter(n => n !== netNuma).sort((a, b) => parseInt(a) - parseInt(b));
        
        if (otherNumas.length >= 1) {
            const n1 = (topology.byNuma[otherNumas[0]] || []).filter(c => isolatedCores.includes(c) && !isAssigned(c));
            if (isoRobots.length > 0 && isoRobots.length < MIN_ISO) isoRobots.forEach(c => { assignRole(c, 'pool1'); pool1.push(c); });
            n1.forEach(c => { assignRole(c, 'pool1'); pool1.push(c); });
            if (pool1.length > 0) recommendations.push({ title: '🤖 Pool 1', cores: pool1, description: `NUMA ${otherNumas[0]}: ${pool1.length}`, rationale: 'Tier 2' });
        }
        if (otherNumas.length >= 2) {
            const n2 = (topology.byNuma[otherNumas[1]] || []).filter(c => isolatedCores.includes(c) && !isAssigned(c));
            n2.forEach(c => { assignRole(c, 'pool2'); pool2.push(c); });
            if (pool2.length > 0) recommendations.push({ title: '🤖 Pool 2', cores: pool2, description: `NUMA ${otherNumas[1]}: ${pool2.length}`, rationale: 'Tier 3' });
        }
        if (otherNumas.length >= 3) {
            for (let i = 2; i < otherNumas.length; i++) {
                (topology.byNuma[otherNumas[i]] || []).filter(c => isolatedCores.includes(c) && !isAssigned(c)).forEach(c => { assignRole(c, 'robot_default'); defCores.push(c); });
            }
            if (defCores.length > 0) recommendations.push({ title: '🤖 Default', cores: defCores, description: `${defCores.length} ядер`, rationale: 'Tier 4' });
        }
        
        const allRobots = [...(isoRobots.length >= MIN_ISO ? isoRobots : []), ...pool1, ...pool2, ...defCores];
        if (allRobots.length === 0) warnings.push('НЕТ РОБОТОВ!');
        
        // HTML
        let html = '<div class="recommend-result">';
        html += `<div class="recommend-section"><h3>⚠️ Важно!</h3><div class="recommend-card warning"><p><strong>Сбор:</strong> cpu-map.sh минимум <strong>2 минуты</strong> в <strong>торговый день</strong>!</p><p style="font-size:11px;color:var(--text-muted);margin-top:8px;">В выходной нагрузка 1%, в торговый 85%+</p></div></div>`;
        html += `<div class="recommend-section"><h3>📊 Топология</h3><div class="recommend-card"><p><strong>Сокетов:</strong> ${numSockets} | <strong>NUMA:</strong> ${numNumas} | <strong>Ядер:</strong> ${totalCores}</p><p><strong>Изолировано:</strong> ${isolatedCores.length} | <strong>Сетевая:</strong> ${netNuma}</p><p><strong>L3:</strong> ${netL3Keys.join(', ') || '—'}</p></div></div>`;
        if (warnings.length > 0) { html += '<div class="recommend-section"><h3>⚠️</h3>'; warnings.forEach(w => html += `<div class="recommend-card warning"><p>${w}</p></div>`); html += '</div>'; }
        html += '<div class="recommend-section"><h3>📋 Конфигурация</h3>';
        recommendations.forEach(r => {
            html += `<div class="recommend-card ${r.warning ? 'warning' : ''}"><h4>${r.title}</h4><p>${r.description}</p><p style="font-size:11px;color:var(--text-muted);">${r.rationale}</p>${r.warning ? `<p style="color:#ef4444;">⚠ ${r.warning}</p>` : ''}`;
            if (r.cores?.length) { html += '<div class="recommend-cores">'; r.cores.forEach(c => { const role = (proposed.Physical[c] || [])[0]; const col = this.roles[role]?.color || '#555'; html += `<div class="recommend-core" style="background:${col};color:#fff;">${c}</div>`; }); html += '</div>'; }
            html += '</div>';
        });
        html += '</div>';
        html += `<div class="recommend-section"><h3>🏆 Градация</h3><div class="recommend-card"><table style="width:100%;font-size:11px;"><tr style="border-bottom:1px solid var(--border-subtle);"><th>Tier</th><th>Пул</th><th>Ядер</th></tr><tr><td style="color:#10b981;">💎1</td><td>Isolated</td><td>${isoRobots.length >= MIN_ISO ? isoRobots.length : 0}</td></tr><tr><td style="color:#3b82f6;">🥈2</td><td>Pool 1</td><td>${pool1.length}</td></tr><tr><td style="color:#6366f1;">🥉3</td><td>Pool 2</td><td>${pool2.length}</td></tr><tr><td style="color:#2ec4b6;">4</td><td>Default</td><td>${defCores.length}</td></tr></table></div></div>`;
        html += `<div class="recommend-section"><h3>📈 Итого</h3><div class="recommend-card ${allRobots.length === 0 ? 'warning' : 'success'}"><p><strong>IRQ:</strong> ${irqCores.length} | <strong>GW:</strong> ${gwCores.length} | <strong>Роботов:</strong> ${allRobots.length}</p><p><strong>Использовано:</strong> ${Object.keys(proposed.Physical).length}/${totalCores}</p></div></div>`;
        html += '</div>';
        
        return { html, proposedConfig: { instances: proposed }, recommendations, warnings };
    },
    
    analyzeTopology(state) {
        const r = { byNuma: {}, byL3: {}, byNumaL3: {} };
        Object.entries(state.coreNumaMap).forEach(([cpu, numa]) => { if (!r.byNuma[numa]) r.byNuma[numa] = []; r.byNuma[numa].push(cpu); });
        Object.entries(state.l3Groups || {}).forEach(([l3, cores]) => { r.byL3[l3] = cores; const numa = state.coreNumaMap[cores[0]]; if (!r.byNumaL3[numa]) r.byNumaL3[numa] = {}; r.byNumaL3[numa][l3] = cores; });
        Object.values(r.byNuma).forEach(c => c.sort((a, b) => parseInt(a) - parseInt(b)));
        return r;
    }
};

if (typeof window !== 'undefined') window.HFT_RULES = HFT_RULES;

/**
 * HFT CPU Mapper - Optimization Rules Engine v4.6
 */

const HFT_RULES = {
    version: '4.6',
    
    categories: {
        system: { name: 'System', roles: ['sys_os'] },
        network:  { name: 'Network Stack', roles: ['net_irq', 'udp', 'trash'] },
        gateway: { name: 'Gateways', roles: ['gateway'] },
        logic: { name: 'Trading Logic', roles: ['isolated_robots', 'pool1', 'pool2', 'robot_default', 'ar', 'rf', 'formula', 'click'] }
    },
    
    roles: {
        sys_os: { id: 'sys_os', name: 'System (OS)', category: 'system', color: '#5c6b7a', priority: 100 },
        net_irq: { id: 'net_irq', name: 'IRQ (Network)', category: 'network', color:  '#e63946', priority: 95 },
        udp: { id:  'udp', name: 'UDP Handler', category: 'network', color: '#f4a261', priority: 70 },
        trash: { id: 'trash', name:  'Trash', category: 'network', color: '#8b6914', priority: 20 },
        gateway: { id: 'gateway', name:  'Gateway', category: 'gateway', color: '#ffd60a', priority: 90 },
        isolated_robots: { id: 'isolated_robots', name: '💎 Isolated Robots', category: 'logic', color: '#10b981', priority:  89, tier: 1 },
        pool1: { id:  'pool1', name: 'Robot Pool 1', category: 'logic', color: '#3b82f6', priority: 85, tier: 2 },
        pool2: { id: 'pool2', name: 'Robot Pool 2', category:  'logic', color: '#6366f1', priority:  80, tier:  3 },
        robot_default:  { id: 'robot_default', name: 'Robot Default', category: 'logic', color: '#2ec4b6', priority: 75, tier: 4 },
        ar: { id: 'ar', name:  'AllRobots', category: 'logic', color:  '#a855f7', priority: 60 },
        rf:  { id: 'rf', name: 'RemoteFormula', category: 'logic', color: '#22d3ee', priority:  50 },
        formula: { id: 'formula', name:  'Formula', category: 'logic', color: '#94a3b8', priority: 30 },
        click: { id: 'click', name:  'ClickHouse', category: 'logic', color: '#4f46e5', priority: 40 },
        isolated: { id: 'isolated', name:  'Isolated', category: 'state', color: '#ffffff', priority: 1, isStateFlag: true }
    },
    
    rules: [
        { id: 'irq-isolated', severity: 'error', check: (s) => {
            const issues = [];
            Object.entries(s.instances?. Physical || {}).forEach(([cpu, tags]) => {
                if (tags.has('net_irq') && ! s.isolatedCores.has(cpu)) issues.push({ message: `IRQ ${cpu} не изолировано! ` });
            });
            return issues;
        }},
        { id: 'trash-single', severity: 'error', check: (s) => {
            const cores = []; Object.entries(s. instances?.Physical || {}).forEach(([cpu, tags]) => { if (tags.has('trash')) cores.push(cpu); });
            return cores.length > 1 ?  [{ message: `Trash на ${cores.length} ядрах!` }] : [];
        }},
        { id: 'ar-trash', severity: 'error', check: (s) => {
            const issues = [];
            Object.entries(s. instances?.Physical || {}).forEach(([cpu, tags]) => {
                if (tags.has('ar') && tags.has('trash')) issues.push({ message: `${cpu}:  AR+Trash! ` });
            });
            return issues;
        }},
        { id: 'gateway-dedicated', severity: 'error', check: (s) => {
            const issues = [];
            Object.entries(s.instances?. Physical || {}).forEach(([cpu, tags]) => {
                if (tags.has('gateway')) {
                    const other = [... tags].filter(t => t !== 'gateway' && t !== 'isolated');
                    if (other.length > 0) issues.push({ message: `Gateway ${cpu} + ${other.join(',')}` });
                }
            });
            return issues;
        }},
        { id: 'robot-dedicated', severity: 'error', check: (s) => {
            const issues = [], rr = ['isolated_robots', 'pool1', 'pool2', 'robot_default'];
            Object.entries(s.instances?. Physical || {}).forEach(([cpu, tags]) => {
                if (rr. some(r => tags. has(r))) {
                    const other = [...tags]. filter(t => ! rr.includes(t) && t !== 'isolated');
                    if (other.length > 0) issues.push({ message: `Robot ${cpu} + ${other.join(',')}` });
                }
            });
            return issues;
        }},
        { id: 'os-nothing', severity: 'error', check: (s) => {
            const issues = [];
            Object.entries(s.instances?. Physical || {}).forEach(([cpu, tags]) => {
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
            Object.entries(s.instances?.Physical || {}).forEach(([cpu, tags]) => { if (rr.some(r => tags. has(r))) found = true; });
            return (Object.keys(s. coreNumaMap).length > 0 && ! found) ? [{ message: 'Нет роботов!' }] : [];
        }}
    ],
    
    getCoreL3(state, cpu) {
        for (const [key, cores] of Object.entries(state.l3Groups || {})) {
            if (cores.includes(cpu) || cores.includes(cpu. toString())) return key;
        }
        return `numa-${state.coreNumaMap[cpu] || '0'}`;
    },
    
    runValidation(state) {
        const issues = [];
        this.rules.forEach(r => r.check(state).forEach(i => issues.push({ ruleId: r.id, severity: r.severity, message: i.message })));
        return issues;
    },
    
    generateRecommendation(state) {
        const totalCores = Object. keys(state.coreNumaMap).length;
        const netNuma = [... state.netNumaNodes][0] || '0';
        const isolatedCores = [... state.isolatedCores];
        const topology = this.analyzeTopology(state);
        
        const currentRoles = {};
        Object.entries(state.instances?. Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => { if (!currentRoles[t]) currentRoles[t] = []; currentRoles[t]. push(cpu); });
        });
        
        const getLoad = (cores) => ! cores?. length ? 0 : cores.reduce((s, c) => s + parseFloat(state.cpuLoadMap[c] || 0), 0) / cores.length;
        const getTotalLoad = (cores) => !cores?.length ? 0 :  cores.reduce((s, c) => s + parseFloat(state.cpuLoadMap[c] || 0), 0);
        const calcNeeded = (cores, target = 25) => { const t = getTotalLoad(cores); return t === 0 ? (cores?. length || 1) : Math.max(1, Math.ceil(t / target)); };
        
        const proposed = { Physical: {} };
        const recommendations = [];
        const warnings = [];
        
        const assignRole = (cpu, role) => { if (!proposed. Physical[cpu]) proposed.Physical[cpu] = []; if (!proposed.Physical[cpu].includes(role)) proposed.Physical[cpu].push(role); };
        const isAssigned = (cpu) => proposed.Physical[cpu]?.length > 0;
        
        const netNumaCores = topology.byNuma[netNuma] || [];
        const netL3Pools = topology.byNumaL3[netNuma] || {};
        const netL3Keys = Object.keys(netL3Pools).sort((a, b) => (parseInt(a. split('-').pop()) || 0) - (parseInt(b.split('-').pop()) || 0));
        const numSockets = Object.keys(state.geometry || {}).length;
        const numNumas = Object.keys(topology.byNuma).length;
        
        // OS
        const osCores = netNumaCores.filter(c => !isolatedCores.includes(c));
        const osLoad = getLoad(currentRoles['sys_os'] || osCores);
        let osNeeded = Math.max(2, Math.ceil(osLoad * (currentRoles['sys_os']?.length || osCores.length) / 25));
        osNeeded = Math. min(osNeeded, osCores.length);
        const assignedOsCores = osCores.slice(0, osNeeded);
        assignedOsCores. forEach(cpu => assignRole(cpu, 'sys_os'));
        
        let serviceL3 = null;
        for (const l3 of netL3Keys) { if (netL3Pools[l3]. some(c => assignedOsCores. includes(c))) { serviceL3 = l3; break; } }
        if (!serviceL3 && netL3Keys.length > 0) serviceL3 = netL3Keys[0];
        const workL3Keys = netL3Keys.filter(k => k !== serviceL3);
        
        recommendations.push({ title: '🖥️ OS', cores: assignedOsCores, description: `${assignedOsCores.length} ядер`, rationale: `~${osLoad.toFixed(0)}%` });
        
        // Service cores
        const servicePool = (netL3Pools[serviceL3] || []).filter(c => isolatedCores.includes(c) && !isAssigned(c)).sort((a, b) => parseInt(a) - parseInt(b));
        let svcIdx = 0;
        const getSvc = () => svcIdx < servicePool.length ? servicePool[svcIdx++] : null;
        
        const trashCore = getSvc();
        if (trashCore) { assignRole(trashCore, 'trash'); assignRole(trashCore, 'rf'); assignRole(trashCore, 'click'); recommendations.push({ title: '🗑️ Trash+RF+Click', cores: [trashCore],

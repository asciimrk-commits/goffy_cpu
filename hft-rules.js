/**
 * HFT CPU Mapper - Optimization Rules Engine v4.3
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * КЛЮЧЕВЫЕ ПРИНЦИПЫ ОПТИМИЗАЦИИ
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 1. L3 CACHE AFFINITY (критично для latency):
 *    - Гейты + Роботы → идеально в одном L3
 *    - Гейты + IRQ → желательно в одном L3
 *    - Сервисные ядра (OS, Trash, RF, Click, UDP, AR) → вымывают ОДИН L3 пул
 *    - НЕ вымывать L3 кэш роботов и гейтов!
 * 
 * 2. NUMA LOCALITY:
 *    - Сетевая NUMA: IRQ, Gateways, Trash, UDP
 *    - Пулы роботов: 1 пул = 1 NUMA нода (минимизация cross-NUMA трафика)
 * 
 * 3. НАГРУЗКА:
 *    - Цель: 20-30% avg на ядро
 *    - Расчёт количества ядер по текущей нагрузке
 * 
 * 4. ИЗОЛЯЦИЯ:
 *    - OS ядра: НЕ изолированы, на них НИЧЕГО
 *    - Все остальные роли: ТОЛЬКО на изолированных ядрах
 * 
 * 5. СОВМЕЩЕНИЕ:
 *    - Trash + RF + ClickHouse → можно на 1 ядро
 *    - AR + Formula → можно на 1 ядро
 *    - AR + Trash → НЕЛЬЗЯ
 *    - Gateway/Robot → ТОЛЬКО выделенные ядра
 */

const HFT_RULES = {
    version: '4.3',
    
    categories: {
        system: { name: 'System', roles: ['sys_os'] },
        network: { name: 'Network Stack', roles: ['net_irq', 'udp', 'trash'] },
        gateway: { name: 'Gateways', roles: ['gateway'] },
        logic: { name: 'Trading Logic', roles: ['robot', 'pool1', 'pool2', 'ar', 'rf', 'formula', 'click'] }
    },
    
    roles: {
        sys_os: {
            id: 'sys_os', name: 'System (OS)', category: 'system',
            color: '#5c6b7a', priority: 100,
            description: 'OS ядра. НЕ изолированы. На них НИЧЕГО не размещается.'
        },
        net_irq: {
            id: 'net_irq', name: 'IRQ (Network)', category: 'network',
            color: '#e63946', priority: 95,
            description: 'Изолированные ядра. Желательно в L3 с гейтами.'
        },
        udp: {
            id: 'udp', name: 'UDP Handler', category: 'network',
            color: '#f4a261', priority: 70,
            description: 'Максимум 1 ядро. Сервисный L3 пул.'
        },
        trash: {
            id: 'trash', name: 'Trash', category: 'network',
            color: '#8b6914', priority: 20,
            description: 'Ровно 1 ядро. Сервисный L3 пул. Совмещается с RF, Click.'
        },
        gateway: {
            id: 'gateway', name: 'Gateway', category: 'gateway',
            color: '#ffd60a', priority: 90,
            description: 'Сетевая NUMA. L3 с IRQ и роботами. ВЫДЕЛЕННЫЕ ядра.'
        },
        robot: {
            id: 'robot', name: 'Robot', category: 'logic',
            color: '#2ec4b6', priority: 85,
            description: 'L3 с гейтами. ВЫДЕЛЕННЫЕ ядра. Цель: 20-30% нагрузки.'
        },
        pool1: { 
            id: 'pool1', name: 'Robot Pool 1', category: 'logic', 
            color: '#3b82f6', priority: 80,
            description: '1 пул = 1 NUMA нода целиком'
        },
        pool2: { 
            id: 'pool2', name: 'Robot Pool 2', category: 'logic', 
            color: '#6366f1', priority: 75,
            description: '1 пул = 1 NUMA нода целиком'
        },
        ar: {
            id: 'ar', name: 'AllRobots', category: 'logic',
            color: '#a855f7', priority: 60,
            description: '1 ядро. Сервисный L3 пул. НЕ совмещать с Trash.'
        },
        rf: {
            id: 'rf', name: 'RemoteFormula', category: 'logic',
            color: '#22d3ee', priority: 50,
            description: 'Сервисный L3 пул. Можно с Trash.'
        },
        formula: {
            id: 'formula', name: 'Formula', category: 'logic',
            color: '#94a3b8', priority: 30,
            description: 'Обычно на AR. Сервисный L3 пул.'
        },
        click: {
            id: 'click', name: 'ClickHouse', category: 'logic',
            color: '#4f46e5', priority: 40,
            description: 'Не критично к L3. Можно с Trash.'
        },
        isolated: {
            id: 'isolated', name: 'Isolated', category: 'state',
            color: '#ffffff', priority: 1, isStateFlag: true
        }
    },
    
    // =========================================================================
    // VALIDATION RULES
    // =========================================================================
    rules: [
        {
            id: 'irq-only-isolated',
            severity: 'error',
            check: (state) => {
                const issues = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('net_irq') && !state.isolatedCores.has(cpu)) {
                        issues.push({ message: `IRQ на ядре ${cpu} — ядро НЕ изолировано!` });
                    }
                });
                return issues;
            }
        },
        {
            id: 'trash-single',
            severity: 'error',
            check: (state) => {
                const trashCores = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('trash')) trashCores.push(cpu);
                });
                if (trashCores.length > 1) {
                    return [{ message: `Trash на ${trashCores.length} ядрах (${trashCores.join(', ')}). Должен быть РОВНО 1!` }];
                }
                return [];
            }
        },
        {
            id: 'trash-network-numa',
            severity: 'error',
            check: (state) => {
                const issues = [];
                const netNumas = state.netNumaNodes;
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('trash')) {
                        const numa = state.coreNumaMap[cpu];
                        if (netNumas.size > 0 && !netNumas.has(numa)) {
                            issues.push({ message: `Trash на ядре ${cpu} (NUMA ${numa}) — должен быть на сетевой NUMA!` });
                        }
                    }
                });
                return issues;
            }
        },
        {
            id: 'ar-trash-conflict',
            severity: 'error',
            check: (state) => {
                const issues = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('ar') && tags.has('trash')) {
                        issues.push({ message: `Ядро ${cpu}: AR + Trash вместе НЕДОПУСТИМО!` });
                    }
                });
                return issues;
            }
        },
        {
            id: 'gateway-network-numa',
            severity: 'error',
            check: (state) => {
                const issues = [];
                const netNumas = state.netNumaNodes;
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('gateway')) {
                        const numa = state.coreNumaMap[cpu];
                        if (netNumas.size > 0 && !netNumas.has(numa)) {
                            issues.push({ message: `Gateway на ядре ${cpu} (NUMA ${numa}) — ДОЛЖЕН быть на сетевой NUMA!` });
                        }
                    }
                });
                return issues;
            }
        },
        {
            id: 'gateway-dedicated',
            severity: 'error',
            check: (state) => {
                const issues = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('gateway')) {
                        const otherRoles = [...tags].filter(t => t !== 'gateway' && t !== 'isolated');
                        if (otherRoles.length > 0) {
                            issues.push({ message: `Gateway ядро ${cpu} совмещено с ${otherRoles.join(', ')} — НЕДОПУСТИМО!` });
                        }
                    }
                });
                return issues;
            }
        },
        {
            id: 'robot-dedicated',
            severity: 'error',
            check: (state) => {
                const issues = [];
                const robotRoles = ['robot', 'pool1', 'pool2'];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    const hasRobot = robotRoles.some(r => tags.has(r));
                    if (hasRobot) {
                        const otherRoles = [...tags].filter(t => !robotRoles.includes(t) && t !== 'isolated');
                        if (otherRoles.length > 0) {
                            issues.push({ message: `Robot ядро ${cpu} совмещено с ${otherRoles.join(', ')} — НЕДОПУСТИМО!` });
                        }
                    }
                });
                return issues;
            }
        },
        {
            id: 'udp-single',
            severity: 'warning',
            check: (state) => {
                const udpCores = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('udp')) udpCores.push(cpu);
                });
                if (udpCores.length > 1) {
                    return [{ message: `UDP на ${udpCores.length} ядрах — максимум 1!` }];
                }
                return [];
            }
        },
        {
            id: 'os-nothing',
            severity: 'error',
            check: (state) => {
                const issues = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('sys_os')) {
                        const otherRoles = [...tags].filter(t => t !== 'sys_os' && t !== 'isolated');
                        if (otherRoles.length > 0) {
                            issues.push({ message: `OS ядро ${cpu} имеет роли: ${otherRoles.join(', ')} — НЕДОПУСТИМО!` });
                        }
                    }
                });
                return issues;
            }
        },
        {
            id: 'robots-exist',
            severity: 'error',
            check: (state) => {
                const robotCores = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('robot') || tags.has('pool1') || tags.has('pool2')) robotCores.push(cpu);
                });
                if (Object.keys(state.coreNumaMap).length > 0 && robotCores.length === 0) {
                    return [{ message: 'НЕТ ядер для Robots — торговля НЕВОЗМОЖНА!' }];
                }
                return [];
            }
        },
        {
            id: 'gateway-irq-l3',
            severity: 'info',
            check: (state) => {
                const irqL3s = new Set();
                const gatewayL3s = new Set();
                
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    const l3 = HFT_RULES.getCoreL3(state, cpu);
                    if (tags.has('net_irq')) irqL3s.add(l3);
                    if (tags.has('gateway')) gatewayL3s.add(l3);
                });
                
                const shared = [...irqL3s].filter(l3 => gatewayL3s.has(l3));
                if (irqL3s.size > 0 && gatewayL3s.size > 0 && shared.length === 0) {
                    return [{ message: 'IRQ и Gateways в разных L3 кэшах — желательно в одном' }];
                }
                return [];
            }
        },
        {
            id: 'gateway-robot-l3',
            severity: 'info',
            check: (state) => {
                const robotL3s = new Set();
                const gatewayL3s = new Set();
                
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    const l3 = HFT_RULES.getCoreL3(state, cpu);
                    if (tags.has('robot') || tags.has('pool1') || tags.has('pool2')) robotL3s.add(l3);
                    if (tags.has('gateway')) gatewayL3s.add(l3);
                });
                
                const shared = [...robotL3s].filter(l3 => gatewayL3s.has(l3));
                if (robotL3s.size > 0 && gatewayL3s.size > 0 && shared.length === 0) {
                    return [{ message: 'Роботы и Gateways в разных L3 кэшах — идеально в одном' }];
                }
                return [];
            }
        },
        {
            id: 'pool-numa-isolation',
            severity: 'warning',
            check: (state) => {
                const issues = [];
                const pool1Numas = new Set();
                const pool2Numas = new Set();
                
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    const numa = state.coreNumaMap[cpu];
                    if (tags.has('pool1')) pool1Numas.add(numa);
                    if (tags.has('pool2')) pool2Numas.add(numa);
                });
                
                if (pool1Numas.size > 1) {
                    issues.push({ message: `Pool 1 на ${pool1Numas.size} NUMA нодах — должен быть на 1` });
                }
                if (pool2Numas.size > 1) {
                    issues.push({ message: `Pool 2 на ${pool2Numas.size} NUMA нодах — должен быть на 1` });
                }
                const overlap = [...pool1Numas].filter(n => pool2Numas.has(n));
                if (overlap.length > 0 && pool1Numas.size > 0 && pool2Numas.size > 0) {
                    issues.push({ message: `Pool 1 и Pool 2 пересекаются на NUMA ${overlap.join(',')}` });
                }
                return issues;
            }
        },
        {
            id: 'load-gateway',
            severity: 'warning',
            check: (state) => {
                const issues = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('gateway')) {
                        const load = parseFloat(state.cpuLoadMap[cpu] || 0);
                        if (load > 30) {
                            issues.push({ message: `Gateway ${cpu}: нагрузка ${load.toFixed(0)}% > 30%` });
                        }
                    }
                });
                return issues;
            }
        },
        {
            id: 'load-robot',
            severity: 'warning',
            check: (state) => {
                const issues = [];
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('robot') || tags.has('pool1') || tags.has('pool2')) {
                        const load = parseFloat(state.cpuLoadMap[cpu] || 0);
                        if (load > 30) {
                            issues.push({ message: `Robot ${cpu}: нагрузка ${load.toFixed(0)}% > 30%` });
                        }
                    }
                });
                return issues;
            }
        }
    ],
    
    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================
    
    getCoreL3(state, cpu) {
        for (const [key, cores] of Object.entries(state.l3Groups || {})) {
            if (cores.includes(cpu) || cores.includes(cpu.toString())) {
                return key;
            }
        }
        return `numa-${state.coreNumaMap[cpu] || '0'}`;
    },
    
    runValidation(state) {
        const allIssues = [];
        this.rules.forEach(rule => {
            const issues = rule.check(state);
            issues.forEach(issue => {
                allIssues.push({
                    ruleId: rule.id,
                    severity: rule.severity,
                    message: issue.message
                });
            });
        });
        return allIssues;
    },
    
    // =========================================================================
    // RECOMMENDATION ENGINE
    // =========================================================================
    generateRecommendation(state) {
        const totalCores = Object.keys(state.coreNumaMap).length;
        const netNuma = [...state.netNumaNodes][0] || '0';
        const isolatedCores = [...state.isolatedCores];
        
        // Анализ топологии
        const topology = this.analyzeTopology(state);
        
        // Текущие роли
        const currentRoles = {};
        Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!currentRoles[t]) currentRoles[t] = [];
                currentRoles[t].push(cpu);
            });
        });
        
        // Функции нагрузки
        const getLoad = (cores) => {
            if (!cores || cores.length === 0) return 0;
            let total = 0;
            cores.forEach(cpu => { total += parseFloat(state.cpuLoadMap[cpu] || 0); });
            return total / cores.length;
        };
        
        const getTotalLoad = (cores) => {
            if (!cores || cores.length === 0) return 0;
            let total = 0;
            cores.forEach(cpu => { total += parseFloat(state.cpuLoadMap[cpu] || 0); });
            return total;
        };
        
        const calcNeeded = (roleCores, targetLoad = 25) => {
            const total = getTotalLoad(roleCores);
            if (total === 0) return roleCores?.length || 1;
            return Math.max(1, Math.ceil(total / targetLoad));
        };
        
        // =====================================================================
        // СТРОИМ ОПТИМАЛЬНУЮ КОНФИГУРАЦИЮ
        // =====================================================================
        
        const proposed = { Physical: {} };
        const recommendations = [];
        const warnings = [];
        
        const assignRole = (cpu, role) => {
            if (!proposed.Physical[cpu]) proposed.Physical[cpu] = [];
            if (!proposed.Physical[cpu].includes(role)) {
                proposed.Physical[cpu].push(role);
            }
        };
        
        const isAssigned = (cpu) => proposed.Physical[cpu]?.length > 0;
        
        // L3 пулы на сетевой NUMA
        const netNumaCores = topology.byNuma[netNuma] || [];
        const netL3Pools = topology.byNumaL3[netNuma] || {};
        const netL3Keys = Object.keys(netL3Pools).sort();
        
        // -----------------------------------------------------------------
        // 1. OS ЯДРА - не изолированные
        // -----------------------------------------------------------------
        const osCores = netNumaCores.filter(c => !isolatedCores.includes(c));
        const osLoad = getLoad(currentRoles['sys_os'] || osCores);
        let osNeeded = Math.max(2, Math.ceil(osLoad * osCores.length / 25));
        osNeeded = Math.min(osNeeded, osCores.length);
        
        const assignedOsCores = osCores.slice(0, osNeeded);
        assignedOsCores.forEach(cpu => assignRole(cpu, 'sys_os'));
        
        // Определяем "сервисный" L3 (там где OS)
        let serviceL3 = null;
        for (const l3Key of netL3Keys) {
            if (netL3Pools[l3Key].some(c => assignedOsCores.includes(c))) {
                serviceL3 = l3Key;
                break;
            }
        }
        if (!serviceL3) serviceL3 = netL3Keys[0];
        
        // L3 для гейтов (не сервисный, если возможно)
        let gatewayL3 = netL3Keys.find(k => k !== serviceL3) || serviceL3;
        
        recommendations.push({
            title: '🖥️ OS / Housekeeping',
            cores: assignedOsCores,
            description: `${assignedOsCores.length} ядер для системы`,
            rationale: `L3: ${serviceL3}. Нагрузка ~${osLoad.toFixed(0)}%. НИЧЕГО больше на этих ядрах.`
        });
        
        // -----------------------------------------------------------------
        // 2. СЕРВИСНЫЕ ЯДРА (в сервисном L3)
        // -----------------------------------------------------------------
        const servicePool = (netL3Pools[serviceL3] || [])
            .filter(c => isolatedCores.includes(c) && !isAssigned(c))
            .sort((a, b) => parseInt(a) - parseInt(b));
        
        let svcIdx = 0;
        
        // Trash + RF + Click
        if (svcIdx < servicePool.length) {
            const cpu = servicePool[svcIdx++];
            assignRole(cpu, 'trash');
            assignRole(cpu, 'rf');
            assignRole(cpu, 'click');
            recommendations.push({
                title: '🗑️ Trash + RF + ClickHouse',
                cores: [cpu],
                description: `Ядро ${cpu} — фоновые задачи`,
                rationale: `Сервисный L3 (${serviceL3}). Не вымывает кэш критичных задач.`
            });
        }
        
        // UDP (если есть)
        if ((currentRoles['udp']?.length || 0) > 0 && svcIdx < servicePool.length) {
            const cpu = servicePool[svcIdx++];
            assignRole(cpu, 'udp');
            recommendations.push({
                title: '📡 UDP Handler',
                cores: [cpu],
                description: `Ядро ${cpu} — UDP`,
                rationale: 'Максимум 1 ядро. Сервисный L3.'
            });
        }
        
        // AR + Formula
        if (svcIdx < servicePool.length) {
            const cpu = servicePool[svcIdx++];
            assignRole(cpu, 'ar');
            assignRole(cpu, 'formula');
            recommendations.push({
                title: '🔄 AllRobots + Formula',
                cores: [cpu],
                description: `Ядро ${cpu}`,
                rationale: 'НЕ на Trash! Сервисный L3.'
            });
        }
        
        // -----------------------------------------------------------------
        // 3. IRQ (желательно в L3 гейтов)
        // -----------------------------------------------------------------
        const gatewayPool = (netL3Pools[gatewayL3] || [])
            .filter(c => isolatedCores.includes(c) && !isAssigned(c))
            .sort((a, b) => parseInt(a) - parseInt(b));
        
        const irqCores = [];
        for (let i = 0; i < 2 && i < gatewayPool.length; i++) {
            const cpu = gatewayPool[i];
            assignRole(cpu, 'net_irq');
            irqCores.push(cpu);
        }
        
        if (irqCores.length > 0) {
            recommendations.push({
                title: '⚡ Network IRQ',
                cores: irqCores,
                description: `Ядра ${irqCores.join(', ')}`,
                rationale: `✓ В L3 с гейтами (${gatewayL3})`
            });
        }
        
        // -----------------------------------------------------------------
        // 4. GATEWAYS
        // -----------------------------------------------------------------
        const neededGateways = calcNeeded(currentRoles['gateway']);
        const gwLoad = getLoad(currentRoles['gateway']);
        const gatewayCores = [];
        
        const availGw = gatewayPool.filter(c => !isAssigned(c));
        for (let i = 0; i < neededGateways && i < availGw.length; i++) {
            assignRole(availGw[i], 'gateway');
            gatewayCores.push(availGw[i]);
        }
        
        // Если не хватило — берём из других L3 на сетевой NUMA
        if (gatewayCores.length < neededGateways) {
            const otherNet = netNumaCores
                .filter(c => isolatedCores.includes(c) && !isAssigned(c));
            for (let i = 0; gatewayCores.length < neededGateways && i < otherNet.length; i++) {
                assignRole(otherNet[i], 'gateway');
                gatewayCores.push(otherNet[i]);
            }
        }
        
        recommendations.push({
            title: '🚪 Gateways',
            cores: gatewayCores,
            description: `${gatewayCores.length} ядер: ${gatewayCores.join(', ')}`,
            rationale: `Нагрузка ~${gwLoad.toFixed(0)}%. L3: ${gatewayL3}`,
            warning: gatewayCores.length < neededGateways ? `Нужно ${neededGateways}!` : null
        });
        
        // -----------------------------------------------------------------
        // 5. ROBOTS
        // -----------------------------------------------------------------
        const robotLoad = getLoad(currentRoles['robot'] || currentRoles['pool1'] || currentRoles['pool2']);
        const robotCores = [];
        const pool1Cores = [];
        const pool2Cores = [];
        
        // Сначала — роботы в L3 с гейтами (идеально!)
        const robotsInGwL3 = gatewayPool.filter(c => !isAssigned(c));
        robotsInGwL3.forEach(cpu => {
            assignRole(cpu, 'robot');
            robotCores.push(cpu);
        });
        
        // Другие NUMA ноды — пулы
        const otherNumas = Object.keys(topology.byNuma)
            .filter(n => n !== netNuma)
            .sort((a, b) => parseInt(a) - parseInt(b));
        
        if (otherNumas.length >= 2) {
            (topology.byNuma[otherNumas[0]] || [])
                .filter(c => isolatedCores.includes(c) && !isAssigned(c))
                .forEach(cpu => { assignRole(cpu, 'pool1'); pool1Cores.push(cpu); });
            
            (topology.byNuma[otherNumas[1]] || [])
                .filter(c => isolatedCores.includes(c) && !isAssigned(c))
                .forEach(cpu => { assignRole(cpu, 'pool2'); pool2Cores.push(cpu); });
        } else if (otherNumas.length === 1) {
            (topology.byNuma[otherNumas[0]] || [])
                .filter(c => isolatedCores.includes(c) && !isAssigned(c))
                .forEach(cpu => { assignRole(cpu, 'robot'); robotCores.push(cpu); });
        }
        
        if (robotCores.length > 0) {
            recommendations.push({
                title: '🤖 Robots (L3 с гейтами)',
                cores: robotCores,
                description: `${robotCores.length} ядер в общем L3`,
                rationale: '✓ Идеально! Минимальный cache miss.'
            });
        }
        
        if (pool1Cores.length > 0) {
            recommendations.push({
                title: '🤖 Robot Pool 1',
                cores: pool1Cores,
                description: `NUMA ${otherNumas[0]}: ${pool1Cores.length} ядер`,
                rationale: '1 пул = 1 NUMA. Нет cross-NUMA.'
            });
        }
        
        if (pool2Cores.length > 0) {
            recommendations.push({
                title: '🤖 Robot Pool 2',
                cores: pool2Cores,
                description: `NUMA ${otherNumas[1]}: ${pool2Cores.length} ядер`,
                rationale: 'Изолирован от Pool 1.'
            });
        }
        
        const allRobots = [...robotCores, ...pool1Cores, ...pool2Cores];
        if (allRobots.length === 0) {
            warnings.push('КРИТИЧНО: Нет ядер для роботов!');
        }
        
        // =====================================================================
        // HTML
        // =====================================================================
        let html = '<div class="recommend-result">';
        
        html += `<div class="recommend-section">
            <h3>📊 Топология</h3>
            <div class="recommend-card">
                <p><strong>Ядер:</strong> ${totalCores} | <strong>Изолировано:</strong> ${isolatedCores.length}</p>
                <p><strong>Сетевая NUMA:</strong> ${netNuma} | <strong>L3:</strong> ${netL3Keys.join(', ')}</p>
                <p><strong>Сервисный L3:</strong> ${serviceL3} | <strong>L3 гейтов:</strong> ${gatewayL3}</p>
            </div>
        </div>`;
        
        if (warnings.length > 0) {
            html += '<div class="recommend-section"><h3>⚠️ Критично</h3>';
            warnings.forEach(w => html += `<div class="recommend-card warning"><p>${w}</p></div>`);
            html += '</div>';
        }
        
        html += '<div class="recommend-section"><h3>📋 Конфигурация</h3>';
        recommendations.forEach(rec => {
            html += `<div class="recommend-card ${rec.warning ? 'warning' : ''}">
                <h4>${rec.title}</h4>
                <p>${rec.description}</p>
                <p style="font-size:11px;color:var(--text-muted);margin-top:6px;">${rec.rationale}</p>
                ${rec.warning ? `<p style="color:#ef4444;">⚠ ${rec.warning}</p>` : ''}
                ${rec.cores?.length ? `<div class="recommend-cores">
                    ${rec.cores.map(c => {
                        const r = (proposed.Physical[c] || [])[0];
                        const col = this.roles[r]?.color || '#555';
                        return `<div class="recommend-core" style="background:${col};color:#fff;">${c}</div>`;
                    }).join('')}
                </div>` : ''}
            </div>`;
        });
        html += '</div>';
        
        html += `<div class="recommend-section">
            <h3>📈 Итого</h3>
            <div class="recommend-card ${allRobots.length === 0 ? 'warning' : 'success'}">
                <p><strong>Гейтов:</strong> ${gatewayCores.length} | <strong>Роботов:</strong> ${allRobots.length}</p>
                <p><strong>Использовано:</strong> ${Object.keys(proposed.Physical).length} из ${totalCores}</p>
            </div>
        </div>`;
        
        html += `<div class="recommend-section">
            <h3>💾 L3 Distribution</h3>
            <div class="recommend-card"><table style="width:100%;font-size:11px;">
                <tr style="border-bottom:1px solid var(--border-subtle);">
                    <th style="text-align:left;padding:4px;">L3</th>
                    <th style="text-align:left;padding:4px;">Роли</th>
                </tr>`;
        
        const l3Sum = {};
        Object.entries(proposed.Physical).forEach(([cpu, roles]) => {
            const l3 = this.getCoreL3(state, cpu);
            if (!l3Sum[l3]) l3Sum[l3] = new Set();
            roles.forEach(r => l3Sum[l3].add(r));
        });
        
        Object.entries(l3Sum).forEach(([l3, roles]) => {
            const roleNames = [...roles].map(r => this.roles[r]?.name || r).join(', ');
            html += `<tr><td style="padding:4px;">${l3}</td><td style="padding:4px;">${roleNames}</td></tr>`;
        });
        
        html += '</table></div></div></div>';
        
        return { html, proposedConfig: { instances: proposed }, recommendations, warnings };
    },
    
    analyzeTopology(state) {
        const result = { byNuma: {}, byL3: {}, byNumaL3: {} };
        
        Object.entries(state.coreNumaMap).forEach(([cpu, numa]) => {
            if (!result.byNuma[numa]) result.byNuma[numa] = [];
            result.byNuma[numa].push(cpu);
        });
        
        Object.entries(state.l3Groups || {}).forEach(([l3Key, cores]) => {
            result.byL3[l3Key] = cores;
            const numa = state.coreNumaMap[cores[0]];
            if (!result.byNumaL3[numa]) result.byNumaL3[numa] = {};
            result.byNumaL3[numa][l3Key] = cores;
        });
        
        Object.values(result.byNuma).forEach(c => c.sort((a, b) => parseInt(a) - parseInt(b)));
        
        return result;
    }
};

if (typeof window !== 'undefined') window.HFT_RULES = HFT_RULES;

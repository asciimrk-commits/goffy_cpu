/**
 * HFT CPU Optimizer - Capacity Planning Engine v5.0
 * 
 * Логика автоматической оптимизации распределения ядер между сервисами
 * на основе текущей нагрузки, топологии NUMA/L3 и правил распределения (Scoring System)
 */

const CPU_OPTIMIZER = {
    // Система очков для NUMA placement (User defined)
    NUMA_SCORES: {
        // Иначе быть не может (Critical Constraints)
        CRITICAL: {
            os_on_node0: 1000,
            irq_on_network: 1000,
            trash_click_rf_on_network: 1000, // Треш+click+rf - всегда на сетевой
            udp_on_network: 1000             // udp - только на сетевой
        },
        // Бонусные очки (Preferences)
        BONUS: {
            gateway_on_network: 500,         // гейты на сетевой +500
            ar_formula_on_network: 200,      // ar + form на сетевой +200
            robot_sss_on_network: 100        // robot на сетевой +100 -sss+ тир роботов
        },
        // Штрафы (Penalty)
        PENALTY: {
            wrong_l3_sharing: -500 // Смешивание Hot/Cold в одном L3, если есть возможность разделить
        }
    },

    // Целевые диапазоны нагрузки
    TARGET_LOADS: {
        os: { target: 20 },
        irq: { target: 10 },
        gateway: { min: 20, max: 30, target: 25 },
        robot: { min: 30, max: 50, target: 40 },
        // Остальные сервисы по 1 ядру, нагрузка не так важна для скейлинга
    },

    /**
     * Главная функция оптимизации
     */
    optimize(snapshot) {
        const totalCores = snapshot.topology.length;
        const instances = this.extractInstances(snapshot);

        console.log('[Optimizer] Starting optimization v5.0', { totalCores, instances: instances.length });

        // 1. OS Cores: Strictly 0 to N (10% of total)
        // os расположены с 0го ядра по N - иначе нельзя
        const osCount = Math.ceil(totalCores * 0.1);
        const osCores = [];
        for (let i = 0; i < osCount; i++) osCores.push(i);

        // 2. Рассчитать потребности инстансов (Needs Calculation)
        // Сортируем инстансы по нагрузке ("Big" -> "Small")
        const instancePlans = instances.map(inst => this.calculateInstanceNeeds(inst, snapshot))
                                       .sort((a, b) => b.priorityScore - a.priorityScore);

        // 3. Расчет IRQ (1 ядро на 4 гейта)
        // irq - на сетевой ноде (если она не одна то на каждой в зависимости от кол-ва гейтов на ноде)
        // Мы считаем глобально сколько нужно IRQ ядер, но при плейсменте будем пытаться разместить их на нужных нодах
        let totalGateways = 0;
        instancePlans.forEach(p => totalGateways += p.gateway);
        // Min 1 IRQ if any gateways exist
        const totalIrqNeeded = totalGateways > 0 ? Math.max(1, Math.ceil(totalGateways / 4)) : 0;

        // 4. Доступные ядра (Total - OS)
        // IRQ ядра берутся из доступных, так как они должны быть на сетевой ноде
        const availableCoresTotal = totalCores - osCount;

        // 5. Распределение ядер между инстансами (Allocation)
        const allocations = this.allocateResources(instancePlans, availableCoresTotal - totalIrqNeeded, snapshot);

        // 6. Топологическая оптимизация (Placement & Scoring)
        const optimizedTopology = this.optimizeTopology(allocations, snapshot, osCores, totalIrqNeeded);

        return {
            totalCores,
            osCores,
            irqCores: optimizedTopology.irqCoresCount,
            totalScore: optimizedTopology.totalScore,
            instances: optimizedTopology.instances,
            recommendations: this.generateRecommendations(optimizedTopology.instances, snapshot)
        };
    },

    extractInstances(snapshot) {
        const map = new Map();
        snapshot.topology.forEach(c => {
            c.services.forEach(s => {
                if (s.instanceId === 'SYSTEM') return;
                if (!map.has(s.instanceId)) map.set(s.instanceId, { id: s.instanceId, services: [] });
                map.get(s.instanceId).services.push({ ...s, coreId: c.id, load: c.currentLoad });
            });
        });
        return Array.from(map.values());
    },

    calculateInstanceNeeds(inst, snapshot) {
        // Агрегация нагрузки по типам
        const loads = { gateway: { sum: 0, count: 0 }, robot: { sum: 0, count: 0 } };
        inst.services.forEach(s => {
            const type = this.mapServiceType(s.name);
            if (loads[type]) { loads[type].sum += s.load || 0; loads[type].count++; }
        });

        const getAvg = (type) => loads[type].count > 0 ? loads[type].sum / loads[type].count : 0;
        const gwLoad = getAvg('gateway');
        const robLoad = getAvg('robot');
        const curGw = loads.gateway.count || 1;
        const curRob = loads.robot.count || 1;

        const needs = {
            instanceId: inst.id,
            priorityScore: gwLoad + robLoad, // Simple priority metric
            current: { gateway: curGw, robot: curRob, gwLoad, robLoad },
            gateway: 1, robot: 1, trash: 1, udp: 1, ar: 1, rf: 1, formula: 1, click: 1
        };

        // Scaling Logic
        // Гейты: оценить нагрзку, если там 20-30 процентов но было увеличено кол-во роботов, нужно будет увеличить кол-во гейтов
        // (как правило 1 гейт на 3-4 робота)
        // Gateway load logic: target 20-30%
        if (gwLoad > 30) needs.gateway = Math.ceil(curGw * (gwLoad / 25)); // Scale up to reach ~25%
        else needs.gateway = Math.max(1, curGw); // Keep or min 1

        // Роботы: оцениваем нагрузку текущую, если она в районе 60-70% то нужно расчитать такое кол-во ядер, чтобы снизилась до 30-50
        if (robLoad >= 60) needs.robot = Math.ceil(curRob * (robLoad / 40)); // Scale to ~40%
        else needs.robot = Math.max(1, curRob);

        // Ratio Check: 1 Gate per 3-4 Robots
        if (needs.robot / needs.gateway > 4) needs.gateway = Math.ceil(needs.robot / 3.5);

        // Min Config Check: Gate-1 Robot-1 Trash/RF/Click-1 AR/Form-1 UDP-1
        // We track distinct cores for services.
        // Trash/RF/Click usually combined -> 1 core
        // AR/Form usually combined -> 1 core
        // UDP separate -> 1 core
        needs.trash_combo = 1; // Trash + Click + RF
        needs.ar_combo = 1;    // AR + Formula
        needs.udp = 1;

        needs.totalCoreCount = needs.gateway + needs.robot + needs.trash_combo + needs.ar_combo + needs.udp;
        needs.totalCoreCount = Math.max(6, needs.totalCoreCount); // Min 6 stated in requirements

        return needs;
    },

    allocateResources(plans, available, snapshot) {
        // Simple allocation: First come (Big), first served.
        // If constrained, squeeze "Small" instances?
        // Logic: Try to satisfy everyone. If not enough, reduce Robots (lowest prio scaler) or squeeze Small.
        // For now, we assume we have enough cores or we fill until full.

        let remaining = available;
        return plans.map(p => {
            // Calculate strictly needed
            const allocated = { ...p, assigned: {} };

            // Mandatory 1 core services
            ['trash_combo', 'ar_combo', 'udp'].forEach(k => {
                if (remaining > 0) { allocated.assigned[k] = 1; remaining--; }
            });

            // Gateways (High Prio)
            const gwGiven = Math.min(p.gateway, remaining);
            allocated.assigned.gateway = gwGiven;
            remaining -= gwGiven;

            // Robots (Fill remaining)
            const robGiven = Math.min(p.robot, remaining);
            allocated.assigned.robot = robGiven;
            remaining -= robGiven;

            return allocated;
        });
    },

    optimizeTopology(allocations, snapshot, osCores, totalIrqNeeded) {
        const topology = this.analyzeTopology(snapshot);
        const netNumas = topology.networkNumas; // Array of NUMA IDs

        // Prepare grid
        const coreMap = {}; // coreId -> { service, instance }
        const freeCores = new Set(snapshot.topology.map(c => c.id));

        // 1. Assign OS (Critical)
        osCores.forEach(c => {
            coreMap[c] = { service: 'os', instance: 'SYSTEM' };
            freeCores.delete(c);
        });

        // 2. Assign Services for each instance with Placement Logic
        // We want to maximize Total Score.
        // Strategies:
        // - Place Network-Critical services on Network NUMA first.
        // - Place High-Score services on Network NUMA next.

        // Flatten all service requests into a list of "Tasks" with affinity
        const tasks = [];

        // Global IRQ Tasks (associated with instances roughly)
        // We need to place IRQs. Logic: "1 IRQ per 4 Gateways".
        // Ideally distribute IRQs based on where Gateways are, OR place on Network NUMA.
        // Requirement: "IRQ - on network node".
        // We will create IRQ tasks and assign them to Network NUMA.
        for (let i = 0; i < totalIrqNeeded; i++) {
            tasks.push({
                type: 'irq', instance: 'SYSTEM',
                mustBeNet: true, priority: 1000
            });
        }

        allocations.forEach(alloc => {
            // Mandatory Network
            tasks.push({ type: 'udp', instance: alloc.instanceId, mustBeNet: true, priority: 1000 });
            tasks.push({ type: 'trash_combo', instance: alloc.instanceId, mustBeNet: true, priority: 1000 });

            // High Value
            for(let i=0; i<alloc.assigned.gateway; i++)
                tasks.push({ type: 'gateway', instance: alloc.instanceId, netBonus: 500, priority: 500 });

            for(let i=0; i<alloc.assigned.ar_combo; i++)
                tasks.push({ type: 'ar_combo', instance: alloc.instanceId, netBonus: 200, priority: 200 });

            // Standard
            for(let i=0; i<alloc.assigned.robot; i++)
                tasks.push({ type: 'robot', instance: alloc.instanceId, netBonus: 100, priority: 100 });
        });

        // Sort tasks by priority
        tasks.sort((a, b) => b.priority - a.priority);

        // Placement Solver
        // Iterate tasks and find best slot
        const placementResult = [];
        let globalScore = 0;

        // Helper: Get best available core
        const getBestCore = (task) => {
            const instanceNetNuma = this.getInstanceNetNuma(task.instance, topology);

            // Candidates: All free cores
            const candidates = Array.from(freeCores).map(id => {
                const coreInfo = snapshot.topology.find(c => c.id === id);
                return { id, ...coreInfo };
            });

            if (candidates.length === 0) return null;

            // Score each candidate
            const scored = candidates.map(c => {
                let score = 0;
                const isNet = c.numaNodeId === instanceNetNuma;

                // Hard Constraints
                if (task.mustBeNet && !isNet) score = -10000;
                else if (task.mustBeNet && isNet) score = 1000;

                // Bonuses
                if (task.netBonus && isNet) score += task.netBonus;

                // L3 Affinity (Hot/Cold) separation preference
                // Simple heuristic: If core is in "Service L3", favor Trash/IRQ/UDP.
                // If "Hot L3", favor Gateway/Robot.
                // We need to dynamically track L3 usage. For now, simple Net affinity is dominant.

                return { core: c, score };
            });

            // Sort by score desc, then by core ID (keep compact)
            scored.sort((a, b) => b.score - a.score || a.core.id - b.core.id);

            // If strictly needed on Net but best score is low (no net cores left),
            // we have a problem. But we take best available.
            return scored[0];
        };

        tasks.forEach(task => {
            const match = getBestCore(task);
            if (match) {
                freeCores.delete(match.core.id);
                placementResult.push({
                    core: match.core.id,
                    service: task.type,
                    instance: task.instance,
                    score: match.score > -5000 ? match.score : 0 // Don't count penalties in display score
                });
                if (match.score > -5000) globalScore += match.score;
            }
        });

        // Add OS to result
        osCores.forEach(c => {
            placementResult.push({ core: c, service: 'os', instance: 'SYSTEM', score: 1000 });
            globalScore += 1000;
        });

        return this.formatResult(placementResult, globalScore, topology, allocations);
    },

    getInstanceNetNuma(instanceId, topology) {
        // Logic to find which NUMA is "Network" for this instance
        // Uses instanceToInterface map or defaults to first network node
        if (instanceId === 'SYSTEM') return topology.networkNumas[0];

        const iface = topology.instanceToInterface[instanceId];
        if (iface && topology.interfaceNumaMap[iface] !== undefined) {
            return parseInt(topology.interfaceNumaMap[iface]);
        }
        return topology.networkNumas[0];
    },

    formatResult(placements, totalScore, topology, allocations) {
        // Group by instance
        const instMap = {};
        let irqCount = 0;

        placements.forEach(p => {
            if (p.service === 'irq') irqCount++;

            // Include SYSTEM instance so we can visualize OS and IRQ assignments
            if (!instMap[p.instance]) instMap[p.instance] = {
                instanceId: p.instance,
                totalScore: 0,
                coreAssignments: [],
                allocatedCores: 0,
                // Needs from allocation plan
                ...allocations.find(a => a.instanceId === p.instance)?.assigned
            };

            const inst = instMap[p.instance];
            inst.totalScore += p.score;
            inst.allocatedCores++;

            // Group by service for display
            // Map internal types to display names/roles
            let role = 'sys_os';
            if (p.service === 'gateway') role = 'gateway';
            if (p.service === 'robot') role = 'robot_default';
            if (p.service === 'trash_combo') role = 'trash'; // Will need to split visually or just assign trash
            if (p.service === 'ar_combo') role = 'ar';
            if (p.service === 'udp') role = 'udp';

            // Special handling for combos: we assigned 1 core for combo,
            // but in UI we might want to show multiple roles or just the primary one.
            // For BENDER config generation, we need to know this core does multiple things.

            // Add to assignments (grouping by service type)
            let group = inst.coreAssignments.find(g => g.service === p.service);
            if (!group) {
                group = { service: p.service, cores: [] };
                inst.coreAssignments.push(group);
            }
            group.cores.push(p.core);
        });

        // Calculate "Points" breakdown for UI
        const instances = Object.values(instMap).map(inst => {
            // Add placement breakdown
            const breakdown = {};
            inst.coreAssignments.forEach(g => {
                g.cores.forEach(c => {
                    const coreInfo = topology.coreInfo[c];
                    const numa = coreInfo.numaNodeId;
                    if (!breakdown[numa]) breakdown[numa] = { numaId: numa, services: [], totalScore: 0, isNetwork: topology.networkNumas.includes(numa) };
                    breakdown[numa].services.push(g.service);
                    // Re-calculate score for display if needed, or assume p.score
                });
            });

            return {
                ...inst,
                numaPlacement: { breakdown, totalScore: inst.totalScore }
            };
        });

        return {
            totalScore,
            irqCoresCount: irqCount,
            instances
        };
    },

    analyzeTopology(snapshot) {
        // Reuse existing logic but ensure we have quick lookups
        const coreInfo = {};
        snapshot.topology.forEach(c => coreInfo[c.id] = c);

        return {
            networkNumas: snapshot.network.map(n => n.numaNode),
            instanceToInterface: snapshot.instanceToInterface || {},
            interfaceNumaMap: snapshot.interfaceNumaMap || {},
            coreInfo
        };
    },

    mapServiceType(name) {
        if (!name) return 'other';
        const l = name.toLowerCase();
        if (l.includes('gateway')) return 'gateway';
        if (l.includes('robot')) return 'robot';
        if (l.includes('trash')) return 'trash';
        if (l.includes('udp')) return 'udp';
        if (l.includes('ar')) return 'ar';
        if (l.includes('rf')) return 'rf';
        if (l.includes('formula')) return 'formula';
        if (l.includes('click')) return 'click';
        return 'other';
    },

    generateRecommendations(instances, snapshot) {
        // Generate text advice based on changes
        const recs = [];
        instances.forEach(inst => {
           // Simple change detection logic could go here
        });
        return recs;
    }
};

if (typeof window !== 'undefined') window.CPU_OPTIMIZER = CPU_OPTIMIZER;
if (typeof module !== 'undefined') module.exports = CPU_OPTIMIZER;

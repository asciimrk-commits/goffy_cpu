/**
 * HFT CPU Optimizer - Capacity Planning Engine
 * 
 * Логика автоматической оптимизации распределения ядер между сервисами
 * на основе текущей нагрузки, топологии NUMA/L3 и правил распределения
 */

const CPU_OPTIMIZER = {
    // Система очков для NUMA placement
    NUMA_SCORES: {
        // Иначе быть не может (+1000)
        CRITICAL: {
            os_on_node0: 1000,
            irq_on_network: 1000
        },
        // Супер правильно (+100)
        EXCELLENT: {
            trash_rf_click_on_network: 100,
            gateway_on_network: 100,
            udp_on_network: 100,
            ar_formula_on_network: 100
        },
        // Сойдет (промежуточные баллы)
        ACCEPTABLE: {
            robots_same_l3_with_gateways: 25,
            gateway_not_on_network: 10,
            trash_click_not_on_network: 10
        }
    },

    // Целевые диапазоны нагрузки для каждого типа сервиса
    TARGET_LOADS: {
        os: { min: 0, max: 30, target: 20 },
        irq: { min: 0, max: 20, target: 10 },
        gateway: { min: 15, max: 30, target: 20 },
        robot: { min: 30, max: 50, target: 40 },
        trash: { min: 0, max: 80, target: 60 },
        udp: { min: 0, max: 80, target: 60 },
        ar: { min: 0, max: 80, target: 60 },
        rf: { min: 0, max: 80, target: 60 },
        formula: { min: 0, max: 80, target: 60 },
        click: { min: 0, max: 80, target: 60 }
    },

    // Минимальная конфигурация (6 ядер)
    MIN_CONFIG: {
        os: 1,
        gateway: 1,
        robot: 1,
        trash_click_rf: 1,  // Комбо
        ar_formula: 1,      // Комбо
        udp: 1,
        irq: 0  // Рассчитывается динамически
    },

    /**
     * Главная функция оптимизации
     * @param {Object} snapshot - Текущий snapshot сервера
     * @returns {Object} Оптимизированная конфигурация
     */
    optimize(snapshot) {
        const totalCores = snapshot.topology.length;
        const instances = this.extractInstances(snapshot);

        console.log('[Optimizer] Starting optimization', {
            totalCores,
            instances: instances.map(i => i.id)
        });

        // 1. Рассчитать OS ядра (10% от общего количества, минимум 1)
        const osCores = Math.max(1, Math.ceil(totalCores * 0.1));

        // 2. Для каждого инстанса рассчитать необходимые ядра
        const instancePlans = instances.map(inst =>
            this.calculateInstanceNeeds(inst, snapshot)
        );

        // 3. Рассчитать общее количество IRQ ядер на основе гейтов
        const totalGatewayNeeds = instancePlans.reduce((sum, plan) => sum + plan.gateway, 0);
        const irqCores = this.calculateIrqCores(totalGatewayNeeds);

        // 4. Рассчитать доступные ядра для инстансов
        const availableForInstances = totalCores - osCores - irqCores;

        console.log('[Optimizer] Resource allocation', {
            totalCores,
            osCores,
            irqCores,
            availableForInstances
        });

        // 5. Распределить ядра между инстансами
        const allocations = this.allocateCoresBetweenInstances(
            instancePlans,
            availableForInstances,
            snapshot
        );

        // 6. Оптимизация по топологии (NUMA, L3)
        const topologyOptimized = this.optimizeByTopology(
            allocations,
            snapshot,
            osCores,
            irqCores
        );

        return {
            totalCores,
            osCores,
            irqCores,
            instances: topologyOptimized,
            recommendations: this.generateRecommendations(topologyOptimized, snapshot)
        };
    },

    /**
     * Извлечь инстансы из snapshot
     */
    extractInstances(snapshot) {
        const instanceMap = new Map();

        snapshot.topology.forEach(core => {
            core.services.forEach(service => {
                if (service.instanceId === 'SYSTEM') return;

                if (!instanceMap.has(service.instanceId)) {
                    instanceMap.set(service.instanceId, {
                        id: service.instanceId,
                        services: [],
                        cores: new Set()
                    });
                }

                const inst = instanceMap.get(service.instanceId);
                inst.services.push(service);
                inst.cores.add(core.id);
            });
        });

        return Array.from(instanceMap.values());
    },

    /**
     * Рассчитать необходимость в ядрах для одного инстанса
     */
    calculateInstanceNeeds(instance, snapshot) {
        const serviceLoads = this.aggregateServiceLoads(instance, snapshot);

        const needs = {
            instanceId: instance.id,
            gateway: 0,
            robot: 0,
            trash: 1,    // Всегда 1
            udp: 1,      // Всегда 1
            ar: 1,       // Всегда 1
            rf: 1,       // Всегда 1
            formula: 1,  // Всегда 1
            click: 1,    // Всегда 1
            currentLoads: serviceLoads
        };

        // Рассчитать необходимые ядра для гейтов
        if (serviceLoads.gateway) {
            const avgLoad = serviceLoads.gateway.avgLoad;
            const currentCores = serviceLoads.gateway.cores;

            if (avgLoad < this.TARGET_LOADS.gateway.min) {
                // Слишком мало нагрузки - уменьшить
                needs.gateway = Math.max(1, Math.floor(currentCores * 0.7));
            } else if (avgLoad > this.TARGET_LOADS.gateway.max) {
                // Слишком много нагрузки - увеличить
                const targetCores = Math.ceil(currentCores * (avgLoad / this.TARGET_LOADS.gateway.target));
                needs.gateway = targetCores;
            } else {
                // Нормально
                needs.gateway = currentCores;
            }
        } else {
            needs.gateway = 1; // Минимум
        }

        // Рассчитать необходимые ядра для роботов
        if (serviceLoads.robot) {
            const avgLoad = serviceLoads.robot.avgLoad;
            const currentCores = serviceLoads.robot.cores;

            if (avgLoad >= 60 && avgLoad <= 70) {
                // Критическая зона - нужно снизить до 30-50%
                const targetCores = Math.ceil(currentCores * (avgLoad / this.TARGET_LOADS.robot.target));
                needs.robot = targetCores;
            } else if (avgLoad > 70) {
                // Перегрузка - увеличить агрессивно
                const targetCores = Math.ceil(currentCores * 1.5);
                needs.robot = targetCores;
            } else if (avgLoad < this.TARGET_LOADS.robot.min) {
                // Недогрузка - уменьшить
                needs.robot = Math.max(1, Math.floor(currentCores * 0.8));
            } else {
                // Нормально
                needs.robot = currentCores;
            }
        } else {
            needs.robot = 1; // Минимум
        }

        // Проверить соотношение гейты/роботы (1 гейт на 3-4 робота)
        const robotGatewayRatio = needs.robot / needs.gateway;
        if (robotGatewayRatio > 4) {
            // Нужно больше гейтов
            needs.gateway = Math.ceil(needs.robot / 3.5);
        }

        needs.total = needs.gateway + needs.robot + needs.trash + needs.udp +
            needs.ar + needs.rf + needs.formula + needs.click;

        // Минимум - 6 ядер (без учета OS и IRQ)
        needs.total = Math.max(6, needs.total);

        return needs;
    },

    /**
     * Агрегировать нагрузки по сервисам для инстанса
     */
    aggregateServiceLoads(instance, snapshot) {
        const loads = {};

        instance.services.forEach(service => {
            const serviceType = this.mapServiceToType(service.name);
            if (!serviceType) return;

            if (!loads[serviceType]) {
                loads[serviceType] = {
                    cores: 0,
                    totalLoad: 0,
                    avgLoad: 0,
                    coreIds: []
                };
            }

            // Найти нагрузку для этого ядра
            const core = snapshot.topology.find(c =>
                service.currentCoreIds.includes(c.id)
            );

            if (core) {
                loads[serviceType].cores++;
                loads[serviceType].totalLoad += core.currentLoad || 0;
                loads[serviceType].coreIds.push(core.id);
            }
        });

        // Рассчитать средние
        Object.keys(loads).forEach(type => {
            if (loads[type].cores > 0) {
                loads[type].avgLoad = loads[type].totalLoad / loads[type].cores;
            }
        });

        return loads;
    },

    /**
     * Маппинг имени сервиса на тип
     */
    mapServiceToType(serviceName) {
        const map = {
            'Gateway': 'gateway',
            'Robot': 'robot',
            'Trash': 'trash',
            'UDP': 'udp',
            'AR': 'ar',
            'RF': 'rf',
            'Formula': 'formula',
            'ClickHouse': 'click',
            'IRQ': 'irq',
            'System': 'os'
        };
        return map[serviceName];
    },

    /**
     * Рассчитать необходимое количество IRQ ядер
     * Правило: 1 IRQ на 4 ядра гейтов
     */
    calculateIrqCores(totalGatewayCores) {
        if (totalGatewayCores <= 4) return 1;
        return Math.ceil(totalGatewayCores / 4);
    },

    /**
     * Распределить доступные ядра между инстансами
     */
    allocateCoresBetweenInstances(instancePlans, availableCores, snapshot) {
        if (instancePlans.length === 0) return [];
        if (instancePlans.length === 1) {
            // Один инстанс - дать все ядра
            return [{
                ...instancePlans[0],
                allocatedCores: availableCores
            }];
        }

        // Сортировать инстансы по приоритету (более нагруженные первыми)
        const sorted = instancePlans.sort((a, b) => {
            const loadA = this.getInstancePriority(a);
            const loadB = this.getInstancePriority(b);
            return loadB - loadA;
        });

        const allocations = [];
        let remaining = availableCores;

        // Для каждого инстанса, дать необходимые ядра
        sorted.forEach((plan, idx) => {
            const isLast = idx === sorted.length - 1;

            if (isLast) {
                // Последнему инстансу дать то что осталось
                allocations.push({
                    ...plan,
                    allocatedCores: remaining
                });
            } else {
                // Дать необходимое количество
                const needed = plan.total;
                const allocated = Math.min(needed, remaining);

                allocations.push({
                    ...plan,
                    allocatedCores: allocated
                });

                remaining -= allocated;
            }
        });

        // Проверить что малому инстансу хватает
        const smallInstance = allocations[allocations.length - 1];
        if (smallInstance.allocatedCores < 6) {
            console.warn('[Optimizer] Small instance has less than minimum (6 cores)');
            // TODO: оптимизировать IRQ чтобы освободить ядра
        }

        return allocations;
    },

    /**
     * Получить приоритет инстанса (для сортировки)
     */
    getInstancePriority(plan) {
        // Приоритет = средняя нагрузка на гейты + роботы
        let totalLoad = 0;
        let count = 0;

        if (plan.currentLoads.gateway) {
            totalLoad += plan.currentLoads.gateway.avgLoad;
            count++;
        }
        if (plan.currentLoads.robot) {
            totalLoad += plan.currentLoads.robot.avgLoad;
            count++;
        }

        return count > 0 ? totalLoad / count : 0;
    },

    /**
     * Оптимизация по топологии (NUMA, L3 Cache) с максимизацией очков
     */
    optimizeByTopology(allocations, snapshot, osCores, irqCores) {
        const topology = this.analyzeTopology(snapshot);
        topology.osCores = osCores;
        topology.irqCores = irqCores;

        console.log('[Optimizer] Topology analysis', topology);

        // Использовать scoring систему для оптимального размещения
        const scoredPlacement = this.optimizeNumaPlacementByScore(allocations, topology);

        // Объединить результаты scoring с allocations
        return allocations.map((alloc, idx) => {
            const placement = scoredPlacement.placements[idx];

            const optimized = {
                ...alloc,
                coreAssignments: placement.services,
                totalScore: placement.totalScore,
                numaPlacement: this.buildNumaPlacementSummary(placement, topology),
                l3Placement: this.partitionL3Cache(topology, alloc)
            };

            return optimized;
        });
    },

    /**
     * Построить summary размещения по NUMA на основе scoring результатов
     */
    buildNumaPlacementSummary(placement, topology) {
        const networkNumaId = topology.networkNumas[0];
        const summary = {
            totalScore: placement.totalScore,
            breakdown: {}
        };

        // Группировать сервисы по NUMA
        placement.services.forEach(svc => {
            if (!summary.breakdown[svc.numaId]) {
                summary.breakdown[svc.numaId] = {
                    numaId: svc.numaId,
                    isNetwork: svc.numaId === networkNumaId,
                    services: [],
                    totalScore: 0
                };
            }

            summary.breakdown[svc.numaId].services.push(svc.service);
            summary.breakdown[svc.numaId].totalScore += svc.score;
        });

        return summary;
    },

    /**
     * Анализ топологии (NUMA, L3, сокеты)
     */
    analyzeTopology(snapshot) {
        const sockets = new Map();
        const numas = new Map();
        const l3Caches = new Map();
        const networkNumas = new Set(snapshot.network.map(iface => iface.numaNode));

        snapshot.topology.forEach(core => {
            // Сокеты
            if (!sockets.has(core.socketId)) {
                sockets.set(core.socketId, {
                    id: core.socketId,
                    numas: new Set(),
                    cores: []
                });
            }
            sockets.get(core.socketId).numas.add(core.numaNodeId);
            sockets.get(core.socketId).cores.push(core.id);

            // NUMA
            if (!numas.has(core.numaNodeId)) {
                numas.set(core.numaNodeId, {
                    id: core.numaNodeId,
                    cores: [],
                    l3Caches: new Set()
                });
            }
            numas.get(core.numaNodeId).cores.push(core.id);
            numas.get(core.numaNodeId).l3Caches.add(core.l3CacheId);

            // L3 Cache
            const l3Key = `${core.socketId}_${core.numaNodeId}_${core.l3CacheId}`;
            if (!l3Caches.has(l3Key)) {
                l3Caches.set(l3Key, {
                    socketId: core.socketId,
                    numaId: core.numaNodeId,
                    l3Id: core.l3CacheId,
                    cores: []
                });
            }
            l3Caches.get(l3Key).cores.push(core.id);
        });

        return {
            sockets: Array.from(sockets.values()).map(s => ({
                ...s,
                numas: Array.from(s.numas)
            })),
            numas: Array.from(numas.values()).map(n => ({
                ...n,
                l3Caches: Array.from(n.l3Caches)
            })),
            l3Caches: Array.from(l3Caches.values()),
            networkNumas: Array.from(networkNumas),
            // Для мульти-интерфейс серверов
            instanceToInterface: snapshot.instanceToInterface || {},
            interfaceNumaMap: snapshot.interfaceNumaMap || {}
        };
    },

    /**
     * Рассчитать очки за размещение на NUMA
     * @param {Object} placement - Размещение {service, numaId, networkNumaId, l3Id, instanceId}
     * @param {Object} topology - Топология сервера  
     * @returns {number} Количество очков
     */
    calculateNumaScore(placement, topology) {
        const { service, numaId, l3Id, gatewayL3Id, instanceId } = placement;

        // Определить network NUMA для этого инстанса
        let networkNumaId = topology.networkNumas[0]; // Default

        // Если есть маппинг инстанс -> интерфейс -> NUMA, использовать его
        if (instanceId && topology.instanceToInterface && topology.interfaceNumaMap) {
            const ifName = topology.instanceToInterface[instanceId];
            if (ifName && topology.interfaceNumaMap[ifName]) {
                networkNumaId = parseInt(topology.interfaceNumaMap[ifName]);
            }
        }

        let score = 0;

        // CRITICAL (+1000) - Иначе быть не может
        if (service === 'os' && numaId === 0) {
            score += this.NUMA_SCORES.CRITICAL.os_on_node0;
        }
        if (service === 'irq' && numaId === networkNumaId) {
            score += this.NUMA_SCORES.CRITICAL.irq_on_network;
        }

        // EXCELLENT (+100) - Супер правильно
        if ((service === 'trash' || service === 'rf' || service === 'click') && numaId === networkNumaId) {
            score += this.NUMA_SCORES.EXCELLENT.trash_rf_click_on_network;
        }
        if (service === 'gateway' && numaId === networkNumaId) {
            score += this.NUMA_SCORES.EXCELLENT.gateway_on_network;
        }
        if (service === 'udp' && numaId === networkNumaId) {
            score += this.NUMA_SCORES.EXCELLENT.udp_on_network;
        }
        if ((service === 'ar' || service === 'formula') && numaId === networkNumaId) {
            score += this.NUMA_SCORES.EXCELLENT.ar_formula_on_network;
        }

        // ACCEPTABLE - Сойдет
        if (service === 'robot' && l3Id === gatewayL3Id && l3Id !== undefined) {
            score += this.NUMA_SCORES.ACCEPTABLE.robots_same_l3_with_gateways;
        }
        if (service === 'gateway' && numaId !== networkNumaId) {
            score += this.NUMA_SCORES.ACCEPTABLE.gateway_not_on_network;
        }
        if ((service === 'trash' || service === 'click') && numaId !== networkNumaId) {
            score += this.NUMA_SCORES.ACCEPTABLE.trash_click_not_on_network;
        }

        return score;
    },

    /**
     * Оптимизация размещения с максимизацией общих очков
     * @param {Array} allocations - Размещения инстансов
     * @param {Object} topology - Топология сервера
     * @returns {Object} Оптимизированное размещение
     */
    optimizeNumaPlacementByScore(allocations, topology) {
        const networkNumaId = topology.networkNumas[0];

        // Получить доступные NUMA и L3 зоны
        const numaZones = topology.numas.map(n => ({
            id: n.id,
            cores: n.cores,
            l3Caches: n.l3Caches,
            availableCores: [...n.cores]
        }));

        const l3Zones = topology.l3Caches.map(l3 => ({
            ...l3,
            availableCores: [...l3.cores]
        }));

        // Для каждого инстанса создать placement plan
        const placements = allocations.map(alloc => ({
            instanceId: alloc.instanceId,
            services: [],
            totalScore: 0
        }));

        // Приоритет размещения (сначала критические, потом excellent, потом остальные)
        const serviceOrder = [
            // CRITICAL (должны быть размещены правильно)
            { service: 'os', count: 'osCores', priority: 1000 },
            { service: 'irq', count: 'irqCores', priority: 1000 },
            // EXCELLENT (желательно на network NUMA)
            { service: 'gateway', count: 'gateway', priority: 100 },
            { service: 'trash', count: 'trash', priority: 100 },
            { service: 'udp', count: 'udp', priority: 100 },
            { service: 'ar', count: 'ar', priority: 100 },
            { service: 'rf', count: 'rf', priority: 100 },
            { service: 'formula', count: 'formula', priority: 100 },
            { service: 'click', count: 'click', priority: 100 },
            // ACCEPTABLE (могут быть где угодно)
            { service: 'robot', count: 'robot', priority: 25 }
        ];

        // Разместить сервисы с максимизацией очков
        serviceOrder.forEach(({ service, count, priority }) => {
            allocations.forEach((alloc, allocIdx) => {
                const coresNeeded = service === 'os' || service === 'irq'
                    ? (service === 'os' ? topology.osCores : topology.irqCores)
                    : alloc[count] || 0;

                if (coresNeeded === 0) return;

                // Найти лучшее размещение для этого сервиса
                let bestPlacement = null;
                let bestScore = -Infinity;

                numaZones.forEach(numa => {
                    if (numa.availableCores.length < coresNeeded) return;

                    // Рассчитать score для этого размещения
                    const score = this.calculateNumaScore({
                        service,
                        numaId: numa.id,
                        l3Id: numa.l3Caches[0], // Упрощение: берём первый L3
                        gatewayL3Id: this.findGatewayL3(placements[allocIdx], l3Zones),
                        instanceId: alloc.instanceId
                    }, topology);

                    if (score > bestScore) {
                        bestScore = score;
                        bestPlacement = {
                            numaId: numa.id,
                            l3Id: numa.l3Caches[0],
                            cores: numa.availableCores.slice(0, coresNeeded)
                        };
                    }
                });

                // Применить лучшее размещение
                if (bestPlacement) {
                    placements[allocIdx].services.push({
                        service,
                        numaId: bestPlacement.numaId,
                        l3Id: bestPlacement.l3Id,
                        cores: bestPlacement.cores,
                        score: bestScore
                    });

                    placements[allocIdx].totalScore += bestScore;

                    // Убрать использованные ядра из доступных
                    const numa = numaZones.find(n => n.id === bestPlacement.numaId);
                    numa.availableCores = numa.availableCores.filter(
                        c => !bestPlacement.cores.includes(c)
                    );
                }
            });
        });

        // Рассчитать общий счёт
        const totalScore = placements.reduce((sum, p) => sum + p.totalScore, 0);

        console.log('[Optimizer] NUMA placement scores:', {
            placements: placements.map(p => ({
                instance: p.instanceId,
                score: p.totalScore
            })),
            totalScore
        });

        return {
            placements,
            totalScore
        };
    },

    /**
     * Найти L3 где размещены гейты инстанса
     */
    findGatewayL3(placement, l3Zones) {
        const gatewayService = placement.services.find(s => s.service === 'gateway');
        return gatewayService ? gatewayService.l3Id : undefined;
    },

    /**
     * Разделение L3 кэша на пулы
     * 
     * Стратегия:
     * - Сервисный L3: Trash, UDP, IRQ, AR+RF, Gateways Tier A
     * - Рабочий L3: Gateways SSS+, Robots
     */
    partitionL3Cache(topology, allocation) {
        const l3Pools = {
            service: {
                name: 'Сервисный L3',
                services: ['trash', 'click', 'rf', 'udp', 'irq', 'ar', 'formula'],
                l3Caches: [],
                reason: 'Холодные данные + сервисные задачи'
            },
            hot: {
                name: 'Рабочий L3',
                services: ['gateway', 'robot'],
                l3Caches: [],
                reason: 'Горячие данные - максимальная производительность'
            }
        };

        // Если L3 кэшей >= 2, разделить
        if (topology.l3Caches.length >= 2) {
            const sortedL3 = topology.l3Caches.sort((a, b) => a.cores.length - b.cores.length);

            // Первый (меньший) L3 - сервисный
            l3Pools.service.l3Caches.push(sortedL3[0]);

            // Остальные - рабочие
            l3Pools.hot.l3Caches.push(...sortedL3.slice(1));
        } else {
            // Один L3 - все в него
            l3Pools.hot.l3Caches.push(...topology.l3Caches);
        }

        return l3Pools;
    },

    /**
     * Генерация рекомендаций
     */
    generateRecommendations(optimizedAllocations, snapshot) {
        const recommendations = [];

        // Для каждого инстанса
        optimizedAllocations.forEach(alloc => {
            const inst = {
                instanceId: alloc.instanceId,
                changes: [],
                warnings: [],
                priorities: []
            };

            // Проверить гейты
            if (alloc.currentLoads.gateway) {
                const current = alloc.currentLoads.gateway.cores;
                const proposed = alloc.gateway;

                if (proposed > current) {
                    inst.changes.push({
                        type: 'increase',
                        service: 'Gateway',
                        from: current,
                        to: proposed,
                        reason: `Текущая нагрузка ${alloc.currentLoads.gateway.avgLoad.toFixed(1)}% требует увеличения`
                    });
                    inst.priorities.push('high');
                } else if (proposed < current) {
                    inst.changes.push({
                        type: 'decrease',
                        service: 'Gateway',
                        from: current,
                        to: proposed,
                        reason: `Недогрузка ${alloc.currentLoads.gateway.avgLoad.toFixed(1)}% - можно освободить ядра`
                    });
                    inst.priorities.push('medium');
                }
            }

            // Проверить роботов
            if (alloc.currentLoads.robot) {
                const current = alloc.currentLoads.robot.cores;
                const proposed = alloc.robot;

                if (proposed > current) {
                    inst.changes.push({
                        type: 'increase',
                        service: 'Robot',
                        from: current,
                        to: proposed,
                        reason: `Нагрузка ${alloc.currentLoads.robot.avgLoad.toFixed(1)}% в критической зоне - нужно снизить до 30-50%`
                    });
                    inst.priorities.push('critical');
                } else if (proposed < current) {
                    inst.changes.push({
                        type: 'decrease',
                        service: 'Robot',
                        from: current,
                        to: proposed,
                        reason: `Недогрузка ${alloc.currentLoads.robot.avgLoad.toFixed(1)}%`
                    });
                    inst.priorities.push('low');
                }
            }

            // NUMA recommendations
            if (alloc.numaPlacement.tier1) {
                inst.changes.push({
                    type: 'numa_placement',
                    service: 'Gateway + IRQ',
                    numa: alloc.numaPlacement.tier1.numaId,
                    reason: alloc.numaPlacement.tier1.reason,
                    priority: 'high'
                });
            }

            // L3 recommendations
            if (alloc.l3Placement.service) {
                inst.changes.push({
                    type: 'l3_cache',
                    pool: 'service',
                    services: alloc.l3Placement.service.services,
                    reason: alloc.l3Placement.service.reason
                });
            }

            if (inst.changes.length > 0) {
                recommendations.push(inst);
            }
        });

        return recommendations;
    }
};

// Export for use in main app
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CPU_OPTIMIZER;
} else {
    // Browser export
    window.CPUOptimizer = CPU_OPTIMIZER;
}

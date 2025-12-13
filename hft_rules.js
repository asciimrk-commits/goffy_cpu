/**
 * HFT CPU Mapper - Optimization Rules Engine v4.0
 * 
 * BenderServer-specific placement rules based on internal documentation.
 * This module provides offline AI-like recommendations for CPU topology optimization.
 * 
 * === CORE PRINCIPLES ===
 * 1. Minimize cross-NUMA access
 * 2. Maximize L3 cache locality for critical paths
 * 3. Reduce jitter through proper isolation
 * 
 * === PLACEMENT HIERARCHY ===
 * Network Node (closest to NIC):
 *   - IRQ handlers (mandatory)
 *   - Gateways (SSS+ tier on clean L3)
 *   - Trash (must be on network node)
 *   - UDP (if traffic > 10k pps)
 * 
 * Logic Node (dedicated L3):
 *   - Diamond tier robots
 *   - AR (AllRobots)
 *   - RF (can share with AR or Trash)
 *   - Formula (5-7% needs dedicated, usually on AR)
 * 
 * OS Node (core 0, hyperthreads):
 *   - System processes
 *   - Housekeeping
 */

const HFT_RULES = {
    // Version for compatibility
    version: '4.0',
    
    // === ROLE CATEGORIES ===
    categories: {
        system: {
            name: 'System',
            description: 'OS and housekeeping tasks',
            roles: ['sys_os'],
            numaPreference: 'any', // Usually core 0 and its hyperthread
            l3Preference: 'dirty' // Can share with other non-critical
        },
        network: {
            name: 'Network Stack',
            description: 'IRQ handlers, UDP processing, Trash',
            roles: ['net_irq', 'udp', 'trash'],
            numaPreference: 'network', // Must be on network-attached NUMA
            l3Preference: 'dirty' // Shared L3 acceptable
        },
        gateway: {
            name: 'Gateways',
            description: 'Market data gateways - most latency sensitive',
            roles: ['gateway'],
            numaPreference: 'network', // Close to NIC
            l3Preference: 'clean' // Prefer clean L3 for SSS+ tier
        },
        logic: {
            name: 'Trading Logic',
            description: 'Robots, AR, RF, Formula, ClickHouse',
            roles: ['robot', 'pool1', 'pool2', 'ar', 'rf', 'formula', 'click'],
            numaPreference: 'any',
            l3Preference: 'clean' // Diamond robots need clean L3
        }
    },
    
    // === ROLE DEFINITIONS ===
    roles: {
        sys_os: {
            id: 'sys_os',
            name: 'System (OS)',
            category: 'system',
            color: '#5c6b7a',
            priority: 100,
            placement: {
                preferredCores: [0], // Core 0 and hyperthread
                avoidSharing: [],
                canShareWith: ['click', 'rf'],
                minCores: 1,
                maxCores: 5,
                loadTarget: 0.2 // Target ~20% utilization
            },
            description: 'OS housekeeping. Scale based on load average.'
        },
        
        net_irq: {
            id: 'net_irq',
            name: 'IRQ (Network)',
            category: 'network',
            color: '#e63946',
            priority: 95,
            placement: {
                numaRequirement: 'network', // MUST be on network NUMA
                avoidSharing: ['robot', 'gateway'], // Never share with latency-critical
                canShareWith: ['trash', 'udp'],
                minCores: 1,
                maxCores: 4,
                scalingRule: 'per-queue' // Scale with NIC queues
            },
            description: 'Network interrupt handlers. Must be on network NUMA node.'
        },
        
        udp: {
            id: 'udp',
            name: 'UDP Handler',
            category: 'network',
            color: '#f4a261',
            priority: 70,
            placement: {
                numaRequirement: 'network',
                avoidSharing: ['robot', 'gateway'],
                canShareWith: ['trash', 'net_irq'],
                minCores: 0, // Not always needed
                maxCores: 2,
                scalingRule: 'traffic' // Dedicated if >10k pps
            },
            description: 'UDP processing. Dedicated core if traffic > 10k pps.'
        },
        
        trash: {
            id: 'trash',
            name: 'Trash',
            category: 'network',
            color: '#8b6914',
            priority: 20,
            placement: {
                numaRequirement: 'network', // MUST be on network node
                avoidSharing: ['ar'], // Never on AR core
                canShareWith: ['rf', 'click', 'udp'],
                minCores: 1,
                maxCores: 1
            },
            description: 'Background tasks. Must be on network node. Never share with AR.'
        },
        
        gateway: {
            id: 'gateway',
            name: 'Gateway',
            category: 'gateway',
            color: '#ffd60a',
            priority: 90,
            placement: {
                numaRequirement: 'network', // Close to NIC
                l3Requirement: 'clean', // SSS+ tier needs clean L3
                avoidSharing: ['trash', 'net_irq', 'udp', 'sys_os'],
                canShareWith: [], // Dedicated cores preferred
                minCores: 3,
                maxCores: 16,
                loadTarget: 0.2 // Target ~20% per core
            },
            description: 'Market data gateways. SSS+ tier on clean L3 cache.'
        },
        
        robot: {
            id: 'robot',
            name: 'Robot',
            category: 'logic',
            color: '#2ec4b6',
            priority: 85,
            placement: {
                l3Requirement: 'clean', // Diamond tier on clean L3
                avoidSharing: ['trash', 'net_irq', 'udp'],
                canShareWith: [], // Dedicated cores
                minCores: 1,
                maxCores: 32,
                loadTarget: 0.2
            },
            description: 'Trading robots. Diamond tier needs clean L3 with gateways.'
        },
        
        pool1: {
            id: 'pool1',
            name: 'Robot Pool 1',
            category: 'logic',
            color: '#3b82f6',
            priority: 80,
            placement: {
                avoidSharing: ['trash', 'net_irq'],
                canShareWith: ['pool2'],
                tier: 'gold'
            },
            description: 'Gold/Silver tier robots. Can be on-socket cross-NUMA.'
        },
        
        pool2: {
            id: 'pool2',
            name: 'Robot Pool 2',
            category: 'logic',
            color: '#6366f1',
            priority: 75,
            placement: {
                avoidSharing: ['trash', 'net_irq'],
                canShareWith: ['pool1'],
                tier: 'silver'
            },
            description: 'Silver tier robots. Cross-socket acceptable.'
        },
        
        ar: {
            id: 'ar',
            name: 'AllRobots',
            category: 'logic',
            color: '#a855f7',
            priority: 60,
            placement: {
                avoidSharing: ['trash'], // NEVER with Trash
                canShareWith: ['rf', 'formula'],
                minCores: 1,
                maxCores: 2
            },
            description: 'AllRobots thread. Can share with RF and Formula. Never with Trash.'
        },
        
        rf: {
            id: 'rf',
            name: 'RemoteFormula',
            category: 'logic',
            color: '#22d3ee',
            priority: 50,
            placement: {
                avoidSharing: [],
                canShareWith: ['ar', 'trash', 'click'], // Flexible placement
                minCores: 1,
                maxCores: 1
            },
            description: 'RemoteFormula. Can be on AR, Trash, or ClickHouse core.'
        },
        
        formula: {
            id: 'formula',
            name: 'Formula',
            category: 'logic',
            color: '#94a3b8',
            priority: 30,
            placement: {
                avoidSharing: [],
                canShareWith: ['ar'],
                dedicatedChance: 0.07 // 5-7% need dedicated core
            },
            description: 'Formula calculations. Usually on AR, rarely needs dedicated.'
        },
        
        click: {
            id: 'click',
            name: 'ClickHouse',
            category: 'logic',
            color: '#4f46e5',
            priority: 40,
            placement: {
                avoidSharing: [],
                canShareWith: ['rf', 'trash', 'sys_os'], // Not cache-critical
                minCores: 1,
                maxCores: 4
            },
            description: 'ClickHouse cores. Not latency critical, L3 flush tolerant.'
        },
        
        isolated: {
            id: 'isolated',
            name: 'Isolated',
            category: 'state',
            color: '#ffffff',
            priority: 1,
            isStateFlag: true,
            description: 'Kernel isolation flag (isolcpus). Visual indicator only.'
        }
    },
    
    // === OPTIMIZATION RULES ===
    rules: [
        {
            id: 'network-numa-irq',
            severity: 'error',
            check: (state) => {
                const issues = [];
                const netNumas = state.netNumaNodes;
                
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('net_irq')) {
                        const numa = state.coreNumaMap[cpu];
                        if (!netNumas.has(numa)) {
                            issues.push({
                                cpu,
                                message: `IRQ on CPU ${cpu} is not on network NUMA (is on NUMA ${numa}, network is ${[...netNumas].join(',')})`
                            });
                        }
                    }
                });
                
                return issues;
            },
            fix: 'Move IRQ handlers to cores on the network NUMA node'
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
                            issues.push({
                                cpu,
                                message: `Trash on CPU ${cpu} must be on network NUMA node`
                            });
                        }
                    }
                });
                
                return issues;
            },
            fix: 'Move Trash to a core on the network NUMA node'
        },
        
        {
            id: 'ar-trash-conflict',
            severity: 'error',
            check: (state) => {
                const issues = [];
                
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('ar') && tags.has('trash')) {
                        issues.push({
                            cpu,
                            message: `CPU ${cpu} has both AR and Trash - these cannot share a core`
                        });
                    }
                });
                
                return issues;
            },
            fix: 'Separate AR and Trash onto different cores'
        },
        
        {
            id: 'gateway-l3-isolation',
            severity: 'warning',
            check: (state) => {
                const issues = [];
                const gatewayCores = new Set();
                const noisyCores = new Set();
                
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('gateway')) gatewayCores.add(cpu);
                    if (tags.has('trash') || tags.has('net_irq') || tags.has('udp') || tags.has('sys_os')) {
                        noisyCores.add(cpu);
                    }
                });
                
                // Check if gateways share L3 with noisy cores
                const l3Groups = state.l3Groups || {};
                Object.entries(l3Groups).forEach(([l3Id, cores]) => {
                    const hasGateway = cores.some(c => gatewayCores.has(c));
                    const hasNoisy = cores.some(c => noisyCores.has(c) && !gatewayCores.has(c));
                    
                    if (hasGateway && hasNoisy) {
                        issues.push({
                            l3: l3Id,
                            message: `L3 cache ${l3Id} has both Gateways and noisy tasks (IRQ/UDP/Trash/OS)`
                        });
                    }
                });
                
                return issues;
            },
            fix: 'Move SSS+ tier Gateways to a clean L3 cache region'
        },
        
        {
            id: 'robot-gateway-l3-sharing',
            severity: 'info',
            check: (state) => {
                const issues = [];
                const gatewayCores = new Set();
                const robotCores = new Set();
                
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('gateway')) gatewayCores.add(cpu);
                    if (tags.has('robot')) robotCores.add(cpu);
                });
                
                // Check if Diamond robots share L3 with gateways (good!)
                const l3Groups = state.l3Groups || {};
                let sharedL3Count = 0;
                
                Object.entries(l3Groups).forEach(([l3Id, cores]) => {
                    const hasGateway = cores.some(c => gatewayCores.has(c));
                    const hasRobot = cores.some(c => robotCores.has(c));
                    if (hasGateway && hasRobot) sharedL3Count++;
                });
                
                if (gatewayCores.size > 0 && robotCores.size > 0 && sharedL3Count === 0) {
                    issues.push({
                        message: 'Diamond tier Robots should share L3 cache with Gateways for best latency'
                    });
                }
                
                return issues;
            },
            fix: 'Consider placing Diamond tier robots on the same L3 as Gateways'
        },
        
        {
            id: 'os-sizing',
            severity: 'warning',
            check: (state) => {
                const issues = [];
                const osCores = [];
                
                Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                    if (tags.has('sys_os')) {
                        osCores.push(cpu);
                    }
                });
                
                // Calculate expected OS cores based on total
                const totalCores = Object.keys(state.coreNumaMap).length;
                const recommended = totalCores > 100 ? 5 : (totalCores > 50 ? 3 : 1);
                
                if (osCores.length < recommended) {
                    issues.push({
                        current: osCores.length,
                        recommended,
                        message: `Only ${osCores.length} OS cores for ${totalCores} total cores. Recommended: ${recommended}`
                    });
                }
                
                return issues;
            },
            fix: 'Add more cores to OS allocation based on system load'
        },
        
        {
            id: 'cross-numa-critical',
            severity: 'warning',
            check: (state) => {
                const issues = [];
                const netNumas = state.netNumaNodes;
                
                ['gateway'].forEach(role => {
                    Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
                        if (tags.has(role)) {
                            const numa = state.coreNumaMap[cpu];
                            // Check if it's far from network (different socket)
                            if (netNumas.size > 0 && !netNumas.has(numa)) {
                                // This is a cross-NUMA placement
                                issues.push({
                                    cpu,
                                    role,
                                    message: `${role} on CPU ${cpu} (NUMA ${numa}) is cross-NUMA from network (${[...netNumas].join(',')})`
                                });
                            }
                        }
                    });
                });
                
                return issues;
            },
            fix: 'Move latency-critical tasks closer to network NUMA'
        }
    ],
    
    /**
     * Generate optimization recommendations for current state
     */
    generateRecommendation(state) {
        const result = {
            timestamp: new Date().toISOString(),
            serverName: state.serverName,
            current: this.analyzeCurrentState(state),
            issues: this.runValidation(state),
            recommendations: [],
            proposedConfig: null,
            metrics: {
                estimatedImprovement: null,
                risks: [],
                monitoring: []
            }
        };
        
        // Generate specific recommendations
        result.recommendations = this.buildRecommendations(state, result.issues);
        
        // Build proposed configuration
        result.proposedConfig = this.buildProposedConfig(state, result.recommendations);
        
        // Estimate improvement and risks
        result.metrics = this.estimateMetrics(state, result);
        
        return result;
    },
    
    /**
     * Analyze current state
     */
    analyzeCurrentState(state) {
        const analysis = {
            totalCores: Object.keys(state.coreNumaMap).length,
            numaNodes: new Set(Object.values(state.coreNumaMap)).size,
            networkNumas: [...state.netNumaNodes],
            roleDistribution: {},
            l3Utilization: {},
            isolatedCores: [...(state.isolatedCores || [])]
        };
        
        // Count roles
        Object.entries(state.instances?.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(tag => {
                analysis.roleDistribution[tag] = (analysis.roleDistribution[tag] || 0) + 1;
            });
        });
        
        return analysis;
    },
    
    /**
     * Run all validation rules
     */
    runValidation(state) {
        const allIssues = [];
        
        this.rules.forEach(rule => {
            const issues = rule.check(state);
            issues.forEach(issue => {
                allIssues.push({
                    ruleId: rule.id,
                    severity: rule.severity,
                    ...issue,
                    fix: rule.fix
                });
            });
        });
        
        return allIssues;
    },
    
    /**
     * Build specific recommendations
     */
    buildRecommendations(state, issues) {
        const recs = [];
        const netNuma = [...state.netNumaNodes][0];
        const coresByNuma = this.groupCoresByNuma(state);
        const coresByL3 = state.l3Groups || {};
        
        // 1. Network placement
        if (netNuma !== undefined) {
            const netCores = coresByNuma[netNuma] || [];
            recs.push({
                id: 'network-placement',
                title: 'Network Stack Placement',
                description: `Place all network-dependent tasks on NUMA ${netNuma} (NIC attached)`,
                cores: netCores.slice(0, 8),
                roles: ['net_irq', 'udp', 'trash'],
                rationale: 'Minimizes DMA latency and ensures IRQ handlers are closest to NIC memory'
            });
        }
        
        // 2. Gateway placement
        const cleanL3 = this.findCleanL3(state, coresByL3);
        if (cleanL3.length > 0) {
            recs.push({
                id: 'gateway-placement',
                title: 'Gateway L3 Isolation',
                description: 'Dedicate clean L3 cache region for SSS+ tier Gateways',
                cores: cleanL3,
                roles: ['gateway'],
                rationale: 'Prevents L3 cache pollution from background tasks'
            });
        }
        
        // 3. Robot placement
        recs.push({
            id: 'robot-placement',
            title: 'Diamond Tier Robots',
            description: 'Place Diamond tier robots on same L3 as Gateways when possible',
            cores: cleanL3.length > 4 ? cleanL3.slice(-2) : [],
            roles: ['robot'],
            rationale: 'Shared L3 between gateways and robots reduces inter-process latency'
        });
        
        // 4. AR/RF/Trash separation
        recs.push({
            id: 'ar-rf-separation',
            title: 'AR and Trash Separation',
            description: 'Ensure AR and Trash are on different cores',
            roles: ['ar', 'rf', 'trash'],
            rationale: 'AR handles aggregated robot state - Trash interference causes jitter'
        });
        
        return recs;
    },
    
    /**
     * Group cores by NUMA node
     */
    groupCoresByNuma(state) {
        const groups = {};
        Object.entries(state.coreNumaMap).forEach(([cpu, numa]) => {
            if (!groups[numa]) groups[numa] = [];
            groups[numa].push(cpu);
        });
        // Sort cores numerically within each group
        Object.keys(groups).forEach(numa => {
            groups[numa].sort((a, b) => parseInt(a) - parseInt(b));
        });
        return groups;
    },
    
    /**
     * Find L3 cache groups without noisy tasks
     */
    findCleanL3(state, l3Groups) {
        const noisyTasks = ['trash', 'net_irq', 'udp', 'sys_os'];
        const cleanCores = [];
        
        Object.entries(l3Groups).forEach(([l3Id, cores]) => {
            const hasNoisy = cores.some(cpu => {
                const tags = state.instances?.Physical?.[cpu];
                return tags && noisyTasks.some(t => tags.has(t));
            });
            
            if (!hasNoisy) {
                cleanCores.push(...cores);
            }
        });
        
        return cleanCores.sort((a, b) => parseInt(a) - parseInt(b));
    },
    
    /**
     * Build proposed configuration
     */
    buildProposedConfig(state, recommendations) {
        // Clone current state
        const proposed = {
            instances: { Physical: {} }
        };
        
        // Apply recommendations
        recommendations.forEach(rec => {
            if (rec.cores && rec.roles) {
                rec.cores.forEach((cpu, idx) => {
                    const role = rec.roles[idx % rec.roles.length];
                    if (!proposed.instances.Physical[cpu]) {
                        proposed.instances.Physical[cpu] = new Set();
                    }
                    proposed.instances.Physical[cpu].add(role);
                });
            }
        });
        
        return proposed;
    },
    
    /**
     * Estimate performance metrics
     */
    estimateMetrics(state, result) {
        const errorCount = result.issues.filter(i => i.severity === 'error').length;
        const warnCount = result.issues.filter(i => i.severity === 'warning').length;
        
        return {
            estimatedImprovement: errorCount > 0 ? '20-40%' : (warnCount > 0 ? '5-15%' : '< 5%'),
            confidenceLevel: errorCount === 0 && warnCount === 0 ? 'High' : 'Medium',
            risks: [
                'Configuration change requires trading halt',
                'Initial stabilization period of 24-48 hours',
                'Monitor for unexpected latency spikes'
            ],
            monitoring: [
                'Watch P99 latency for 1-2 weeks after change',
                'Compare gateway throughput before/after',
                'Check for CPU soft lockups in dmesg',
                'Validate isolcpus kernel parameter'
            ],
            rollback: 'Keep old config JSON for immediate rollback if issues arise'
        };
    }
};

// Export for use in main app
if (typeof window !== 'undefined') {
    window.HFT_RULES = HFT_RULES;
}

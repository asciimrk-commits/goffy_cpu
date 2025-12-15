/**
 * Unit test for AutoOptimize logic
 * Tests the optimizer with trade0516 data (8 cores)
 */

// Simulate the optimizer logic from AutoOptimize.tsx
function testOptimizer() {
    // === Input data (trade0516) ===
    const geometry = {
        '0': {  // socket
            '0': {  // numa
                '0': [0, 1, 2, 3, 4, 5, 6, 7]  // L3 -> cores
            }
        }
    };
    
    const isolatedCores = [2, 3, 4, 5, 6, 7];  // cores 0,1 are OS
    const netNumaNodes = [0];
    const coreLoads = {
        0: 4.7, 1: 3.2, 2: 0.4, 3: 0.4, 
        4: 0.7, 5: 0.7, 6: 0.1, 7: 0.1
    };
    
    // Current roles from BENDER
    const currentRoles = {
        'trash': ['2'],
        'ar': ['3'],
        'udp': ['3'],
        'gateway': ['4', '5'],
        'robot_default': ['6', '7']
    };
    
    // === Optimizer Logic ===
    const netNuma = '0';
    const isolatedSet = new Set(isolatedCores.map(String));
    
    const getAvgLoad = (cores) => {
        if (!cores?.length) return 0;
        const total = cores.reduce((sum, c) => sum + (coreLoads[parseInt(c)] || 0), 0);
        return total / cores.length;
    };
    
    const byNuma = { '0': [0, 1, 2, 3, 4, 5, 6, 7] };
    const totalCores = 8;
    
    const proposed = {};
    const assignRole = (cpu, role) => {
        const cpuStr = String(cpu);
        if (!proposed[cpuStr]) proposed[cpuStr] = [];
        if (!proposed[cpuStr].includes(role)) proposed[cpuStr].push(role);
    };
    const isAssigned = (cpu) => (proposed[String(cpu)]?.length || 0) > 0;
    
    // === OS Cores ===
    // KB: OS from 0 to N CONSECUTIVE, target ~20% load
    const allCoresSorted = [0, 1, 2, 3, 4, 5, 6, 7];
    let osCores = allCoresSorted.filter(c => !isolatedSet.has(String(c)));
    
    const osLoad = getAvgLoad(currentRoles['sys_os'] || osCores.map(String));
    const osCoreCount = currentRoles['sys_os']?.length || osCores.length;
    let osNeeded;
    
    if (osLoad > 0) {
        osNeeded = Math.max(1, Math.ceil(osLoad * osCoreCount / 20));
    } else {
        if (totalCores >= 100) osNeeded = 4;
        else if (totalCores <= 12) osNeeded = 1;
        else osNeeded = 2;
    }
    osNeeded = Math.min(osNeeded, osCores.length);
    
    const assignedOsCores = osCores.slice(0, osNeeded);
    assignedOsCores.forEach(c => assignRole(c, 'sys_os'));
    
    console.log('=== OS Cores ===');
    console.log('Available OS cores:', osCores);
    console.log('OS load:', osLoad.toFixed(1) + '%');
    console.log('OS needed:', osNeeded);
    console.log('Assigned OS:', assignedOsCores);
    console.log('CHECK: OS consecutive from 0?', assignedOsCores[0] === 0 ? '✅' : '❌');
    
    // === Service Pool ===
    const servicePool = allCoresSorted.filter(c => 
        isolatedSet.has(String(c)) && !isAssigned(c)
    ).sort((a, b) => a - b);
    
    let svcIdx = 0;
    const getSvc = () => svcIdx < servicePool.length ? servicePool[svcIdx++] : null;
    
    console.log('\n=== Service Pool ===');
    console.log('Available:', servicePool);
    
    // === Trash + ClickHouse ===
    const trashCore = getSvc();
    if (trashCore !== null) {
        assignRole(trashCore, 'trash');
        assignRole(trashCore, 'click');
    }
    console.log('\n=== Trash+Click ===');
    console.log('Trash core:', trashCore);
    
    // === UDP ===
    const hasUdpInInput = (currentRoles['udp']?.length || 0) > 0;
    let udpCore = null;
    if (hasUdpInInput) {
        udpCore = getSvc();
        if (udpCore !== null) {
            assignRole(udpCore, 'udp');
        }
    } else if (trashCore !== null) {
        assignRole(trashCore, 'udp');
    }
    console.log('\n=== UDP ===');
    console.log('Has UDP in input:', hasUdpInInput);
    console.log('UDP core:', udpCore ?? 'shared with trash');
    
    // === AR + RF + Formula ===
    const arCore = getSvc();
    if (arCore !== null) {
        assignRole(arCore, 'ar');
        assignRole(arCore, 'rf');
        assignRole(arCore, 'formula');
    } else if (trashCore !== null) {
        assignRole(trashCore, 'rf');
    }
    console.log('\n=== AR+RF+Formula ===');
    console.log('AR core:', arCore);
    console.log('CHECK: AR != Trash?', arCore !== trashCore ? '✅' : '❌');
    
    // === IRQ ===
    const gwCount = currentRoles['gateway']?.length || 1;
    const neededIrq = Math.min(6, Math.max(1, Math.ceil(gwCount / 4)));
    console.log('\n=== IRQ ===');
    console.log('Gateway count:', gwCount);
    console.log('IRQ needed (1 per 4 gw):', neededIrq);
    console.log('CHECK: 2 gw = 1 IRQ?', neededIrq === 1 ? '✅' : '❌');
    
    // Assign IRQ
    for (let i = 0; i < neededIrq; i++) {
        const irqCore = getSvc();
        if (irqCore !== null) {
            assignRole(irqCore, 'net_irq');
            console.log('IRQ assigned to core:', irqCore);
        }
    }
    
    // === Gateways ===
    const gwLoad = getAvgLoad(currentRoles['gateway']);
    const gwCoreCount = currentRoles['gateway']?.length || 1;
    const neededGw = gwLoad > 0 
        ? Math.max(1, Math.ceil(gwLoad * gwCoreCount / 20))
        : Math.max(1, gwCoreCount);
    
    console.log('\n=== Gateways ===');
    console.log('Gateway load:', gwLoad.toFixed(1) + '%');
    console.log('Gateway count:', gwCoreCount);
    console.log('Gateways needed (20% target):', neededGw);
    
    // Assign gateways
    const gwCores = [];
    for (let i = 0; i < neededGw; i++) {
        const gwCore = getSvc();
        if (gwCore !== null) {
            assignRole(gwCore, 'gateway');
            gwCores.push(gwCore);
        }
    }
    console.log('Gateway cores:', gwCores);
    
    // === Robots ===
    const robotCores = [];
    while (svcIdx < servicePool.length) {
        const robotCore = getSvc();
        if (robotCore !== null) {
            assignRole(robotCore, 'robot_default');
            robotCores.push(robotCore);
        }
    }
    console.log('\n=== Robots ===');
    console.log('Robot cores:', robotCores);
    console.log('CHECK: Robots >= 1?', robotCores.length >= 1 ? '✅' : '❌ (' + robotCores.length + ')');
    
    // === Final Summary ===
    console.log('\n========== FINAL ALLOCATION ==========');
    Object.entries(proposed).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).forEach(([cpu, roles]) => {
        console.log(`Core ${cpu}: ${roles.join(', ')}`);
    });
    
    // === Validation ===
    console.log('\n========== VALIDATION ==========');
    const results = [];
    
    // 1. OS consecutive from 0
    const osOk = assignedOsCores.every((c, i) => c === i);
    results.push(['OS consecutive from 0', osOk]);
    
    // 2. IRQ formula correct
    results.push(['IRQ = 1 per 4 gateways', neededIrq === Math.ceil(gwCount / 4)]);
    
    // 3. AR not with Trash
    const arRoles = proposed[String(arCore)] || [];
    const trashRoles = proposed[String(trashCore)] || [];
    const arNotWithTrash = !arRoles.includes('trash') && !trashRoles.includes('ar');
    results.push(['AR not with Trash', arNotWithTrash]);
    
    // 4. AR has RF
    const arHasRf = arRoles.includes('rf');
    results.push(['AR has RF', arHasRf]);
    
    // 5. Robots >= 1
    results.push(['Robots >= 1', robotCores.length >= 1]);
    
    // 6. OS >= 1
    results.push(['OS >= 1', assignedOsCores.length >= 1]);
    
    let allPassed = true;
    results.forEach(([name, passed]) => {
        console.log(`${passed ? '✅' : '❌'} ${name}`);
        if (!passed) allPassed = false;
    });
    
    console.log('\n' + (allPassed ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED'));
    return allPassed;
}

testOptimizer();

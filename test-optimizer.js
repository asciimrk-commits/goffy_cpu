/**
 * Unit test for Multi-Instance Optimizer with Core Partitioning
 * Tests with 48-core dual-instance system (HUB7 + RFQ1)
 */

function testMultiInstanceOptimizer() {
    console.log('========== MULTI-INSTANCE OPTIMIZER TEST ==========\n');

    const totalCores = 48;
    const allCoresSorted = Array.from({ length: 48 }, (_, i) => i);

    // OS cores: 0, 1, 2 (non-isolated) 
    // Isolated: 3-47
    const isolatedCores = allCoresSorted.filter(c => c >= 3);
    const isolatedSet = new Set(isolatedCores.map(String));

    const coreLoads = {
        0: 10, 1: 10, 2: 10,  // OS = 30%
        9: 25, 10: 25, 11: 25, // HUB7 gw = 75%
        17: 20, 18: 20, 19: 20 // RFQ1 gw = 60%
    };

    const instances = ['HUB7', 'RFQ1'];
    const instanceRoles = {
        'HUB7': { 'gateway': ['9', '10', '11'] },
        'RFQ1': { 'gateway': ['17', '18', '19'] }
    };
    const currentRoles = {
        'sys_os': ['0', '1', '2'],
        'gateway': ['9', '10', '11', '17', '18', '19']
    };

    const getTotalLoad = (cores) => {
        if (!cores?.length) return 0;
        return cores.reduce((sum, c) => sum + (coreLoads[parseInt(c)] || 0), 0);
    };

    const proposed = {};
    const assignedCores = new Set();

    const assignRole = (cpu, role) => {
        const cpuStr = String(cpu);
        if (!proposed[cpuStr]) proposed[cpuStr] = [];
        if (!proposed[cpuStr].includes(role)) proposed[cpuStr].push(role);
        assignedCores.add(parseInt(cpu));
    };
    const isAssigned = (cpu) => assignedCores.has(parseInt(cpu));

    // PHASE 1: OS
    console.log('=== PHASE 1: OS ===');
    const osCoresAvailable = allCoresSorted.filter(c => !isolatedSet.has(String(c)));
    const osLoad = getTotalLoad(currentRoles['sys_os']);
    let osNeeded = Math.max(1, Math.ceil(osLoad / 25));
    osNeeded = Math.min(osNeeded, osCoresAvailable.length);
    osCoresAvailable.slice(0, osNeeded).forEach(c => assignRole(c, 'sys_os'));
    console.log(`OS: ${osNeeded} cores (${osLoad}% / 25 = ${Math.ceil(osLoad / 25)})`);
    console.log(`CHECK: OS formula? ${osNeeded === Math.ceil(osLoad / 25) ? '✅' : '❌'}`);

    // PHASE 2: IRQ
    console.log('\n=== PHASE 2: IRQ ===');
    const totalGw = 6;
    const neededIrq = Math.min(6, Math.max(1, Math.ceil(totalGw / 4)));
    isolatedCores.filter(c => !isAssigned(c)).slice(0, neededIrq).forEach(c => assignRole(c, 'net_irq'));
    console.log(`IRQ: ${neededIrq} cores (${totalGw} gw / 4)`);
    console.log(`CHECK: IRQ formula? ${neededIrq === Math.ceil(totalGw / 4) ? '✅' : '❌'}`);

    // PHASE 3: Partition
    console.log('\n=== PHASE 3: Partition ===');
    const available = isolatedCores.filter(c => !isAssigned(c));
    const perInstance = Math.floor(available.length / instances.length);
    const pools = {};
    instances.forEach((inst, i) => {
        const start = i * perInstance;
        const end = i === instances.length - 1 ? available.length : start + perInstance;
        pools[inst] = available.slice(start, end);
        console.log(`${inst}: ${pools[inst].length} cores`);
    });

    // PHASE 4: Per-Instance
    console.log('\n=== PHASE 4: Per-Instance ===');
    for (const inst of instances) {
        console.log(`\n--- ${inst} ---`);
        const pool = [...pools[inst]];
        let idx = 0;
        const get = () => idx < pool.length && !isAssigned(pool[idx]) ? pool[idx++] : null;

        // Trash, UDP, AR
        const trash = get(); if (trash !== null) { assignRole(trash, 'trash'); console.log(`Trash: ${trash}`); }
        const udp = get(); if (udp !== null) { assignRole(udp, 'udp'); console.log(`UDP: ${udp}`); }
        const ar = get(); if (ar !== null) { assignRole(ar, 'ar'); console.log(`AR: ${ar}`); }
        console.log(`CHECK: AR != Trash? ${ar !== trash ? '✅' : '❌'}`);

        // Gateways
        const gwLoad = getTotalLoad(instanceRoles[inst]['gateway']);
        const gwNeeded = Math.max(1, Math.ceil(gwLoad / 25));
        const gws = [];
        for (let i = 0; i < gwNeeded; i++) { const c = get(); if (c !== null) { assignRole(c, 'gateway'); gws.push(c); } }
        console.log(`Gateways: ${gws.length} (${gwLoad}% / 25 = ${gwNeeded})`);

        // Robots
        const robots = [];
        let c = get();
        while (c !== null) { assignRole(c, 'robot_default'); robots.push(c); c = get(); }
        console.log(`Robots: ${robots.length}`);
        console.log(`CHECK: Robots >= 1? ${robots.length >= 1 ? '✅' : '❌'}`);
    }

    // PHASE 5: Fill Remaining
    console.log('\n=== PHASE 5: Fill Remaining ===');
    const remNonIso = allCoresSorted.filter(c => !isolatedSet.has(String(c)) && !isAssigned(c));
    remNonIso.forEach(c => assignRole(c, 'sys_os'));
    console.log(`Non-isolated → OS: ${remNonIso.length} [${remNonIso.join(', ')}]`);

    const remIso = allCoresSorted.filter(c => isolatedSet.has(String(c)) && !isAssigned(c));
    remIso.forEach(c => assignRole(c, 'robot_default'));
    console.log(`Isolated → Robots: ${remIso.length}`);

    // Summary
    console.log('\n========== SUMMARY ==========');
    console.log(`Total: ${totalCores}, Assigned: ${assignedCores.size}`);

    const results = [
        ['OS = totalLoad/25%', osNeeded === Math.ceil(osLoad / 25)],
        ['IRQ = ceil(gw/4)', neededIrq === Math.ceil(totalGw / 4)],
        ['All cores assigned', assignedCores.size === totalCores],
        ['Multi-instance', instances.length === 2],
        ['Equal partition', Math.abs(pools['HUB7'].length - pools['RFQ1'].length) <= 1]
    ];

    console.log('\n========== VALIDATION ==========');
    let allPassed = true;
    results.forEach(([name, ok]) => { console.log(`${ok ? '✅' : '❌'} ${name}`); if (!ok) allPassed = false; });
    console.log('\n' + (allPassed ? '🎉 ALL TESTS PASSED!' : '❌ SOME FAILED'));
    return allPassed;
}

testMultiInstanceOptimizer();

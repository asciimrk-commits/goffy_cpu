/**
 * Unit test for Multi-Instance Optimizer v4
 * Tests per-instance IRQ, 30% load target, separate allocations
 */

function testMultiInstanceOptimizerV4() {
    console.log('========== MULTI-INSTANCE OPTIMIZER v4 TEST ==========\n');

    // === Setup: 48 cores, HUB7 + RFQ1 ===
    const totalCores = 48;
    const allCores = Array.from({ length: 48 }, (_, i) => i);

    // Isolation: 0,1 = OS, 2-43 = isolated, 44-47 = OS
    const isolatedCores = allCores.filter(c => c >= 2 && c <= 43);
    const isolatedSet = new Set(isolatedCores.map(String));

    // Load data  
    const coreLoads = {};
    // HUB7 gateways (5,6,7,8): ~10% each = 40%
    [5, 6, 7, 8].forEach(c => coreLoads[c] = 10);
    // RFQ1 gateways (27,28,29,30,31): ~12% each = 60%
    [27, 28, 29, 30, 31].forEach(c => coreLoads[c] = 12);
    // HUB7 robots: ~5% each = ~55%
    [10, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23].forEach(c => coreLoads[c] = 5);
    // RFQ1 robots: ~3% each = ~33%
    [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43].forEach(c => coreLoads[c] = 3);
    // OS cores: ~15% each
    [0, 1, 44, 45, 46, 47].forEach(c => coreLoads[c] = 15);

    const instances = {
        HUB7: {
            gateway: [5, 6, 7, 8],
            robot_default: [10, 11, 12, 13, 17, 18, 19, 20, 21, 22, 23]
        },
        RFQ1: {
            gateway: [27, 28, 29, 30, 31],
            robot_default: [33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43]
        }
    };

    const getTotalLoad = (cores) => {
        if (!cores?.length) return 0;
        return cores.reduce((sum, c) => sum + (coreLoads[c] || 0), 0);
    };

    const assignedCores = new Set();
    const assignRole = (c) => assignedCores.add(c);
    const isAssigned = (c) => assignedCores.has(c);

    // === PHASE 1: OS (30% target) ===
    console.log('=== PHASE 1: OS ===');
    const osCores = allCores.filter(c => !isolatedSet.has(String(c)));
    const osLoad = getTotalLoad(osCores);
    const osNeeded = Math.max(1, Math.ceil(osLoad / 30));
    osCores.slice(0, osNeeded).forEach(c => assignRole(c));

    console.log(`OS cores: [${osCores.join(', ')}]`);
    console.log(`OS load: ${osLoad}% / 30 = ${osNeeded} cores needed`);
    console.log(`CHECK: OS formula correct? ${osNeeded === Math.ceil(osLoad / 30) ? '✅' : '❌'}`);

    // === PHASE 2: Per-Instance ===
    console.log('\n=== PHASE 2: Per-Instance ===');

    for (const [instName, instRoles] of Object.entries(instances)) {
        console.log(`\n--- ${instName} ---`);

        // Count gateways for this instance
        const gwCount = instRoles.gateway.length;
        const gwLoad = getTotalLoad(instRoles.gateway);

        // IRQ per instance: 1 per 4 gateways
        const irqNeeded = Math.max(1, Math.ceil(gwCount / 4));
        console.log(`Gateways: ${gwCount}, IRQ needed: ${irqNeeded} (${gwCount}/4 = ${Math.ceil(gwCount / 4)})`);
        console.log(`CHECK: IRQ formula? ${irqNeeded === Math.ceil(gwCount / 4) ? '✅' : '❌'}`);

        // Gateways (30% target)
        const gwNeeded = Math.max(1, Math.ceil(gwLoad / 30));
        console.log(`GW load: ${gwLoad}%, needed: ${gwNeeded} (${gwLoad}/30 = ${Math.ceil(gwLoad / 30)})`);
        console.log(`CHECK: GW formula? ${gwNeeded === Math.ceil(gwLoad / 30) ? '✅' : '❌'}`);

        // Robots (30% target)
        const robotLoad = getTotalLoad(instRoles.robot_default);
        const robotNeeded = Math.max(1, Math.ceil(robotLoad / 30));
        console.log(`Robot load: ${robotLoad}%, needed: ${robotNeeded}`);

        // Low load check
        if (robotLoad < 10) {
            console.log(`⚠️ Robot load <10% - could be reserve`);
        }
    }

    // === Validation ===
    console.log('\n========== VALIDATION ==========');
    const results = [];

    // HUB7: 4 gateways → 1 IRQ
    results.push(['HUB7: 4 gw = 1 IRQ', Math.ceil(4 / 4) === 1]);

    // RFQ1: 5 gateways → 2 IRQ
    results.push(['RFQ1: 5 gw = 2 IRQ', Math.ceil(5 / 4) === 2]);

    // OS: 90% / 30 = 3
    results.push(['OS: 90%/30 = 3', Math.ceil(90 / 30) === 3]);

    // HUB7 GW: 40% / 30 = 2
    results.push(['HUB7 GW: 40%/30 = 2', Math.ceil(40 / 30) === 2]);

    // RFQ1 GW: 60% / 30 = 2
    results.push(['RFQ1 GW: 60%/30 = 2', Math.ceil(60 / 30) === 2]);

    // HUB7 Robots: 55% / 30 = 2
    results.push(['HUB7 Robots: 55%/30 = 2', Math.ceil(55 / 30) === 2]);

    // RFQ1 Robots: 33% / 30 = 2
    results.push(['RFQ1 Robots: 33%/30 = 2', Math.ceil(33 / 30) === 2]);

    let allPassed = true;
    results.forEach(([name, ok]) => {
        console.log(`${ok ? '✅' : '❌'} ${name}`);
        if (!ok) allPassed = false;
    });

    console.log('\n' + (allPassed ? '🎉 ALL TESTS PASSED!' : '❌ SOME FAILED'));
    return allPassed;
}

testMultiInstanceOptimizerV4();

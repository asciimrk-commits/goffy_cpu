
const CPU_OPTIMIZER = require('./cpu-optimizer.js');

function createSmallSnapshot() {
    const topology = [];
    // 8 cores
    for (let i = 0; i < 8; i++) {
        topology.push({
            id: i,
            socketId: 0,
            numaNodeId: 0,
            l3CacheId: 0,
            currentLoad: 0, // Set to 0 to trigger "fallback to count" logic for Gateways
            services: []
        });
    }
    topology[0].services.push({ instanceId: 'GG00', name: 'Gateway 1' });
    topology[1].services.push({ instanceId: 'GG00', name: 'Gateway 2' });
    topology[2].services.push({ instanceId: 'GG00', name: 'Robot 1' });
    topology[3].services.push({ instanceId: 'GG00', name: 'Robot 2' });

    return {
        topology: topology,
        network: [{ name: 'net0', numaNode: 0 }]
    };
}

function testSmallServer() {
    const snapshot = createSmallSnapshot();
    const result = CPU_OPTIMIZER.optimize(snapshot);

    console.log('--- Small Server (8 cores) Optimization ---');
    console.log(`Total Cores: ${result.totalCores}`);
    console.log(`OS Cores: ${result.osCores.join(',')}`);
    console.log(`IRQ Cores: ${result.irqCores.join(',')}`);

    const inst = result.instances[0];
    if (inst) {
        console.log(`Instance ${inst.instanceId} Allocated: ${inst.allocatedCores}`);
        inst.coreAssignments.forEach(a => {
            console.log(`  Role ${a.role}: ${a.cores.join(',')}`);
        });
    }

    if (result.osCores.length !== 1) console.error('FAIL: OS Cores count should be 1');
    else console.log('PASS: OS Cores count is 1');

    const gw = inst.coreAssignments.find(a => a.role === 'gateway');
    const rob = inst.coreAssignments.find(a => a.role === 'robot_default');

    if (gw && gw.cores.length >= 2) console.log(`PASS: Gateways ${gw.cores.length}`);
    else console.error(`FAIL: Gateways count ${gw ? gw.cores.length : 0} (Expected 2)`);

    if (rob && rob.cores.length >= 2) console.log(`PASS: Robots ${rob.cores.length}`);
    else console.error(`FAIL: Robots count ${rob ? rob.cores.length : 0} (Expected 2)`);
}

testSmallServer();

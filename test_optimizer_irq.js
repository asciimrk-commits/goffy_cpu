
const CPU_OPTIMIZER = require('./cpu-optimizer.js');

function createSnapshot(coreCount) {
    const topology = [];
    for (let i = 0; i < coreCount; i++) {
        topology.push({
            id: i,
            socketId: 0,
            numaNodeId: 0,
            l3CacheId: Math.floor(i / 16),
            currentLoad: 10,
            services: []
        });
    }
    // Minimal mock for network detection (1 island)
    return {
        topology: topology,
        network: [{ name: 'net0', numaNode: 0 }]
    };
}

function testIrqCount(coreCount) {
    const snapshot = createSnapshot(coreCount);
    // Mock HFT_RULES constants if needed (CONSTANTS are inside CPU_OPTIMIZER)
    // The optimizer logic uses its own internal constants usually,
    // but the file exports an object with CONSTANTS property.

    // We need to inject or modify the calculateIrq logic?
    // Wait, the test is to verify the NEW logic.
    // I haven't implemented the new logic yet.
    // This script will FAIL until I implement it.

    const result = CPU_OPTIMIZER.optimize(snapshot);
    console.log(`Cores: ${coreCount}, IRQ: ${result.irqCores.length}`);
    return result.irqCores.length;
}

console.log('--- Testing IRQ Allocation Logic ---');

const tests = [
    { cores: 16, expected: 1 },
    { cores: 32, expected: 2 },
    { cores: 48, expected: 2 },
    { cores: 64, expected: 3 },
    { cores: 96, expected: 3 },
    { cores: 100, expected: 4 }
];

let failed = false;
tests.forEach(t => {
    const actual = testIrqCount(t.cores);
    if (actual !== t.expected) {
        console.error(`FAIL: Cores ${t.cores} expected ${t.expected}, got ${actual}`);
        failed = true;
    } else {
        console.log(`PASS: Cores ${t.cores} -> ${actual}`);
    }
});

if (failed) process.exit(1);

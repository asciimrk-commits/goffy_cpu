/**
 * Debug parser - test instance detection from BENDER
 */

// Test BENDER line parsing
const testLines = [
    '{cpu_id:2,isolated:True,TrashCPU:[HUB7],ClickHouseCores:[HUB7]}',
    '{cpu_id:24,isolated:True,TrashCPU:[RFQ1]}',
    '{cpu_id:5,isolated:True,GatewaysDefault:[HUB7]}',
    '{cpu_id:27,isolated:True,GatewaysDefault:[RFQ1]}',
];

console.log('=== Parser Debug ===\n');

const BENDER_TO_ROLE = {
    'TrashCPU': 'trash',
    'ClickHouseCores': 'click',
    'UdpSendCores': 'udp',
    'UdpReceiveCores': 'udp',
    'AllRobotsThCPU': 'ar',
    'GatewaysDefault': 'gateway',
    'RemoteFormulaCPU': 'rf',
    'RobotsDefault': 'robot_default',
    'Formula': 'formula',
};

const instances = { Physical: {} };

for (const line of testLines) {
    console.log(`Line: ${line}`);

    const cpuMatch = line.match(/['"]?cpu_id['"]?\s*:\s*(\d+)/);
    if (!cpuMatch) {
        console.log('  No cpu_id match!');
        continue;
    }

    const cpu = cpuMatch[1];
    console.log(`  CPU: ${cpu}`);

    // My pattern from parser.ts
    const roleInstancePattern = /['"]?(\w+)['"]?\s*:\s*\[([^\]]+)\]/g;
    let match;
    while ((match = roleInstancePattern.exec(line)) !== null) {
        const benderName = match[1];
        const instanceValue = match[2];

        console.log(`  Found: ${benderName}:[${instanceValue}]`);

        if (['cpu_id', 'isolated'].includes(benderName)) {
            console.log(`    Skipping ${benderName}`);
            continue;
        }

        // Check if instance name
        const instanceMatch = instanceValue.match(/^([A-Z][A-Z0-9]+)$/);
        const instanceName = instanceMatch ? instanceMatch[1] : null;

        console.log(`    Instance match: ${instanceName}`);

        const roleId = BENDER_TO_ROLE[benderName];
        console.log(`    Role: ${roleId}`);

        if (roleId && instanceName) {
            if (!instances[instanceName]) instances[instanceName] = {};
            if (!instances[instanceName][cpu]) instances[instanceName][cpu] = [];
            if (!instances[instanceName][cpu].includes(roleId)) {
                instances[instanceName][cpu].push(roleId);
            }
            console.log(`    Added: instances[${instanceName}][${cpu}] = [${instances[instanceName][cpu]}]`);
        }
    }
    console.log('');
}

console.log('=== Result ===');
console.log('Instances detected:', Object.keys(instances).filter(k => k !== 'Physical'));
console.log(JSON.stringify(instances, null, 2));

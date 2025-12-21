const fs = require('fs');

global.document = {
    getElementById: () => ({ value: '', innerHTML: '', appendChild: () => {}, classList: { remove: () => {}, add: () => {}, toggle: () => {} } }),
    querySelector: () => ({ style: {}, clientWidth: 1000, clientHeight: 1000 }),
    querySelectorAll: () => [],
    createElement: () => ({ classList: { add: () => {}, remove: () => {} }, style: {}, querySelector: () => ({}) }),
    body: { appendChild: () => {}, removeChild: () => {} },
    addEventListener: () => {}
};
global.window = { location: { hash: '' } };
global.navigator = { clipboard: { writeText: () => Promise.resolve() } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.requestAnimationFrame = (cb) => cb();

global.HFT_RULES = {
    categories: { system: { roles: [] }, network: { roles: [] }, gateway: { roles: [] }, logic: { roles: [] } },
    roles: { isolated: { id: 'isolated', color: '#000' } }
};

let appContent = fs.readFileSync('app.js', 'utf8');
appContent = appContent.replace('const HFT =', 'global.HFT =');
eval(appContent);

// Setup state
HFT.state = {
    serverName: 'test',
    geometry: { '0': { '0': { '0': [0, 1] } } }, // Socket 0, NUMA 0, L3 0, CPUs 0,1
    coreNumaMap: { '0': '0', '1': '0' },
    corePhysicalMap: { '0': '0', '1': '0' }, // Both on Core 0
    l3Groups: { '0-0-0': [0, 1] },
    netNumaNodes: new Set(),
    isolatedCores: new Set(),
    coreIRQMap: {},
    cpuLoadMap: {},
    instances: { Physical: {} },
    networkInterfaces: []
};

const html = HFT.renderSocket('0', HFT.state.geometry['0']);
// Check for hierarchy: socket -> numa -> l3 -> phy-core -> core
if (html.includes('class="socket"') &&
    html.includes('class="numa') &&
    html.includes('class="l3"') &&
    html.includes('class="phy-core"') &&
    html.includes('Core P#0')) {
    console.log('Render Structure Verified');
} else {
    console.error('Render Structure Missing Components');
    console.log(html);
    process.exit(1);
}

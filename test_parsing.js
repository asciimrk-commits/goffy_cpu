const fs = require('fs');

global.document = {
    getElementById: () => ({ value: '', innerHTML: '', appendChild: () => {}, classList: { remove: () => {}, add: () => {}, toggle: () => {} } }),
    querySelector: () => ({ style: {} }),
    querySelectorAll: () => [],
    createElement: () => ({ classList: { add: () => {}, remove: () => {} }, style: {}, querySelector: () => ({}) }),
    body: { appendChild: () => {}, removeChild: () => {} },
    addEventListener: () => {}
};
global.window = { location: { hash: '' } };
global.navigator = { clipboard: { writeText: () => Promise.resolve() } };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

global.HFT_RULES = {
    categories: { system: { roles: [] }, network: { roles: [] }, gateway: { roles: [] }, logic: { roles: [] } },
    roles: { isolated: { id: 'isolated', color: '#000' } }
};

let appContent = fs.readFileSync('app.js', 'utf8');
// Replace const HFT with global.HFT =
appContent = appContent.replace('const HFT =', 'global.HFT =');
eval(appContent);

const input = `@@HFT_CPU_MAP_V4@@
HOST:test
@@LSCPU@@
0,0,0,0,0
1,0,0,0,0
2,0,0,1,0
3,0,0,1,0
`;

HFT.parse(input);

console.log('Core Physical Map:', JSON.stringify(HFT.state.corePhysicalMap));

const expected = { "0": "0", "1": "0", "2": "1", "3": "1" };
const actual = HFT.state.corePhysicalMap;

let pass = true;
for (const k in expected) {
    if (actual[k] !== expected[k]) {
        console.error(`Mismatch for CPU ${k}: expected ${expected[k]}, got ${actual[k]}`);
        pass = false;
    }
}

if (pass) console.log('Parsing Test Passed');
else process.exit(1);

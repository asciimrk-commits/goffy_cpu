import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';
import { parseTopology } from '../lib/parser';

const roleGroups = [
    { name: 'System', roles: ['sys_os'] },
    { name: 'Network Stack', roles: ['net_irq', 'udp', 'trash'] },
    { name: 'Gateways', roles: ['gateway'] },
    { name: 'Trading Logic', roles: ['isolated_robots', 'pool1', 'pool2', 'robot_default', 'ar'] },
    { name: 'Analytics', roles: ['rf', 'formula', 'click'] },
];

export function Sidebar() {
    const {
        rawInput,
        setRawInput,
        activeTool,
        setActiveTool,
        setServerInfo,
        setGeometry,
        setIsolatedCores,
        setCoreNumaMap,
        setL3Groups,
        setNetworkInterfaces,
        setNetNumaNodes,
        setCoreLoads,
        setInstances,
        sidebarCollapsed,
        toggleSidebar,
    } = useAppStore();

    const handleBuildMap = () => {
        const result = parseTopology(rawInput);
        setServerInfo(result.serverName, result.date);
        setGeometry(result.geometry);
        setIsolatedCores(result.isolatedCores);
        setCoreNumaMap(result.coreNumaMap);
        setL3Groups(result.l3Groups);
        setNetworkInterfaces(result.networkInterfaces);
        setNetNumaNodes(result.netNumaNodes);
        setCoreLoads(result.coreLoads);
        setInstances(result.instances);
    };

    const handleLoadDemo = async () => {
        // Demo data for testing
        const demo = `@@HFT_CPU_MAP_V4@@
HOST:demo-server
DATE:${new Date().toISOString()}
@@LSCPU@@
0,0,0,0,0
1,0,0,1,0
2,0,0,2,0
3,0,0,3,0
4,0,0,4,0
5,0,0,5,0
6,0,0,6,0
7,0,0,7,0
8,0,0,8,1
9,0,0,9,1
10,0,0,10,1
11,0,0,11,1
12,0,0,12,1
13,0,0,13,1
14,0,0,14,1
15,0,0,15,1
@@NUMA@@
node 0 cpus: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
node 0 size: 32000 MB
@@ISOLATED@@
5-15
@@END@@`;
        setRawInput(demo);
    };

    if (sidebarCollapsed) {
        return (
            <div className="sidebar collapsed">
                <button className="sidebar-toggle" onClick={toggleSidebar}>›</button>
            </div>
        );
    }

    return (
        <aside className="sidebar">
            <button className="sidebar-toggle" onClick={toggleSidebar}>‹</button>

            <div className="sidebar-inner">
                <div className="sidebar-header">
                    <div className="logo">
                        <img src="/goffy_cpu/cpu-icon.png" alt="CPU" className="logo-icon" />
                        <div className="logo-text">
                            <span className="logo-holy">✝ HOLY</span>
                            <span className="logo-main">CPU<span className="logo-accent">MAPPER</span></span>
                        </div>
                    </div>
                </div>

                <div className="sidebar-content">
                    {/* Data Input */}
                    <section className="panel">
                        <h3 className="panel-title">📥 Data Input</h3>
                        <textarea
                            className="input-area"
                            value={rawInput}
                            onChange={(e) => setRawInput(e.target.value)}
                            placeholder="Paste cpu-map.sh output here..."
                        />
                        <div className="button-group">
                            <button className="btn btn-primary" onClick={handleBuildMap}>
                                Build Map
                            </button>
                            <button className="btn btn-ghost" onClick={handleLoadDemo}>
                                Demo
                            </button>
                        </div>
                    </section>

                    {/* Paint Tools */}
                    <section className="panel">
                        <h3 className="panel-title">🎨 Paint Tools</h3>
                        <div className="palette">
                            {roleGroups.map(group => (
                                <div key={group.name} className="palette-group">
                                    <div className="palette-group-name">{group.name}</div>
                                    {group.roles.map(roleId => {
                                        const role = ROLES[roleId];
                                        if (!role) return null;
                                        return (
                                            <div
                                                key={roleId}
                                                className={`palette-item ${activeTool === roleId ? 'active' : ''}`}
                                                onClick={() => setActiveTool(activeTool === roleId ? null : roleId)}
                                            >
                                                <span
                                                    className="palette-color"
                                                    style={{ backgroundColor: role.color }}
                                                />
                                                <span className="palette-name">{role.name}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ))}
                        </div>
                        <p className="hint">Click to paint • Ctrl+Click to erase</p>
                    </section>
                </div>
            </div>
        </aside>
    );
}

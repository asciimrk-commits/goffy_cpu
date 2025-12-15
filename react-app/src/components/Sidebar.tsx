import { useRef, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { parseTopology } from '../lib/parser';
import { ROLES } from '../types/topology';

// Simple Icons
const Icons = {
    Cpu: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>,
    Upload: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>,
    Trash: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>,
    Download: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>,
    Play: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>,
    Menu: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>,
    ChevronLeft: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
};

export function Sidebar() {
    const {
        rawInput,
        setRawInput,
        setServerInfo,
        setGeometry,
        setIsolatedCores,
        setCoreNumaMap,
        setL3Groups,
        setNetworkInterfaces,
        setNetNumaNodes,
        setCoreLoads,
        setInstances,
    } = useAppStore();

    const [isExpanded, setIsExpanded] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleBuildMap = () => {
        if (!rawInput.trim()) return;
        try {
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
        } catch (e) {
            console.error(e);
            alert('Error parsing input');
        }
    };

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const text = ev.target?.result as string;
            setRawInput(text);
        };
        reader.readAsText(file);
    };

    // Group Roles for Legend
    const roleGroups: Record<string, typeof ROLES[keyof typeof ROLES][]> = {};
    Object.values(ROLES).forEach(role => {
        if (!roleGroups[role.group]) roleGroups[role.group] = [];
        roleGroups[role.group].push(role);
    });

    return (
        <aside
            className={`sidebar ${isExpanded ? 'expanded' : ''}`}
            onChange={() => { } /* Fix React warning */}
            style={{ width: isExpanded ? '260px' : '72px', transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)' }}
        >
            <div className="sidebar-header" style={{ padding: '20px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', borderBottom: isExpanded ? '1px solid var(--border-color)' : 'none' }}>
                <div
                    className="logo-icon-bg"
                    title={isExpanded ? "Minimize" : "Expand"}
                    onClick={() => setIsExpanded(!isExpanded)}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: isExpanded ? '10px' : '0' }}
                >
                    {isExpanded ? <Icons.ChevronLeft /> : <Icons.Menu />}
                </div>
                {isExpanded && <span style={{ fontWeight: 700, fontSize: '1.1em' }}>CPU MAPPER</span>}
            </div>

            <div className="sidebar-content" style={{ flex: 1, width: '100%', overflowY: 'auto', overflowX: 'hidden', padding: '10px 0' }}>
                {/* Actions */}
                <div className="nav-group">
                    {/* Build Map */}
                    <div className={`nav-item ${isExpanded ? 'expanded-item' : ''}`} title="Build Map" onClick={handleBuildMap}>
                        <Icons.Play />
                        {isExpanded && <span className="nav-label">Build Map</span>}
                    </div>

                    {/* Upload */}
                    <div className={`nav-item ${isExpanded ? 'expanded-item' : ''}`} title="Upload Config" onClick={() => fileInputRef.current?.click()}>
                        <Icons.Upload />
                        {isExpanded && <span className="nav-label">Upload Config</span>}
                        <input
                            type="file"
                            ref={fileInputRef}
                            onChange={handleFileUpload}
                            style={{ display: 'none' }}
                            accept=".sh,.txt,.log"
                        />
                    </div>

                    {/* Clear */}
                    <div className={`nav-item ${isExpanded ? 'expanded-item' : ''}`} title="Clear Data" onClick={() => {
                        setRawInput('');
                        setGeometry({});
                    }}>
                        <Icons.Trash />
                        {isExpanded && <span className="nav-label">Clear Data</span>}
                    </div>

                    {/* Download */}
                    <div className={`nav-item ${isExpanded ? 'expanded-item' : ''}`} title="Download Config" onClick={() => {
                        const { instances } = useAppStore.getState();
                        if (Object.keys(instances).length === 0) {
                            alert('No configuration to download');
                            return;
                        }
                        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(instances, null, 2));
                        const downloadAnchorNode = document.createElement('a');
                        downloadAnchorNode.setAttribute("href", dataStr);
                        downloadAnchorNode.setAttribute("download", "cpu_config.json");
                        document.body.appendChild(downloadAnchorNode); // required for firefox
                        downloadAnchorNode.click();
                        downloadAnchorNode.remove();
                    }}>
                        <Icons.Download />
                        {isExpanded && <span className="nav-label">Download Config</span>}
                    </div>
                </div>

                {/* Legend - Only Visible When Expanded */}
                {isExpanded && (
                    <div className="sidebar-legend" style={{ padding: '20px 16px', borderTop: '1px solid var(--border-color)', marginTop: '20px' }}>
                        <h4 style={{ fontSize: '0.8rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '12px', letterSpacing: '0.05em' }}>Legend</h4>

                        {Object.entries(roleGroups).map(([group, roles]) => (
                            <div key={group} style={{ marginBottom: '16px' }}>
                                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px' }}>{group}</div>
                                {roles.map(role => (
                                    <div key={role.id} style={{ display: 'flex', alignItems: 'center', marginBottom: '6px' }}>
                                        <div style={{ width: '12px', height: '12px', borderRadius: '3px', backgroundColor: role.color, marginRight: '8px', flexShrink: 0 }}></div>
                                        <span style={{ fontSize: '0.8rem', color: 'var(--text-main)' }}>{role.name}</span>
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </aside>
    );
}

import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { parseTopology } from '../lib/parser';

// Simple Icons
const Icons = {
    Cpu: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><rect x="9" y="9" width="6" height="6"></rect><line x1="9" y1="1" x2="9" y2="4"></line><line x1="15" y1="1" x2="15" y2="4"></line><line x1="9" y1="20" x2="9" y2="23"></line><line x1="15" y1="20" x2="15" y2="23"></line><line x1="20" y1="9" x2="23" y2="9"></line><line x1="20" y1="14" x2="23" y2="14"></line><line x1="1" y1="9" x2="4" y2="9"></line><line x1="1" y1="14" x2="4" y2="14"></line></svg>,
    Upload: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>,
    Trash: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>,
    Download: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>,
    Play: () => <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
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
            // Auto build on upload? No, let user verify input 
            // Actually usually better to separate.
            // But let's build for convenience if valid?
            // Let's just set input.
        };
        reader.readAsText(file);
    };

    return (
        <aside className="sidebar">
            <div className="logo-icon-bg" title="Bender CPU Mapper">
                <Icons.Cpu />
            </div>

            <div className="sidebar-content">
                <div className="nav-item" title="Build Map" onClick={handleBuildMap}>
                    <Icons.Play />
                </div>

                <div className="nav-item" title="Upload Config" onClick={() => fileInputRef.current?.click()}>
                    <Icons.Upload />
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        style={{ display: 'none' }}
                        accept=".sh,.txt,.log"
                    />
                </div>

                <div className="nav-item" title="Download Config" onClick={() => alert('Download not implemented yet')}>
                    <Icons.Download />
                </div>

                <div className="nav-item" title="Clear Data" onClick={() => {
                    setRawInput('');
                    setGeometry({});
                }}>
                    <Icons.Trash />
                </div>
            </div>

            {/* Input is visible only if selected? Or hidden? */}
            {/* The previous sidebar had a big textarea. 
                In the new design, layout is "Dashboard". Where does Input go?
                Maybe Input should be a modal or a separate view?
                Or maybe we keep the input panel but styled better?
                
                The user mockup shows "Input" panel on left. 
                My implementation plan said "Sidebar: Slim, icon-based".
                So the textarea should move to a panel in the main content area?
                
                Wait, my App.tsx puts `ConfigOutput` in mapper-sidebar (right).
                Input logic matches `TopologyMap`?
                
                If I made sidebar slim, I need a place for `rawInput`.
                
                Let's put `rawInput` in a Modal when clicking "Upload/Edit"?
                Or for now, let's assume the user uses the file upload or pasting is done elsewhere.
                
                Actually, `setRawInput` is used in `handleFileUpload`.
                If the user wants to PASTE, they need a textarea.
                Let's add a `Prompt` or Modal for pasting?
                
                Or, let's follow the "Input" panel idea from mockup.
                The mockup has "Input" card on the left.
                
                My `App.tsx` has `mapper-main` which contains `TopologyMap`.
                I should add an Input Card to `mapper-main` or `mapper-sidebar`.
                
                Currently `mapper-sidebar` has `ConfigOutput`.
                Let's move `Input` logic to a new component `InputPanel` and place it in the layout?
                
                For this step (Sidebar.tsx), I am making the NAVIGATION sidebar. 
                The actual "Input" form needs to be somewhere.
                
                I'll handle Input in a separate step or component. 
                For now, Sidebar just has buttons.
            */}
        </aside>
    );
}

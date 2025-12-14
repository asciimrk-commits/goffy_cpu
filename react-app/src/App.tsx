import { Sidebar } from './components/Sidebar';
import { TopologyMap } from './components/TopologyMap';
import { ConfigOutput } from './components/ConfigOutput';
import { CompareView } from './components/CompareView';
import { AutoOptimize } from './components/AutoOptimize';
import { useAppStore } from './store/appStore';
import './App.css';

function App() {
  const { serverName, date, activeTab, setActiveTab } = useAppStore();

  return (
    <div className="app">
      <Sidebar />

      <main className="main-content">
        {/* Header */}
        <header className="header">
          <div className="header-tabs">
            <button
              className={`tab ${activeTab === 'mapper' ? 'active' : ''}`}
              onClick={() => setActiveTab('mapper')}
            >
              [MAPPER]
            </button>
            <button
              className={`tab ${activeTab === 'compare' ? 'active' : ''}`}
              onClick={() => setActiveTab('compare')}
            >
              [COMPARE]
            </button>
            <button
              className={`tab ${activeTab === 'optimize' ? 'active' : ''}`}
              onClick={() => setActiveTab('optimize')}
            >
              [AUTO-OPT]
            </button>
          </div>

          {serverName && (
            <div className="header-info">
              <span className="server-name">{serverName}</span>
              {date && <span className="server-date">{date}</span>}
            </div>
          )}
        </header>

        {/* Content */}
        <div className="content">
          {activeTab === 'mapper' && (
            <div className="mapper-layout">
              <div className="mapper-main">
                <TopologyMap />
              </div>
              <div className="mapper-sidebar">
                <ConfigOutput />
              </div>
            </div>
          )}
          {activeTab === 'compare' && <CompareView />}
          {activeTab === 'optimize' && <AutoOptimize />}
        </div>
      </main>
    </div>
  );
}

export default App;

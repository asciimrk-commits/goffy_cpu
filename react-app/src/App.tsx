import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { InputPanel } from './components/InputPanel';
import { TopologyMap } from './components/TopologyMap';
import { ConfigOutput } from './components/ConfigOutput';
import { CompareView } from './components/CompareView';
import { AutoOptimize } from './components/AutoOptimize';
import { useAppStore } from './store/appStore';
import './App.css';

function App() {
  const { serverName, date, activeTab, setActiveTab } = useAppStore();
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('theme') || 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'light' ? 'dark' : 'light');
  };

  return (
    <div className="app">
      <Sidebar />

      <main className="main-content">
        {/* Header */}
        <header className="header">
          <div className="header-left">
            <div className="header-tabs">
              <button
                className={`tab ${activeTab === 'mapper' ? 'active' : ''}`}
                onClick={() => setActiveTab('mapper')}
              >
                MAPPER
              </button>
              <button
                className={`tab ${activeTab === 'compare' ? 'active' : ''}`}
                onClick={() => setActiveTab('compare')}
              >
                COMPARE
              </button>
              <button
                className={`tab ${activeTab === 'optimize' ? 'active' : ''}`}
                onClick={() => setActiveTab('optimize')}
              >
                AUTO-OPT
              </button>
            </div>
          </div>

          <div className="header-right" style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            {serverName && (
              <div className="header-info">
                <span className="server-name">{serverName}</span>
                {date && <span className="server-date">{date}</span>}
              </div>
            )}
            <button onClick={toggleTheme} className="theme-toggle" title="Toggle Theme">
              {theme === 'light' ? '🌙' : '☀️'}
            </button>
          </div>
        </header>

        {/* Content */}
        <div className="content">
          {activeTab === 'mapper' && (
            <div className="mapper-dashboard">
              <div className="card input-card">
                <InputPanel />
              </div>
              <div className="card mapper-card">
                <TopologyMap />
              </div>
              <div className="card config-card">
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

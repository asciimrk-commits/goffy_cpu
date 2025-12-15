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
              {theme === 'light' ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
              )}
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

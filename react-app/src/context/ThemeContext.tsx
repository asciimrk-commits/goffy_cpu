import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

// Theme types
export type ThemeMode = 'cyberpunk' | 'surgical';

interface ThemeContextType {
    theme: ThemeMode;
    setTheme: (theme: ThemeMode) => void;
    toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Semantic instance colors
export const INSTANCE_COLORS = {
    // Blue spectrum for Instance A / PROD
    prod: {
        primary: '#3b82f6',
        secondary: '#60a5fa',
        accent: '#2563eb',
        glow: 'rgba(59, 130, 246, 0.3)'
    },
    // Purple spectrum for Instance B / TEST
    test: {
        primary: '#a855f7',
        secondary: '#c084fc',
        accent: '#9333ea',
        glow: 'rgba(168, 85, 247, 0.3)'
    },
    // Monochrome for OS/System
    system: {
        primary: '#64748b',
        secondary: '#94a3b8',
        accent: '#475569',
        glow: 'rgba(100, 116, 139, 0.3)'
    },
    // Conflict indicator
    conflict: {
        primary: '#ef4444',
        secondary: '#f87171',
        accent: '#dc2626',
        glow: 'rgba(239, 68, 68, 0.4)'
    }
};

// L3 Zone colors
export const ZONE_COLORS = {
    dirty: {
        bg: 'rgba(220, 38, 38, 0.1)',
        border: '#dc2626',
        label: '#fca5a5'
    },
    gold: {
        bg: 'rgba(245, 158, 11, 0.1)',
        border: '#f59e0b',
        label: '#fcd34d'
    },
    silver: {
        bg: 'rgba(100, 116, 139, 0.1)',
        border: '#64748b',
        label: '#94a3b8'
    }
};

interface ThemeProviderProps {
    children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
    const [theme, setThemeState] = useState<ThemeMode>(() => {
        // Check localStorage or system preference
        const stored = localStorage.getItem('hft-theme') as ThemeMode | null;
        if (stored) return stored;

        // Default to cyberpunk (dark)
        return 'cyberpunk';
    });

    useEffect(() => {
        // Apply theme to document
        const root = document.documentElement;

        if (theme === 'surgical') {
            root.setAttribute('data-theme', 'light');
        } else {
            root.removeAttribute('data-theme');
        }

        localStorage.setItem('hft-theme', theme);
    }, [theme]);

    const setTheme = (newTheme: ThemeMode) => {
        setThemeState(newTheme);
    };

    const toggleTheme = () => {
        setThemeState(prev => prev === 'cyberpunk' ? 'surgical' : 'cyberpunk');
    };

    return (
        <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (!context) {
        throw new Error('useTheme must be used within ThemeProvider');
    }
    return context;
}

// Theme toggle component
export function ThemeToggle() {
    const { theme, toggleTheme } = useTheme();

    return (
        <button
            onClick={toggleTheme}
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                fontSize: '12px',
                fontFamily: 'var(--font-ui)',
                color: 'var(--text-main)',
                transition: 'all 0.2s'
            }}
            title={theme === 'cyberpunk' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
            {theme === 'cyberpunk' ? (
                <>
                    <span style={{ fontSize: '16px' }}>🌙</span>
                    <span>Cyberpunk</span>
                </>
            ) : (
                <>
                    <span style={{ fontSize: '16px' }}>☀️</span>
                    <span>Surgical</span>
                </>
            )}
        </button>
    );
}

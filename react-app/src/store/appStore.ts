import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Geometry, InstanceConfig } from '../types/topology';

interface AppState {
    // Server info
    serverName: string;
    date: string;
    rawInput: string;

    // Topology
    geometry: Geometry;
    isolatedCores: number[];
    coreNumaMap: Record<string, number>;
    l3Groups: Record<string, number[]>;
    networkInterfaces: string[];
    netNumaNodes: number[];
    coreLoads: Record<number, number>;

    // Configuration
    instances: InstanceConfig;

    // UI State
    activeTool: string | null;
    activeTab: 'mapper' | 'compare' | 'optimize';
    sidebarCollapsed: boolean;

    // Actions
    setRawInput: (input: string) => void;
    setServerInfo: (name: string, date: string) => void;
    setGeometry: (geometry: Geometry) => void;
    setIsolatedCores: (cores: number[]) => void;
    setCoreNumaMap: (map: Record<string, number>) => void;
    setL3Groups: (groups: Record<string, number[]>) => void;
    setNetworkInterfaces: (interfaces: string[]) => void;
    setNetNumaNodes: (nodes: number[]) => void;
    setCoreLoads: (loads: Record<number, number>) => void;
    setInstances: (instances: InstanceConfig) => void;
    setActiveTool: (tool: string | null) => void;
    setActiveTab: (tab: 'mapper' | 'compare' | 'optimize') => void;
    toggleSidebar: () => void;

    // Core painting
    paintCore: (cpuId: number, roleId: string) => void;
    eraseCore: (cpuId: number, roleId?: string) => void;

    // Reset
    reset: () => void;
}

const initialState = {
    serverName: '',
    date: '',
    rawInput: '',
    geometry: {},
    isolatedCores: [],
    coreNumaMap: {},
    l3Groups: {},
    networkInterfaces: [],
    netNumaNodes: [],
    coreLoads: {},
    instances: { Physical: {} },
    activeTool: null,
    activeTab: 'mapper' as const,
    sidebarCollapsed: false,
};

export const useAppStore = create<AppState>()(
    persist(
        (set, get) => ({
            ...initialState,

            setRawInput: (input) => set({ rawInput: input }),
            setServerInfo: (name, date) => set({ serverName: name, date }),
            setGeometry: (geometry) => set({ geometry }),
            setIsolatedCores: (cores) => set({ isolatedCores: cores }),
            setCoreNumaMap: (map) => set({ coreNumaMap: map }),
            setL3Groups: (groups) => set({ l3Groups: groups }),
            setNetworkInterfaces: (interfaces) => set({ networkInterfaces: interfaces }),
            setNetNumaNodes: (nodes) => set({ netNumaNodes: nodes }),
            setCoreLoads: (loads) => set({ coreLoads: loads }),
            setInstances: (instances) => set({ instances }),
            setActiveTool: (tool) => set({ activeTool: tool }),
            setActiveTab: (tab) => set({ activeTab: tab }),
            toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

            paintCore: (cpuId, roleId) => {
                const { instances, isolatedCores } = get();
                const cpuStr = String(cpuId);
                const current = instances.Physical[cpuStr] || [];

                if (!current.includes(roleId)) {
                    const updated = {
                        ...instances,
                        Physical: {
                            ...instances.Physical,
                            [cpuStr]: [...current, roleId],
                        },
                    };

                    // If painting an isolated role, add to isolated cores
                    const newIsolated = roleId !== 'sys_os' && !isolatedCores.includes(cpuId)
                        ? [...isolatedCores, cpuId]
                        : isolatedCores;

                    set({ instances: updated, isolatedCores: newIsolated });
                }
            },

            eraseCore: (cpuId, roleId) => {
                const { instances } = get();
                const cpuStr = String(cpuId);
                const current = instances.Physical[cpuStr] || [];

                let updated: string[];
                if (roleId) {
                    updated = current.filter(r => r !== roleId);
                } else {
                    updated = [];
                }

                const newInstances = {
                    ...instances,
                    Physical: {
                        ...instances.Physical,
                        [cpuStr]: updated,
                    },
                };

                // Clean up empty entries
                if (updated.length === 0) {
                    delete newInstances.Physical[cpuStr];
                }

                set({ instances: newInstances });
            },

            reset: () => set(initialState),
        }),
        {
            name: 'hft-cpu-mapper-storage',
            partialize: (state) => ({
                serverName: state.serverName,
                date: state.date,
                rawInput: state.rawInput,
                geometry: state.geometry,
                isolatedCores: state.isolatedCores,
                coreNumaMap: state.coreNumaMap,
                instances: state.instances,
                networkInterfaces: state.networkInterfaces,
                netNumaNodes: state.netNumaNodes,
            }),
        }
    )
);

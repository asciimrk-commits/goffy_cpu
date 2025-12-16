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
    previousInstances: InstanceConfig | null;

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
    setPreviousInstances: (instances: InstanceConfig | null) => void;
    setActiveTool: (tool: string | null) => void;
    setActiveTab: (tab: 'mapper' | 'compare' | 'optimize') => void;
    toggleSidebar: () => void;

    // Core painting
    paintCore: (cpuId: number, roleId: string) => void;
    eraseCore: (cpuId: number, roleId?: string) => void;
    assignInstanceToL3: (instanceId: string, l3Id: string) => void;

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
    previousInstances: null,
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
            setPreviousInstances: (prev) => set({ previousInstances: prev }),
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

            assignInstanceToL3: (instanceId, l3Id) => {
                const { instances, l3Groups, isolatedCores } = get();
                const l3Cores = l3Groups[l3Id] || [];

                // Get current assignments for this instance
                const currentMap = instances[instanceId];
                if (!currentMap || Object.keys(currentMap).length === 0) return;

                // Extract roles from current assignments
                // structure: [ { roles: [...] }, ... ]
                const tasksToMove: string[][] = Object.values(currentMap);

                // Simpler: 1. Clean up old. 2. Find free. 3. Assign.

                // 1. Clean up old assignments
                // Create a working copy of instances
                const nextInstances = JSON.parse(JSON.stringify(instances));

                // Remove from Physical using currentMap keys
                Object.keys(currentMap).forEach(cpuStr => {
                    if (nextInstances.Physical[cpuStr]) {
                        // Filter out roles that belong to this instance??
                        // Actually, instances[instanceId] stores roles for that instance.
                        // But Physical stores aggregated roles.
                        // If we assume strict ownership or just remove matching roles.
                        // Let's just remove the roles listed in currentMap[cpuStr].
                        const rolesToRemove = currentMap[cpuStr];
                        nextInstances.Physical[cpuStr] = nextInstances.Physical[cpuStr].filter((r: string) => !rolesToRemove.includes(r));
                    }
                });

                // Clear the instance specific map
                nextInstances[instanceId] = {};

                // 2. Find free cores NOW (after cleanup, check if target L3 has free cores)
                // Note: If we moved FROM this L3, cores are now free.
                const availableCores = l3Cores.filter(c => {
                    const cStr = String(c);
                    return !nextInstances.Physical[cStr] || nextInstances.Physical[cStr].length === 0;
                });

                // 3. Assign to available cores
                let assignedCount = 0;
                const newIsolated = [...isolatedCores];

                tasksToMove.forEach(roles => {
                    if (assignedCount < availableCores.length) {
                        const targetCpu = availableCores[assignedCount];
                        const targetStr = String(targetCpu);

                        // Update Physical
                        nextInstances.Physical[targetStr] = roles;

                        // Update Instance Map
                        nextInstances[instanceId][targetStr] = roles;

                        // Update Isolated (if needed)
                        if (!newIsolated.includes(targetCpu)) {
                            newIsolated.push(targetCpu);
                        }

                        assignedCount++;
                    } else {
                        // Overflow / Alert? 
                        // For now, just drop the roles if no space.
                        console.warn(`Not enough space in L3 ${l3Id} for instance ${instanceId}`);
                    }
                });

                set({ instances: nextInstances, isolatedCores: newIsolated });
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

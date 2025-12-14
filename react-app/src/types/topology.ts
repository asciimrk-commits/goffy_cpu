// CPU Topology Types

export interface CpuCore {
    id: number;
    socket: number;
    numa: number;
    l3: number;
    roles: string[];
    load?: number;
}

export interface Geometry {
    [socketId: string]: {
        [numaId: string]: {
            [l3Id: string]: number[];
        };
    };
}

export interface RoleDefinition {
    id: string;
    name: string;
    group: string;
    color: string;
    shortName?: string;
}

export interface InstanceConfig {
    Physical: { [cpuId: string]: string[] };
}

export interface TopologyState {
    serverName: string;
    date: string;
    geometry: Geometry;
    isolatedCores: Set<number>;
    coreNumaMap: Map<string | number, number>;
    l3Groups: { [l3Id: string]: number[] };
    networkInterfaces: string[];
    netNumaNodes: Set<number>;
    instances: InstanceConfig;
    coreLoads: Map<number, number>;
}

export interface ParsedConfig {
    serverName: string;
    date: string;
    geometry: Geometry;
    isolatedCores: number[];
    instances: InstanceConfig;
    netNumaNodes: number[];
}

export const ROLES: Record<string, RoleDefinition> = {
    sys_os: { id: 'sys_os', name: 'System (OS)', group: 'System', color: '#64748b' },
    net_irq: { id: 'net_irq', name: 'IRQ (Network)', group: 'Network Stack', color: '#ef4444' },
    udp: { id: 'udp', name: 'UDP Handler', group: 'Network Stack', color: '#f97316' },
    trash: { id: 'trash', name: 'Trash', group: 'Network Stack', color: '#eab308' },
    gateway: { id: 'gateway', name: 'Gateway', group: 'Gateways', color: '#f59e0b' },
    isolated_robots: { id: 'isolated_robots', name: 'Isolated Robots', group: 'Trading Logic', color: '#10b981' },
    pool1: { id: 'pool1', name: 'Robot Pool 1', group: 'Trading Logic', color: '#3b82f6' },
    pool2: { id: 'pool2', name: 'Robot Pool 2', group: 'Trading Logic', color: '#6366f1' },
    robot_default: { id: 'robot_default', name: 'Robot Default', group: 'Trading Logic', color: '#2ec4b6' },
    ar: { id: 'ar', name: 'AllRobotsTh', group: 'Trading Logic', color: '#8b5cf6' },
    allrobots_th: { id: 'allrobots_th', name: 'AllRobotsTh', group: 'Trading Logic', color: '#8b5cf6' },
    rf: { id: 'rf', name: 'RemoteFormula', group: 'Analytics', color: '#d946ef' },
    remoteformula: { id: 'remoteformula', name: 'RemoteFormula', group: 'Analytics', color: '#d946ef' },
    formula: { id: 'formula', name: 'Formula', group: 'Analytics', color: '#ec4899' },
    click: { id: 'click', name: 'ClickHouse', group: 'Analytics', color: '#14b8a6' },
    isolated: { id: 'isolated', name: 'Isolated', group: 'Other', color: '#64748b' },
};

export const BENDER_TO_ROLE: Record<string, string> = {
    'UdpReceiveCores': 'udp',
    'UdpSendCores': 'udp',
    'TrashCPU': 'trash',
    'GatewaysDefault': 'gateway',
    'Gateways': 'gateway',
    'IsolatedRobots': 'isolated_robots',
    'RobotsPool1': 'pool1',
    'RobotsPool2': 'pool2',
    'RobotsDefault': 'robot_default',
    'RobotsNode1': 'pool1',
    'RobotsNode2': 'pool2',
    'RobotsNode3': 'pool2',
    'AllRobotsThCPU': 'ar',
    'RemoteFormulaCPU': 'rf',
    'Formula': 'formula',
    'ClickHouseCores': 'click',
    'Isolated': 'isolated',
};

export const ROLE_TO_BENDER: Record<string, string> = {
    'udp': 'UdpReceiveCores',
    'trash': 'TrashCPU',
    'gateway': 'GatewaysDefault',
    'isolated_robots': 'IsolatedRobots',
    'pool1': 'RobotsNode1',
    'pool2': 'RobotsNode2',
    'robot_default': 'RobotsDefault',
    'ar': 'AllRobotsThCPU',
    'rf': 'RemoteFormulaCPU',
    'formula': 'Formula',
    'click': 'ClickHouseCores',
};

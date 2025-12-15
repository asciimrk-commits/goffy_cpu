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
    [instanceName: string]: { [cpuId: string]: string[] };
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
    // SYSTEM - Gray palette
    sys_os: { id: 'sys_os', name: 'System (OS)', group: 'System', color: '#5a6068' },

    // NETWORK STACK - Red/Orange palette  
    net_irq: { id: 'net_irq', name: 'IRQ (Network)', group: 'Network Stack', color: '#c04040' },
    udp: { id: 'udp', name: 'UDP Handler', group: 'Network Stack', color: '#d06030' },
    trash: { id: 'trash', name: 'Trash', group: 'Network Stack', color: '#b08020' },

    // GATEWAYS - Amber/Yellow palette
    gateway: { id: 'gateway', name: 'Gateway', group: 'Gateways', color: '#c09020' },

    // TRADING LOGIC - Blue/Green/Purple palette (distinct)
    isolated_robots: { id: 'isolated_robots', name: 'Isolated Robots', group: 'Trading Logic', color: '#208060' },
    pool1: { id: 'pool1', name: 'Robot Pool 1', group: 'Trading Logic', color: '#3060a0' },
    pool2: { id: 'pool2', name: 'Robot Pool 2', group: 'Trading Logic', color: '#4050b0' },
    robot_default: { id: 'robot_default', name: 'Robot Default', group: 'Trading Logic', color: '#306080' },
    ar: { id: 'ar', name: 'AllRobotsTh', group: 'Trading Logic', color: '#6050a0' },
    allrobots_th: { id: 'allrobots_th', name: 'AllRobotsTh', group: 'Trading Logic', color: '#6050a0' },

    // ANALYTICS - Purple/Pink palette
    rf: { id: 'rf', name: 'RemoteFormula', group: 'Analytics', color: '#8040a0' },
    remoteformula: { id: 'remoteformula', name: 'RemoteFormula', group: 'Analytics', color: '#8040a0' },
    formula: { id: 'formula', name: 'Formula', group: 'Analytics', color: '#a04080' },
    click: { id: 'click', name: 'ClickHouse', group: 'Analytics', color: '#207080' },

    // OTHER
    isolated: { id: 'isolated', name: 'Isolated', group: 'Other', color: '#404858' },
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

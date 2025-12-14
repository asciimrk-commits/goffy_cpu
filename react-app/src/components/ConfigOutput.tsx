import { useAppStore } from '../store/appStore';
import { formatCoreRange } from '../lib/parser';

export function ConfigOutput() {
    const {
        serverName,
        instances,
        isolatedCores,
        coreNumaMap,
        networkInterfaces,
    } = useAppStore();

    const generateConfig = () => {
        const physicalRoles: Record<string, number[]> = {};

        Object.entries(instances.Physical || {}).forEach(([cpu, tags]) => {
            tags.forEach(t => {
                if (!physicalRoles[t]) physicalRoles[t] = [];
                physicalRoles[t].push(parseInt(cpu));
            });
        });

        // Sort all role cores
        Object.keys(physicalRoles).forEach(role => {
            physicalRoles[role].sort((a, b) => a - b);
        });

        const instanceName = serverName?.toUpperCase() || 'INSTANCE';

        // Get all NUMAs for membind (always include all NUMAs in multi-NUMA system)
        const trashCpu = physicalRoles['trash']?.[0] || '';
        const allNumas = [...new Set(Object.values(coreNumaMap))].sort((a, b) => a - b);
        const membind = allNumas.join(',');

        // Build YAML-style bs_instances config
        let txt = 'bs_instances:\n';
        txt += `  ${instanceName}:\n`;
        txt += `    path: bender2-${instanceName}\n`;
        txt += `    name: ${instanceName}\n`;
        txt += `    id: 0\n`;
        txt += `    daemon_pri: dsf1.qb.loc:8051\n`;
        txt += `    daemon_sec: dsf3.qb.loc:8051\n`;
        txt += `    membind: "${membind}"\n`;
        txt += `    taskset: "${trashCpu}"\n`;
        txt += `    trash_cpu: "${trashCpu}"\n`;

        const arCpu = physicalRoles['ar']?.[0] || '';
        txt += `    allrobots_cpu: "${arCpu}"\n`;

        const rfCpu = physicalRoles['rf']?.[0] || physicalRoles['trash']?.[0] || '';
        txt += `    remoteformula_cpu: "${rfCpu}"\n`;

        const gwCores = physicalRoles['gateway'] || [];
        txt += `    gateways_cpu: ${gwCores.join(',')}\n`;

        const robotsCores = physicalRoles['robot_default'] || [];
        txt += `    robots_cpu: ${robotsCores.join(',')}\n`;

        const udpCores = physicalRoles['udp'] || [];
        txt += `    udpsend_cpu: "${udpCores[0] || ''}"\n`;
        txt += `    udpreceive_cpu: "${udpCores[0] || ''}"\n`;
        txt += `    udp_emitstats: true\n`;
        txt += `    type: colo\n`;

        txt += `    cpualias_custom:\n`;

        const formulaCpu = physicalRoles['formula']?.[0] || physicalRoles['trash']?.[0] || '';
        if (formulaCpu) {
            txt += `      - <CPUAlias Name="Formula" Cores="${formulaCpu}" IoService="true" Debug="false" />\n`;
        }

        const isolatedRobots = physicalRoles['isolated_robots'] || [];
        if (isolatedRobots.length > 0) {
            txt += `      - <CPUAlias Name="Isolated" Cores="${isolatedRobots.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO"/>\n`;
        }

        const pool1 = physicalRoles['pool1'] || [];
        if (pool1.length > 0) {
            txt += `      - <CPUAlias Name="RobotsNode1" Cores="${pool1.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO" />\n`;
        }

        const pool2 = physicalRoles['pool2'] || [];
        if (pool2.length > 0) {
            txt += `      - <CPUAlias Name="RobotsNode2" Cores="${pool2.join(',')}" Pool="1" Priority="10" SchedPolicy="FIFO" />\n`;
        }

        txt += '\n';
        const clickCores = physicalRoles['click'] || [];
        if (clickCores.length > 0) {
            txt += `clickhouse: ${clickCores.join(',')}\n`;
        }

        // System config block
        txt += '\n---\n';
        txt += 'hft_tunels: true\n';

        if (isolatedCores.length > 0) {
            txt += `isol_cpus: ${formatCoreRange(isolatedCores)}\n`;
        }

        const sysCores = (physicalRoles['sys_os'] || []).sort((a, b) => a - b);
        if (sysCores.length > 0) {
            txt += `irqaffinity_cpus: ${formatCoreRange(sysCores)}\n`;
        }

        const netCores = physicalRoles['net_irq'] || [];
        if (netCores.length > 0) {
            txt += '\nnet_cpus:\n';
            if (networkInterfaces.length > 0) {
                networkInterfaces.forEach(iface => {
                    txt += `  ${iface}: [${netCores.join(', ')}]\n`;
                });
            } else {
                txt += `  net0: [${netCores.join(', ')}]\n`;
            }
        }

        return txt;
    };

    const handleCopy = async () => {
        const config = generateConfig();
        await navigator.clipboard.writeText(config);
    };

    const config = generateConfig();
    const hasData = Object.keys(instances.Physical || {}).length > 0;

    if (!hasData) {
        return (
            <div className="config-output empty">
                <p>No configuration data yet</p>
            </div>
        );
    }

    return (
        <div className="config-output">
            <div className="config-header">
                <h4>📋 Config Output</h4>
                <button className="btn btn-primary btn-sm" onClick={handleCopy}>
                    Copy
                </button>
            </div>
            <pre className="config-content">{config}</pre>
        </div>
    );
}

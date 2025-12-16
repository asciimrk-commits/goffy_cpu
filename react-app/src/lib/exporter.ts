import type { InstanceConfig } from '../types/topology';

// Helper to collapse ranges 1,2,3 -> 1-3
function compressRange(nums: number[]): string {
    if (nums.length === 0) return '';
    const sorted = [...nums].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];
    let prev = start;

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== prev + 1) {
            ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
            start = sorted[i];
        }
        prev = sorted[i];
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    return ranges.join(',');
}

export function exportToBender(instances: InstanceConfig, isolatedCores: number[]): string {
    let yaml = '# Bender HFT Configuration\n';
    yaml += `# Generated: ${new Date().toISOString()}\n\n`;

    // System Section
    yaml += 'system:\n';
    yaml += `  isolated_cores: "${compressRange(isolatedCores)}"\n`;

    // Extract OS cores from Physical
    const physMap = instances.Physical || {};
    const osCores: number[] = [];

    Object.entries(physMap).forEach(([cpu, roles]) => {
        if (roles.includes('sys_os')) {
            osCores.push(Number(cpu));
        }
    });

    if (osCores.length > 0) {
        yaml += `  os_cores: "${compressRange(osCores)}"\n`;
    }

    yaml += '\ninstances:\n';

    // Detailed Instance Config
    Object.entries(instances).forEach(([name, coreMap]) => {
        if (name === 'Physical') return;

        yaml += `  ${name}:\n`;

        // Group by role
        const roleToCpus: Record<string, number[]> = {};

        Object.entries(coreMap).forEach(([cpuStr, roles]) => {
            const cpu = Number(cpuStr);
            roles.forEach(role => {
                if (!roleToCpus[role]) roleToCpus[role] = [];
                roleToCpus[role].push(cpu);
            });
        });

        // Output roles
        Object.entries(roleToCpus).sort().forEach(([role, cpus]) => {
            yaml += `    ${role}: "${compressRange(cpus)}"\n`;
        });

        yaml += '\n';
    });

    return yaml;
}

export function downloadYaml(filename: string, content: string) {
    const blob = new Blob([content], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

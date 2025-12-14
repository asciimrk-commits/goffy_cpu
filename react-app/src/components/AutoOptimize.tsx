import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import { ROLES } from '../types/topology';

export function AutoOptimize() {
    const {
        geometry,
        isolatedCores,
        netNumaNodes,
        setInstances,
    } = useAppStore();

    const [result, setResult] = useState<string | null>(null);
    const [recommendations, setRecommendations] = useState<Array<{
        title: string;
        description: string;
        cores: number[];
        role: string;
    }>>([]);

    const generateOptimization = () => {
        if (Object.keys(geometry).length === 0) {
            setResult('No topology data. Load server data first.');
            return;
        }

        const netNuma = netNumaNodes[0] ?? 1;
        const allCores: number[] = [];
        const coresByNuma: Record<number, number[]> = {};

        Object.values(geometry).forEach(socket => {
            Object.entries(socket).forEach(([numaId, l3Data]) => {
                const numa = parseInt(numaId);
                if (!coresByNuma[numa]) coresByNuma[numa] = [];
                Object.values(l3Data).forEach(cores => {
                    allCores.push(...cores);
                    coresByNuma[numa].push(...cores);
                });
            });
        });

        const isolatedSet = new Set(isolatedCores);
        const isoByNuma: Record<number, number[]> = {};

        Object.entries(coresByNuma).forEach(([numa, cores]) => {
            isoByNuma[parseInt(numa)] = cores.filter(c => isolatedSet.has(c));
        });

        const recs: typeof recommendations = [];
        const proposed: Record<string, string[]> = {};

        const osCores = allCores.filter(c => !isolatedSet.has(c)).slice(0, 8);
        recs.push({
            title: '🖥️ OS Cores',
            description: `System processes: ${osCores.length} cores`,
            cores: osCores,
            role: 'sys_os',
        });
        osCores.forEach(c => {
            proposed[String(c)] = ['sys_os'];
        });

        const netCores = (isoByNuma[netNuma] || []).slice(0, 6);
        if (netCores.length > 0) {
            recs.push({
                title: '🌐 Network IRQ',
                description: `IRQ handlers on NUMA ${netNuma}`,
                cores: netCores,
                role: 'net_irq',
            });
            netCores.forEach(c => {
                proposed[String(c)] = ['net_irq'];
            });
        }

        const gwCores = (isoByNuma[netNuma] || []).filter(c => !netCores.includes(c)).slice(0, 10);
        if (gwCores.length > 0) {
            recs.push({
                title: '🚪 Gateways',
                description: `Gateway processes: ${gwCores.length} cores`,
                cores: gwCores,
                role: 'gateway',
            });
            gwCores.forEach(c => {
                proposed[String(c)] = ['gateway'];
            });
        }

        const workNumas = Object.keys(coresByNuma)
            .map(Number)
            .filter(n => n !== netNuma)
            .sort();

        workNumas.forEach((numa, idx) => {
            const availCores = (isoByNuma[numa] || []).filter(c => !proposed[String(c)]);
            if (availCores.length > 0) {
                const role = idx === 0 ? 'pool1' : 'pool2';
                const name = idx === 0 ? 'Robot Pool 1' : 'Robot Pool 2';
                recs.push({
                    title: `🤖 ${name}`,
                    description: `NUMA ${numa}: ${availCores.length} cores`,
                    cores: availCores,
                    role,
                });
                availCores.forEach(c => {
                    proposed[String(c)] = [role];
                });
            }
        });

        setRecommendations(recs);
        setResult(`Generated ${recs.length} recommendations`);
    };

    const applyRecommendations = () => {
        const proposed: Record<string, string[]> = {};
        recommendations.forEach(rec => {
            rec.cores.forEach(c => {
                if (!proposed[String(c)]) proposed[String(c)] = [];
                proposed[String(c)].push(rec.role);
            });
        });
        setInstances({ Physical: proposed });
        setResult('Applied! Check topology map.');
    };

    return (
        <div className="optimize-container">
            <div className="optimize-header">
                <h2>⚡ Auto-Optimization Engine</h2>
                <p>Generate optimized configuration based on BenderServer best practices</p>
            </div>

            <div className="optimize-actions">
                <button className="btn btn-primary btn-lg" onClick={generateOptimization}>
                    🔄 Generate Optimization
                </button>
                {recommendations.length > 0 && (
                    <button className="btn btn-secondary" onClick={applyRecommendations}>
                        ✅ Apply to Map
                    </button>
                )}
            </div>

            {result && (
                <div className="optimize-result">
                    <p>{result}</p>
                </div>
            )}

            {recommendations.length > 0 && (
                <div className="optimize-recommendations">
                    {recommendations.map((rec, idx) => (
                        <div key={idx} className="recommend-card">
                            <h4>{rec.title}</h4>
                            <p>{rec.description}</p>
                            <div className="recommend-cores">
                                {rec.cores.map(c => (
                                    <span
                                        key={c}
                                        className="recommend-core"
                                        style={{ backgroundColor: ROLES[rec.role]?.color || '#64748b' }}
                                    >
                                        {c}
                                    </span>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

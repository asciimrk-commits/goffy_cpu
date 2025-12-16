import { useMemo } from 'react';
import { useAppStore } from '../store/appStore';
import type { L3Zone } from '../lib/hftOptimizer';

interface Violation {
    id: string;
    type: 'error' | 'warning';
    rule: string;
    message: string;
    coreId?: number;
}

/**
 * ValidationPanel - Real-time L3 Guard
 * 
 * Checks:
 * - Rule 1 (Golden Rule): Gateway + OS in same L3 → Critical
 * - Rule 2 (NUMA Locality): Gateway + IRQ cross-NUMA → Warning
 * - Rule 3 (Zone Purity): Service bundles in GOLD L3 → Warning
 */
export function ValidationPanel() {
    const { geometry, instances, netNumaNodes } = useAppStore();

    const violations = useMemo(() => {
        const result: Violation[] = [];

        if (!geometry || Object.keys(geometry).length === 0) {
            return result;
        }

        // Build core → L3 mapping and detect zones
        const coreToL3: Record<number, string> = {};
        const l3Zones: Record<string, L3Zone> = {};
        const coreRoles: Record<number, string[]> = {};

        Object.entries(geometry).forEach(([_socketId, numaData]) => {
            Object.entries(numaData).forEach(([numaId, l3Data]) => {
                const isNetNuma = netNumaNodes.includes(parseInt(numaId));

                Object.entries(l3Data).forEach(([l3Id, cores]) => {
                    const hasCore0 = cores.includes(0);

                    // Determine zone
                    if (hasCore0) {
                        l3Zones[l3Id] = 'dirty';
                    } else if (isNetNuma) {
                        l3Zones[l3Id] = 'gold';
                    } else {
                        l3Zones[l3Id] = 'silver';
                    }

                    cores.forEach(c => {
                        coreToL3[c] = l3Id;
                    });
                });
            });
        });

        // Collect roles per core
        Object.entries(instances).forEach(([_instName, coreMap]) => {
            Object.entries(coreMap).forEach(([coreStr, roles]) => {
                const coreId = parseInt(coreStr);
                if (!coreRoles[coreId]) coreRoles[coreId] = [];
                coreRoles[coreId].push(...roles);
            });
        });

        // Check violations
        Object.entries(coreRoles).forEach(([coreStr, roles]) => {
            const coreId = parseInt(coreStr);
            const l3Id = coreToL3[coreId];
            const zone = l3Zones[l3Id];

            // Rule 1: Gateway on DIRTY L3
            if (roles.includes('gateway') && zone === 'dirty') {
                result.push({
                    id: `gw-dirty-${coreId}`,
                    type: 'error',
                    rule: 'Golden Rule',
                    message: `Gateway on Core ${coreId} shares L3 with OS/Trash`,
                    coreId
                });
            }

            // Rule 3: Trash/ClickHouse on GOLD L3
            if ((roles.includes('trash') || roles.includes('clickhouse') || roles.includes('rf')) && zone === 'gold') {
                result.push({
                    id: `trash-gold-${coreId}`,
                    type: 'warning',
                    rule: 'Zone Purity',
                    message: `Service role on Core ${coreId} is in GOLD L3 (should be DIRTY)`,
                    coreId
                });
            }
        });

        return result;
    }, [geometry, instances, netNumaNodes]);

    const errors = violations.filter(v => v.type === 'error');
    const warnings = violations.filter(v => v.type === 'warning');

    if (violations.length === 0) {
        return (
            <div style={{
                padding: '12px',
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid var(--color-success)',
                borderRadius: 'var(--radius-md)',
                fontSize: '12px',
                color: 'var(--color-success)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
            }}>
                <span style={{ fontSize: '16px' }}>✓</span>
                <span>No violations detected</span>
            </div>
        );
    }

    return (
        <div style={{ fontSize: '12px' }}>
            {/* Errors */}
            {errors.length > 0 && (
                <div style={{ marginBottom: '12px' }}>
                    <div style={{
                        fontWeight: 600,
                        color: 'var(--color-danger)',
                        marginBottom: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                    }}>
                        <span style={{ fontSize: '14px' }}>⚠️</span>
                        Errors ({errors.length})
                    </div>
                    {errors.map(err => (
                        <div
                            key={err.id}
                            style={{
                                padding: '8px 12px',
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid var(--color-danger)',
                                borderRadius: 'var(--radius-sm)',
                                marginBottom: '6px'
                            }}
                        >
                            <div style={{ fontWeight: 600, color: 'var(--color-danger)' }}>
                                {err.rule}
                            </div>
                            <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                                {err.message}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Warnings */}
            {warnings.length > 0 && (
                <div>
                    <div style={{
                        fontWeight: 600,
                        color: 'var(--color-warning)',
                        marginBottom: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                    }}>
                        <span style={{ fontSize: '14px' }}>⚡</span>
                        Warnings ({warnings.length})
                    </div>
                    {warnings.map(warn => (
                        <div
                            key={warn.id}
                            style={{
                                padding: '8px 12px',
                                background: 'rgba(245, 158, 11, 0.1)',
                                border: '1px solid var(--color-warning)',
                                borderRadius: 'var(--radius-sm)',
                                marginBottom: '6px'
                            }}
                        >
                            <div style={{ fontWeight: 600, color: 'var(--color-warning)' }}>
                                {warn.rule}
                            </div>
                            <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                                {warn.message}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

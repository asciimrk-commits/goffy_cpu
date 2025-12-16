import { type ReactNode } from 'react';
import { useDrop } from 'react-dnd';
import { type L3Zone } from '../lib/hftOptimizer';
import { ZONE_COLORS } from '../context/ThemeContext';

interface L3IslandProps {
    l3Id: string;
    zone: L3Zone;
    numa: number;
    coreCount: number;
    children: ReactNode;
    onDropInstance?: (instanceId: string) => void;
}

/**
 * L3Island - Visual container for cores within an L3 cache
 * 
 * Displays zone-specific styling:
 * - DIRTY (red): OS + Service bundles
 * - GOLD (amber): Gateways + IRQ
 * - SILVER (grey): Robots + overflow
 */
export function L3Island({ l3Id, zone, numa, coreCount, children, onDropInstance }: L3IslandProps) {
    const [{ isOver }, drop] = useDrop(() => ({
        accept: 'INSTANCE',
        drop: (item: { instanceId: string }) => {
            if (onDropInstance) onDropInstance(item.instanceId);
        },
        collect: (monitor) => ({
            isOver: !!monitor.isOver(),
        }),
    }));

    const zoneStyle = ZONE_COLORS[zone];

    const zoneLabel = {
        dirty: 'DIRTY',
        gold: 'GOLD',
        silver: 'SILVER'
    }[zone];

    const zoneIcon = {
        dirty: '⚠️',
        gold: '⭐',
        silver: '◆'
    }[zone];

    return (
        <div
            ref={drop as unknown as React.RefObject<HTMLDivElement>}
            className="l3-island"
            style={{
                background: isOver ? `${zoneStyle.bg.replace('0.1', '0.3')}` : zoneStyle.bg,
                border: isOver ? `2px dashed ${zoneStyle.border}` : `2px solid ${zoneStyle.border}`,
                borderRadius: 'var(--radius-lg)',
                padding: '12px',
                marginBottom: '12px',
                position: 'relative',
                transition: 'all 0.2s',
                transform: isOver ? 'scale(1.02)' : 'scale(1)',
                boxShadow: isOver ? `0 0 15px ${zoneStyle.border}40` : 'none'
            }}
        >
            {/* L3 Header */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '10px',
                paddingBottom: '8px',
                borderBottom: `1px solid ${zoneStyle.border}40`
            }}>
                {/* L3 ID and Zone badge */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '11px',
                        color: 'var(--text-muted)'
                    }}>
                        L3 #{l3Id}
                    </span>

                    {/* Zone badge */}
                    <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        background: zoneStyle.border,
                        color: zone === 'silver' ? 'white' : '#000',
                        fontSize: '9px',
                        fontWeight: 700,
                        letterSpacing: '0.5px'
                    }}>
                        {zoneIcon} {zoneLabel}
                    </span>
                </div>

                {/* Core count */}
                <span style={{
                    fontSize: '10px',
                    color: zoneStyle.label,
                    fontFamily: 'var(--font-mono)'
                }}>
                    {coreCount} cores
                </span>
            </div>

            {/* Cores grid */}
            <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--gap-core)'
            }}>
                {children}
            </div>

            {/* NUMA indicator */}
            <div style={{
                position: 'absolute',
                top: '-8px',
                right: '12px',
                padding: '2px 6px',
                background: 'var(--bg-panel)',
                border: '1px solid var(--border-color)',
                borderRadius: '4px',
                fontSize: '9px',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)'
            }}>
                NUMA {numa}
            </div>
        </div>
    );
}

/**
 * Compact L3 badge for legend/summary
 */
export function L3ZoneBadge({ zone }: { zone: L3Zone }) {
    const zoneStyle = ZONE_COLORS[zone];
    const label = zone.toUpperCase();

    return (
        <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '3px 8px',
            borderRadius: '4px',
            background: zoneStyle.bg,
            border: `1px solid ${zoneStyle.border}`,
            fontSize: '10px',
            fontWeight: 600,
            color: zoneStyle.label
        }}>
            {label}
        </span>
    );
}

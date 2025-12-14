import { useState } from 'react';
import { ROLES } from '../types/topology';
import './Tooltip.css';

interface TooltipProps {
    cpuId: number;
    roles: string[];
    load?: number;
    isIsolated: boolean;
    children: React.ReactNode;
}

export function CoreTooltip({ cpuId, roles, load, isIsolated, children }: TooltipProps) {
    const [show, setShow] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });

    const handleMouseEnter = (e: React.MouseEvent) => {
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        setPosition({ x: rect.left + rect.width / 2, y: rect.top });
        setShow(true);
    };

    const handleMouseLeave = () => {
        setShow(false);
    };

    return (
        <div
            className="tooltip-wrapper"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            {children}
            {show && (
                <div
                    className="custom-tooltip"
                    style={{
                        left: position.x,
                        top: position.y - 8,
                    }}
                >
                    <div className="tooltip-header">
                        <span className="tooltip-cpu">CPU {cpuId}</span>
                        {isIsolated && <span className="tooltip-badge isolated">ISOLATED</span>}
                    </div>
                    {load !== undefined && (
                        <div className="tooltip-load">
                            Load: <span className="load-value">{load.toFixed(1)}%</span>
                        </div>
                    )}
                    {roles.length > 0 ? (
                        <div className="tooltip-roles">
                            {roles.map(r => (
                                <div key={r} className="tooltip-role">
                                    <span
                                        className="role-color"
                                        style={{ backgroundColor: ROLES[r]?.color || '#64748b' }}
                                    />
                                    <span className="role-name">{ROLES[r]?.name || r}</span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="tooltip-empty">No roles assigned</div>
                    )}
                </div>
            )}
        </div>
    );
}

export type GaugeStatus = 'ok' | 'warn' | 'error' | 'neutral';

interface GaugeProps {
  label: string;
  /** Main center value (e.g. model name, provider, "--"). */
  value: string;
  /** Secondary center line (e.g. provider, state word). */
  sub?: string;
  /** Third center line (e.g. APPLIED / DRIFT). */
  state?: string;
  status: GaugeStatus;
  /** 0..1 fill of the arc; null = indeterminate (dim track only). */
  fill?: number | null;
  size?: number;
}

const COLORS: Record<GaugeStatus, { arc: string; text: string; glow: string }> = {
  ok: { arc: 'var(--gauge-ok)', text: 'var(--text-strong)', glow: 'none' },
  warn: { arc: 'var(--gauge-warn)', text: 'var(--text-strong)', glow: 'none' },
  error: { arc: 'var(--gauge-error)', text: 'var(--text-strong)', glow: 'none' },
  neutral: { arc: 'var(--gauge-neutral)', text: 'var(--text-dim)', glow: 'none' },
};

/**
 * Cockpit-style SVG gauge. A 270-degree arc with tick marks, semantic status
 * coloring, and up to three center readouts. No animation loops; the arc only
 * changes when real data changes.
 */
export function Gauge({ label, value, sub, state, status, fill = null, size = 240 }: GaugeProps) {
  const stroke = 10;
  const r = (size - stroke * 2) / 2 - 14;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = 135; // degrees; 270-degree sweep
  const sweep = 270;
  const colors = COLORS[status];

  const polar = (angleDeg: number): [number, number] => {
    const rad = (angleDeg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };

  const [sx, sy] = polar(startAngle);
  const [ex, ey] = polar(startAngle + sweep);

  const trackPath = `M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`;
  const clampedFill = fill === null ? null : Math.max(0, Math.min(1, fill));
  const valueSweep = clampedFill === null ? 0 : sweep * clampedFill;
  const [vx, vy] = polar(startAngle + valueSweep);
  const valuePath =
    clampedFill === null || clampedFill <= 0
      ? null
      : `M ${sx} ${sy} A ${r} ${r} 0 ${valueSweep > 180 ? 1 : 0} 1 ${vx} ${vy}`;

  const ticks = Array.from({ length: 10 }, (_, i) => startAngle + (sweep / 9) * i);

  return (
    <div className="gauge" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${value}${sub ? ` ${sub}` : ''}${state ? ` ${state}` : ''}`}>
        {/* track */}
        <path d={trackPath} fill="none" stroke="var(--gauge-track)" strokeWidth={stroke} strokeLinecap="round" />
        {/* value arc */}
        {valuePath && (
          <path d={valuePath} fill="none" stroke={colors.arc} strokeWidth={stroke} strokeLinecap="round" />
        )}
        {/* ticks */}
        {ticks.map((angle, i) => {
          const [x1, y1] = polar(angle);
          const rad = (angle * Math.PI) / 180;
          const x2 = cx + (r + 10) * Math.cos(rad);
          const y2 = cy + (r + 10) * Math.sin(rad);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--gauge-tick)" strokeWidth={2} />;
        })}
      </svg>
      <div className="gauge-center">
        <span className="gauge-label">{label}</span>
        <span className={`gauge-value ${status}`}>{value}</span>
        {sub && <span className="gauge-sub">{sub}</span>}
        {state && <span className={`gauge-state ${status}`}>{state}</span>}
      </div>
    </div>
  );
}

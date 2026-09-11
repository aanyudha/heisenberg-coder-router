interface TelemetryTileProps {
  label: string;
  /** Preformatted value or null. null renders as '--' (unknown, NOT zero). */
  value: string | null;
  unit?: string;
  /** Tooltip/help text, e.g. why a metric is unavailable. */
  help?: string;
}

/**
 * Compact telemetry readout. Truthfulness rule: a null value renders as '--'.
 * Unknown is never displayed as zero.
 */
export function TelemetryTile({ label, value, unit, help }: TelemetryTileProps) {
  const display = value === null || value === undefined ? '--' : value;
  return (
    <div
      className={`telemetry-tile ${value === null || value === undefined ? 'telemetry-unavailable' : ''}`}
      title={help ?? (value === null || value === undefined ? 'Not observed' : undefined)}
    >
      <span className="telemetry-value">{display}</span>
      <span className="telemetry-unit">{unit ?? label}</span>
    </div>
  );
}

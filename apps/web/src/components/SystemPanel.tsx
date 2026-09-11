type Led = 'ok' | 'warn' | 'error' | 'neutral';

interface SystemRow {
  label: string;
  value: string;
  led: Led;
  detail?: string;
}

interface SystemPanelProps {
  codex: { installed: boolean; version?: string; path?: string };
  ollama: { online: boolean; endpoint: string; modelCount: number; version?: string };
  route: { status: 'applied' | 'drift' | 'not_configured' | 'error'; detail?: string };
  config: { synced: boolean; detail?: string };
  vscode: { detected: boolean; confirmed: boolean; detail: string };
}

/** VS Code status label follows the strict truthfulness rules. */
export function vscodeStatusLabel(vscode: SystemPanelProps['vscode']): {
  label: string;
  led: Led;
} {
  if (!vscode.detected) return { label: 'Not Detected', led: 'neutral' };
  if (vscode.confirmed) return { label: 'Uses HCR Route', led: 'ok' };
  return { label: 'Route Not Verified', led: 'warn' };
}

export function SystemPanel({ codex, ollama, route, config, vscode }: SystemPanelProps) {
  const rows: SystemRow[] = [
    {
      label: 'Codex',
      value: codex.installed ? 'Installed' : 'Not Installed',
      led: codex.installed ? 'ok' : 'error',
      detail: codex.version ?? undefined,
    },
    {
      label: 'Ollama',
      value: ollama.online ? 'Online' : 'Offline',
      led: ollama.online ? 'ok' : 'neutral',
      detail: ollama.online ? `${ollama.modelCount} model(s) · ${ollama.endpoint}` : ollama.endpoint,
    },
    {
      label: 'Route',
      value:
        route.status === 'applied'
          ? 'Applied'
          : route.status === 'drift'
            ? 'Drift'
            : route.status === 'error'
              ? 'Error'
              : 'Not Configured',
      led:
        route.status === 'applied'
          ? 'ok'
          : route.status === 'drift'
            ? 'error'
            : route.status === 'error'
              ? 'error'
              : 'warn',
      detail: route.detail,
    },
    {
      label: 'Config',
      value: config.synced ? 'Synced' : 'Drifted',
      led: config.synced ? 'ok' : 'warn',
      detail: config.detail,
    },
    (() => {
      const vs = vscodeStatusLabel(vscode);
      return { label: 'VS Code Codex', value: vs.label, led: vs.led, detail: vscode.detail };
    })(),
  ];

  return (
    <div className="system-panel">
      <div className="panel-title">SYSTEM</div>
      {rows.map((row) => (
        <div key={row.label} className="system-row" title={row.detail}>
          <span className="system-label">{row.label}</span>
          <span className="system-value">
            <span className={`led ${row.led}`} aria-hidden="true" /> {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

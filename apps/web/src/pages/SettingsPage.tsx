import { useState } from 'react';
import { Card, PageHeader, Badge, KeyValue, StatTile } from '../components/ui';
import { useHcr } from '../hcr-context';
import { apiPost, formatTime } from '../api';
import type { PageId } from '../nav';

export function SettingsPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { status, verify, companion, online, refresh } = useHcr();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
      setNotice(`${label} completed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  const routing = status?.routing;

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Server, configuration and maintenance. HCR stores routing state locally and keeps no cloud account."
      />

      {error ? <div className="notice notice-error">{error}</div> : null}
      {notice ? <div className="notice notice-info" style={{ marginTop: error ? 8 : 0 }}>{notice}</div> : null}

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <div className="stack">
          <Card title="Server">
            <KeyValue label="Endpoint" value={status ? `${status.server.host}:${status.server.port}` : '—'} mono />
            <KeyValue label="State" value={online ? 'Online' : 'Offline'} />
            <KeyValue label="Ollama endpoint" value={status?.ollama.endpoint ?? '—'} mono />
            <KeyValue label="Ollama version" value={status?.ollama.version ?? '—'} />
            <KeyValue label="Codex CLI" value={status?.codex.installed ? (status.codex.version ?? 'Installed') : 'Not Installed'} />
            <KeyValue label="Codex path" value={status?.codex.path ?? '—'} mono />
          </Card>

          <Card title="Codex Configuration">
            <KeyValue label="Config path" value={routing?.configPath ?? '—'} mono />
            <KeyValue label="Backup" value={routing?.backupPath ?? '—'} mono />
            <KeyValue label="Route status" value={routing ? routing.status.replace(/_/g, ' ') : '—'} />
            <KeyValue
              label="Verification"
              value={verify?.layers ? (verify.layers.configSynced ? 'Config synced' : 'Config drifted') : 'pending'}
            />
            <KeyValue
              label="VS Code Codex"
              value={
                verify
                  ? verify.vscodeCodex.detected
                    ? verify.vscodeCodex.confirmed
                      ? 'Uses HCR route'
                      : 'Route not verified'
                    : 'Not detected'
                  : '—'
              }
            />
            <p className="muted small" style={{ marginTop: 10 }}>
              HCR only mutates the settings it owns inside the Codex config; other keys, sections and comments are
              preserved.
            </p>
          </Card>

          <Card title="Project">
            <KeyValue label="Active project" value={status?.project?.name ?? '—'} />
            <KeyValue label="Path" value={status?.project?.path ?? '—'} mono />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn btn-sm" type="button" onClick={() => onNavigate('projects')}>
                Manage Projects
              </button>
            </div>
          </Card>
        </div>

        <div className="stack">
          <Card title="Maintenance">
            <div className="row">
              <button
                className="btn"
                type="button"
                disabled={busy || !online}
                onClick={() => void act('Status refresh', async () => undefined)}
              >
                Refresh Status
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || !online}
                onClick={() => void act('Ollama refresh', async () => {
                  await apiPost('/api/ollama/refresh', undefined, { action: 'Could not refresh Ollama models.' });
                })}
              >
                Refresh Ollama
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || !online}
                onClick={() => void act('Routing verification', async () => undefined)}
              >
                Re-verify Routing
              </button>
              <button className="btn btn-sm" type="button" onClick={() => onNavigate('browser-companion')}>
                Companion Setup
              </button>
            </div>
          </Card>

          <Card title="Privacy & Data">
            <div className="stat-grid">
              <StatTile label="ChatGPT credentials" value="Never stored" tone="ok" />
              <StatTile label="OpenAI API keys" value="Never used" tone="ok" />
              <StatTile label="Prompt contents" value="Not persisted" tone="ok" />
              <StatTile label="Auto-apply" value="Disabled" tone="info" />
            </div>
            <ul className="steps-list" style={{ marginTop: 12 }}>
              <li>Local SQLite database in <code className="mono">data/router.sqlite</code>.</li>
              <li>Gateway log keeps request metadata only, in a bounded ring buffer.</li>
              <li>Web Handoff context is rebuilt per handoff and never uploaded by HCR itself.</li>
              <li>The pairing secret never leaves this machine and is never sent to chatgpt.com.</li>
            </ul>
          </Card>

          <Card title="Companion">
            <KeyValue label="Connection" value={companion ? (companion.connected ? 'Connected' : 'Not Connected') : '—'} />
            <Badge tone={companion?.paired ? 'ok' : 'warn'}>{companion?.paired ? 'Paired' : 'Not Paired'}</Badge>
            <KeyValue
              label="Last heartbeat"
              value={companion?.lastSeenAt ? formatTime(companion.lastSeenAt) : '—'}
            />
            <p className="muted small" style={{ marginTop: 10 }}>
              Rotate the pairing secret from the Browser Companion page if you suspect the extension was compromised.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

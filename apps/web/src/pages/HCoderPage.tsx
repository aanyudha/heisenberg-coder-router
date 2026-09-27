import { useCallback, useEffect, useState } from 'react';
import { Card, PageHeader, Badge, StatTile, KeyValue, Field } from '../components/ui';
import { apiGet, apiPost, formatBytes } from '../api';
import type { HcoderStatus } from '../types';

const ROUTES: Array<{ id: 'companion' | 'ollama'; label: string; hint: string }> = [
  {
    id: 'companion',
    label: 'ChatGPT Web (Browser Companion)',
    hint: 'Turns go through your own ChatGPT tab - same Project, same chat session for every round.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    hint: 'Turns go to a selected local Ollama model through HCR. No cloud traffic.',
  },
];

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`;
}

function destinationLabel(status: HcoderStatus): string {
  if (status.route === 'ollama') return '-';
  const destination = status.destination;
  if (!destination) return 'Current ChatGPT tab (the first turn creates the session)';
  const parts = [
    destination.chatgptProjectName || destination.chatgptProjectId,
    destination.chatTitle,
    destination.chatUrl,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : 'Saved ChatGPT session';
}

/**
 * HCoder dashboard: the local coding agent's control surface.
 *
 * Shows which intelligence route answers HCoder turns (companion vs Ollama),
 * the package install/update commands and the safety model. Patch review and
 * apply stay in the CLI (`hcoder diff` / `hcoder apply`) - this page never
 * writes to a project.
 */
export function HCoderPage() {
  const [status, setStatus] = useState<HcoderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await apiGet<HcoderStatus>('/api/hcoder/status', { action: 'Could not load HCoder status.' }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load HCoder status');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchRoute = async (route: 'companion' | 'ollama') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiPost<{ route: string; routeLabel: string }>('/api/hcoder/route', { route }, {
        action: 'Could not switch the HCoder route.',
      });
      setNotice(`Route set to ${result.routeLabel}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Route switch failed');
    } finally {
      setBusy(false);
    }
  };

  const limits = status?.limits;
  const packageInfo = status?.package;
  const routeReady =
    status?.route === 'ollama'
      ? Boolean(status.model)
      : Boolean(status?.companion?.paired && status?.companion?.connected);

  return (
    <>
      <PageHeader
        title="HCoder"
        subtitle="Local coding agent for HCR: bounded read-only tools, staged patches and an explicit apply. HCR picks the intelligence route - HCoder never talks to a provider directly."
        actions={
          packageInfo?.available ? (
            <a className="btn btn-sm btn-primary" href="/downloads/hcoder-latest.tgz" download>
              Download HCoder CLI
            </a>
          ) : (
            <a className="btn btn-sm" href="/downloads/hcoder-latest.tgz" download>
              Download HCoder CLI
            </a>
          )
        }
      />

      {error ? <div className="notice notice-error">{error}</div> : null}
      {notice ? (
        <div className="notice notice-info" style={{ marginTop: error ? 8 : 0 }}>
          {notice}
        </div>
      ) : null}

      <div className="grid grid-3" style={{ marginTop: 14 }}>
        <StatTile
          label="Active Route"
          value={status?.routeLabel ?? 'Unknown'}
          tone={routeReady ? 'ok' : 'warn'}
          hint={status ? `provider: ${status.provider}${status.model ? ` · ${status.model}` : ''}` : 'loading…'}
        />
        <StatTile
          label="Intelligence"
          value={status?.online ? 'HCR Online' : 'HCR Offline'}
          tone={status?.online ? 'ok' : 'error'}
          hint={status ? `HCoder ${status.version} · agent protocol HCODER_AGENT_V1` : undefined}
        />
        <StatTile
          label="Package"
          value={packageInfo?.available ? formatBytes(packageInfo.bytes) : 'Not Built'}
          tone={packageInfo?.available ? 'ok' : 'warn'}
          hint={packageInfo ? packageInfo.filename : undefined}
        />
      </div>

      <div className="grid grid-sidebar" style={{ marginTop: 14 }}>
        <div className="stack">
          <Card title="Intelligence Route">
            <p className="muted small">
              One route answers every HCoder turn. There is no silent fallback: if the selected route cannot answer,
              HCoder fails with a deterministic code instead of quietly switching providers.
            </p>
            <div className="stack">
              {ROUTES.map((route) => {
                const active = status?.route === route.id;
                return (
                  <div key={route.id} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                    <div>
                      <strong>{route.label}</strong>
                      <p className="muted small" style={{ margin: 0 }}>
                        {route.hint}
                      </p>
                    </div>
                    <button
                      className={`btn btn-sm ${active ? 'btn-primary' : ''}`}
                      type="button"
                      disabled={busy || active}
                      onClick={() => void switchRoute(route.id)}
                    >
                      {active ? 'Active' : 'Use Route'}
                    </button>
                  </div>
                );
              })}
            </div>

            {status?.route === 'companion' && !routeReady ? (
              <div className="notice notice-error" style={{ marginTop: 10 }}>
                Browser Companion is {status?.companion?.paired ? 'not connected' : 'not paired'}. Pair the extension
                on the Browser Companion page, or switch to the Ollama route.
              </div>
            ) : null}
            {status?.route === 'ollama' && !routeReady ? (
              <div className="notice notice-error" style={{ marginTop: 10 }}>
                No Ollama model is selected. Apply an Ollama route on the Routing page first.
              </div>
            ) : null}
          </Card>

          <Card title="Install / Update">
            <Field label="Install (local npm tarball served by HCR)">
              <code className="mono code-block">{packageInfo?.installCommand ?? 'npm install -g http://127.0.0.1:7876/downloads/hcoder-latest.tgz'}</code>
            </Field>
            <Field label="Update">
              <code className="mono code-block">{packageInfo?.updateCommand ?? 'npm install -g --force http://127.0.0.1:7876/downloads/hcoder-latest.tgz'}</code>
            </Field>
            <Field label="Uninstall">
              <code className="mono code-block">{packageInfo?.uninstallCommand ?? 'npm uninstall -g @heisenberg/hcoder'}</code>
            </Field>
            <p className="muted small" style={{ marginTop: 8 }}>
              {packageInfo?.available
                ? `Tarball served at ${packageInfo.url} (HCR origin http://127.0.0.1:7876).`
                : 'Tarball not built yet - run "npm run build" to package the CLI.'}
            </p>
          </Card>

          <Card title="Everyday Commands">
            <Field label="Run a task (stages a patch, never applies it)">
              <code className="mono code-block">hcoder &quot;add input validation to the parser&quot;</code>
            </Field>
            <Field label="Review / apply / rollback">
              <code className="mono code-block">hcoder diff{'\n'}hcoder apply{'\n'}hcoder revert</code>
            </Field>
            <Field label="Route, history, status">
              <code className="mono code-block">hcoder route{'\n'}hcoder history{'\n'}hcoder status --json</code>
            </Field>
          </Card>
        </div>

        <div className="stack">
          <Card title="Live Status">
            <KeyValue label="Version" value={status?.version ?? '—'} />
            <KeyValue label="Route" value={status ? `${status.routeLabel} (${status.route})` : '—'} />
            <KeyValue
              label="Provider"
              value={status ? `${status.provider}${status.model ? ` · ${status.model}` : ''}` : '—'}
            />
            <KeyValue label="Destination" value={status ? destinationLabel(status) : '—'} />
            <KeyValue
              label="Companion"
              value={
                status?.companion
                  ? `${status.companion.paired ? 'paired' : 'not paired'}, ${
                      status.companion.connected ? 'connected' : 'not connected'
                    }`
                  : '—'
              }
            />
            <div className="row" style={{ marginTop: 10 }}>
              <Badge tone={routeReady ? 'ok' : 'warn'}>{routeReady ? 'READY' : 'NOT READY'}</Badge>
              <button className="btn btn-sm" type="button" onClick={() => void load()}>
                Refresh
              </button>
            </div>
          </Card>

          <Card title="Limits">
            {limits ? (
              <>
                <KeyValue label="Agent rounds" value={String(limits.maxRounds)} mono />
                <KeyValue label="Tool requests / round" value={String(limits.maxToolRequestsPerRound)} mono />
                <KeyValue label="Bytes / file" value={kb(limits.maxBytesPerFile)} mono />
                <KeyValue label="Tool bytes / round" value={kb(limits.maxResultBytesPerRound)} mono />
                <KeyValue label="Tool bytes / task" value={kb(limits.maxTotalToolResultBytes)} mono />
                <KeyValue label="Search results" value={String(limits.maxSearchResults)} mono />
              </>
            ) : (
              <p className="muted small">Loading limits…</p>
            )}
          </Card>

          <Card title="Safety Model">
            <ul className="steps-list">
              <li>The AI never touches the filesystem: tools are bounded, read-only and sandboxed to the project.</li>
              <li>No shell execution - no cmd, PowerShell, bash, npm, npx or git runs from the agent.</li>
              <li>Patches are staged locally; nothing is written until you run an explicit `hcoder apply`.</li>
              <li>`hcoder revert` restores the pre-apply snapshot (replaced, deleted and created files).</li>
              <li>Protected files (.env, keys, lockfiles) are rejected on read and on write.</li>
              <li>HCR_PATCH_V1 stays the only write protocol; agent turns are text only.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

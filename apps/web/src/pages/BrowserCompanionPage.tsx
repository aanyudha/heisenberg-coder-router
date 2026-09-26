import { useState } from 'react';
import { Card, PageHeader, Badge, StatTile, KeyValue, Field } from '../components/ui';
import { useHcr } from '../hcr-context';
import { apiGet, apiPost, formatTime, relativeTime } from '../api';
import type { DownloadInfo, PairingCodeResponse } from '../types';

export function BrowserCompanionPage() {
  const { companion, refresh } = useHcr();
  const [pairing, setPairing] = useState<PairingCodeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadInfo | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const generateCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<PairingCodeResponse>('/api/browser-companion/pairing-code', undefined, {
        action: 'Could not generate pairing code.',
      });
      setPairing(result);
      setNotice(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate a pairing code');
    } finally {
      setBusy(false);
    }
  };

  const loadDownload = async () => {
    setBusy(true);
    setError(null);
    try {
      setDownload(await apiGet<DownloadInfo>('/api/browser-companion/download', {
        action: 'Could not check the companion bundle.',
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Companion bundle not built yet');
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ connected: boolean; paired: boolean; lastSeenAt: string | null; queuedTasks: number }>(
        '/api/browser-companion/test',
        undefined,
        { action: 'Could not run the connection test.' }
      );
      setTestResult(
        `connected=${result.connected} paired=${result.paired} queuedTasks=${result.queuedTasks} lastSeen=${
          result.lastSeenAt ? formatTime(result.lastSeenAt) : 'never'
        }`
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setBusy(false);
    }
  };

  const resetPairing = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/browser-companion/reset', undefined, {
        action: 'Could not rotate the pairing secret.',
      });
      setPairing(null);
      setNotice('Pairing secret rotated. The extension must pair again with a new code.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  const connected = companion?.connected ?? false;

  return (
    <>
      <PageHeader
        title="Browser Companion"
        subtitle="Optional Chrome/Edge extension that carries the Web Handoff prompt into your own ChatGPT tab. HCR never sees your ChatGPT credentials."
        actions={
          <a className="btn btn-sm btn-primary" href="/downloads/hcr-browser-companion.zip" download>
            Download Extension
          </a>
        }
      />

      {error ? <div className="notice notice-error">{error}</div> : null}
      {notice ? <div className="notice notice-info" style={{ marginTop: error ? 8 : 0 }}>{notice}</div> : null}

      <div className="grid grid-3" style={{ marginTop: 14 }}>
        <StatTile
          label="Extension"
          value={connected ? 'Connected' : 'Not Connected'}
          tone={connected ? 'ok' : 'warn'}
          hint={companion?.lastSeenAt ? `last heartbeat ${relativeTime(companion.lastSeenAt)}` : 'no heartbeat yet'}
        />
        <StatTile
          label="Pairing"
          value={companion?.paired ? 'Paired' : 'Not Paired'}
          tone={companion?.paired ? 'ok' : 'warn'}
          hint={companion?.pairingReady ? 'code can be generated' : 'generate a code below'}
        />
        <StatTile
          label="ChatGPT Tab"
          value={
            companion?.chatgpt.state === 'ready'
              ? 'Ready'
              : companion?.chatgpt.state === 'auth_required'
                ? 'Sign-in Required'
                : companion?.chatgpt.state === 'tab_not_found'
                  ? 'No ChatGPT Tab'
                  : 'Unknown'
          }
          tone={companion?.chatgpt.state === 'ready' ? 'ok' : 'warn'}
          hint={companion?.chatgpt.detail ?? undefined}
        />
      </div>

      <div className="grid grid-sidebar" style={{ marginTop: 14 }}>
        <div className="stack">
          <Card title="Setup">
            <ol className="steps-list">
              <li>
                <strong>Download</strong> the extension bundle (<code className="mono">hcr-browser-companion.zip</code>)
                and extract it to a folder on this machine.
              </li>
              <li>
                Open <code className="mono">chrome://extensions</code> (or <code className="mono">edge://extensions</code>),{' '}
                enable <em>Developer mode</em>, click <strong>Load unpacked</strong>, and select the extracted folder.
              </li>
              <li>
                Generate a <strong>pairing code</strong> below, then open the extension popup and paste the code.
              </li>
              <li>
                Keep a <code className="mono">https://chatgpt.com</code> tab open and signed in. The extension never
                logs in for you and never solves CAPTCHAs.
              </li>
            </ol>

            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="btn"
                type="button"
                onClick={() => void loadDownload()}
                disabled={busy}
              >
                Check Bundle
              </button>
              <span className="muted small">
                {download
                  ? `${download.filename} · ${Math.round(download.bytes / 1024)} KB${download.available ? '' : ' (not built)'}`
                  : 'Bundle is produced by npm run build:companion'}
              </span>
            </div>
          </Card>

          <Card title="Pairing">
            <div className="stack">
              <p className="muted small">
                The pairing code is an 8-character, single-use code valid for 10 minutes. It exchanges a
                machine-local secret with the extension. The secret is never sent to ChatGPT or any other site.
              </p>
              <div className="row">
                <button className="btn btn-primary" type="button" onClick={() => void generateCode()} disabled={busy}>
                  {busy ? 'Working…' : 'Generate Pairing Code'}
                </button>
                <button className="btn btn-danger" type="button" onClick={() => void resetPairing()} disabled={busy}>
                  Rotate Secret
                </button>
                <button className="btn" type="button" onClick={() => void runTest()} disabled={busy}>
                  Run Connection Test
                </button>
              </div>

              {pairing ? (
                <div className="pairing-block">
                  <span className="pairing-code mono">{pairing.code}</span>
                  <span className="muted small">expires {formatTime(pairing.expiresAt)}</span>
                  <ol className="steps-list">
                    {pairing.instructions.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {testResult ? <p className="mono small muted">{testResult}</p> : null}
            </div>
          </Card>

          <Card title="Security Model">
            <ul className="steps-list">
              <li>Only <code className="mono">https://chatgpt.com/*</code> tabs are ever targeted.</li>
              <li>Credentials, cookies and session storage are never read or stored by HCR.</li>
              <li>No OpenAI API key is used, requested or stored for Web Handoff.</li>
              <li>Every companion endpoint (except status/pairing) requires the local pairing token.</li>
              <li>Nothing is written to your project until you review and apply the patch.</li>
            </ul>
          </Card>
        </div>

        <div className="stack">
          <Card title="Live Status">
            <KeyValue label="Connection" value={connected ? 'Connected' : 'Not Connected'} />
            <KeyValue label="Paired" value={companion?.paired ? 'Yes' : 'No'} />
            <KeyValue label="Provider" value="chatgpt-web" />
            <KeyValue
              label="Last heartbeat"
              value={companion?.lastSeenAt ? `${formatTime(companion.lastSeenAt)} (${relativeTime(companion.lastSeenAt)})` : '—'}
            />
            <KeyValue
              label="ChatGPT state"
              value={
                companion
                  ? `${companion.chatgpt.state}${companion.chatgpt.detail ? ` — ${companion.chatgpt.detail}` : ''}`
                  : 'unknown'
              }
            />
            <KeyValue
              label="Reported at"
              value={companion?.chatgpt.reportedAt ? formatTime(companion.chatgpt.reportedAt) : '—'}
            />
            <div className="row" style={{ marginTop: 10 }}>
              <Badge tone={connected ? 'ok' : 'warn'}>{connected ? 'HEARTBEATING' : 'OFFLINE'}</Badge>
              <button className="btn btn-sm" type="button" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
          </Card>

          <Card title="If Pairing Fails">
            <Field label="Common fixes">
              <ul className="steps-list">
                <li>Confirm the HCR server is running on 127.0.0.1:7876.</li>
                <li>Regenerate the code — codes are single-use and expire after 10 minutes.</li>
                <li>Check the extension popup for an error message.</li>
                <li>Load the unpacked extension from the folder you extracted.</li>
                <li>If the secret was rotated, pair the extension again.</li>
              </ul>
            </Field>
          </Card>
        </div>
      </div>
    </>
  );
}

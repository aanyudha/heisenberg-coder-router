import { Card, PageHeader, Badge, KeyValue } from '../components/ui';
import { useHcr } from '../hcr-context';
import type { PageId } from '../nav';

const FEATURES: Array<{ title: string; body: string; tone: 'ok' | 'info' | 'warn' }> = [
  {
    title: 'Routing Control Plane',
    body: 'Desired provider/model selection applied to the Codex configuration with layered verification (config, runtime, observed traffic) and drift detection.',
    tone: 'ok',
  },
  {
    title: 'Web Handoff',
    body: 'HCR prepares a bounded project context, the Browser Companion sends it to your own ChatGPT tab, and the response must match HCR_PATCH_V1 before you can review and apply it.',
    tone: 'info',
  },
  {
    title: 'Browser Companion',
    body: 'Optional MV3 extension that pairs through a short-lived local code, targets only chatgpt.com, and never touches credentials, CAPTCHAs or session storage.',
    tone: 'info',
  },
  {
    title: 'Safe Application',
    body: 'Path traversal, absolute paths and protected files are rejected. Writes are atomic with snapshot-based rollback. Nothing is committed to git automatically.',
    tone: 'warn',
  },
];

export function AboutPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { status, online } = useHcr();

  return (
    <>
      <PageHeader title="About" subtitle="What Heisenberg Coder Router is, and the guarantees it makes." />

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <div className="stack">
          <Card title="Heisenberg Coder Router">
            <p className="muted">
              HCR is a local control plane for AI coding. It routes Codex CLI traffic through an HCR gateway so
              Ollama and OpenAI routing can be observed and verified, and it can hand a bounded slice of your project
              to ChatGPT Web for a review-first patch workflow.
            </p>
            <div className="row" style={{ marginTop: 10 }}>
              <Badge tone={online ? 'ok' : 'error'}>{online ? 'Server Online' : 'Server Offline'}</Badge>
              <Badge tone="info">v0.1.0</Badge>
            </div>
            <div style={{ marginTop: 12 }}>
              <KeyValue label="Endpoint" value={status ? `${status.server.host}:${status.server.port}` : '127.0.0.1:7876'} mono />
              <KeyValue label="Project" value={status?.project?.name ?? '—'} />
              <KeyValue label="Codex" value={status?.codex.installed ? 'Installed' : 'Not Installed'} />
              <KeyValue label="Ollama" value={status?.ollama.online ? 'Online' : 'Offline'} />
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn-sm" type="button" onClick={() => onNavigate('settings')}>
                Settings
              </button>
              <a className="btn btn-sm" href="/downloads/hcr-browser-companion.zip" download>
                Download Companion
              </a>
            </div>
          </Card>

          <Card title="Architecture">
            <pre className="mono architecture">
{`  Codex CLI ──► HCR gateway ──► Ollama / OpenAI
                    │
                    ▼
              telemetry + routing state
                    │
  Dashboard ────────┤  (127.0.0.1:7876)
                    │
  Browser Companion │  (paired, local secret)
                    ▼
              ChatGPT Web tab ──► HCR_PATCH_V1
                    │
                    ▼
        review ──► apply ──► revert (snapshot)`}
            </pre>
          </Card>
        </div>

        <div className="stack">
          {FEATURES.map((feature) => (
            <Card key={feature.title} title={feature.title}>
              <p className="muted">{feature.body}</p>
            </Card>
          ))}

          <Card title="Hard Guarantees">
            <ul className="steps-list">
              <li>No shell commands are ever generated from a model response.</li>
              <li>No git commit, push or branch operation is performed automatically.</li>
              <li>No OpenAI API key is used, requested or stored for Web Handoff.</li>
              <li>No ChatGPT credentials, cookies or CAPTCHA automation.</li>
              <li>Only <code className="mono">https://chatgpt.com/*</code> is an allowed browser target.</li>
              <li>Patches are never auto-applied: review first, then apply, then revert if needed.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

import { useState } from 'react';
import { Card, PageHeader, Badge, KeyValue, EmptyState, StatTile } from '../components/ui';
import { ProjectControl } from '../components/ProjectControl';
import { useHcr } from '../hcr-context';
import { apiPost, formatTime, relativeTime } from '../api';
import type { PageId } from '../nav';

const STATE_TONE: Record<string, 'ok' | 'warn' | 'error' | 'neutral' | 'info'> = {
  ready_for_review: 'ok',
  applied: 'ok',
  invalid_patch_response: 'error',
  error: 'error',
  rejected: 'neutral',
  reverted: 'neutral',
};

export function ProjectsPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { status, handoffs, refresh } = useHcr();
  const [error, setError] = useState<string | null>(null);

  const setProject = async (projectDir: string): Promise<boolean> => {
    try {
      await apiPost('/api/project', { projectDir });
      await refresh();
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid project directory');
      return false;
    }
  };

  const project = status?.project ?? null;
  const projectHandoffs = handoffs.filter((handoff) => (project ? handoff.project === project.path : false));

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="The active working directory for routing, context building and patch application."
        actions={
          <button className="btn btn-sm btn-primary" type="button" onClick={() => onNavigate('web-handoff')}>
            New Web Handoff
          </button>
        }
      />

      {error ? <div className="notice notice-error">{error}</div> : null}

      <div className="grid grid-sidebar" style={{ marginTop: 14 }}>
        <div className="stack">
          <Card title="Active Project">
            <div className="stack">
              {status ? (
                <ProjectControl key={project?.path ?? 'none'} project={project} onSetProject={setProject} />
              ) : null}
              <p className="muted small">
                The project directory is used for the Codex config context, Web Handoff context building, and patch
                application. HCR only writes files inside this directory, and only after you apply a reviewed patch.
              </p>
              <div className="row">
                <button className="btn" type="button" onClick={() => onNavigate('routing')}>
                  Open Routing
                </button>
                <button className="btn btn-ghost" type="button" onClick={() => onNavigate('web-handoff')}>
                  Prepare Context
                </button>
              </div>
            </div>
          </Card>

          <Card title="Handoffs for this Project" bodyClassName="is-flush">
            {projectHandoffs.length === 0 ? (
              <EmptyState title="No handoffs for this project yet" hint="Start one from the Web Handoff page." />
            ) : (
              <ul className="handoff-list">
                {projectHandoffs.slice(0, 10).map((handoff) => (
                  <li key={handoff.id} onClick={() => onNavigate('web-handoff')}>
                    <span className="handoff-title" title={handoff.taskTitle}>
                      {handoff.taskTitle}
                    </span>
                    <Badge tone={STATE_TONE[handoff.status] ?? 'neutral'}>{handoff.status.replace(/_/g, ' ')}</Badge>
                    <span className="handoff-time">{relativeTime(handoff.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="Project Details">
            {project ? (
              <>
                <KeyValue label="Name" value={project.name} />
                <KeyValue label="Path" value={project.path} mono />
                <KeyValue label="Handoffs" value={String(projectHandoffs.length)} />
                <KeyValue
                  label="Last activity"
                  value={projectHandoffs.length > 0 ? formatTime(projectHandoffs[0].createdAt) : '—'}
                />
              </>
            ) : (
              <EmptyState title="No project selected" hint="Enter an absolute path and click Set." />
            )}
          </Card>

          <Card title="Workspace Safety">
            <div className="stat-grid">
              <StatTile label="Protected paths" value="On" tone="ok" hint=".git, node_modules, lockfiles and more" />
              <StatTile label="Secret scanning" value="On" tone="ok" hint="keys and tokens are excluded from context" />
              <StatTile label="Auto-apply" value="Off" tone="info" hint="every patch needs explicit review" />
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Path traversal, absolute paths and protected files are rejected at validation time, before anything is
              written to disk.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

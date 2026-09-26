import { useMemo, useState } from 'react';
import { Card, PageHeader, Badge, EmptyState, StatTile } from '../components/ui';
import { useHcr } from '../hcr-context';
import { formatTime, relativeTime, shortId } from '../api';
import type { WebHandoffStatus } from '../types';
import type { PageId } from '../nav';

const STATE_TONE: Record<string, 'ok' | 'warn' | 'error' | 'neutral' | 'info'> = {
  ready_for_review: 'ok',
  applied: 'ok',
  invalid_patch_response: 'error',
  error: 'error',
  rejected: 'neutral',
  reverted: 'neutral',
};

const FILTERS: Array<{ label: string; match: (status: WebHandoffStatus) => boolean }> = [
  { label: 'All', match: () => true },
  { label: 'Needs Review', match: (status) => status === 'ready_for_review' || status === 'invalid_patch_response' },
  { label: 'Completed', match: (status) => status === 'applied' || status === 'reverted' },
  { label: 'Failed', match: (status) => status === 'error' || status === 'rejected' },
];

export function ActivityPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { handoffs, recent } = useHcr();
  const [filter, setFilter] = useState(0);

  const visible = useMemo(
    () => handoffs.filter((handoff) => FILTERS[filter].match(handoff.status)),
    [handoffs, filter]
  );

  const needsReview = handoffs.filter(
    (handoff) => handoff.status === 'ready_for_review' || handoff.status === 'invalid_patch_response'
  ).length;

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Every Web Handoff ever prepared, with its outcome, plus the gateway request log."
        actions={
          <button className="btn btn-sm" type="button" onClick={() => onNavigate('web-handoff')}>
            Open Web Handoff
          </button>
        }
      />

      <div className="grid grid-3" style={{ marginTop: 14 }}>
        <StatTile label="Total handoffs" value={String(handoffs.length)} tone="info" />
        <StatTile label="Needs review" value={String(needsReview)} tone={needsReview > 0 ? 'warn' : 'ok'} />
        <StatTile label="Gateway requests" value={String(recent.length)} tone="neutral" />
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        {FILTERS.map((entry, index) => (
          <button
            key={entry.label}
            type="button"
            className={`btn btn-sm ${filter === index ? 'btn-primary' : ''}`}
            onClick={() => setFilter(index)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <Card title="Web Handoff Log" bodyClassName="is-flush" className="card-activity">
        {visible.length === 0 ? (
          <EmptyState title="No handoffs in this filter" hint="Handoffs appear here as soon as you prepare one." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Files</th>
                  <th>Created</th>
                  <th>Completed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((handoff) => (
                  <tr key={handoff.id}>
                    <td className="cell-strong" title={handoff.taskTitle}>
                      {handoff.taskTitle}
                      <span className="mono muted small"> {shortId(handoff.id)}</span>
                    </td>
                    <td>{handoff.projectName}</td>
                    <td>
                      <Badge tone={STATE_TONE[handoff.status] ?? 'neutral'}>{handoff.status.replace(/_/g, ' ')}</Badge>
                      {handoff.error ? (
                        <div className="muted small" title={handoff.error}>
                          {handoff.error}
                        </div>
                      ) : null}
                    </td>
                    <td className="num">{handoff.filesChanged}</td>
                    <td title={formatTime(handoff.createdAt)}>{relativeTime(handoff.createdAt)}</td>
                    <td>{handoff.completedAt ? relativeTime(handoff.completedAt) : '—'}</td>
                    <td>
                      <button className="btn btn-sm" type="button" onClick={() => onNavigate('web-handoff')}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Gateway Request Log" bodyClassName="is-flush">
        {recent.length === 0 ? (
          <EmptyState title="No gateway traffic yet" hint="Metadata-only request log from the HCR Ollama gateway." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>State</th>
                  <th>Duration</th>
                  <th>Tokens</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {[...recent].reverse().map((entry) => (
                  <tr key={entry.requestId}>
                    <td className="mono">{shortId(entry.requestId)}</td>
                    <td>{entry.provider}</td>
                    <td className="mono">{entry.model ?? '—'}</td>
                    <td>
                      <Badge
                        tone={entry.state === 'completed' ? 'ok' : entry.state === 'error' ? 'error' : 'info'}
                      >
                        {entry.state}
                      </Badge>
                      {entry.error ? <div className="muted small">{entry.error}</div> : null}
                    </td>
                    <td className="num">{entry.durationMs !== null ? `${entry.durationMs} ms` : '—'}</td>
                    <td className="num">{entry.totalTokens !== null ? entry.totalTokens : '—'}</td>
                    <td title={formatTime(entry.startedAt)}>{relativeTime(entry.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

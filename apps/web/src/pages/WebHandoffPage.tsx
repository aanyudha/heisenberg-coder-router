import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, PageHeader, Badge, Field, EmptyState, KeyValue, StatTile } from '../components/ui';
import { ProjectControl } from '../components/ProjectControl';
import { StatusStepper, HANDOFF_STEPS } from '../components/StatusStepper';
import { DiffView } from '../components/DiffView';
import { Modal } from '../components/Modal';
import { useHcr } from '../hcr-context';
import { apiGet, apiPost, formatBytes, formatTime } from '../api';
import type { ProjectContextSummary, WebHandoffDetail, WebHandoffSummary } from '../types';
import type { PageId } from '../nav';

const LIVE_STATUSES = new Set([
  'waiting_for_browser',
  'opening_chatgpt',
  'sending_prompt',
  'waiting_for_response',
  'receiving_response',
  'validating_patch',
]);

const STATE_TONE: Record<string, 'ok' | 'warn' | 'error' | 'neutral' | 'info'> = {
  ready_for_review: 'ok',
  applied: 'ok',
  context_ready: 'info',
  waiting_for_browser: 'info',
  opening_chatgpt: 'info',
  sending_prompt: 'info',
  waiting_for_response: 'info',
  receiving_response: 'info',
  validating_patch: 'info',
  invalid_patch_response: 'error',
  error: 'error',
  rejected: 'neutral',
  reverted: 'neutral',
};

const ACTION_TONE: Record<string, string> = { create: 'ok', replace: 'info', delete: 'error' };
const ACTION_MARK: Record<string, string> = { create: '+', replace: '~', delete: '−' };

export function WebHandoffPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const { status, companion, handoffs, refresh, online } = useHcr();

  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [detail, setDetail] = useState<WebHandoffDetail | null>(null);
  const [fullContext, setFullContext] = useState<ProjectContextSummary | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [reviewingContext, setReviewingContext] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [applyResult, setApplyResult] = useState<{ changedFiles: string[] } | null>(null);
  const pollRef = useRef<number | null>(null);

  const companionConnected = companion?.connected ?? false;

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const loadDetail = useCallback(async (id: string): Promise<WebHandoffDetail | null> => {
    try {
      const next = await apiGet<WebHandoffDetail>(`/api/web-handoff/${id}`);
      setDetail(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load handoff');
      return null;
    }
  }, []);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      pollRef.current = window.setInterval(() => {
        void (async () => {
          const next = await loadDetail(id);
          if (!next || !LIVE_STATUSES.has(next.status)) stopPolling();
        })();
      }, 1500);
    },
    [loadDetail, stopPolling]
  );

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Re-attach polling after a page reload when a handoff is still running.
  useEffect(() => {
    if (!detail) return;
    if (LIVE_STATUSES.has(detail.status)) startPolling(detail.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prepare = async () => {
    if (task.trim().length === 0) {
      setError('Describe the task first.');
      return;
    }
    if (!status?.project) {
      setError('Select a project first.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setApplyResult(null);
    try {
      const prepared = await apiPost<WebHandoffDetail>('/api/web-handoff', {
        task: task.trim(),
        projectDir: status.project.path,
      });
      setDetail(prepared);
      setFullContext(prepared.contextSummary);
      setShowContext(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to prepare the handoff');
    } finally {
      setBusy(false);
    }
  };

  const reviewFullContext = async () => {
    if (!detail) return;
    setReviewingContext(true);
    try {
      const context = await apiGet<ProjectContextSummary>(`/api/web-handoff/${detail.id}/context`);
      setFullContext(context);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the context');
    } finally {
      setReviewingContext(false);
    }
  };

  const send = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const sent = await apiPost<WebHandoffDetail>(`/api/web-handoff/${detail.id}/send`, undefined, {
        action: 'Could not queue the prompt for the Browser Companion.',
      });
      setDetail(sent);
      setShowContext(false);
      setNotice('Prompt queued for the Browser Companion.');
      startPolling(sent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send the handoff');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const next = await apiPost<WebHandoffDetail>(`/api/web-handoff/${detail.id}/retry`, undefined, {
        action: 'Could not queue the correction prompt.',
      });
      setDetail(next);
      setNotice('Correction prompt queued.');
      startPolling(next.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ changedFiles: string[]; handoff: WebHandoffDetail }>(
        `/api/web-handoff/${detail.id}/apply`,
        undefined,
        { action: 'Could not apply the reviewed patch.' }
      );
      setApplyResult({ changedFiles: result.changedFiles });
      setDetail(result.handoff);
      setNotice(`Applied ${result.changedFiles.length} file change(s) to the project.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply the patch');
    } finally {
      setBusy(false);
    }
  };

  const revert = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<{ changedFiles: string[]; handoff: WebHandoffDetail }>(
        `/api/web-handoff/${detail.id}/revert`,
        undefined,
        { action: 'Could not revert the last apply.' }
      );
      setApplyResult(null);
      setDetail(result.handoff);
      setNotice(`Reverted ${result.changedFiles.length} file change(s).`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revert');
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const next = await apiPost<WebHandoffDetail>(`/api/web-handoff/${detail.id}/reject`, undefined, {
        action: 'Could not reject the proposal.',
      });
      setDetail(next);
      setNotice('Proposal rejected. Nothing was written.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject');
    } finally {
      setBusy(false);
    }
  };

  const openHandoff = async (handoff: WebHandoffSummary) => {
    stopPolling();
    setApplyResult(null);
    setNotice(null);
    const next = await loadDetail(handoff.id);
    if (next && LIVE_STATUSES.has(next.status)) startPolling(next.id);
  };

  const setProject = async (projectDir: string): Promise<boolean> => {
    try {
      await apiPost('/api/project', { projectDir });
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid project directory');
      return false;
    }
  };

  const showReview = detail?.status === 'ready_for_review';
  const showInvalid = detail?.status === 'invalid_patch_response';
  const showApplied = detail?.status === 'applied';

  return (
    <>
      <PageHeader
        title="Web Handoff"
        subtitle="HCR prepares safe project context, the Browser Companion sends it to ChatGPT Web, and you review the returned patch before anything is written."
        actions={
          <button className="btn btn-sm" type="button" onClick={() => onNavigate('browser-companion')}>
            Browser Companion
          </button>
        }
      />

      {error ? <div className="notice notice-error">{error}</div> : null}
      {notice ? <div className="notice notice-info" style={{ marginTop: error ? 8 : 0 }}>{notice}</div> : null}

      <div className="grid grid-sidebar" style={{ marginTop: 14 }}>
        {/* ------------------------------------------------ left column -- */}
        <div className="stack">
          <Card title="Task">
            <div className="stack">
              <Field label="Project">
                {status ? (
                  <ProjectControl key={status.project?.path ?? 'none'} project={status.project} onSetProject={setProject} />
                ) : null}
              </Field>

              <Field label="Intelligence Source">
                <select defaultValue="chatgpt-web" disabled>
                  <option value="chatgpt-web">ChatGPT Web (Browser Companion)</option>
                </select>
                <p className="field-hint">
                  Codex is not used for Web Handoff. No OpenAI API credentials are involved.
                </p>
              </Field>

              <Field label="Task">
                <textarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder="Create an Inventory menu like Sales and add it to the sidebar."
                  rows={7}
                />
              </Field>

              <Field label="Context" hint="HCR never uploads the whole repository. Excluded files are reported before sending.">
                <select defaultValue="auto" disabled>
                  <option value="auto">Auto Select Relevant Files</option>
                </select>
              </Field>

              <div className="row">
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void prepare()}
                  disabled={busy || !online}
                >
                  Send to ChatGPT
                </button>
                {detail ? (
                  <button className="btn btn-ghost" type="button" onClick={() => setDetail(null)}>
                    Clear
                  </button>
                ) : null}
              </div>
              {!online ? <p className="error-text">HCR server is not reachable.</p> : null}
            </div>
          </Card>

          <Card title="Handoff History" bodyClassName="is-flush">
            {handoffs.length === 0 ? (
              <EmptyState title="No handoffs yet" hint="Prepared handoffs and their results appear here." />
            ) : (
              <ul className="handoff-list">
                {handoffs.slice(0, 10).map((handoff) => (
                  <li key={handoff.id} onClick={() => void openHandoff(handoff)}>
                    <span className="handoff-title" title={handoff.taskTitle}>
                      {handoff.taskTitle}
                    </span>
                    <Badge tone={STATE_TONE[handoff.status] ?? 'neutral'}>{handoff.status.replace(/_/g, ' ')}</Badge>
                    <span className="handoff-time">{formatTime(handoff.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ----------------------------------------------- right column -- */}
        <div className="stack">
          <Card title="Browser Companion">
            <div className="stat-grid">
              <StatTile
                label="Status"
                value={companionConnected ? 'Connected' : 'Not Connected'}
                tone={companionConnected ? 'ok' : 'warn'}
                hint={companion?.lastSeenAt ? `last heartbeat ${formatTime(companion.lastSeenAt)}` : 'no heartbeat yet'}
              />
              <StatTile
                label="Pairing"
                value={companion?.paired ? 'Paired' : 'Not Paired'}
                tone={companion?.paired ? 'ok' : 'warn'}
                hint={companion?.provider ?? 'chatgpt-web'}
              />
              <StatTile
                label="ChatGPT Web"
                value={
                  companion
                    ? companion.chatgpt.state === 'ready'
                      ? 'Ready'
                      : companion.chatgpt.state === 'auth_required'
                        ? 'Auth Required'
                        : companion.chatgpt.state === 'tab_not_found'
                          ? 'Tab Not Found'
                          : companion.chatgpt.state === 'error'
                            ? 'Error'
                            : 'Unknown'
                    : 'Unknown'
                }
                tone={companion?.chatgpt.state === 'ready' ? 'ok' : companion?.chatgpt.state === 'auth_required' ? 'warn' : 'neutral'}
              />
            </div>
            {!companionConnected ? (
              <p className="muted small" style={{ marginTop: 10 }}>
                The extension is optional. Without it, handoffs stay queued.{' '}
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => onNavigate('browser-companion')}>
                  Set up
                </button>
              </p>
            ) : null}
          </Card>

          <Card title="Status">
            {detail ? (
              <div className="stack">
                <div className="row">
                  <Badge tone={STATE_TONE[detail.status] ?? 'neutral'}>{detail.status.replace(/_/g, ' ')}</Badge>
                  <span className="muted small mono">{detail.id}</span>
                </div>
                <StatusStepper steps={HANDOFF_STEPS} current={detail.status} error={detail.error} />
                {detail.summary ? <KeyValue label="Summary" value={detail.summary} /> : null}
                <KeyValue label="Project" value={detail.projectName} />
                <KeyValue label="Context" value={`${detail.contextSummary?.fileCount ?? 0} files · ${formatBytes(detail.contextSummary?.totalBytes)}`} />
                <KeyValue label="Source" value="chatgpt-web" />
              </div>
            ) : (
              <EmptyState
                title="No active handoff"
                hint="Describe a task on the left and click Send to ChatGPT."
              />
            )}
          </Card>

          {showReview && detail ? (
            <Card
              title="Proposed Changes"
              actions={
                <Badge tone="ok">{detail.files.length} file{detail.files.length === 1 ? '' : 's'}</Badge>
              }
            >
              <div className="stack">
                {detail.patch ? <p className="muted">{detail.patch.summary}</p> : null}
                <ul className="review-list">
                  {detail.files.map((file) => (
                    <li key={file.path}>
                      <span className={`badge badge-${ACTION_TONE[file.action]}`}>
                        {ACTION_MARK[file.action]} {file.action}
                      </span>
                      <span className="review-path mono" title={file.path}>
                        {file.path}
                      </span>
                      <span className="muted small">
                        {file.state === 'missing' ? 'missing on disk' : formatBytes(file.afterBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <button className="btn" type="button" onClick={() => setShowDiff(true)}>
                    View Diff
                  </button>
                  <button
                    className="btn btn-success"
                    type="button"
                    onClick={() => void apply()}
                    disabled={busy || !detail.canApply}
                  >
                    Apply Changes
                  </button>
                  <button className="btn btn-danger" type="button" onClick={() => void reject()} disabled={busy}>
                    Reject
                  </button>
                </div>
                {detail.pathIssues.length > 0 ? (
                  <div className="notice notice-error">
                    {detail.pathIssues.map((issue) => (
                      <div key={issue.path}>
                        {issue.path}: {issue.error}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          {showInvalid && detail ? (
            <Card title="Invalid Patch Response">
              <div className="stack">
                <div className="notice notice-error">
                  <strong>INVALID_PATCH_RESPONSE</strong>
                  <div style={{ marginTop: 6 }}>
                    {detail.patchErrors.length > 0 ? detail.patchErrors.join(' ') : 'The response did not match HCR_PATCH_V1.'}
                  </div>
                </div>
                <p className="muted small">
                  Nothing was applied. Inspect the raw response below, then retry with a correction prompt.
                </p>
                <div className="row">
                  <button className="btn" type="button" onClick={() => setShowRaw((value) => !value)}>
                    {showRaw ? 'Hide Raw Response' : 'Show Raw Response'}
                  </button>
                  <button className="btn btn-primary" type="button" onClick={() => void retry()} disabled={busy}>
                    Retry with Correction Prompt
                  </button>
                </div>
                {showRaw && detail.rawResponse ? (
                  <pre className="mono" style={{ maxHeight: 300, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap' }}>
                    {detail.rawResponse}
                  </pre>
                ) : null}
              </div>
            </Card>
          ) : null}

          {showApplied && detail ? (
            <Card title="Changes Applied">
              <div className="stack">
                <p className="ok-text" style={{ margin: 0 }}>
                  {(applyResult?.changedFiles.length ?? detail.filesChanged)} file change(s) written to{' '}
                  {detail.projectName}.
                </p>
                <ul className="review-list">
                  {(applyResult?.changedFiles ?? detail.files.map((file) => file.path)).map((path) => (
                    <li key={path}>
                      <span className="review-path mono">{path}</span>
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <button className="btn" type="button" onClick={() => setShowDiff(true)}>
                    Open Diff
                  </button>
                  <button
                    className="btn btn-warn"
                    type="button"
                    onClick={() => void revert()}
                    disabled={busy || !detail.canRevert}
                    title={detail.canRevert ? undefined : 'Rollback is only available for the most recent apply'}
                  >
                    Revert Changes
                  </button>
                </div>
                {detail.canRevert ? null : (
                  <p className="muted small">Rollback is only available for the most recently applied patch.</p>
                )}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      {/* ---------------------------------------------------- modals ----- */}
      <Modal
        title="Context being sent"
        open={showContext}
        onClose={() => setShowContext(false)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => void reviewFullContext()} disabled={reviewingContext}>
              {reviewingContext ? 'Loading…' : 'Review Context'}
            </button>
            <button className="btn btn-primary" type="button" onClick={() => void send()} disabled={busy}>
              Send
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="stat-grid">
            <StatTile label="Files" value={String(fullContext?.fileCount ?? 0)} tone="info" />
            <StatTile label="Total size" value={formatBytes(fullContext?.totalBytes)} tone="info" />
            <StatTile label="Excluded" value={String(fullContext?.excluded.length ?? 0)} tone="warn" />
          </div>
          <p className="muted small">
            Only these files are transmitted to ChatGPT Web. Secrets, lockfiles, binaries, node_modules and .git are
            excluded by default. Nothing is sent until you click Send.
          </p>

          {fullContext && fullContext.files.length > 0 ? (
            <ul className="file-list">
              {fullContext.files.map((file) => (
                <li key={file.path}>
                  <span className="file-path mono" title={file.path}>
                    {file.selected === 'user' ? '★ ' : ''}
                    {file.path}
                  </span>
                  <span className="file-meta">{formatBytes(file.bytes)}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {fullContext && fullContext.excluded.length > 0 ? (
            <details>
              <summary className="muted">
                {fullContext.excluded.length} file(s) excluded from context
              </summary>
              <ul className="file-list" style={{ marginTop: 8 }}>
                {fullContext.excluded.map((item) => (
                  <li key={`${item.path}:${item.reason}`}>
                    <span className="file-path mono">{item.path}</span>
                    <span className="file-meta">{item.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </Modal>

      <Modal title="Proposed diff" open={showDiff} onClose={() => setShowDiff(false)} wide>
        <DiffView
          diffs={detail?.diffs ?? []}
          emptyHint="The diff is computed from the current files on disk. Reload the handoff to refresh."
        />
      </Modal>
    </>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, PageHeader, Badge, Field, EmptyState, KeyValue, StatTile } from '../components/ui';
import { ProjectControl } from '../components/ProjectControl';
import { StatusStepper, HANDOFF_STEPS } from '../components/StatusStepper';
import { DiffView } from '../components/DiffView';
import { Modal } from '../components/Modal';
import { useHcr } from '../hcr-context';
import { apiGet, apiPost, formatBytes, formatTime } from '../api';
import type {
  ChatGptChat,
  ChatGptProject,
  ChatgptDestination,
  ChatgptDiscoveryStatus,
  ChatgptChatsResponse,
  ChatgptDestinationResponse,
  ChatgptProjectsResponse,
  ProjectContextSummary,
  WebHandoffDetail,
  WebHandoffSummary,
} from '../types';
import type { PageId } from '../nav';

type DiscoveryState = 'idle' | 'loading' | 'ready';

function normalizeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim(), 'https://chatgpt.com');
    return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Identity match by id first, then URL - never by visible name. */
function matchByIdOrUrl<T extends { id: string; url: string }>(
  list: T[],
  target: { id?: string | null; url?: string | null } | null | undefined
): T | null {
  if (!target) return null;
  if (target.id) {
    const byId = list.find((item) => item.id === target.id);
    if (byId) return byId;
  }
  const wanted = normalizeUrl(target.url);
  if (wanted) {
    const byUrl = list.find((item) => normalizeUrl(item.url) === wanted);
    if (byUrl) return byUrl;
  }
  return null;
}

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

  // ---- ChatGPT destination (Project / Session / Mode) ------------------ //
  const [projects, setProjects] = useState<ChatGptProject[]>([]);
  const [projectsState, setProjectsState] = useState<DiscoveryState>('idle');
  const [projectsStatus, setProjectsStatus] = useState<ChatgptDiscoveryStatus | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ChatGptProject | null>(null);

  const [chats, setChats] = useState<ChatGptChat[]>([]);
  const [chatsState, setChatsState] = useState<DiscoveryState>('idle');
  const [chatsStatus, setChatsStatus] = useState<ChatgptDiscoveryStatus | null>(null);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [selectedChat, setSelectedChat] = useState<ChatGptChat | null>(null);
  /** Saved session exists but is not in the discovered list. */
  const [chatMissing, setChatMissing] = useState(false);

  const [mode, setMode] = useState<'continue' | 'create'>('continue');
  const [newChatTitle, setNewChatTitle] = useState('');
  const [destinationNotice, setDestinationNotice] = useState<string | null>(null);

  const selectedProjectRef = useRef<ChatGptProject | null>(null);
  const selectedChatRef = useRef<ChatGptChat | null>(null);
  const savedDestinationRef = useRef<ChatgptDestination | null>(null);
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);
  useEffect(() => {
    selectedChatRef.current = selectedChat;
  }, [selectedChat]);

  const loadSavedDestination = useCallback(async (projectPath: string): Promise<ChatgptDestination | null> => {
    try {
      const response = await apiGet<ChatgptDestinationResponse>(
        `/api/browser-companion/chatgpt/destination?projectDir=${encodeURIComponent(projectPath)}`
      );
      return response.destination;
    } catch {
      // Missing mapping is normal for a first run.
      return null;
    }
  }, []);

  const loadChats = useCallback(
    async (project: ChatGptProject | null, opts: { refresh?: boolean; restore?: boolean } = {}) => {
      if (!project) {
        setChats([]);
        setChatsState('idle');
        setSelectedChat(null);
        setChatsStatus(null);
        setChatsError(null);
        setChatMissing(false);
        return;
      }
      setChatsState('loading');
      setChatsError(null);
      setChatsStatus(null);
      setChatMissing(false);
      setDestinationNotice(null);

      let response: ChatgptChatsResponse;
      try {
        response = await apiGet<ChatgptChatsResponse>(
          `/api/browser-companion/chatgpt/projects/${encodeURIComponent(project.id)}/chats` +
            `?url=${encodeURIComponent(project.url)}${opts.refresh ? '&refresh=1' : ''}`,
          { action: 'Could not list chats in that ChatGPT Project' }
        );
      } catch (err) {
        setChats([]);
        setChatsState('ready');
        setChatsStatus('error');
        setChatsError(err instanceof Error ? err.message : 'Could not list chats in that ChatGPT Project.');
        setSelectedChat(null);
        return;
      }

      setChats(response.chats);
      setChatsStatus(response.status);
      setChatsError(response.status === 'ok' ? null : response.error);
      setChatsState('ready');

      if (opts.refresh) {
        const previous = selectedChatRef.current;
        const stillThere = previous ? matchByIdOrUrl(response.chats, previous) : null;
        setSelectedChat(stillThere);
        if (previous && !stillThere) {
          setDestinationNotice('The selected chat session is no longer in this ChatGPT Project.');
        }
        return;
      }
      if (opts.restore) {
        const saved = savedDestinationRef.current;
        if (saved && saved.chatMode === 'continue') {
          const match = matchByIdOrUrl(response.chats, { id: saved.chatId, url: saved.chatUrl });
          if (match) {
            setSelectedChat(match);
            return;
          }
          if (saved.chatId || saved.chatUrl) {
            setSelectedChat(null);
            setChatMissing(true);
            return;
          }
        }
      }
      setSelectedChat(null);
    },
    []
  );

  const loadProjects = useCallback(
    async (opts: { refresh?: boolean; restore?: boolean } = {}) => {
      setProjectsState('loading');
      setProjectsError(null);
      setProjectsStatus(null);

      let response: ChatgptProjectsResponse;
      try {
        response = await apiGet<ChatgptProjectsResponse>(
          `/api/browser-companion/chatgpt/projects${opts.refresh ? '?refresh=1' : ''}`,
          { action: 'Could not discover ChatGPT Projects' }
        );
      } catch (err) {
        setProjects([]);
        setProjectsState('ready');
        setProjectsStatus('error');
        setProjectsError(err instanceof Error ? err.message : 'Could not discover ChatGPT Projects.');
        setSelectedProject(null);
        setChats([]);
        setSelectedChat(null);
        setChatsState('idle');
        return;
      }

      setProjects(response.projects);
      setProjectsStatus(response.status);
      setProjectsError(response.status === 'ok' ? null : response.error);
      setProjectsState('ready');

      if (opts.refresh) {
        const previous = selectedProjectRef.current;
        const stillThere = previous ? matchByIdOrUrl(response.projects, previous) : null;
        if (stillThere) {
          setSelectedProject(stillThere);
          await loadChats(stillThere, { refresh: true });
        } else {
          setSelectedProject(null);
          setChats([]);
          setSelectedChat(null);
          setChatsState('idle');
          if (previous) setDestinationNotice('The selected ChatGPT Project was not found. Select another one.');
        }
        return;
      }

      if (opts.restore) {
        const saved = savedDestinationRef.current;
        const match = saved
          ? matchByIdOrUrl(response.projects, { id: saved.chatgptProjectId, url: saved.chatgptProjectUrl })
          : null;
        if (match) {
          setSelectedProject(match);
          await loadChats(match, { restore: true });
          return;
        }
        setSelectedProject(null);
        setChats([]);
        setSelectedChat(null);
        setChatsState('idle');
        if (saved && response.status === 'ok') {
          setDestinationNotice('The saved ChatGPT Project was not found. Select a project to continue.');
        }
        return;
      }

      const current = selectedProjectRef.current;
      const stillThere = current ? matchByIdOrUrl(response.projects, current) : null;
      if (!stillThere) {
        setSelectedProject(null);
        setChats([]);
        setSelectedChat(null);
        setChatsState('idle');
      } else {
        setSelectedProject(stillThere);
      }
    },
    [loadChats]
  );

  // A different local HCR project: restore its last-used ChatGPT destination.
  const localProjectPath = status?.project?.path ?? '';
  useEffect(() => {
    setSelectedProject(null);
    setSelectedChat(null);
    setProjects([]);
    setProjectsState('idle');
    setChats([]);
    setChatsState('idle');
    setChatMissing(false);
    setDestinationNotice(null);
    savedDestinationRef.current = null;
    if (localProjectPath.length === 0) return;
    let cancelled = false;
    void (async () => {
      const saved = await loadSavedDestination(localProjectPath);
      if (cancelled) return;
      savedDestinationRef.current = saved;
      await loadProjects({ restore: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [localProjectPath, loadProjects, loadSavedDestination]);


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
    if (selectedProject && mode === 'continue' && !selectedChat) {
      setError('Select a chat session, or switch Mode to "Create New Session in Selected Project".');
      return;
    }
    const destination: ChatgptDestination | null = selectedProject
      ? {
          chatgptProjectId: selectedProject.id,
          chatgptProjectName: selectedProject.name,
          chatgptProjectUrl: selectedProject.url,
          chatId: mode === 'continue' ? selectedChat?.id ?? null : null,
          chatTitle: mode === 'continue' ? selectedChat?.title ?? null : null,
          chatUrl: mode === 'continue' ? selectedChat?.url ?? null : null,
          chatMode: mode,
          newChatTitle: mode === 'create' ? newChatTitle.trim() || null : null,
        }
      : null;

    setBusy(true);
    setError(null);
    try {
      const sent = await apiPost<WebHandoffDetail>(
        `/api/web-handoff/${detail.id}/send`,
        { destination },
        { action: 'Could not queue the prompt for the Browser Companion.' }
      );
      setDetail(sent);
      setShowContext(false);
      const targeted = destination
        ? `Prompt queued for ${destination.chatgptProjectName || 'the selected ChatGPT Project'}${
            destination.chatMode === 'continue' && destination.chatTitle ? ` / ${destination.chatTitle}` : ''
          }.`
        : 'Prompt queued for the Browser Companion (no ChatGPT Project selected).';
      setNotice(targeted);
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

  const projectPlaceholder =
    projectsState === 'loading'
      ? 'Loading...'
      : projectsStatus === 'not_connected'
        ? 'Browser Companion Not Connected'
        : projectsStatus === 'auth_required'
          ? 'Authentication Required'
          : projectsStatus === 'ui_unsupported'
            ? 'Unsupported ChatGPT UI'
            : projectsState === 'ready' && projects.length === 0
              ? projectsStatus === 'ok' || !projectsError
                ? 'No Projects Found'
                : projectsError
              : 'Select ChatGPT Project';

  const chatPlaceholder =
    !selectedProject
      ? 'Select Project First'
      : chatsState === 'loading'
        ? 'Loading...'
        : chatMissing
          ? 'Session Not Found'
          : chatsStatus === 'not_connected'
            ? 'Browser Companion Not Connected'
            : chatsStatus === 'auth_required'
              ? 'Authentication Required'
              : chatsStatus === 'ui_unsupported'
                ? 'Unsupported ChatGPT UI'
                : chatsState === 'ready' && chats.length === 0
                  ? chatsStatus === 'ok' || !chatsError
                    ? 'No Sessions Found'
                    : chatsError
                  : 'Select Chat Session';

  const onProjectChange = (value: string) => {
    const project = projects.find((candidate) => candidate.id === value) ?? null;
    savedDestinationRef.current = null;
    setDestinationNotice(null);
    setSelectedProject(project);
    void loadChats(project);
  };

  const onChatChange = (value: string) => {
    setSelectedChat(chats.find((candidate) => candidate.id === value) ?? null);
    setChatMissing(false);
  };

  const destinationLabel = detail?.destination
    ? [
        detail.destination.chatgptProjectName || detail.destination.chatgptProjectId,
        detail.destination.chatMode === 'continue' ? (detail.destination.chatTitle ?? 'existing session') : 'new session',
      ].join(' / ')
    : null;

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

          <Card title="ChatGPT Destination">
            <div className="stack">
              <Field label="Local Project" hint="The destination mapping is stored per local project on this machine.">
                <p className="mono small" style={{ margin: 0, wordBreak: 'break-all' }}>
                  {status?.project?.path ?? 'No local project selected'}
                </p>
              </Field>

              <Field
                label="Project"
                hint="Discovered from your signed-in ChatGPT Web UI. Metadata only - HCR never reads other conversations."
              >
                <div className="row" style={{ marginBottom: 6 }}>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => void loadProjects({ refresh: true })}
                    disabled={busy || projectsState === 'loading'}
                  >
                    Refresh Projects
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => void loadChats(selectedProject, { refresh: true })}
                    disabled={busy || !selectedProject || chatsState === 'loading'}
                  >
                    Refresh Sessions
                  </button>
                </div>
                <select value={selectedProject?.id ?? ''} onChange={(event) => onProjectChange(event.target.value)}>
                  <option value="">{projectPlaceholder}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name || project.id}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Session">
                <select
                  value={selectedChat?.id ?? ''}
                  onChange={(event) => onChatChange(event.target.value)}
                  disabled={!selectedProject}
                >
                  <option value="">{chatPlaceholder}</option>
                  {chats.map((chat) => (
                    <option key={chat.id} value={chat.id}>
                      {chat.title || chat.id}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Mode">
                <select value={mode} onChange={(event) => setMode(event.target.value as 'continue' | 'create')}>
                  <option value="continue">Continue Existing Session</option>
                  <option value="create">Create New Session in Selected Project</option>
                </select>
              </Field>

              {mode === 'create' ? (
                <Field
                  label="New Session Title"
                  hint="Optional. ChatGPT may rename the session - the captured URL/ID stays the authoritative identifier."
                >
                  <input
                    type="text"
                    value={newChatTitle}
                    onChange={(event) => setNewChatTitle(event.target.value)}
                    placeholder="e.g. Browser Companion Work"
                    maxLength={120}
                  />
                </Field>
              ) : null}

              {destinationNotice ? <p className="field-hint">{destinationNotice}</p> : null}
              {!selectedProject ? (
                <p className="field-hint">
                  Without a selected ChatGPT Project the prompt is sent to whichever ChatGPT chat is currently open.
                </p>
              ) : null}
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
                {destinationLabel ? <KeyValue label="ChatGPT Destination" value={destinationLabel} /> : null}
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

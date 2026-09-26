import type { FileDiff, PatchAction } from '../types';

const ACTION_LABEL: Record<PatchAction, string> = {
  create: 'CREATE',
  replace: 'REPLACE',
  delete: 'DELETE',
};

const ACTION_TONE: Record<PatchAction, string> = {
  create: 'ok',
  replace: 'info',
  delete: 'error',
};

function DiffLines({ diff }: { diff: FileDiff }) {
  if (diff.lines.length === 0) {
    return <p className="diff-empty">No textual differences.</p>;
  }
  return (
    <div className="diff-lines">
      {diff.lines.map((line, index) => (
        <div key={index} className={`diff-line diff-${line.type}`}>
          <span className="diff-gutter">{line.oldNo ?? ''}</span>
          <span className="diff-gutter">{line.newNo ?? ''}</span>
          <span className="diff-marker">
            {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
          </span>
          <span className="diff-text">{line.text === '' ? ' ' : line.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Before/after diff renderer. Delete actions are visually explicit: the whole
 * file is rendered as removals with a DELETE marker.
 */
export function DiffView({ diffs, emptyHint }: { diffs: FileDiff[]; emptyHint?: string }) {
  if (diffs.length === 0) {
    return <p className="muted">{emptyHint ?? 'No changes to display.'}</p>;
  }

  return (
    <div className="diff-list">
      {diffs.map((diff) => (
        <div key={`${diff.action}:${diff.path}`} className="diff-file">
          <div className="diff-file-header">
            <span className={`badge badge-${ACTION_TONE[diff.action]}`}>{ACTION_LABEL[diff.action]}</span>
            <span className="diff-path mono">{diff.path}</span>
            <span className="diff-stats">
              <span className="diff-add-count">+{diff.added}</span>
              <span className="diff-del-count">−{diff.removed}</span>
            </span>
          </div>
          {diff.action === 'delete' ? (
            <p className="diff-delete-note">This file will be permanently removed from the project.</p>
          ) : null}
          {diff.summarized ? (
            <p className="diff-summarized muted small">
              Large file: shown as a full replacement (line-by-line diff omitted).
            </p>
          ) : null}
          <DiffLines diff={diff} />
        </div>
      ))}
    </div>
  );
}

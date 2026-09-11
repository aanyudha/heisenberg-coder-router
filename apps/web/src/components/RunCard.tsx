import type { RunStatus } from '../App';

interface RunCardProps {
  run: RunStatus;
  onStart: () => void;
  onStop: () => void;
}

export function RunCard({ run, onStart, onStop }: RunCardProps) {
  const isRunning = run.state === 'running' || run.state === 'starting';

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Codex Runner</span>
        <span className={`status-badge ${run.state === 'running' ? 'online' : run.state === 'idle' ? 'offline' : 'unknown'}`}>
          {run.state}
        </span>
      </div>

      {run.command && <p className="muted mono">Command: {run.command}</p>}
      {run.error && <p className="error-text">{run.error}</p>}
      {run.state === 'exited' && run.exitCode !== null && run.exitCode !== undefined && (
        <p className="muted">Last exit code: {run.exitCode}</p>
      )}

      <div className="btn-row">
        <button className="btn btn-primary" onClick={onStart} disabled={isRunning}>
          Start Codex
        </button>
        <button className="btn btn-danger" onClick={onStop} disabled={!isRunning}>
          Stop Codex
        </button>
      </div>
    </div>
  );
}

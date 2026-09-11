import { useState } from 'react';
import type { ProjectInfoLike } from '../types';

interface ProjectControlProps {
  project: ProjectInfoLike | null;
  onSetProject: (projectDir: string) => Promise<boolean>;
}

export function ProjectControl({ project, onSetProject }: ProjectControlProps) {
  const [value, setValue] = useState(project?.path ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onSetProject(value.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-control">
      <label className="field-label">Project</label>
      <div className="project-row">
        <input
          type="text"
          value={value}
          placeholder="C:\\path\\to\\project"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <button className="btn btn-small" onClick={() => void submit()} disabled={busy}>
          Set
        </button>
      </div>
      {project && <span className="muted small mono">{project.name}</span>}
    </div>
  );
}

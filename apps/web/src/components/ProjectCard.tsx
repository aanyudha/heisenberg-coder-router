import { useState } from 'react';
import type { ProjectInfoLike } from '../types';

interface ProjectCardProps {
  project: ProjectInfoLike | null;
  onSetProject: (projectDir: string) => Promise<boolean>;
}

export function ProjectCard({ project, onSetProject }: ProjectCardProps) {
  const [value, setValue] = useState(project?.path ?? '');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onSetProject(value.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Project</span>
        {project && <span className="muted">{project.name}</span>}
      </div>
      <div className="field-group">
        <label className="field-label">Project directory</label>
        <input
          type="text"
          value={value}
          placeholder="C:\\path\\to\\your\\project"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSubmit();
          }}
        />
      </div>
      <button className="btn" onClick={() => void handleSubmit()} disabled={busy}>
        Set Project Directory
      </button>
    </div>
  );
}

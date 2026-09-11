interface StatusCardProps {
  title: string;
  value: string;
  status: 'online' | 'offline' | 'installed' | 'not-installed' | 'unknown';
  details?: string;
}

export function StatusCard({ title, value, status, details }: StatusCardProps) {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">{title}</span>
        <span className={`status-badge ${status}`}>{value}</span>
      </div>
      {details && <p className="muted">{details}</p>}
    </div>
  );
}

import { NAV, type PageId } from '../nav';

const ICONS: Record<string, string> = {
  overview: '▦',
  routing: '⇄',
  providers: '◉',
  models: '▤',
  'web-handoff': '⇄',
  'browser-companion': '◈',
  projects: '▣',
  activity: '≡',
  'live-traffic': '⚡',
  telemetry: '◔',
  settings: '⚙',
  about: 'ⓘ',
};

export function Sidebar({
  page,
  collapsed,
  onNavigate,
  onToggleCollapse,
}: {
  page: PageId;
  collapsed: boolean;
  onNavigate: (page: PageId) => void;
  onToggleCollapse: () => void;
}) {
  return (
    <nav className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="Primary">
      <div className="sidebar-brand">
        <span className="brand-mark">HCR</span>
        {!collapsed && (
          <span className="brand-text">
            <strong>Heisenberg</strong>
            <span>Coder Router</span>
          </span>
        )}
      </div>

      <div className="sidebar-scroll">
        {NAV.map((section) => (
          <div key={section.title ?? 'root'} className="nav-section">
            {section.title && !collapsed ? <div className="nav-section-title">{section.title}</div> : null}
            {section.title && collapsed ? <div className="nav-section-divider" /> : null}
            {section.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${page === item.id ? 'is-active' : ''}`}
                onClick={() => onNavigate(item.id)}
                title={collapsed ? item.label : undefined}
                aria-current={page === item.id ? 'page' : undefined}
              >
                <span className="nav-icon" aria-hidden="true">
                  {ICONS[item.id] ?? '•'}
                </span>
                {!collapsed && <span className="nav-label">{item.label}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>

      <button type="button" className="sidebar-collapse" onClick={onToggleCollapse}>
        <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
        {!collapsed && <span>Collapse</span>}
      </button>
    </nav>
  );
}

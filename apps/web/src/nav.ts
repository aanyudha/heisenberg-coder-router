import { useEffect, useState } from 'react';

export type PageId =
  | 'overview'
  | 'routing'
  | 'providers'
  | 'models'
  | 'web-handoff'
  | 'browser-companion'
  | 'hcoder'
  | 'projects'
  | 'activity'
  | 'live-traffic'
  | 'telemetry'
  | 'settings'
  | 'about';

export interface NavItem {
  id: PageId;
  label: string;
}

export interface NavSection {
  title: string | null;
  items: NavItem[];
}

export const DEFAULT_PAGE: PageId = 'overview';

/** Office-style admin navigation (sidebar sections). */
export const NAV: NavSection[] = [
  { title: null, items: [{ id: 'overview', label: 'Overview' }] },
  {
    title: 'AI Routing',
    items: [
      { id: 'routing', label: 'Routing' },
      { id: 'providers', label: 'Providers' },
      { id: 'models', label: 'Models' },
    ],
  },
  {
    title: 'Automation',
    items: [
      { id: 'web-handoff', label: 'Web Handoff' },
      { id: 'browser-companion', label: 'Browser Companion' },
    ],
  },
  {
    title: 'Coding',
    items: [{ id: 'hcoder', label: 'HCoder' }],
  },
  {
    title: 'Workspace',
    items: [
      { id: 'projects', label: 'Projects' },
      { id: 'activity', label: 'Activity' },
    ],
  },
  {
    title: 'Monitoring',
    items: [
      { id: 'live-traffic', label: 'Live Traffic' },
      { id: 'telemetry', label: 'Telemetry' },
    ],
  },
  {
    title: 'System',
    items: [
      { id: 'settings', label: 'Settings' },
      { id: 'about', label: 'About' },
    ],
  },
];

export const PAGE_TITLE: Record<PageId, string> = {
  overview: 'Overview',
  routing: 'Routing',
  providers: 'Providers',
  models: 'Models',
  'web-handoff': 'Web Handoff',
  'browser-companion': 'Browser Companion',
  hcoder: 'HCoder',
  projects: 'Projects',
  activity: 'Activity',
  'live-traffic': 'Live Traffic',
  telemetry: 'Telemetry',
  settings: 'Settings',
  about: 'About',
};

export const PAGE_SECTION: Record<PageId, string> = {
  overview: 'Workspace',
  routing: 'AI Routing',
  providers: 'AI Routing',
  models: 'AI Routing',
  'web-handoff': 'Automation',
  'browser-companion': 'Automation',
  hcoder: 'Coding',
  projects: 'Workspace',
  activity: 'Workspace',
  'live-traffic': 'Monitoring',
  telemetry: 'Monitoring',
  settings: 'System',
  about: 'System',
};

export const ALL_PAGE_IDS: PageId[] = NAV.flatMap((section) => section.items.map((item) => item.id));

function readHash(): PageId {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (ALL_PAGE_IDS as string[]).includes(raw) ? (raw as PageId) : DEFAULT_PAGE;
}

/** Hash-based page routing (no router dependency). */
export function usePage(): [PageId, (page: PageId) => void] {
  const [page, setPage] = useState<PageId>(() => readHash());

  useEffect(() => {
    const onHashChange = () => setPage(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = (next: PageId) => {
    window.location.hash = `/${next}`;
    setPage(next);
  };

  return [page, navigate];
}

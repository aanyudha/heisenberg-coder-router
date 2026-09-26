/** A single line in a computed before/after diff. */
export interface DiffLine {
  type: 'context' | 'add' | 'del';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface FileDiff {
  path: string;
  action: 'create' | 'replace' | 'delete';
  beforeExists: boolean;
  afterExists: boolean;
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the diff was summarized instead of line-matched (large file). */
  summarized: boolean;
}

/** Above this many lines per side the diff degrades to a coarse summary. */
const MAX_DIFF_LINES = 1000;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split('\n');
}

/**
 * Longest-common-subsequence line diff. Bounded: files above MAX_DIFF_LINES
 * per side fall back to a coarse remove-all/add-all view instead of building
 * a quadratic table.
 */
export function diffLines(before: string | null, after: string): { lines: DiffLine[]; added: number; removed: number; summarized: boolean } {
  const oldLines = before === null ? [] : splitLines(before);
  const newLines = splitLines(after);

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    const lines: DiffLine[] = [];
    for (let i = 0; i < oldLines.length; i++) {
      lines.push({ type: 'del', text: oldLines[i], oldNo: i + 1, newNo: null });
    }
    for (let i = 0; i < newLines.length; i++) {
      lines.push({ type: 'add', text: newLines[i], oldNo: null, newNo: i + 1 });
    }
    return { lines, added: newLines.length, removed: oldLines.length, summarized: true };
  }

  const n = oldLines.length;
  const m = newLines.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: 'context', text: oldLines[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: 'del', text: oldLines[i], oldNo: i + 1, newNo: null });
      removed++;
      i++;
    } else {
      lines.push({ type: 'add', text: newLines[j], oldNo: null, newNo: j + 1 });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: oldLines[i], oldNo: i + 1, newNo: null });
    removed++;
    i++;
  }
  while (j < m) {
    lines.push({ type: 'add', text: newLines[j], oldNo: null, newNo: j + 1 });
    added++;
    j++;
  }

  return { lines, added, removed, summarized: false };
}

/** Unified-diff style text (used by the "Open Diff" view and tests). */
export function toUnifiedDiff(diff: FileDiff): string {
  const header = [
    `--- ${diff.beforeExists ? `a/${diff.path}` : '/dev/null'}`,
    `+++ ${diff.afterExists ? `b/${diff.path}` : '/dev/null'}`,
    `@@ ${diff.action.toUpperCase()} ${diff.path} @@`,
  ];
  const body = diff.lines.map((line) => {
    const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    return `${prefix}${line.text}`;
  });
  return [...header, ...body].join('\n');
}

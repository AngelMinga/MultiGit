// Resumen de ramas de todos los repos (para la barra de estado). Puro, sin `vscode`.
import { describeHead, type RepoStatus } from './parsers';

export interface BranchSummaryInput {
  name: string;
  status?: RepoStatus;
}

export type BranchSummary =
  | { kind: 'empty' }
  /** Todos los repos (con estado legible) están en la misma rama. */
  | { kind: 'single'; branch: string; repos: string[] }
  /** Hay repos en ramas distintas. `byBranch` está ordenado por cantidad de repos (desc). */
  | { kind: 'mixed'; byBranch: Array<{ branch: string; repos: string[] }> };

export function summarizeBranches(repos: readonly BranchSummaryInput[]): BranchSummary {
  const groups = new Map<string, string[]>();
  for (const repo of repos) {
    if (!repo.status) continue;
    const head = describeHead(repo.status);
    const list = groups.get(head) ?? [];
    list.push(repo.name);
    groups.set(head, list);
  }

  if (groups.size === 0) return { kind: 'empty' };

  const byBranch = [...groups.entries()]
    .map(([branch, names]) => ({ branch, repos: names.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => b.repos.length - a.repos.length || a.branch.localeCompare(b.branch));

  if (byBranch.length === 1) {
    const only = byBranch[0]!;
    return { kind: 'single', branch: only.branch, repos: only.repos };
  }
  return { kind: 'mixed', byBranch };
}

/** Totales de commits por subir/bajar y repos con cambios, sumando todos los repos. */
export function sumCounters(statuses: readonly (RepoStatus | undefined)[]): {
  ahead: number;
  behind: number;
  dirtyRepos: number;
} {
  let ahead = 0;
  let behind = 0;
  let dirtyRepos = 0;
  for (const s of statuses) {
    if (!s) continue;
    ahead += s.ahead ?? 0;
    behind += s.behind ?? 0;
    if (s.changes.total > 0) dirtyRepos++;
  }
  return { ahead, behind, dirtyRepos };
}

/** Texto compacto `↑2 ↓5` (vacío si ambos son 0 o no hay upstream). */
export function formatAheadBehind(status: Pick<RepoStatus, 'ahead' | 'behind'>): string {
  const parts: string[] = [];
  if (status.ahead) parts.push(`↑${status.ahead}`);
  if (status.behind) parts.push(`↓${status.behind}`);
  return parts.join(' ');
}

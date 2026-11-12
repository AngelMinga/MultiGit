// Ramas desalineadas: la mayoría de los repos está en una rama y algunos en otra. Puro.
import { summarizeBranches, type BranchSummaryInput } from './branchSummary';

export interface Alignment {
  /** Rama de la mayoría. */
  target: string;
  aligned: string[];
  /** Repos en otra rama (o con HEAD detached). */
  outliers: Array<{ repo: string; branch: string }>;
}

/**
 * Rama de la mayoría y repos fuera de ella. `null` si están todos en la misma rama, si no hay una
 * mayoría clara (empate o menos de 2 repos en la más usada) o si la mayoría está en HEAD detached.
 */
export function computeAlignment(repos: readonly BranchSummaryInput[]): Alignment | null {
  const summary = summarizeBranches(repos);
  if (summary.kind !== 'mixed') return null;
  const [first, second] = summary.byBranch;
  if (!first || first.repos.length < 2 || (second && second.repos.length === first.repos.length)) return null;
  if (first.branch.startsWith('(')) return null; // "(detached …)": no es una rama a la que alinear
  return {
    target: first.branch,
    aligned: first.repos,
    outliers: summary.byBranch.slice(1).flatMap((g) => g.repos.map((repo) => ({ repo, branch: g.branch }))),
  };
}

/** Firma para avisar solo cuando la desalineación aparece o cambia. */
export function alignmentKey(a: Alignment | null): string {
  return a ? `${a.target}|${a.outliers.map((o) => `${o.repo}:${o.branch}`).join(',')}` : '';
}

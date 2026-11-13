// Lógica pura del diálogo de Pull (sin `vscode`).
import { orderBranches, type LocalBranch, type RepoBranches } from './branches';

export type PullMode = 'merge' | 'rebase' | 'ff-only';

export const PULL_MODE_LABEL: Record<PullMode, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'ff-only': '--ff-only',
};

/**
 * Argumentos de `git pull`. Sin `remote`/`branch`, usa el upstream de la rama actual.
 * En merge se pasa `--no-edit` para no abrir un editor con el mensaje del merge. Con `--autostash`, los
 * cambios sin commit no impiden el pull.
 */
export function pullArgs(mode: PullMode, remote?: string, branch?: string): string[] {
  // --autostash: con cambios sin commit, git los aparta y los vuelve a aplicar al terminar.
  const args = ['pull', '--autostash'];
  if (mode === 'merge') args.push('--no-rebase', '--no-edit');
  else if (mode === 'rebase') args.push('--rebase');
  else args.push('--ff-only');
  if (remote && branch) args.push(remote, branch);
  return args;
}

export interface PullRepoInput {
  repo: string;
  branches: RepoBranches;
}

export interface PullBranchChoice {
  /** Nombre en el remote (sin el remote): `develop`. */
  name: string;
  /** Repos donde existe `remote/name`. */
  repos: string[];
  /** Repos cuya rama actual tiene este upstream. */
  upstreamFor: string[];
}

/** Rama local actual de un repo. */
export function currentLocal(branches: RepoBranches): LocalBranch | undefined {
  return branches.local.find((b) => b.current);
}

/** Remotes de los repos, `origin` primero. */
export function remotesOf(repos: readonly PullRepoInput[]): string[] {
  const all = [...new Set(repos.flatMap((r) => r.branches.remotes))];
  return all.sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)));
}

/**
 * Ramas de `remote` (unión de todos los repos), ordenadas como IntelliJ:
 * primero la que es upstream de más repos, luego favoritas y luego alfabético.
 */
export function remoteBranchChoices(
  repos: readonly PullRepoInput[],
  remote: string,
  favorites: readonly string[],
): PullBranchChoice[] {
  const byName = new Map<string, PullBranchChoice>();
  for (const { repo, branches } of repos) {
    for (const b of branches.remote) {
      if (b.remote !== remote) continue;
      const choice = byName.get(b.name) ?? { name: b.name, repos: [], upstreamFor: [] };
      choice.repos.push(repo);
      byName.set(b.name, choice);
    }
    const cur = currentLocal(branches);
    if (cur?.upstreamRemote === remote && cur.upstreamBranch && !cur.gone) {
      byName.get(cur.upstreamBranch)?.upstreamFor.push(repo);
    }
  }
  const ordered = orderBranches([...byName.values()], favorites, (c) => c.name);
  return ordered.sort((a, b) => b.upstreamFor.length - a.upstreamFor.length);
}

/** Si todos los repos tienen el mismo upstream en `remote`, su nombre; si no, `null`. */
export function commonUpstream(repos: readonly PullRepoInput[], remote: string): string | null {
  let name: string | null = null;
  for (const { branches } of repos) {
    const cur = currentLocal(branches);
    if (!cur || cur.upstreamRemote !== remote || !cur.upstreamBranch || cur.gone) return null;
    if (name !== null && name !== cur.upstreamBranch) return null;
    name = cur.upstreamBranch;
  }
  return name;
}

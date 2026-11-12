// Ramas: parseo de `git for-each-ref` y lógica de "ramas comunes". Puro, sin `vscode`.
import * as path from 'node:path';

export interface LocalBranch {
  name: string;
  /** Es la rama actual (HEAD) del repo. */
  current: boolean;
  /** Upstream abreviado, p. ej. `origin/develop`. */
  upstream: string | null;
  /** Remote del upstream, p. ej. `origin`. */
  upstreamRemote: string | null;
  /** Nombre de la rama en el remote (sin `refs/heads/`). */
  upstreamBranch: string | null;
  ahead: number;
  behind: number;
  /** El upstream configurado ya no existe en el remote. */
  gone: boolean;
}

export interface RemoteBranch {
  remote: string;
  /** Nombre sin el remote: `develop`. */
  name: string;
  /** Nombre completo: `origin/develop`. */
  full: string;
}

export interface RepoBranches {
  local: LocalBranch[];
  remote: RemoteBranch[];
  remotes: string[];
}

/** Formato de `git for-each-ref` que entiende `parseRefs` (campos separados por NUL). */
export const REF_FORMAT = [
  '%(refname)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:remotename)',
  '%(upstream:remoteref)',
  '%(upstream:track,nobracket)',
].join('%00');

/** Parsea la salida de `git for-each-ref --format=REF_FORMAT refs/heads refs/remotes`. */
export function parseRefs(output: string, remotes: readonly string[]): RepoBranches {
  const local: LocalBranch[] = [];
  const remote: RemoteBranch[] = [];
  // Remotes más largos primero, por si uno es prefijo de otro ("origin" / "origin/fork").
  const byLength = [...remotes].sort((a, b) => b.length - a.length);

  for (const line of output.split('\n')) {
    if (!line) continue;
    const [refname = '', head = '', upstream = '', upRemote = '', upRef = '', track = ''] = line.split('\0');

    if (refname.startsWith('refs/heads/')) {
      const { ahead, behind, gone } = parseTrack(track);
      local.push({
        name: refname.slice('refs/heads/'.length),
        current: head === '*',
        upstream: upstream || null,
        upstreamRemote: upRemote || null,
        upstreamBranch: upRef ? upRef.replace(/^refs\/heads\//, '') : null,
        ahead,
        behind,
        gone,
      });
    } else if (refname.startsWith('refs/remotes/')) {
      const rest = refname.slice('refs/remotes/'.length);
      const remoteName = byLength.find((r) => rest.startsWith(`${r}/`)) ?? rest.split('/')[0] ?? '';
      const name = rest.slice(remoteName.length + 1);
      if (!name || name === 'HEAD') continue; // origin/HEAD es un alias, no una rama
      remote.push({ remote: remoteName, name, full: `${remoteName}/${name}` });
    }
  }

  return { local, remote, remotes: [...remotes] };
}

/** Parsea `%(upstream:track,nobracket)`: "ahead 2, behind 1", "behind 3", "gone" o "". */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  if (track === 'gone') return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0, gone: false };
}

export interface CommonBranch {
  /** Nombre local (`develop`) o remoto completo (`origin/develop`). */
  name: string;
  favorite: boolean;
  /** Repos donde es la rama actual. */
  currentIn: string[];
}

export interface RepoBranchesInput {
  repo: string;
  branches: RepoBranches;
}

/**
 * Ramas locales que existen en TODOS los repos (intersección).
 * Orden: favoritas (en el orden configurado) y luego alfabético.
 */
export function commonLocalBranches(repos: readonly RepoBranchesInput[], favorites: readonly string[]): CommonBranch[] {
  if (repos.length === 0) return [];
  const names = intersect(repos.map((r) => r.branches.local.map((b) => b.name)));
  const result = names.map((name) => ({
    name,
    favorite: favorites.includes(name),
    currentIn: repos.filter((r) => r.branches.local.some((b) => b.name === name && b.current)).map((r) => r.repo),
  }));
  return orderBranches(result, favorites, (b) => b.name);
}

/**
 * Ramas remotas que existen en TODOS los repos, agrupadas por remote.
 * Una rama es favorita si su nombre sin remote está en `favorites`.
 */
export function commonRemoteBranches(
  repos: readonly RepoBranchesInput[],
  favorites: readonly string[],
): Map<string, CommonBranch[]> {
  const result = new Map<string, CommonBranch[]>();
  if (repos.length === 0) return result;

  const fulls = intersect(repos.map((r) => r.branches.remote.map((b) => b.full)));
  const first = repos[0]!.branches.remote;
  for (const full of fulls) {
    const info = first.find((b) => b.full === full)!;
    const list = result.get(info.remote) ?? [];
    list.push({ name: full, favorite: favorites.includes(info.name), currentIn: [] });
    result.set(info.remote, list);
  }
  for (const [remote, list] of result) {
    result.set(remote, orderBranches(list, favorites, (b) => b.name.slice(remote.length + 1)));
  }
  return new Map([...result.entries()].sort(([a], [b]) => remoteOrder(a) - remoteOrder(b) || a.localeCompare(b)));
}

/** Favoritas primero (en el orden configurado), luego alfabético. */
export function orderBranches<T>(items: readonly T[], favorites: readonly string[], shortName: (item: T) => string): T[] {
  const rank = (item: T) => {
    const i = favorites.indexOf(shortName(item));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...items].sort((a, b) => rank(a) - rank(b) || shortName(a).localeCompare(shortName(b)));
}

function remoteOrder(remote: string): number {
  return remote === 'origin' ? 0 : 1;
}

function intersect(lists: readonly string[][]): string[] {
  const [first, ...rest] = lists;
  if (!first) return [];
  const sets = rest.map((l) => new Set(l));
  return [...new Set(first)].filter((name) => sets.every((s) => s.has(name)));
}

/** Directorio común más profundo de varias rutas absolutas. */
export function commonAncestor(paths: readonly string[], p: path.PlatformPath = path): string {
  if (paths.length === 0) return '';
  if (paths.length === 1) return p.dirname(paths[0]!);
  const split = paths.map((x) => p.resolve(x).split(p.sep));
  const result: string[] = [];
  for (let i = 0; ; i++) {
    const segment = split[0]![i];
    if (segment === undefined || !split.every((s) => s[i] === segment)) break;
    result.push(segment);
  }
  return result.join(p.sep) || p.sep;
}

/** Nombre de rama apto para una carpeta: `feature/x` → `feature-x`. */
export function branchToFolderName(branch: string): string {
  return branch.replace(/[\\/:*?"<>|\s]+/g, '-');
}

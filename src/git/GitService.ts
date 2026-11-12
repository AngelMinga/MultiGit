// Wrapper de git para UN repositorio. Es el único lugar que ejecuta procesos git.
// Siempre execFile con un array de argumentos: nunca se arma un string de shell.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseRefs, REF_FORMAT, type RepoBranches } from './branches';
import {
  LOG_FORMAT,
  parseLeftRightCount,
  parseLog,
  parseNameStatusZ,
  parseStatusV2,
  type AheadBehind,
  type ChangedFile,
  type CommitInfo,
  type RepoStatus,
} from './parsers';
import type { OperationInProgress } from './preflight';

const DEFAULT_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 180_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Error de un comando git, con su código de salida y stderr para mostrar al usuario. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface PushOptions {
  setUpstream?: boolean;
  forceWithLease?: boolean;
  tags?: 'none' | 'all' | 'follow';
}

export class GitService {
  readonly name: string;

  constructor(
    readonly root: string,
    private readonly gitPath = 'git',
  ) {
    this.name = path.basename(root);
  }

  /** Ejecuta `git <args>` en la raíz del repo y devuelve stdout. */
  exec(args: readonly string[], options: GitExecOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        [...args],
        {
          cwd: this.root,
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: options.signal,
          windowsHide: true,
          env: {
            ...process.env,
            // Nunca bloquear esperando credenciales en una terminal invisible.
            GIT_TERMINAL_PROMPT: '0',
            // Mensajes en inglés y estables para poder parsearlos.
            LC_ALL: 'C',
            // ":" es el editor "no-op" de git: merge/rebase nunca se quedan esperando un editor.
            GIT_EDITOR: ':',
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === 'number' ? error.code : null;
            const detail = stderr.trim() || error.message;
            reject(new GitError(`git ${args.join(' ')} falló en ${this.name}: ${detail}`, args, code, stderr));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  /** Rama actual, upstream, ahead/behind y contadores de cambios. */
  async getStatus(): Promise<RepoStatus> {
    // --no-optional-locks: no competir por index.lock con la extensión git integrada.
    const out = await this.exec(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z']);
    return parseStatusV2(out);
  }

  /**
   * Commits por subir/bajar de `head` respecto a `base` (por defecto, el upstream).
   * `null` si `base` no existe (p. ej. la rama no tiene upstream).
   * Nota: el estado normal ya trae estos contadores (`branch.ab` de getStatus);
   * esto sirve para comparar contra otras ramas.
   */
  async getAheadBehind(base = '@{u}', head = 'HEAD'): Promise<AheadBehind | null> {
    try {
      const out = await this.exec(['rev-list', '--left-right', '--count', `${base}...${head}`, '--']);
      return parseLeftRightCount(out);
    } catch (error) {
      if (error instanceof GitError) return null;
      throw error;
    }
  }

  /** `git fetch --all --prune`. Nunca pide credenciales (GIT_TERMINAL_PROMPT=0). */
  async fetchAll(options: GitExecOptions = {}): Promise<void> {
    await this.exec(['fetch', '--all', '--prune'], { timeoutMs: NETWORK_TIMEOUT_MS, ...options });
  }

  // ---------------------------------------------------------------- lectura

  /** Ramas locales (con upstream y ↑/↓) y remotas. */
  async getBranches(): Promise<RepoBranches> {
    const [remotesOut, refsOut] = await Promise.all([
      this.exec(['remote']),
      this.exec(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes']),
    ]);
    const remotes = remotesOut.split('\n').map((r) => r.trim()).filter(Boolean);
    return parseRefs(refsOut, remotes);
  }

  /** Merge, rebase, cherry-pick o revert a medias (o `null`). */
  async getOperationInProgress(): Promise<OperationInProgress> {
    const markers: Array<[string, Exclude<OperationInProgress, null>]> = [
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase'],
      ['MERGE_HEAD', 'merge'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
    ];
    const out = await this.exec(['rev-parse', ...markers.flatMap(([m]) => ['--git-path', m])]);
    const paths = out.split('\n').filter(Boolean);
    for (let i = 0; i < markers.length; i++) {
      const p = paths[i];
      if (p && (await exists(path.resolve(this.root, p)))) return markers[i]![1];
    }
    return null;
  }

  /** Valida un nombre de rama con `git check-ref-format --branch`. */
  async isValidBranchName(name: string): Promise<boolean> {
    if (!name || name.startsWith('-')) return false;
    try {
      await this.exec(['check-ref-format', '--branch', name]);
      return true;
    } catch {
      return false;
    }
  }

  /** ¿Existe `ref` y apunta a un commit? */
  async revisionExists(ref: string): Promise<boolean> {
    if (!ref || ref.startsWith('-')) return false;
    try {
      await this.exec(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** ¿`ancestor` es ancestro de (o igual a) `descendant`? */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.exec(['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /** Cantidad de commits de un rango (`a..b`). */
  async countCommits(range: string): Promise<number> {
    const out = await this.exec(['rev-list', '--count', range, '--']);
    return Number(out.trim()) || 0;
  }

  /** Commits según `args` (rango, `--not`, etc.), como máximo `max`. */
  async logCommits(args: readonly string[], max = 500): Promise<CommitInfo[]> {
    const out = await this.exec(['log', `--max-count=${max}`, `--format=${LOG_FORMAT}`, ...args, '--']);
    return parseLog(out);
  }

  /** Archivos cambiados por un commit (contra su primer padre; contra vacío si es el commit raíz). */
  async commitFiles(hash: string): Promise<ChangedFile[]> {
    const parents = (await this.exec(['rev-list', '--parents', '-n', '1', hash, '--'])).trim().split(/\s+/);
    const out =
      parents.length > 1
        ? await this.exec(['diff', '--name-status', '-z', '-M', parents[1]!, hash, '--'])
        : await this.exec(['diff-tree', '--root', '-r', '--name-status', '-z', '-M', '--no-commit-id', hash]);
    return parseNameStatusZ(out);
  }

  /** Contenido de `filePath` en `ref` (`git show ref:path`). */
  showFile(ref: string, filePath: string): Promise<string> {
    return this.exec(['show', `${ref}:${filePath}`]);
  }

  /** Commits de un rango, una línea cada uno: `abc1234 asunto (autor, hace 2 días)`. */
  async logOneline(range: string, max = 200): Promise<string[]> {
    const out = await this.exec(['log', `--max-count=${max}`, '--format=%h %s (%an, %ar)', range, '--']);
    return out.split('\n').filter(Boolean);
  }

  // ---------------------------------------------------------------- escritura

  checkout(branch: string): Promise<string> {
    return this.exec(['checkout', branch, '--']);
  }

  /** Crea la rama local `local` siguiendo a `remoteRef` (`origin/x`) y hace checkout. */
  checkoutTracking(local: string, remoteRef: string): Promise<string> {
    return this.exec(['checkout', '-b', local, '--track', remoteRef, '--']);
  }

  checkoutDetached(ref: string): Promise<string> {
    return this.exec(['checkout', '--detach', ref, '--']);
  }

  /**
   * Crea `name` desde `start` (sin upstream: si `start` es remota, git lo enlazaría y el push
   * iría a esa rama). Con `checkout`, además cambia a ella.
   */
  createBranch(name: string, start: string, checkout: boolean): Promise<string> {
    return checkout
      ? this.exec(['checkout', '--no-track', '-b', name, start, '--'])
      : this.exec(['branch', '--no-track', name, start]);
  }

  renameBranch(oldName: string, newName: string): Promise<string> {
    return this.exec(['branch', '-m', oldName, newName]);
  }

  deleteBranch(name: string, force: boolean): Promise<string> {
    return this.exec(['branch', force ? '-D' : '-d', name]);
  }

  deleteRemoteBranch(remote: string, name: string): Promise<string> {
    return this.exec(['push', remote, '--delete', name], { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  merge(ref: string): Promise<string> {
    return this.exec(['merge', '--no-edit', ref]);
  }

  /** `git rebase <onto>` (rama actual) o `git rebase <onto> <branch>` (checkout + rebase). */
  rebase(onto: string, branch?: string): Promise<string> {
    return this.exec(branch ? ['rebase', onto, branch] : ['rebase', onto]);
  }

  /** Pull del upstream con merge. */
  pull(): Promise<string> {
    return this.exec(['pull', '--no-rebase'], { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  /** Actualiza una rama local que NO es la actual (solo fast-forward). */
  fetchIntoBranch(remote: string, remoteBranch: string, localBranch: string): Promise<string> {
    return this.exec(['fetch', remote, `refs/heads/${remoteBranch}:refs/heads/${localBranch}`], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
  }

  fetchBranch(remote: string, branch: string): Promise<string> {
    return this.exec(['fetch', remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`], {
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
  }

  /**
   * Push de `localBranch` a `remote/remoteBranch`.
   * - `setUpstream`: `-u` (rama nueva o sin upstream).
   * - `forceWithLease`: sobrescribe el remote solo si sigue donde lo vimos en el último fetch.
   * - `tags`: `all` → `--tags`; `follow` → `--follow-tags` (tags anotados alcanzables desde lo que se sube).
   */
  pushBranch(remote: string, localBranch: string, remoteBranch: string, options: PushOptions = {}): Promise<string> {
    const args = ['push'];
    if (options.setUpstream) args.push('-u');
    if (options.forceWithLease) args.push('--force-with-lease');
    if (options.tags === 'all') args.push('--tags');
    if (options.tags === 'follow') args.push('--follow-tags');
    args.push(remote, `refs/heads/${localBranch}:refs/heads/${remoteBranch}`);
    return this.exec(args, { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  /** `git worktree add <dir> <branch>` (rama local existente). */
  addWorktree(dir: string, branch: string): Promise<string> {
    return this.exec(['worktree', 'add', dir, branch]);
  }

  /** `git worktree add --track -b <local> <dir> <remoteRef>`. */
  addWorktreeTracking(dir: string, local: string, remoteRef: string): Promise<string> {
    return this.exec(['worktree', 'add', '--track', '-b', local, dir, remoteRef]);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

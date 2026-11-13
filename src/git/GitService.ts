// Wrapper de git para UN repositorio. Es el único lugar que ejecuta procesos git.
// Siempre execFile con un array de argumentos: nunca se arma un string de shell.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseRefs, REF_FORMAT, type RepoBranches } from './branches';
import { pullArgs, type PullMode } from './pull';
import { LOG_PAGE_FORMAT, parseLogPage, type LogCommit } from './log';
import { parseStatusFiles, type StatusFile } from './changes';
import { parseStashList, SHELF_PREFIX, STASH_FORMAT, type StashEntry } from './stashes';
import { buildTodo, parseRebaseLog, REBASE_LOG_FORMAT, type RebaseCommit, type RebaseEntry } from './rebase';
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
import { hasConflictMarkers, type Operation } from './operations';
import { t } from '../i18n';

const DEFAULT_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 180_000;
/** Los hooks de pre-commit (husky, lint-staged) pueden tardar. */
const COMMIT_TIMEOUT_MS = 300_000;
const REBASE_TIMEOUT_MS = 5 * 60_000;
/** Mensaje del stash temporal de Smart Checkout. */
export const SMART_CHECKOUT_PREFIX = 'MultiGit smart checkout → ';
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GitExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Variables de entorno extra (p. ej. GIT_INDEX_FILE). */
  env?: Record<string, string>;
  /** Texto para la entrada estándar. */
  input?: string;
}

/** Error de un comando git, con su código de salida y stderr para mostrar al usuario. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    /** Algunos errores (p. ej. CONFLICT de merge) salen por stdout. */
    readonly stdout = '',
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
  /**
   * Variables extra para todos los procesos git (las del askpass, que activa la extensión).
   * Es estático porque hay un askpass por ventana, compartido por todos los repos.
   */
  static extraEnv: Record<string, string> = {};
  /** Se llama cuando git rechaza una credencial (para olvidar respuestas recordadas). */
  static onAuthFailure: (() => void) | undefined;

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
      const child = execFile(
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
            ...GitService.extraEnv,
            // Nunca bloquear esperando credenciales en una terminal invisible (las pide el askpass).
            GIT_TERMINAL_PROMPT: '0',
            // Mensajes en inglés y estables para poder parsearlos.
            LC_ALL: 'C',
            // ":" es el editor "no-op" de git: merge/rebase nunca se quedan esperando un editor.
            GIT_EDITOR: ':',
            ...options.env,
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const code = typeof error.code === 'number' ? error.code : null;
            const detail = stderr.trim() || stdout.trim() || error.message;
            if (/Authentication failed|Invalid username or password|Permission denied \(publickey|could not read (Username|Password)/i.test(stderr)) {
              GitService.onAuthFailure?.();
            }
            reject(new GitError(t('git {0} failed in {1}: {2}', args.join(' '), this.name, detail), args, code, stderr, stdout));
            return;
          }
          resolve(stdout);
        },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
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

  /** `git <merge|rebase|cherry-pick|revert> --continue` (el editor es ":", acepta el mensaje propuesto). */
  continueOperation(op: Operation): Promise<string> {
    return this.exec([op, '--continue']);
  }

  /** `git <op> --abort`: vuelve al estado anterior a la operación. */
  abortOperation(op: Operation): Promise<string> {
    return this.exec([op, '--abort']);
  }

  /** `git rebase --skip` / `git cherry-pick --skip`: salta el commit actual. */
  skipOperation(op: Operation): Promise<string> {
    return this.exec([op, '--skip']);
  }

  /** De los archivos dados, los que todavía tienen marcas de conflicto (<<<<<<< … >>>>>>>). */
  async filesWithConflictMarkers(paths: readonly string[]): Promise<string[]> {
    const result: string[] = [];
    for (const p of paths) {
      try {
        if (hasConflictMarkers(await fs.readFile(path.join(this.root, p), 'utf8'))) result.push(p);
      } catch {
        // borrado como resolución: no tiene marcas
      }
    }
    return result;
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

  /**
   * Archivos de un commit agrupados como el detalle de IntelliJ. Commit normal: un grupo contra su padre.
   * Merge: lo que cambió respecto a TODOS los padres (lo resuelto en el merge) y un grupo por padre.
   */
  async commitFileGroups(hash: string): Promise<Array<{ parent: string | null; parentSubject?: string; files: ChangedFile[]; merged?: boolean }>> {
    const parents = (await this.exec(['rev-list', '--parents', '-n', '1', hash, '--'])).trim().split(/\s+/).slice(1);
    if (parents.length < 2) return [{ parent: parents[0] ?? null, files: await this.commitFiles(hash) }];
    const perParent = await Promise.all(
      parents.map(async (p) => ({
        parent: p,
        parentSubject: (await this.exec(['log', '-1', '--format=%s', p, '--'])).trim(),
        files: parseNameStatusZ(await this.exec(['diff', '--name-status', '-z', '-M', p, hash, '--'])),
      })),
    );
    const inAll = perParent[0]!.files.filter((f) => perParent.every((g) => g.files.some((x) => x.path === f.path)));
    return [{ parent: parents[0]!, files: inAll, merged: true }, ...perParent];
  }

  /** Ramas locales que contienen el commit y si HEAD lo contiene. */
  async branchesContaining(hash: string): Promise<{ branches: string[]; inHead: boolean }> {
    const [list, inHead] = await Promise.all([
      this.exec(['branch', '--contains', hash, '--format=%(refname:short)']).catch(() => ''),
      this.isAncestor(hash, 'HEAD').catch(() => false),
    ]);
    return { branches: list.split('\n').map((b) => b.trim()).filter(Boolean), inHead };
  }

  /** Archivos que difieren entre `ref` y el working tree. */
  async diffWithWorkingTree(ref: string): Promise<ChangedFile[]> {
    return parseNameStatusZ(await this.exec(['diff', '--name-status', '-z', '-M', ref, '--']));
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

  /**
   * Archivos con cambios locales que `git checkout <target>` sobrescribiría (y por eso fallaría):
   * versionados con cambios que además difieren entre HEAD y `target`, y sin versionar que existen en `target`.
   */
  async wouldBeOverwritten(target: string, files: readonly StatusFile[]): Promise<string[]> {
    const tracked = new Set(files.filter((f) => f.kind === 'tracked').flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path])));
    const untracked = new Set(files.filter((f) => f.kind === 'untracked').map((f) => f.path));
    if (!tracked.size && !untracked.size) return [];
    const hasHead = await this.revisionExists('HEAD');
    const out = new Set<string>();
    if (tracked.size) {
      const differ = hasHead
        ? (await this.exec(['diff', '--name-only', '--no-renames', '-z', 'HEAD', target, '--'])).split('\0')
        : (await this.exec(['ls-tree', '-r', '-z', '--name-only', target])).split('\0');
      for (const p of differ) if (tracked.has(p)) out.add(p);
    }
    if (untracked.size) {
      const inTarget = (await this.exec(['ls-tree', '-r', '-z', '--name-only', target])).split('\0');
      // Carpetas sin versionar ("src/nueva/"): choca cualquier archivo de target dentro de ellas.
      const dirs = [...untracked].filter((p) => p.endsWith('/'));
      for (const p of inTarget) if (untracked.has(p) || dirs.some((d) => p.startsWith(d))) out.add(p);
    }
    return [...out].sort();
  }

  /**
   * Smart Checkout (como IntelliJ): guarda los cambios locales en un stash, hace el checkout y los vuelve
   * a aplicar. Si al aplicarlos hay conflictos, devuelve los archivos (quedan con marcas para el merge
   * editor y el stash se conserva como copia). Si el checkout falla, devuelve los cambios a su sitio.
   */
  async smartCheckout(target: string, checkout: () => Promise<unknown>): Promise<{ conflicts: string[] }> {
    await this.exec(['stash', 'push', '--include-untracked', '-m', `${SMART_CHECKOUT_PREFIX}${target}`]);
    try {
      await checkout();
    } catch (error) {
      await this.exec(['stash', 'pop']).catch(() => undefined);
      throw error;
    }
    try {
      await this.exec(['stash', 'pop']);
      return { conflicts: [] };
    } catch (error) {
      const conflicts = await this.getConflictedFiles().catch(() => []);
      if (conflicts.length) return { conflicts };
      throw new Error(t('{0} (your changes are kept in the stash "{1}")', error instanceof Error ? error.message : String(error), `${SMART_CHECKOUT_PREFIX}${target}`));
    }
  }

  /** `git checkout [-f] <rama>`. Con `force` descarta los cambios locales que estorben. */
  checkout(branch: string, force = false): Promise<string> {
    return this.exec(['checkout', ...(force ? ['-f'] : []), branch, '--']);
  }

  /** Crea la rama local `local` siguiendo a `remoteRef` (`origin/x`) y hace checkout. */
  checkoutTracking(local: string, remoteRef: string, force = false): Promise<string> {
    return this.exec(['checkout', ...(force ? ['-f'] : []), '-b', local, '--track', remoteRef, '--']);
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
    return this.pullWith('merge');
  }

  /** Pull con modo (merge / rebase / ff-only) desde el upstream o desde `remote`/`branch`. */
  pullWith(mode: PullMode, remote?: string, branch?: string): Promise<string> {
    return this.exec(pullArgs(mode, remote, branch), { timeoutMs: NETWORK_TIMEOUT_MS });
  }

  /** SHA de HEAD (o `null` si el repo no tiene commits). */
  async headSha(): Promise<string | null> {
    try {
      return (await this.exec(['rev-parse', '--verify', '--quiet', 'HEAD'])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Archivos en conflicto (rutas relativas a la raíz del repo). */
  async getConflictedFiles(): Promise<string[]> {
    const out = await this.exec(['diff', '--name-only', '--diff-filter=U', '-z']);
    return [...new Set(out.split('\0').filter(Boolean))];
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

  // ---------------------------------------------------------------- log

  /** Una página del log (`--skip`/`--max-count`) con los argumentos de filtro y el pathspec. */
  async logPage(filterArgs: readonly string[], paths: readonly string[], skip: number, count: number): Promise<LogCommit[]> {
    const out = await this.exec([
      'log',
      `--format=${LOG_PAGE_FORMAT}`,
      `--skip=${skip}`,
      `--max-count=${count}`,
      ...filterArgs,
      '--',
      ...paths,
    ]);
    return parseLogPage(out);
  }

  /** Hash del commit al que apunta `ref`, o `null` si no existe en este repo. */
  async resolveCommit(ref: string): Promise<string | null> {
    if (!(await this.revisionExists(ref))) return null;
    // revisionExists ya descartó refs que empiezan con '-'; con --verify solo se imprime el hash.
    return (await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
  }

  /** Commits que tocaron un archivo (siguiendo renombres), del más nuevo al más viejo. */
  async fileHistory(relPath: string, max = 300): Promise<CommitInfo[]> {
    const out = await this.exec(['log', `--max-count=${max}`, '--follow', `--format=${LOG_FORMAT}`, 'HEAD', '--', relPath]);
    return parseLog(out);
  }

  /** Tags, del más reciente al más antiguo. */
  async listTags(): Promise<string[]> {
    const out = await this.exec(['tag', '--list', '--sort=-creatordate']);
    return out.split('\n').map((t) => t.trim()).filter(Boolean);
  }

  /** Un commit concreto en el formato del log (o `null` si no existe en este repo). */
  async logCommit(ref: string): Promise<LogCommit | null> {
    if (!(await this.revisionExists(ref))) return null;
    const out = await this.exec(['log', '-1', `--format=${LOG_PAGE_FORMAT}`, '--end-of-options', ref, '--']);
    return parseLogPage(out)[0] ?? null;
  }

  /** Mensaje completo y datos del committer de un commit. */
  async commitDetails(hash: string): Promise<{ body: string; committer: string; commitTime: number }> {
    const out = await this.exec(['show', '-s', '--format=%B%x00%cn%x00%ct', hash]);
    const [body = '', committer = '', ct = '0'] = out.split('\0');
    return { body: body.trim(), committer: committer.trim(), commitTime: Number(ct.trim()) * 1000 };
  }

  /** Valor de `git config <key>` (o vacío). */
  async configGet(key: string): Promise<string> {
    try {
      return (await this.exec(['config', '--get', key])).trim();
    } catch {
      return '';
    }
  }

  cherryPick(hash: string): Promise<string> {
    return this.exec(['cherry-pick', hash]);
  }

  revert(hash: string): Promise<string> {
    return this.exec(['revert', '--no-edit', hash]);
  }

  /** `git reset --soft|--mixed|--hard <hash>` sobre la rama actual. */
  reset(mode: 'soft' | 'mixed' | 'hard', hash: string): Promise<string> {
    return this.exec(['reset', `--${mode}`, hash]);
  }

  /** Tag ligero, o anotado si hay mensaje. */
  createTag(name: string, hash: string, message?: string): Promise<string> {
    return this.exec(message ? ['tag', '-a', name, '-m', message, hash] : ['tag', name, hash]);
  }

  /** ¿`name` es válido como nombre de tag? */
  async isValidTagName(name: string): Promise<boolean> {
    if (!name || name.startsWith('-')) return false;
    try {
      await this.exec(['check-ref-format', `refs/tags/${name}`]);
      return true;
    } catch {
      return false;
    }
  }



  /** Archivos con cambios (incluye cada archivo dentro de carpetas sin versionar). */
  async getChanges(includeIgnored = false): Promise<StatusFile[]> {
    const out = await this.exec(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all']);
    const files = parseStatusFiles(out);
    if (!includeIgnored) return files;
    // Ignorados aparte y con carpetas agrupadas: node_modules/ es UNA entrada, no miles de archivos.
    const ignoredOut = await this.exec([
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=normal',
      '--ignored=traditional',
    ]);
    return [...files, ...parseStatusFiles(ignoredOut).filter((f) => f.kind === 'ignored')];
  }

  /** `git add -- <paths>` (para incluir archivos sin versionar en un commit). */
  async addPaths(paths: readonly string[]): Promise<void> {
    if (paths.length) await this.exec(['add', '--', ...paths]);
  }

  /**
   * Commits de un rebase interactivo desde `hash` (incluido) hasta HEAD, del más viejo al más nuevo.
   * `base` es el padre de `hash` (null si `hash` es la raíz: se usa `--root`).
   */
  async rebaseCommits(hash: string): Promise<{ base: string | null; commits: RebaseCommit[]; merges: number }> {
    const base = (await this.revisionExists(`${hash}^`)) ? (await this.exec(['rev-parse', `${hash}^`])).trim() : null;
    const range = base ? `${base}..HEAD` : 'HEAD';
    const [log, merges] = await Promise.all([
      this.exec(['log', '--reverse', `--format=${REBASE_LOG_FORMAT}`, range, '--']),
      this.exec(['rev-list', '--count', '--merges', range, '--']),
    ]);
    return { base, commits: parseRebaseLog(log), merges: Number(merges.trim()) || 0 };
  }

  /** `git rebase -i` con el todo ya armado (sin editor): `reword` usa archivos con el mensaje nuevo. */
  async interactiveRebase(base: string | null, entries: readonly RebaseEntry[]): Promise<string> {
    const dir = path.resolve(this.root, (await this.exec(['rev-parse', '--git-path', 'multigit-rebase'])).trim());
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const messageFile = (hash: string) => path.join(dir, `msg-${hash}.txt`);
    for (const e of entries) if (e.action === 'reword') await fs.writeFile(messageFile(e.hash), `${e.message!.trim()}\n`);
    const todo = path.join(dir, 'todo.txt');
    await fs.writeFile(todo, buildTodo(entries, messageFile));
    // Git llama a `$GIT_SEQUENCE_EDITOR <archivo-todo>`: copiamos el nuestro encima.
    const editor = `cp "${todo.replace(/\\/g, '/')}"`;
    return this.exec(['rebase', '-i', base ?? '--root'], { env: { GIT_SEQUENCE_EDITOR: editor }, timeoutMs: REBASE_TIMEOUT_MS });
  }

  async remoteUrl(remote: string): Promise<string> {
    return (await this.exec(['remote', 'get-url', '--', remote])).trim();
  }

  /** Rama por defecto del remoto (`refs/remotes/origin/HEAD` → `main`), si se conoce. */
  async remoteDefaultBranch(remote: string): Promise<string | undefined> {
    try {
      const ref = (await this.exec(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).trim();
      return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Asuntos de los commits de un rango (`a..b`), del más nuevo al más viejo. */
  async subjects(range: string, max = 100): Promise<string[]> {
    return (await this.exec(['log', `--max-count=${max}`, '--format=%s', range, '--'])).split('\n').filter(Boolean);
  }

  /** Archivos distintos entre dos revisiones (`git diff --name-status a b`). */
  async diffRefs(a: string, b: string): Promise<ChangedFile[]> {
    return parseNameStatusZ(await this.exec(['diff', '--name-status', '-z', '-M', '--end-of-options', a, b, '--']));
  }

  /** Diff de un archivo contra HEAD sin contexto (para elegir líneas del commit parcial). */
  diffForPartial(filePath: string): Promise<string> {
    return this.exec(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--', filePath]);
  }

  /**
   * Commit con archivos completos (`paths`, como `commitPaths`) y archivos con solo parte de sus
   * cambios (`partial`: contenido ya calculado). Se arma en un índice temporal a partir de HEAD, así
   * el working tree no se toca y lo no elegido queda como cambio sin commit. Después, el índice real
   * de esas rutas queda igual que el commit.
   */
  async commitPartial(
    message: string,
    paths: readonly string[],
    partial: ReadonlyArray<{ path: string; content: string }>,
    amend: boolean,
  ): Promise<string> {
    const tmp = path.resolve(this.root, (await this.exec(['rev-parse', '--git-path', 'multigit-index'])).trim());
    const env = { GIT_INDEX_FILE: tmp };
    let out: string;
    try {
      await this.exec(['read-tree', 'HEAD'], { env });
      if (paths.length) await this.exec(['add', '-A', '--', ...paths], { env });
      for (const p of partial) {
        const sha = (await this.exec(['hash-object', '-w', '--no-filters', '--stdin'], { input: p.content })).trim();
        const mode = (await this.exec(['ls-tree', 'HEAD', '--', p.path])).split(' ')[0] || '100644';
        await this.exec(['update-index', '--add', '--cacheinfo', `${mode},${sha},${p.path}`], { env });
      }
      out = await this.exec(['commit', '-m', message, ...(amend ? ['--amend'] : [])], { env, timeoutMs: COMMIT_TIMEOUT_MS });
    } finally {
      await fs.rm(tmp, { force: true });
    }
    // Como `commit --only`: en el índice real, esas rutas quedan como en el commit nuevo.
    await this.exec(['reset', '-q', 'HEAD', '--', ...paths, ...partial.map((p) => p.path)]);
    return out;
  }

  /** Commit solo de `paths` (`git commit --only`), opcionalmente `--amend`. */
  commitPaths(message: string, paths: readonly string[], amend: boolean): Promise<string> {
    const args = ['commit', '--only', '-m', message];
    if (amend) args.push('--amend');
    return this.exec([...args, '--', ...paths], { timeoutMs: COMMIT_TIMEOUT_MS });
  }

  /** Mensajes completos de los últimos `count` commits de un autor (email). */
  async recentMessages(email: string, count: number): Promise<string[]> {
    if (!email) return [];
    const out = await this.exec(['log', `-${count}`, '--no-merges', '--fixed-strings', `--author=<${email}>`, '--format=%B%x1e']);
    return out.split('\x1e').map((m) => m.trim()).filter(Boolean);
  }

  /** Mensaje completo del último commit (para Amend). */
  async lastCommitMessage(): Promise<string> {
    return (await this.exec(['log', '-1', '--format=%B'])).trim();
  }

  /** Vuelve `paths` a como están en HEAD (índice y working tree). */
  async restorePaths(paths: readonly string[]): Promise<void> {
    if (paths.length) await this.exec(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...paths]);
  }

  /** Saca `paths` del índice sin tocar el disco (los añadidos vuelven a "sin versionar"). */
  async unstageAdded(paths: readonly string[]): Promise<void> {
    if (paths.length) await this.exec(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...paths]);
  }

  /** Ruta absoluta de un archivo dentro de `.git` (p. ej. `info/exclude`), válida también en worktrees. */
  async resolveGitPath(name: string): Promise<string> {
    return path.resolve(this.root, (await this.exec(['rev-parse', '--git-path', name])).trim());
  }

  /** Patch (formato `git diff`) de archivos versionados contra HEAD. */
  async patchTracked(paths: readonly string[]): Promise<string> {
    if (!paths.length) return '';
    return this.exec(['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff', '--', ...paths]);
  }

  /** Patch de un archivo sin versionar (`git diff --no-index /dev/null <archivo>`). */
  async patchUntracked(filePath: string): Promise<string> {
    try {
      return await this.exec(['diff', '--no-index', '--binary', '--no-color', '--', '/dev/null', filePath]);
    } catch (error) {
      // --no-index sale con código 1 cuando hay diferencias (siempre, para un archivo nuevo).
      if (error instanceof GitError && error.exitCode === 1) return error.stdout;
      throw error;
    }
  }

  /** Shelve: `git stash push -u -m "MultiGit: <nombre>" -- <paths>`. */
  async stashPush(name: string, paths: readonly string[]): Promise<void> {
    await this.exec(['stash', 'push', '--include-untracked', '-m', `${SHELF_PREFIX}${name}`, '--', ...paths]);
  }

  async listStashes(): Promise<StashEntry[]> {
    return parseStashList(await this.exec(['stash', 'list', `--format=${STASH_FORMAT}`]));
  }

  stashPop(ref: string): Promise<string> {
    return this.exec(['stash', 'pop', ref]);
  }

  /** Stash Changes: `git stash push [-u] [--keep-index] -m <mensaje>`. */
  async stashAll(message: string, options: { untracked?: boolean; keepIndex?: boolean } = {}): Promise<void> {
    await this.exec(['stash', 'push', ...(options.untracked ? ['--include-untracked'] : []), ...(options.keepIndex ? ['--keep-index'] : []), '-m', message]);
  }

  /** `git stash apply [--index] <ref>`. */
  stashApply(ref: string, index = false): Promise<string> {
    return this.exec(['stash', 'apply', ...(index ? ['--index'] : []), ref]);
  }

  stashDrop(ref: string): Promise<string> {
    return this.exec(['stash', 'drop', ref]);
  }

  stashClear(): Promise<string> {
    return this.exec(['stash', 'clear']);
  }

  /** `git stash branch <rama> <ref>`: rama nueva desde la base del stash, con el stash aplicado. */
  stashBranch(branch: string, ref: string): Promise<string> {
    return this.exec(['stash', 'branch', branch, ref]);
  }

  /** Archivos de un stash: cambios versionados (base → stash) y, si los guardó, los sin versionar. */
  async stashFiles(hash: string): Promise<Array<ChangedFile & { untracked?: boolean }>> {
    const tracked = parseNameStatusZ(await this.exec(['diff', '--name-status', '-z', '-M', `${hash}^1`, hash, '--']));
    let untracked: string[] = [];
    if (await this.revisionExists(`${hash}^3`)) {
      untracked = (await this.exec(['ls-tree', '-r', '-z', '--name-only', `${hash}^3`])).split('\0').filter(Boolean);
    }
    return [...tracked, ...untracked.map((p) => ({ status: 'A', path: p, untracked: true }))];
  }


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

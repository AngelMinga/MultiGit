// Conoce TODOS los repos del workspace: los descubre, guarda su estado, les asigna color
// y avisa cuando algo cambia. Las vistas leen de aquí; nunca llaman a git directamente.
import * as vscode from 'vscode';
import { GitService } from './GitService';
import { describeHead, type RepoStatus } from './parsers';
import { assignRepoColors, repoColorId } from './repoColor';
import { canonicalPath, scanForRepos } from './repoScanner';
import type { GitAPI, GitExtension, GitRepository } from './vscodeGit';

export interface Repo {
  readonly git: GitService;
  readonly name: string;
  readonly root: string;
  /** Índice en la paleta `multigit.repoN`. */
  colorIndex: number;
  /** Último estado leído; `undefined` si todavía no se leyó o falló. */
  status?: RepoStatus;
  /** Mensaje del último error al leer el estado. */
  error?: string;
}

export interface FetchResult {
  repo: Repo;
  error?: string;
}

const API_INIT_TIMEOUT_MS = 10_000;
/** Espera tras un cambio antes de releer el estado (agrupa ráfagas de eventos). */
const STATUS_DEBOUNCE_MS = 400;
/** Fetches simultáneos como máximo. */
const FETCH_CONCURRENCY = 4;

export class RepoManager implements vscode.Disposable {
  /** Clave: ruta canónica (sin symlinks; en macOS/Windows en minúsculas). */
  private readonly repos = new Map<string, Repo>();
  /** Watchers por repo (misma clave que `repos`). */
  private readonly watchers = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private gitApi: GitAPI | undefined;
  private refreshRunning: Promise<void> | undefined;
  private refreshQueued = false;
  private readonly pendingStatus = new Set<string>();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;

  /** Se dispara después de cada refresco (repos añadidos/quitados o estado actualizado). */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(this.changeEmitter);
  }

  /** Repos ordenados por nombre. */
  get all(): readonly Repo[] {
    return [...this.repos.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Id del color de tema del repo, para `new vscode.ThemeColor(...)`. */
  colorIdOf(repo: Repo): string {
    return repoColorId(repo.colorIndex);
  }

  async initialize(): Promise<void> {
    this.gitApi = await this.loadGitApi();

    if (this.gitApi) {
      this.disposables.push(
        this.gitApi.onDidOpenRepository(() => void this.refresh()),
        this.gitApi.onDidCloseRepository(() => void this.refresh()),
      );
    }
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('multigit.scanDepth')) void this.refresh();
      }),
      // Al volver a la ventana releemos todo: pudo haber cambios desde una terminal externa.
      vscode.window.onDidChangeWindowState((e) => {
        if (e.focused) this.scheduleStatusRefresh();
      }),
    );

    await this.refresh();
  }

  /**
   * Vuelve a descubrir repos y leer su estado. Si ya hay un refresco en curso,
   * se encola UNO más al terminar (las llamadas intermedias se agrupan).
   */
  refresh(): Promise<void> {
    if (this.refreshRunning) {
      this.refreshQueued = true;
      return this.refreshRunning;
    }
    this.refreshRunning = (async () => {
      try {
        do {
          this.refreshQueued = false;
          await this.doRefresh();
        } while (this.refreshQueued);
      } finally {
        this.refreshRunning = undefined;
      }
    })();
    return this.refreshRunning;
  }

  /**
   * Relee solo el estado (rama, ↑/↓, cambios) de los repos indicados, o de todos,
   * con debounce. No vuelve a descubrir repos.
   */
  scheduleStatusRefresh(keys?: Iterable<string>): void {
    for (const key of keys ?? this.repos.keys()) this.pendingStatus.add(key);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => void this.flushStatusRefresh(), STATUS_DEBOUNCE_MS);
  }

  /**
   * `git fetch --all --prune` en todos los repos (máx. FETCH_CONCURRENCY a la vez)
   * y después relee su estado. Nunca lanza: los errores vienen en el resultado.
   */
  async fetchAll(onProgress?: (done: number, total: number, repo: Repo) => void): Promise<FetchResult[]> {
    const repos = this.all;
    const results: FetchResult[] = [];
    let done = 0;
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < repos.length) {
        const repo = repos[next++]!;
        try {
          await repo.git.fetchAll();
          results.push({ repo });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn(`Fetch falló en ${repo.name}: ${message}`);
          results.push({ repo, error: message });
        }
        onProgress?.(++done, repos.length, repo);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, repos.length) }, worker));

    await this.readStatuses(repos);
    this.changeEmitter.fire();
    return results.sort((a, b) => a.repo.name.localeCompare(b.repo.name));
  }

  private async flushStatusRefresh(): Promise<void> {
    this.statusTimer = undefined;
    const repos = [...this.pendingStatus].map((k) => this.repos.get(k)).filter((r): r is Repo => !!r);
    this.pendingStatus.clear();
    if (repos.length === 0) return;
    await this.readStatuses(repos);
    this.changeEmitter.fire();
  }

  private async readStatuses(repos: readonly Repo[]): Promise<void> {
    await Promise.all(
      repos.map(async (repo) => {
        try {
          repo.status = await repo.git.getStatus();
          repo.error = undefined;
        } catch (error) {
          repo.status = undefined;
          repo.error = error instanceof Error ? error.message : String(error);
        }
      }),
    );
  }

  private async doRefresh(): Promise<void> {
    const roots = await this.discoverRoots();
    const gitPath = this.gitApi?.git.path ?? 'git';

    // Quita los repos que ya no están (y sus watchers).
    for (const key of [...this.repos.keys()]) {
      if (!roots.has(key)) {
        this.repos.delete(key);
        this.watchers.get(key)?.dispose();
        this.watchers.delete(key);
      }
    }
    // Agrega los nuevos; los existentes se conservan (mismo objeto).
    for (const [key, root] of roots) {
      if (!this.repos.has(key)) {
        const git = new GitService(root, gitPath);
        this.repos.set(key, { git, name: git.name, root, colorIndex: 0 });
      }
    }
    // Watchers: se recrean siempre, porque la API de vscode.git pudo abrir/cerrar repos.
    for (const [key, repo] of this.repos) {
      this.watchers.get(key)?.dispose();
      this.watchers.set(key, await this.watchRepo(key, repo));
    }

    const colors = assignRepoColors(this.all.map((r) => r.name));
    for (const repo of this.repos.values()) repo.colorIndex = colors.get(repo.name) ?? 0;

    await this.readStatuses([...this.repos.values()]);

    this.logRepos();
    this.changeEmitter.fire();
  }

  /**
   * Detecta cambios en un repo. Si la extensión vscode.git lo tiene abierto, usamos su
   * evento de estado (cubre working tree, índice y refs). Si no, vigilamos `.git`
   * (HEAD, index, refs) y los archivos guardados dentro del repo.
   */
  private async watchRepo(key: string, repo: Repo): Promise<vscode.Disposable> {
    const onChange = () => this.scheduleStatusRefresh([key]);

    const apiRepo = await this.findApiRepository(key);
    if (apiRepo) return apiRepo.state.onDidChange(onChange);

    const base = vscode.Uri.file(repo.root);
    const gitWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(base, '.git/{HEAD,index,FETCH_HEAD,MERGE_HEAD,REBASE_HEAD,refs/**}'),
    );
    const treeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, '**/*'));
    const subs = [
      gitWatcher,
      gitWatcher.onDidChange(onChange),
      gitWatcher.onDidCreate(onChange),
      gitWatcher.onDidDelete(onChange),
      treeWatcher,
      treeWatcher.onDidChange(onChange),
      treeWatcher.onDidCreate(onChange),
      treeWatcher.onDidDelete(onChange),
    ];
    return vscode.Disposable.from(...subs);
  }

  private async findApiRepository(key: string): Promise<GitRepository | undefined> {
    for (const r of this.gitApi?.repositories ?? []) {
      if ((await canonicalPath(r.rootUri.fsPath)) === key) return r;
    }
    return undefined;
  }

  /** Une los repos que conoce la API de vscode.git con los encontrados escaneando el disco. */
  private async discoverRoots(): Promise<Map<string, string>> {
    const candidates: string[] = [];

    if (this.gitApi) {
      candidates.push(...this.gitApi.repositories.map((r) => r.rootUri.fsPath));
    }

    // El escaneo cubre el caso sin vscode.git y también repos que la extensión integrada
    // no abrió (por su `git.repositoryScanMaxDepth`, que por defecto es 1).
    const depth = vscode.workspace.getConfiguration('multigit').get<number>('scanDepth', 2);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const scanned = await Promise.all(
      folders.filter((f) => f.uri.scheme === 'file').map((f) => scanForRepos(f.uri.fsPath, depth)),
    );
    candidates.push(...scanned.flat());

    const roots = new Map<string, string>();
    for (const candidate of candidates) {
      const key = await canonicalPath(candidate);
      if (!roots.has(key)) roots.set(key, candidate);
    }
    return roots;
  }

  private async loadGitApi(): Promise<GitAPI | undefined> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
      this.log.warn('La extensión integrada vscode.git no está disponible; se escaneará el disco.');
      return undefined;
    }
    try {
      const exports = extension.isActive ? extension.exports : await extension.activate();
      if (!exports.enabled) {
        this.log.warn('Git está deshabilitado en VS Code (git.enabled = false); se escaneará el disco.');
        return undefined;
      }
      const api = exports.getAPI(1);
      await waitForInitialized(api);
      this.log.info(`Usando la API de vscode.git (git en ${api.git.path}).`);
      return api;
    } catch (error) {
      this.log.error('No se pudo cargar la API de vscode.git; se escaneará el disco.', error);
      return undefined;
    }
  }

  private logRepos(): void {
    const repos = this.all;
    this.log.info(`${repos.length} repositorio(s) detectado(s):`);
    const width = Math.max(0, ...repos.map((r) => r.name.length));
    for (const repo of repos) {
      const head = repo.status ? describeHead(repo.status) : `error: ${repo.error ?? 'desconocido'}`;
      this.log.info(`  ${repo.name.padEnd(width)}  ⎇ ${head}  (${repo.root})`);
    }
  }

  dispose(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/** Espera a que la API de git termine de abrir los repos iniciales (con timeout). */
function waitForInitialized(api: GitAPI): Promise<void> {
  if (api.state === 'initialized') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, API_INIT_TIMEOUT_MS);
    const sub = api.onDidChangeState((state) => {
      if (state === 'initialized') done();
    });
    function done(): void {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    }
  });
}

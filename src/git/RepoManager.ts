// Conoce TODOS los repos del workspace: los descubre, guarda su estado, les asigna color
// y avisa cuando algo cambia. Las vistas leen de aquí; nunca llaman a git directamente.
import * as vscode from 'vscode';
import { GitService } from './GitService';
import { describeHead, type RepoStatus } from './parsers';
import { assignRepoColors, repoColorId } from './repoColor';
import { canonicalPath, scanForRepos } from './repoScanner';
import type { GitAPI, GitExtension } from './vscodeGit';

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

const API_INIT_TIMEOUT_MS = 10_000;

export class RepoManager implements vscode.Disposable {
  private readonly repos = new Map<string, Repo>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private gitApi: GitAPI | undefined;
  private refreshRunning: Promise<void> | undefined;
  private refreshQueued = false;

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

  private async doRefresh(): Promise<void> {
    const roots = await this.discoverRoots();
    const gitPath = this.gitApi?.git.path ?? 'git';

    // Sincroniza el mapa: conserva los repos que siguen, crea los nuevos, quita los que ya no están.
    const next = new Map<string, Repo>();
    for (const [key, root] of roots) {
      const existing = this.repos.get(key);
      if (existing) {
        next.set(key, existing);
      } else {
        const git = new GitService(root, gitPath);
        next.set(key, { git, name: git.name, root, colorIndex: 0 });
      }
    }
    this.repos.clear();
    for (const [key, repo] of next) this.repos.set(key, repo);

    const colors = assignRepoColors(this.all.map((r) => r.name));
    for (const repo of this.repos.values()) repo.colorIndex = colors.get(repo.name) ?? 0;

    await Promise.all(
      [...this.repos.values()].map(async (repo) => {
        try {
          repo.status = await repo.git.getStatus();
          repo.error = undefined;
        } catch (error) {
          repo.status = undefined;
          repo.error = error instanceof Error ? error.message : String(error);
        }
      }),
    );

    this.logRepos();
    this.changeEmitter.fire();
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

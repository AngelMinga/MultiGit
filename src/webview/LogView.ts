// Panel "Git Log" (WebviewView en el panel inferior): log combinado de todos los repos,
// filtros, detalle del commit y menú contextual (checkout, cherry-pick, revert, reset, rama, tag).
import * as vscode from 'vscode';
import { openCommitFileDiff } from '../git/GitContentProvider';
import {
  EMPTY_FILTERS,
  logFilterArgs,
  looksLikeHash,
  MergedLogPager,
  parseDecorations,
  resolveBranchRefs,
  type LogCommit,
  type LogFilters,
} from '../git/log';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import type { RepoBranches } from '../git/branches';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { BranchActions } from '../views/branchActions';
import type { LogAction, LogRepoInfo, LogRow, WebviewMessage } from './protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';

const PAGE_SIZE = 300;

export class LogView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'multigit.log';

  private view: vscode.WebviewView | undefined;
  private ready = false;
  private filters: LogFilters = EMPTY_FILTERS;
  private generation = 0;
  private pager: MergedLogPager | undefined;
  private loading = false;
  private branches = new Map<Repo, RepoBranches>();
  private tags = new Map<Repo, string[]>();
  /** Rama/HEAD de cada repo en la última carga: si cambia, se recarga el log. */
  private signature = '';
  private stale = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
    private readonly branchActions: BranchActions,
  ) {
    this.disposables.push(manager.onDidChange(() => this.onReposChanged()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri, 'log', 'Git Log');
    this.disposables.push(
      onWebviewMessage(view.webview, (m) => void this.onMessage(m)),
      view.onDidChangeVisibility(() => {
        if (view.visible && this.stale) void this.init();
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
      }),
    );
  }

  /** Navegación pedida antes de que el webview estuviera listo. */
  private pendingNavigate: { ref: string; repoIds: string[] } | undefined;

  /** Navigate Log to Branch Head desde la vista Ramas: abre el log y selecciona el commit de la rama. */
  async navigateTo(ref: string, repoIds: string[] = []): Promise<void> {
    await vscode.commands.executeCommand(`${LogView.viewId}.focus`);
    if (!this.ready) {
      this.pendingNavigate = { ref, repoIds };
      return;
    }
    await this.reveal(ref, repoIds);
  }

  private async reveal(ref: string, repoIds: string[]): Promise<void> {
    const repos = this.manager.all.filter((r) => repoIds.length === 0 || repoIds.includes(r.root));
    for (const repo of repos) {
      const hash = await repo.git.resolveCommit(ref);
      if (hash) {
        this.post({ type: 'log/reveal', payload: { repoId: repo.root, hash } });
        return;
      }
    }
    this.post({ type: 'error', payload: { message: `No se encontró '${ref}'.` } });
  }

  /** Archivo del "Show History": al elegir un commit se abre el diff de ese archivo. */
  private historyFile: { repoId: string; path: string } | undefined;

  /** Show History de un archivo: log de ese archivo en HEAD (siguiendo renombres). */
  async showFileHistory(repoId: string, relPath: string): Promise<void> {
    this.historyFile = { repoId, path: relPath };
    this.filters = { ...EMPTY_FILTERS, branch: 'HEAD', repoIds: [repoId], paths: [relPath], follow: true };
    await vscode.commands.executeCommand(`${LogView.viewId}.focus`);
    if (this.ready) {
      this.post({ type: 'log/filters', payload: this.filters });
      await this.reload();
    }
  }

  /** Muestra el log filtrado por una rama (desde la vista Ramas o el popup). */
  async showBranch(branch: string | null, repoIds: string[] = []): Promise<void> {
    this.filters = { ...this.filters, branch, repoIds };
    await vscode.commands.executeCommand(`${LogView.viewId}.focus`);
    if (this.ready) {
      this.post({ type: 'log/filters', payload: this.filters });
      await this.reload();
    }
  }

  // ------------------------------------------------------------------ mensajes

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          this.post({ type: 'init', payload: { kind: 'log' } });
          await this.init();
          if (this.pendingNavigate) {
            const { ref, repoIds } = this.pendingNavigate;
            this.pendingNavigate = undefined;
            await this.reveal(ref, repoIds);
          }
          break;
        case 'log/setFilters':
          this.filters = message.payload;
          // Si el usuario cambia el archivo o el repo, deja de ser el historial de un archivo.
          if (
            this.historyFile &&
            (this.filters.paths.length !== 1 ||
              this.filters.paths[0] !== this.historyFile.path ||
              !this.filters.repoIds.includes(this.historyFile.repoId))
          ) {
            this.historyFile = undefined;
            this.filters = { ...this.filters, follow: false };
          }
          await this.reload();
          break;
        case 'log/loadMore':
          if (message.payload.generation === this.generation) await this.loadMore();
          break;
        case 'log/resolveRef':
          // Navigate Log to Branch Head: commit al que apunta la rama/tag, en el primer repo que la tenga.
          await this.reveal(message.payload.ref, message.payload.repoIds);
          break;
        case 'log/refresh':
          await this.init();
          break;
        case 'log/select':
          await this.sendDetails(message.payload.repoId, message.payload.hash);
          await this.openHistoryDiff(message.payload.repoId, message.payload.hash);
          break;
        case 'log/openDiff':
          await openCommitFileDiff(message.payload.repoId, message.payload.hash, message.payload.file);
          break;
        case 'log/action':
          await this.runAction(message.payload.action, message.payload.repoId, message.payload.hash);
          break;
        default:
          break;
      }
    } catch (error) {
      this.post({ type: 'error', payload: { message: errorText(error) } });
    }
  }

  private post(message: Parameters<typeof postToWebview>[1]): void {
    if (this.view && this.ready) void postToWebview(this.view.webview, message);
  }

  // ------------------------------------------------------------------ carga

  /** Lee ramas de todos los repos, envía la info inicial y recarga el log. */
  private async init(): Promise<void> {
    this.stale = false;
    const repos = this.manager.all;
    const entries = await Promise.all(
      repos.map(async (r) => [r, await r.git.getBranches().catch(() => ({ local: [], remote: [], remotes: [] }))] as const),
    );
    this.branches = new Map(entries);
    this.tags = new Map(await Promise.all(repos.map(async (r) => [r, await r.git.listTags().catch(() => [])] as const)));
    this.signature = this.computeSignature();
    const first = repos[0];
    const me = first
      ? { name: await first.git.configGet('user.name'), email: await first.git.configGet('user.email') }
      : { name: '', email: '' };
    const info: LogRepoInfo[] = repos.map((r) => {
      const b = this.branches.get(r)!;
      return {
        id: r.root,
        name: r.name,
        colorIndex: r.colorIndex,
        current: b.local.find((l) => l.current)?.name ?? null,
        head: r.status?.oid ?? null,
        local: b.local.map((l) => l.name),
        remote: b.remote.map((x) => x.full),
        tags: this.tags.get(r) ?? [],
      };
    });
    this.post({
      type: 'log/init',
      payload: { repos: info, me, filters: this.filters, favorites: this.manager.favoriteBranches },
    });
    await this.reload();
  }

  private async reload(): Promise<void> {
    const generation = ++this.generation;
    this.pager = undefined;
    const repos = this.manager.all.filter((r) => this.filters.repoIds.length === 0 || this.filters.repoIds.includes(r.root));
    const text = this.filters.text.trim();

    // Hash: busca ese commit en cada repo.
    if (text && looksLikeHash(text)) {
      this.setLoading(generation, true);
      const found = await Promise.all(repos.map(async (r) => ({ repo: r, commit: await r.git.logCommit(text).catch(() => null) })));
      const rows = found.flatMap(({ repo, commit }) => (commit ? [this.toRow(repo, commit)] : []));
      if (generation !== this.generation) return;
      if (rows.length) {
        this.post({ type: 'log/rows', payload: { generation, reset: true, rows, hasMore: false } });
        this.setLoading(generation, false);
        return;
      }
      // Ningún hash coincide: se busca como texto en el mensaje.
      this.setLoading(generation, false);
    }

    const sources = repos.flatMap((repo) => {
      const b = this.branches.get(repo);
      const refs = resolveBranchRefs(
        this.filters.branch,
        b?.local.map((l) => l.name) ?? [],
        b?.remote.map((x) => x.full) ?? [],
        this.tags.get(repo) ?? [],
      );
      if (!refs) return [];
      const args = this.filterArgsFor(refs);
      let reported = false;
      return [
        {
          id: repo.root,
          fetch: async (skip: number, count: number) => {
            try {
              return await repo.git.logPage(args, this.filters.paths, skip, count);
            } catch (error) {
              if (!reported) {
                reported = true;
                this.post({ type: 'error', payload: { message: `${repo.name}: ${errorText(error)}` } });
              }
              return [];
            }
          },
        },
      ];
    });
    this.pager = new MergedLogPager(sources, PAGE_SIZE);
    await this.loadMore(true);
  }

  private filterArgsFor(refs: string[]): string[] {
    // Si llegamos aquí con un texto con forma de hash, es que no existe: se busca como texto.
    return logFilterArgs(this.filters, refs, { hashAsText: true });
  }

  private async loadMore(reset = false): Promise<void> {
    const pager = this.pager;
    const generation = this.generation;
    if (!pager || (this.loading && !reset)) return;
    this.setLoading(generation, true);
    try {
      const commits = await pager.next(PAGE_SIZE);
      if (generation !== this.generation) return;
      const byId = new Map(this.manager.all.map((r) => [r.root, r]));
      const rows = commits.map((c) => this.toRow(byId.get(c.repoId)!, c));
      this.post({ type: 'log/rows', payload: { generation, reset, rows, hasMore: pager.hasMore } });
    } finally {
      this.setLoading(generation, false);
    }
  }

  private setLoading(generation: number, loading: boolean): void {
    this.loading = loading;
    this.post({ type: 'log/loading', payload: { generation, loading } });
  }

  private toRow(repo: Repo, c: LogCommit): LogRow {
    return {
      repoId: repo.root,
      hash: c.hash,
      shortHash: c.shortHash,
      parents: c.parents,
      subject: c.subject,
      author: c.author,
      email: c.email,
      date: c.authorTime,
      refs: parseDecorations(c.decorations, this.branches.get(repo)?.remotes ?? []),
    };
  }

  private async sendDetails(repoId: string, hash: string): Promise<void> {
    const repo = this.repoById(repoId);
    if (!repo) return;
    const [details, files] = await Promise.all([repo.git.commitDetails(hash), repo.git.commitFiles(hash)]);
    this.post({ type: 'log/details', payload: { repoId, hash, ...details, files } });
  }

  /** En "Show History", abre el diff del archivo en el commit elegido (como el panel derecho de IntelliJ). */
  private async openHistoryDiff(repoId: string, hash: string): Promise<void> {
    const target = this.historyFile;
    const repo = this.repoById(repoId);
    if (!target || target.repoId !== repoId || !repo) return;
    const files = await repo.git.commitFiles(hash);
    const name = target.path.split('/').pop();
    // Por renombres, el archivo pudo tener otra ruta en ese commit: misma ruta, o mismo nombre, o el único.
    const file =
      files.find((f) => f.path === target.path) ??
      files.find((f) => f.path.split('/').pop() === name) ??
      (files.length === 1 ? files[0] : undefined);
    if (file) await openCommitFileDiff(repoId, hash, file);
  }

  private computeSignature(): string {
    return this.manager.all.map((r) => `${r.root}:${r.status?.branch ?? ''}:${r.status?.oid ?? ''}:${r.status?.upstream ?? ''}:${r.status?.behind ?? ''}`).join('|');
  }

  /** Recarga solo si cambió alguna rama o HEAD (no en cada archivo guardado). */
  private onReposChanged(): void {
    if (this.computeSignature() === this.signature) return;
    if (this.view?.visible && this.ready) void this.init();
    else this.stale = true;
  }

  private repoById(id: string): Repo | undefined {
    return this.manager.all.find((r) => r.root === id);
  }

  // ------------------------------------------------------------------ acciones

  private async runAction(action: LogAction, repoId: string, hash: string): Promise<void> {
    const repo = this.repoById(repoId);
    if (!repo) return;
    const short = hash.slice(0, 7);
    const scope = { repos: [repo], label: repo.name };

    switch (action) {
      case 'copyHash':
        await vscode.env.clipboard.writeText(hash);
        vscode.window.setStatusBarMessage(`$(copy) Hash ${short} copiado`, 3000);
        return;
      case 'checkout':
        await runInRepos(this.manager, {
          title: `Checkout de ${short} en ${repo.name}`,
          repos: [repo],
          run: async (r) => {
            await r.git.checkoutDetached(hash);
          },
        });
        break;
      case 'cherryPick':
        await runInRepos(this.manager, {
          title: `Cherry-pick de ${short} en ${repo.name}`,
          repos: [repo],
          requireClean: true,
          run: async (r) => {
            await r.git.cherryPick(hash);
          },
        });
        break;
      case 'revert':
        await runInRepos(this.manager, {
          title: `Revert de ${short} en ${repo.name}`,
          repos: [repo],
          requireClean: true,
          run: async (r) => {
            await r.git.revert(hash);
          },
        });
        break;
      case 'reset':
        if (!(await this.reset(repo, hash))) return;
        break;
      case 'newBranch':
        await this.branchActions.newBranch(scope, { type: 'local', name: hash });
        break;
      case 'newTag':
        if (!(await this.newTag(repo, hash))) return;
        break;
    }
    await this.manager.refreshStatusesNow([repo]);
    await this.init();
  }

  /** Reset current branch to here (soft / mixed / hard) con confirmación de lo que se pierde. */
  private async reset(repo: Repo, hash: string): Promise<boolean> {
    const status = await repo.git.getStatus();
    if (!status.branch) {
      void vscode.window.showWarningMessage(`MultiGit: ${repo.name} tiene HEAD detached; no hay rama que mover.`);
      return false;
    }
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: 'mueve la rama; los cambios de los commits quedan en stage', mode: 'soft' as const },
        { label: 'Mixed', description: 'mueve la rama; los cambios quedan sin stage (por defecto)', mode: 'mixed' as const },
        { label: 'Hard', description: 'mueve la rama y DESCARTA todos los cambios', mode: 'hard' as const },
      ],
      { title: `Reset de '${status.branch}' a ${hash.slice(0, 7)} — ${repo.name}`, placeHolder: 'Modo del reset' },
    );
    if (!mode) return false;

    const removed = await repo.git.logOneline(`${hash}..HEAD`, 30);
    const total = await repo.git.countCommits(`${hash}..HEAD`);
    const lines = [
      `Rama '${status.branch}' de ${repo.name} → ${hash.slice(0, 7)} (reset --${mode.mode}).`,
      '',
      total ? `${total} commit(s) dejarán de estar en la rama:` : 'Ningún commit sale de la rama (el destino es posterior o igual).',
      ...removed.map((l) => `  • ${l}`),
      ...(total > removed.length ? [`  … y ${total - removed.length} más`] : []),
    ];
    if (mode.mode === 'hard') {
      lines.push('', status.changes.total ? `⚠ Se perderán además ${status.changes.total} cambio(s) sin commit.` : 'No hay cambios sin commit.');
    } else {
      lines.push('', 'Los cambios de esos commits se conservan en tu working tree.');
    }
    const ok = await vscode.window.showWarningMessage(
      `¿Reset --${mode.mode} de '${status.branch}'?`,
      { modal: true, detail: lines.join('\n') },
      `Reset --${mode.mode}`,
    );
    if (!ok) return false;

    await runInRepos(this.manager, {
      title: `Reset --${mode.mode} de '${status.branch}' en ${repo.name}`,
      repos: [repo],
      run: async (r) => {
        await r.git.reset(mode.mode, hash);
      },
    });
    return true;
  }

  private async newTag(repo: Repo, hash: string): Promise<boolean> {
    const name = (
      await vscode.window.showInputBox({
        title: `Nuevo tag en ${hash.slice(0, 7)} — ${repo.name}`,
        prompt: 'Nombre del tag (p. ej. v1.4.0)',
        validateInput: async (v) =>
          !v.trim() ? 'Escribe un nombre' : (await repo.git.isValidTagName(v.trim())) ? undefined : 'Nombre de tag no válido',
      })
    )?.trim();
    if (!name) return false;
    const message = await vscode.window.showInputBox({
      title: `Tag '${name}'`,
      prompt: 'Mensaje (opcional): con mensaje se crea un tag anotado',
    });
    if (message === undefined) return false;
    await runInRepos(this.manager, {
      title: `Tag '${name}' en ${repo.name}`,
      repos: [repo],
      run: async (r) => {
        await r.git.createTag(name, hash, message.trim() || undefined);
      },
    });
    return true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

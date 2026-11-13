// Panel "Git Log" (WebviewView en el panel inferior): log combinado de todos los repos,
// filtros, detalle del commit y menú contextual (checkout, cherry-pick, revert, reset, rama, tag).
import * as vscode from 'vscode';
import { GitContentProvider, openCommitFileDiff } from '../git/GitContentProvider';
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
import type { BranchActions, BranchRef } from '../views/branchActions';
import type { LogAction, LogBranchAction, LogRepoInfo, LogRow, WebviewMessage } from './protocol';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { RebasePanel } from './RebasePanel';
import { t } from '../i18n';

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
  /** Ramas (locales, remotas y sus ↑/↓) de la última carga: cambia tras un fetch aunque HEAD no cambie. */
  private refsSignature = '';
  private refsCheck: ReturnType<typeof setTimeout> | undefined;
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
    this.post({ type: 'error', payload: { message: t('\'{0}\' was not found.', ref) } });
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
        case 'log/openDiff': {
          const { repoId, hash, file, base } = message.payload;
          if (base === undefined) {
            await openCommitFileDiff(repoId, hash, file);
            break;
          }
          // Contra un padre concreto (merge) o contra nada (commit raíz).
          const left = GitContentProvider.uri(repoId, file.status === 'A' || !base ? '' : base, file.oldPath ?? file.path);
          const right = GitContentProvider.uri(repoId, file.status === 'D' ? '' : hash, file.path);
          const title = `${file.path.split('/').pop()} (${base ? base.slice(0, 7) : '∅'} ↔ ${hash.slice(0, 7)})`;
          await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
          break;
        }
        case 'log/action':
          await this.runAction(message.payload.action, message.payload.repoId, message.payload.hash);
          break;
        case 'log/branchAction':
          await this.runBranchAction(message.payload.action, message.payload.branch, message.payload.repoIds);
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
    this.refsSignature = refsSignatureOf(repos.map((r) => this.branches.get(r)!));
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
        track: Object.fromEntries(
          b.local
            .filter((l) => l.upstream && !l.gone && (l.ahead || l.behind))
            .map((l) => [l.name, { ahead: l.ahead, behind: l.behind }]),
        ),
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
    const [details, groups, contains] = await Promise.all([repo.git.commitDetails(hash), repo.git.commitFileGroups(hash), repo.git.branchesContaining(hash)]);
    const short = (h: string) => h.slice(0, 7);
    this.post({
      type: 'log/details',
      payload: {
        repoId,
        hash,
        ...details,
        files: groups.find((g) => !g.merged)?.files ?? [],
        groups:
          groups.length === 1
            ? [{ title: '', base: groups[0]!.parent, files: groups[0]!.files }]
            : groups.map((g) => ({
                title: g.merged ? t('Changed in the merge') : t('Changes to {0} {1}', short(g.parent!), g.parentSubject ?? ''),
                base: g.parent,
                files: g.files,
              })),
        branches: contains.branches,
        inHead: contains.inHead,
      },
    });
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
    if (this.computeSignature() !== this.signature) return this.markChanged();
    // HEAD igual: un fetch pudo mover ramas remotas o los ↑/↓ de otras ramas. Se comprueba
    // con un for-each-ref por repo, agrupando ráfagas de eventos (p. ej. al guardar archivos).
    if (this.refsCheck) clearTimeout(this.refsCheck);
    this.refsCheck = setTimeout(() => {
      this.refsCheck = undefined;
      void this.checkRefs();
    }, REFS_CHECK_DELAY_MS);
  }

  private async checkRefs(): Promise<void> {
    if (this.stale || !this.ready) return;
    const branches = await Promise.all(this.manager.all.map((r) => r.git.getBranches().catch(() => undefined)));
    if (branches.some((b) => !b)) return;
    if (refsSignatureOf(branches as RepoBranches[]) !== this.refsSignature) this.markChanged();
  }

  private markChanged(): void {
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
          title: t('Checkout of {0} in {1}', short, repo.name),
          repos: [repo],
          run: async (r) => {
            await r.git.checkoutDetached(hash);
          },
        });
        break;
      case 'cherryPick':
        await runInRepos(this.manager, {
          title: t('Cherry-pick of {0} in {1}', short, repo.name),
          repos: [repo],
          requireClean: true,
          run: async (r) => {
            await r.git.cherryPick(hash);
          },
        });
        break;
      case 'revert':
        await runInRepos(this.manager, {
          title: t('Revert of {0} in {1}', short, repo.name),
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
      case 'interactiveRebase':
        await RebasePanel.open(this.extensionUri, this.manager, repo, hash, async () => {
          await this.manager.refreshStatusesNow([repo]);
          await this.init();
        });
        return;
    }
    await this.manager.refreshStatusesNow([repo]);
    await this.init();
  }

  /** Menú contextual de una rama (o tag) del árbol: las mismas acciones que la vista Ramas. */
  private async runBranchAction(action: LogBranchAction, branch: string, repoIds: string[]): Promise<void> {
    const isTag = branch.startsWith('refs/tags/');
    const branchesOf = (r: Repo) => this.branches.get(r);
    const exists = (r: Repo) => {
      const b = branchesOf(r);
      return !!b && (isTag || b.local.some((l) => l.name === branch) || b.remote.some((x) => x.full === branch));
    };
    const repos = repoIds.length ? this.manager.all.filter((r) => repoIds.includes(r.root)) : this.manager.all.filter(exists);
    if (repos.length === 0) return;
    const scope = { repos, label: repos.length === 1 ? repos[0]!.name : t('{0} repositories', repos.length) };
    const remote = repos.map((r) => branchesOf(r)?.remote.find((x) => x.full === branch)).find(Boolean);
    const isLocal = !isTag && repos.some((r) => branchesOf(r)?.local.some((l) => l.name === branch));
    // Los tags se usan por su ref completa (`refs/tags/x`), que git acepta donde va una rama.
    const ref: BranchRef = isLocal || isTag || !remote ? { type: 'local', name: branch } : { type: 'remote', remote: remote.remote, name: remote.name, full: remote.full };
    const local = isLocal ? { type: 'local' as const, name: branch } : undefined;
    const a = this.branchActions;
    switch (action) {
      case 'checkout':
        return isTag ? a.checkoutRef(scope, branch) : a.checkout(scope, ref);
      case 'newBranch':
        return a.newBranch(scope, ref);
      case 'checkoutAndRebase':
        return local ? a.checkoutAndRebase(scope, local) : undefined;
      case 'compare':
        return a.compare(scope, ref);
      case 'compareFiles':
        await vscode.commands.executeCommand('multigit.compareFiles.show', repos, branch);
        return;
      case 'diffWorkingTree':
        return a.diffWithWorkingTree(scope, ref);
      case 'rebaseOnto':
        return a.rebaseOnto(scope, ref);
      case 'merge':
        return a.merge(scope, ref);
      case 'newWorktree':
        return a.newWorktree(scope, ref);
      case 'update':
        return a.update(scope, ref);
      case 'push':
        return local ? a.push(scope, branch) : undefined;
      case 'pullRequests':
        await vscode.commands.executeCommand('multigit.createPullRequests.forRepos', repos.filter((r) => r.status?.branch === branch));
        return;
      case 'rename':
        return local ? a.rename(scope, local) : undefined;
      case 'delete':
        if (local) return a.deleteLocal(scope, local);
        if (ref.type === 'remote') return a.deleteRemote(scope, ref);
        return undefined;
      case 'navigate':
        return this.navigateTo(branch, repoIds);
    }
  }

  /** Reset current branch to here (soft / mixed / hard) con confirmación de lo que se pierde. */
  private async reset(repo: Repo, hash: string): Promise<boolean> {
    const status = await repo.git.getStatus();
    if (!status.branch) {
      void vscode.window.showWarningMessage(t('MultiGit: {0} has a detached HEAD; there is no branch to move.', repo.name));
      return false;
    }
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Soft', description: t('moves the branch; the commits\' changes stay staged'), mode: 'soft' as const },
        { label: 'Mixed', description: t('moves the branch; the changes stay unstaged (default)'), mode: 'mixed' as const },
        { label: 'Hard', description: t('moves the branch and DISCARDS all changes'), mode: 'hard' as const },
      ],
      { title: `Reset de '${status.branch}' a ${hash.slice(0, 7)} — ${repo.name}`, placeHolder: t('Reset mode') },
    );
    if (!mode) return false;

    const removed = await repo.git.logOneline(`${hash}..HEAD`, 30);
    const total = await repo.git.countCommits(`${hash}..HEAD`);
    const lines = [
      t('Branch \'{0}\' of {1} → {2} (reset --{3}).', status.branch, repo.name, hash.slice(0, 7), mode.mode),
      '',
      total ? t('{0} commit(s) will leave the branch:', total) : t('No commit leaves the branch (the target is later or the same).'),
      ...removed.map((l) => `  • ${l}`),
      ...(total > removed.length ? [t('  … and {0} more', total - removed.length)] : []),
    ];
    if (mode.mode === 'hard') {
      lines.push('', status.changes.total ? t('⚠ {0} uncommitted change(s) will also be lost.', status.changes.total) : t('There are no uncommitted changes.'));
    } else {
      lines.push('', t('The changes of those commits are kept in your working tree.'));
    }
    const ok = await vscode.window.showWarningMessage(
      t('Reset --{0} of \'{1}\'?', mode.mode, status.branch),
      { modal: true, detail: lines.join('\n') },
      `Reset --${mode.mode}`,
    );
    if (!ok) return false;

    await runInRepos(this.manager, {
      title: t('Reset --{0} of \'{1}\' in {2}', mode.mode, status.branch, repo.name),
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
        title: t('New tag at {0} — {1}', hash.slice(0, 7), repo.name),
        prompt: t('Tag name (e.g. v1.4.0)'),
        validateInput: async (v) =>
          !v.trim() ? t('Type a name') : (await repo.git.isValidTagName(v.trim())) ? undefined : t('Invalid tag name'),
      })
    )?.trim();
    if (!name) return false;
    const message = await vscode.window.showInputBox({
      title: `Tag '${name}'`,
      prompt: t('Message (optional): with a message an annotated tag is created'),
    });
    if (message === undefined) return false;
    await runInRepos(this.manager, {
      title: t('Tag \'{0}\' in {1}', name, repo.name),
      repos: [repo],
      run: async (r) => {
        await r.git.createTag(name, hash, message.trim() || undefined);
      },
    });
    return true;
  }

  dispose(): void {
    if (this.refsCheck) clearTimeout(this.refsCheck);
    for (const d of this.disposables) d.dispose();
  }
}

const REFS_CHECK_DELAY_MS = 500;

/** Firma de las ramas locales (con ↑/↓) y remotas de varios repos. */
function refsSignatureOf(all: readonly RepoBranches[]): string {
  return all
    .map(
      (b) =>
        `${b.local.map((l) => `${l.name}:${l.ahead}:${l.behind}:${l.gone ? 'g' : ''}`).join(',')}` +
        `|${b.remote.map((x) => x.full).join(',')}`,
    )
    .join('\n');
}

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
import type { LogAction, LogBranchAction, LogFileAction, LogMultiAction, LogRepoInfo, LogRow, PushFile, WebviewMessage } from './protocol';
import * as path from 'node:path';
import { parseRemoteUrl, PROVIDER_NAMES, revisionWebUrl, type RemoteInfo } from '../git/pullRequests';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { RebasePanel } from './RebasePanel';
import { editMessage } from './MessagePanel';
import { autosquashMessage, editPlan, historyBlocker, squashMessage, squashPlan, type HistoryAction, type HistoryInfo } from '../git/historyEdit';
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
  /** Remoto de cada repo (el del upstream, origin o el primero) para "Open on GitHub / GitLab". */
  private remotes = new Map<Repo, { name: string; info: RemoteInfo | undefined }>();
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

  /**
   * Muestra el log filtrado por una rama (desde la vista Ramas o el popup). Como IntelliJ, el filtro de
   * repos no cambia salvo que se pida (`repoIds`): la rama se ve en todos los repos que la tienen.
   */
  async showBranch(branch: string | null, repoIds?: string[]): Promise<void> {
    this.filters = { ...this.filters, branch, ...(repoIds ? { repoIds } : {}) };
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
        case 'log/multiAction':
          await this.runMultiAction(message.payload.action, message.payload.commits);
          break;
        case 'log/fileAction': {
          const { action, repoId, hash, file, base, files } = message.payload;
          if (action === 'cherryPickFiles' || action === 'revertFiles') await this.applySelectedChanges(action === 'revertFiles', repoId, hash, files ?? [file], base);
          else await this.runFileAction(action, repoId, hash, file, base);
          break;
        }
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
    this.remotes = new Map(await Promise.all(repos.map(async (r) => [r, await this.remoteOf(r)] as const)));
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
        web: this.webName(r),
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
        vscode.window.setStatusBarMessage(t('$(copy) Hash {0} copied', short), 3000);
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
      case 'undoCommit':
      case 'editMessage':
      case 'drop':
      case 'pushUpTo':
        if (!(await this.editHistory(action, repo, hash))) return;
        break;
      case 'fixup':
      case 'squashInto':
        await this.prepareAutosquash(action === 'fixup' ? 'fixup' : 'squash', repo, hash);
        return;
      case 'createPatch':
        await vscode.commands.executeCommand('multigit.patch.createFromCommit', repo.root, hash);
        return;
      case 'newBranch':
        await this.branchActions.newBranch(scope, { type: 'local', name: hash });
        break;
      case 'newTag':
        if (!(await this.newTag(repo, hash))) return;
        break;
      case 'goParent':
        await this.goParent(repo, hash);
        return;
      case 'goChild':
        await this.goChild(repo, hash);
        return;
      case 'showRepoAtRevision':
        await this.showRepoAtRevision(repo, hash);
        return;
      case 'openOnRemote':
        await this.openOnRemote(repo, hash);
        return;
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
    if (branch === 'HEAD') return this.runHeadAction(action);
    const isTag = branch.startsWith('refs/tags/');
    const branchesOf = (r: Repo) => this.branches.get(r);
    const exists = (r: Repo) => {
      const b = branchesOf(r);
      if (isTag) return (this.tags.get(r) ?? []).includes(branch.slice('refs/tags/'.length));
      return !!b && (b.local.some((l) => l.name === branch) || b.remote.some((x) => x.full === branch));
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
      case 'pullMerge':
      case 'pullRebase':
        return ref.type === 'remote' ? a.pullInto(scope, ref, action === 'pullMerge' ? 'merge' : 'rebase') : undefined;
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
      case 'pushTag':
        return isTag ? this.pushTag(repos, branch.slice('refs/tags/'.length)) : undefined;
      case 'deleteTag':
        return isTag ? this.deleteTag(repos, branch.slice('refs/tags/'.length)) : undefined;
      case 'navigate':
        return this.navigateTo(branch, repoIds);
    }
  }

  /** Menú de "HEAD (rama actual)" con los repos en ramas distintas: cada acción usa la rama actual de cada repo. */
  private async runHeadAction(action: LogBranchAction): Promise<void> {
    const repos = this.manager.all;
    const scope = { repos, label: t('{0} repositories', repos.length) };
    const head: BranchRef = { type: 'local', name: 'HEAD' };
    const a = this.branchActions;
    switch (action) {
      case 'newBranch':
        return a.newBranch(scope);
      case 'diffWorkingTree':
        return a.diffWithWorkingTree(scope, head);
      case 'update':
        return a.updateProject(scope);
      case 'push':
        return a.push(scope);
      case 'pullRequests':
        await vscode.commands.executeCommand('multigit.createPullRequests.forRepos', repos);
        return;
      case 'navigate':
        return this.navigateTo('HEAD', []);
      default:
        return undefined;
    }
  }

  /** Datos del commit en su repo, o un aviso (y undefined) si la acción no se puede hacer ahí. */
  private async historyCheck(action: HistoryAction, repo: Repo, hash: string): Promise<(HistoryInfo & { pushed: boolean; upstream: string | null }) | undefined> {
    const info = await repo.git.historyInfo(hash);
    const blocker = historyBlocker(action, info);
    if (!blocker) return info;
    const short = hash.slice(0, 7);
    const reasons: Record<NonNullable<ReturnType<typeof historyBlocker>>, string> = {
      detached: t('{0} has a detached HEAD: check out a branch first.', repo.name),
      'not-in-branch': t("{0} is not in the current branch of {1} ('{2}').", short, repo.name, info.branch ?? ''),
      merge: t('{0} is a merge commit: use "Interactively rebase from here…" or Reset.', short),
      root: t('{0} is the first commit of the repository.', short),
      'merges-after': t('There are merge commits after {0}: rewriting the history would flatten them. Use "Interactively rebase from here…".', short),
    };
    void vscode.window.showWarningMessage(t('MultiGit: this cannot be done on {0}', short), { modal: true, detail: reasons[blocker] });
    return undefined;
  }

  /** Aviso de que se reescriben commits ya subidos: hará falta un force push. */
  private pushedNote(info: { pushed: boolean }): string {
    return info.pushed ? t('⚠ This commit is already pushed: after the change you will have to force push (with lease).') : '';
  }

  /** Undo Commit, Edit Commit Message, Drop Commit y Push All up to Here (como IntelliJ). */
  private async editHistory(action: 'undoCommit' | 'editMessage' | 'drop' | 'pushUpTo', repo: Repo, hash: string): Promise<boolean> {
    const kind: HistoryAction = action === 'undoCommit' ? 'undo' : action === 'editMessage' ? 'reword' : action === 'drop' ? 'drop' : 'pushUpTo';
    const info = await this.historyCheck(kind, repo, hash);
    if (!info) return false;
    const short = hash.slice(0, 7);
    const branch = info.branch!;
    const later = await repo.git.logOneline(`${hash}..HEAD`, 20);
    const laterCount = await repo.git.countCommits(`${hash}..HEAD`);
    const listLater = [...later.map((l) => `  • ${l}`), ...(laterCount > later.length ? [t('  … and {0} more', laterCount - later.length)] : [])];
    const subject = `${short} ${(await repo.git.commitInfo(hash).then((c) => c.body.split('\n')[0]!.trim(), () => ''))}`.trim();
    const note = this.pushedNote(info);

    if (action === 'undoCommit') {
      const lines = [
        t("Branch '{0}' of {1} goes back to the parent of {2}.", branch, repo.name, short),
        t('The changes of the commit stay in your working tree (staged), ready to commit again.'),
        ...(laterCount ? ['', t('The {0} later commit(s) are also undone:', laterCount), ...listLater] : []),
        ...(note ? ['', note] : []),
      ];
      const OK = t('Undo Commit');
      if ((await vscode.window.showWarningMessage(t('Undo commit {0}?', subject), { modal: true, detail: lines.join('\n') }, OK)) !== OK) return false;
      const message = await repo.git.commitInfo(hash).then((c) => c.body, () => '');
      const results = await runInRepos(this.manager, {
        title: t('Undo Commit {0} in {1}', short, repo.name),
        repos: [repo],
        run: async (r) => {
          await r.git.undoCommit(hash);
        },
      });
      // Como IntelliJ, el mensaje vuelve a la caja de commit.
      if (results?.every((r) => r.state === 'ok') && message.trim()) await vscode.commands.executeCommand('multigit.commit.prefill', message.trim());
      return true;
    }

    if (action === 'editMessage') {
      const current = (await repo.git.commitInfo(hash)).body.trim();
      const message = await editMessage(this.extensionUri, {
        title: t('Edit Commit Message — {0} {1}', repo.name, short),
        message: current,
        okLabel: t('OK'),
        note: note || (info.isHead ? undefined : t('The {0} later commit(s) will be recreated (rebase).', laterCount)),
      });
      if (!message?.trim() || message.trim() === current) return false;
      await runInRepos(this.manager, {
        title: t('Edit message of {0} in {1}', short, repo.name),
        repos: [repo],
        continueAfterConflict: true,
        run: async (r) => {
          if (info.isHead) {
            await r.git.amendMessage(message);
            return;
          }
          const { base, commits } = await r.git.rebaseCommits(hash);
          await r.git.interactiveRebase(base, editPlan(commits, hash, { action: 'reword', message }), { autostash: true });
        },
      });
      return true;
    }

    if (action === 'drop') {
      const lines = [
        t('{0} is removed from branch \'{1}\' of {2}; its changes are lost.', subject, branch, repo.name),
        ...(laterCount ? ['', t('The {0} later commit(s) will be recreated (rebase):', laterCount), ...listLater] : []),
        ...(note ? ['', note] : []),
      ];
      const OK = t('Drop Commit');
      if ((await vscode.window.showWarningMessage(t('Drop commit {0}?', short), { modal: true, detail: lines.join('\n') }, OK)) !== OK) return false;
      await runInRepos(this.manager, {
        title: t('Drop {0} in {1}', short, repo.name),
        repos: [repo],
        continueAfterConflict: true,
        run: async (r) => {
          const { base, commits } = await r.git.rebaseCommits(hash);
          await r.git.interactiveRebase(base, editPlan(commits, hash, { action: 'drop' }), { autostash: true });
        },
      });
      return true;
    }

    // Push All up to Here: al upstream de la rama (o a origin/<rama> si no tiene).
    const current = (await repo.git.getBranches()).local.find((b) => b.current);
    const remote = (info.upstream && current?.upstreamRemote) || 'origin';
    const remoteBranch = (info.upstream && current?.upstreamBranch) || branch;
    const pending = await repo.git.logCommits(info.upstream ? [`${info.upstream}..${hash}`] : [hash, '--not', '--remotes'], 500);
    const toPush = pending.slice(0, 20).map((c) => `${c.shortHash} ${c.subject}`);
    const total = pending.length;
    if (!toPush.length) {
      void vscode.window.showInformationMessage(t('MultiGit: {0} is already pushed to {1}.', short, `${remote}/${remoteBranch}`));
      return false;
    }
    const OK = t('Push');
    const detail = [
      t('{0} commit(s) of \'{1}\' up to {2} go to {3}:', total, branch, short, `${remote}/${remoteBranch}`),
      ...toPush.map((l) => `  • ${l}`),
      ...(total > toPush.length ? [t('  … and {0} more', total - toPush.length)] : []),
      ...(laterCount ? ['', t('The {0} later commit(s) stay local.', laterCount)] : []),
    ];
    if ((await vscode.window.showInformationMessage(t('Push up to {0}?', short), { modal: true, detail: detail.join('\n') }, OK)) !== OK) return false;
    await runInRepos(this.manager, {
      title: t('Push up to {0} in {1}', short, repo.name),
      repos: [repo],
      run: async (r) => {
        await r.git.pushRevision(remote, hash, remoteBranch);
      },
    });
    return true;
  }

  /**
   * Fixup… / Squash Into… (como IntelliJ): la caja de commit se llena con "fixup! <asunto>" (o "squash!")
   * y, al hacer ese commit, se ofrece integrarlo en el commit elegido (rebase con autosquash).
   */
  private async prepareAutosquash(kind: 'fixup' | 'squash', repo: Repo, hash: string): Promise<void> {
    const info = await this.historyCheck(kind, repo, hash);
    if (!info) return;
    const subject = (await repo.git.commitInfo(hash)).body.split('\n')[0]!.trim();
    await vscode.commands.executeCommand('multigit.commit.prefill', autosquashMessage(kind, subject), { repoRoot: repo.root, hash });
    vscode.window.setStatusBarMessage(t('$(git-commit) Check the changes to put into {0} and commit them', hash.slice(0, 7)), 8000);
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
      { title: t("Reset of '{0}' to {1} — {2}", status.branch, hash.slice(0, 7), repo.name), placeHolder: t('Reset mode') },
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

  // ------------------------------------------------------------------ remoto web

  private async remoteOf(repo: Repo): Promise<{ name: string; info: RemoteInfo | undefined }> {
    const remotes = await repo.git.listRemotes().catch(() => []);
    const upstream = repo.status?.upstream?.split('/')[0];
    const remote = remotes.find((r) => r.name === upstream) ?? remotes.find((r) => r.name === 'origin') ?? remotes[0];
    if (!remote) return { name: '', info: undefined };
    const providers = vscode.workspace.getConfiguration('multigit.pullRequests').get<Record<string, string>>('providers', {});
    return { name: remote.name, info: parseRemoteUrl(remote.url, providers) };
  }

  /** "GitHub", "GitLab"… (un host propio sin configurar cuenta como GitLab), o null sin remoto web. */
  private webName(repo: Repo): string | null {
    const info = this.remotes.get(repo)?.info;
    return info ? PROVIDER_NAMES[info.provider ?? 'gitlab'] : null;
  }

  private async openOnRemote(repo: Repo, hash: string, filePath?: string): Promise<void> {
    const info = this.remotes.get(repo)?.info ?? (await this.remoteOf(repo)).info;
    if (!info) {
      void vscode.window.showWarningMessage(t('MultiGit: {0} has no remote with a web page.', repo.name));
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(revisionWebUrl(info, hash, filePath), true));
  }

  // ------------------------------------------------------------------ navegación

  /** Go to Parent Commit: en un merge se elige el padre. */
  private async goParent(repo: Repo, hash: string): Promise<void> {
    const parents = await repo.git.parentsOf(hash);
    if (!parents.length) {
      void vscode.window.showInformationMessage(t('MultiGit: {0} is the first commit of the repository.', hash.slice(0, 7)));
      return;
    }
    let target = parents[0]!;
    if (parents.length > 1) {
      const items = await Promise.all(
        parents.map(async (p, i) => ({
          label: `${p.slice(0, 7)} ${(await repo.git.commitInfo(p).catch(() => undefined))?.body.split('\n')[0] ?? ''}`,
          description: i === 0 ? t('first parent') : undefined,
          hash: p,
        })),
      );
      const picked = await vscode.window.showQuickPick(items, { title: t('Parent of merge {0}', hash.slice(0, 7)) });
      if (!picked) return;
      target = picked.hash;
    }
    this.post({ type: 'log/reveal', payload: { repoId: repo.root, hash: target } });
  }

  /** Go to Child Commit: si hay varios (ramas que salen de ahí), se elige. */
  private async goChild(repo: Repo, hash: string): Promise<void> {
    const children = await repo.git.childrenOf(hash);
    if (!children.length) {
      void vscode.window.showInformationMessage(t('MultiGit: {0} has no child commits.', hash.slice(0, 7)));
      return;
    }
    let target = children[0]!;
    if (children.length > 1) {
      const items = await Promise.all(
        children.map(async (c) => ({ label: `${c.slice(0, 7)} ${(await repo.git.commitInfo(c).catch(() => undefined))?.body.split('\n')[0] ?? ''}`, hash: c })),
      );
      const picked = await vscode.window.showQuickPick(items, { title: t('Children of {0}', hash.slice(0, 7)) });
      if (!picked) return;
      target = picked.hash;
    }
    this.post({ type: 'log/reveal', payload: { repoId: repo.root, hash: target } });
  }

  /** Show Repository at Revision: todos los archivos del repo en ese commit; el elegido se abre (solo lectura). */
  private async showRepoAtRevision(repo: Repo, hash: string): Promise<void> {
    const files = await repo.git.filesAt(hash);
    const picked = await vscode.window.showQuickPick(
      files.map((f) => ({ label: path.posix.basename(f), description: path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f), path: f })),
      { title: t('{0} at {1} — {2} file(s)', repo.name, hash.slice(0, 7), files.length), placeHolder: t('File to open'), matchOnDescription: true },
    );
    if (picked) await this.openRevision(repo, hash, picked.path);
  }

  private async openRevision(repo: Repo, hash: string, filePath: string): Promise<void> {
    const uri = GitContentProvider.uri(repo.root, hash, filePath);
    await vscode.window.showTextDocument(uri, { preview: true });
  }

  // ------------------------------------------------------------------ archivo de un commit

  private async runFileAction(action: LogFileAction, repoId: string, hash: string, file: PushFile, base?: string | null): Promise<void> {
    const repo = this.repoById(repoId);
    if (!repo) return;
    const short = hash.slice(0, 7);
    const name = path.posix.basename(file.path);
    const local = vscode.Uri.file(path.join(repo.root, file.path));
    switch (action) {
      case 'showDiff':
        if (base === undefined) await openCommitFileDiff(repoId, hash, file);
        else {
          const left = GitContentProvider.uri(repoId, file.status === 'A' || !base ? '' : base, file.oldPath ?? file.path);
          const right = GitContentProvider.uri(repoId, file.status === 'D' ? '' : hash, file.path);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${base ? base.slice(0, 7) : '∅'} ↔ ${short})`, { preview: true });
        }
        return;
      case 'compareWithLocal': {
        // Versión del commit ↔ archivo en disco (como "Compare with Local" de IntelliJ).
        const left = GitContentProvider.uri(repoId, file.status === 'D' ? '' : hash, file.path);
        const exists = await vscode.workspace.fs.stat(local).then(() => true, () => false);
        const right = exists ? local : GitContentProvider.uri(repoId, '', file.path);
        await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${short} ↔ ${t('Local')})`, { preview: true });
        return;
      }
      case 'openRevision':
        if (file.status === 'D') {
          void vscode.window.showInformationMessage(t('MultiGit: {0} was deleted in {1}.', name, short));
          return;
        }
        await this.openRevision(repo, hash, file.path);
        return;
      case 'getFromRevision': {
        const deleted = file.status === 'D';
        const OK = t('Get');
        const detail = deleted
          ? t('{0} did not exist after {1}: it will be deleted from your working tree.', file.path, short)
          : t('{0} is replaced with its version of {1}. Your uncommitted changes to that file are lost.', file.path, short);
        if ((await vscode.window.showWarningMessage(t('Get {0} from revision {1}?', name, short), { modal: true, detail }, OK)) !== OK) return;
        await runInRepos(this.manager, {
          title: t('Get from Revision {0} in {1}', short, repo.name),
          repos: [repo],
          run: async (r) => {
            await r.git.restoreFromRevision(hash, file.path, deleted);
            return file.path;
          },
        });
        await this.manager.refreshStatusesNow([repo]);
        return;
      }
      case 'showHistory':
        await this.showFileHistory(repoId, file.path);
        return;
      case 'openOnRemote':
        await this.openOnRemote(repo, file.status === 'D' && base ? base : hash, file.status === 'D' ? (file.oldPath ?? file.path) : file.path);
        return;
      default:
        return;
    }
  }

  /**
   * Cherry-Pick / Revert Selected Changes (como IntelliJ): solo esos archivos del commit van al working
   * tree (sin commit). Si no encajan limpio se ofrece el merge a 3 bandas; el mensaje del commit queda
   * propuesto en la caja de commit.
   */
  private async applySelectedChanges(reverse: boolean, repoId: string, hash: string, files: readonly PushFile[], base?: string | null): Promise<void> {
    const repo = this.repoById(repoId);
    if (!repo || !files.length) return;
    const short = hash.slice(0, 7);
    const paths = [...new Set(files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path])))];
    const patch = await repo.git.commitFilesPatch(hash, base, paths, reverse);
    if (!patch.trim()) {
      void vscode.window.showInformationMessage(t('MultiGit: there are no differences for a patch.'));
      return;
    }
    let threeWay = false;
    try {
      await repo.git.applyPatch(patch, 'check');
    } catch (error) {
      const MERGE = t('Apply with 3-way Merge');
      const choice = await vscode.window.showWarningMessage(
        reverse ? t('The changes of {0} cannot be reverted cleanly', short) : t('The changes of {0} do not apply cleanly', short),
        {
          modal: true,
          detail: [
            ...files.map((f) => `  • ${f.path}`),
            '',
            errorText(error).split('\n').slice(0, 3).join(' '),
            '',
            t('With a 3-way merge the changes are combined with your versions; where they collide, conflicts are left to resolve.'),
          ].join('\n'),
        },
        MERGE,
      );
      if (choice !== MERGE) return;
      threeWay = true;
    }
    const results = await runInRepos(this.manager, {
      title: reverse ? t('Revert Selected Changes of {0} in {1}', short, repo.name) : t('Cherry-Pick Selected Changes of {0} in {1}', short, repo.name),
      repos: [repo],
      continueAfterConflict: true,
      run: async (r) => {
        await r.git.applyPatch(patch, threeWay ? 'threeWay' : 'apply');
        return t('{0} file(s)', files.length);
      },
    });
    await this.manager.refreshStatusesNow([repo]);
    if (!results?.length) return;
    // Mensaje propuesto, como la changelist que crea IntelliJ.
    const body = (await repo.git.commitInfo(hash).catch(() => undefined))?.body.trim() ?? '';
    const subject = body.split('\n')[0] ?? '';
    const message = reverse ? `Revert "${subject}"\n\nThis reverts part of commit ${hash}.` : body;
    if (message) await vscode.commands.executeCommand('multigit.commit.prefill', message);
  }

  // ------------------------------------------------------------------ varios commits

  private async runMultiAction(action: LogMultiAction, commits: ReadonlyArray<{ repoId: string; hash: string }>): Promise<void> {
    // Por repo, en el orden del log (del más nuevo al más viejo).
    const groups: Array<{ repo: Repo; hashes: string[] }> = [];
    for (const c of commits) {
      const repo = this.repoById(c.repoId);
      if (!repo) continue;
      const g = groups.find((x) => x.repo === repo) ?? (groups.push({ repo, hashes: [] }), groups[groups.length - 1]!);
      if (!g.hashes.includes(c.hash)) g.hashes.push(c.hash);
    }
    if (!groups.length) return;
    const total = groups.reduce((n, g) => n + g.hashes.length, 0);
    const oldestFirst = (g: { hashes: string[] }) => [...g.hashes].reverse();
    const touched = groups.map((g) => g.repo);
    switch (action) {
      case 'copyHashes':
        await vscode.env.clipboard.writeText(commits.map((c) => c.hash).join(' '));
        vscode.window.setStatusBarMessage(t('$(copy) {0} hashes copied', commits.length), 3000);
        return;
      case 'createPatch':
        await vscode.commands.executeCommand(
          'multigit.patch.createFromCommits',
          groups.map((g) => ({ repoRoot: g.repo.root, hashes: oldestFirst(g) })),
        );
        return;
      case 'cherryPick':
        await runInRepos(this.manager, {
          title: t('Cherry-pick of {0} commit(s)', total),
          repos: touched,
          requireClean: true,
          continueAfterConflict: true,
          run: async (r) => {
            const g = groups.find((x) => x.repo === r)!;
            await r.git.cherryPickMany(oldestFirst(g));
            return t('{0} commit(s)', g.hashes.length);
          },
        });
        break;
      case 'revert':
        await runInRepos(this.manager, {
          title: t('Revert of {0} commit(s)', total),
          repos: touched,
          requireClean: true,
          continueAfterConflict: true,
          run: async (r) => {
            const g = groups.find((x) => x.repo === r)!;
            await r.git.revertMany(g.hashes);
            return t('{0} commit(s)', g.hashes.length);
          },
        });
        break;
      case 'compareVersions': {
        if (groups.length !== 1 || total !== 2) return;
        const [newer, older] = groups[0]!.hashes as [string, string];
        await vscode.commands.executeCommand('multigit.compareFiles.show', [groups[0]!.repo], older, { ref: newer, label: newer.slice(0, 7) });
        return;
      }
      case 'squash':
        if (groups.length !== 1) return;
        if (!(await this.squash(groups[0]!.repo, oldestFirst(groups[0]!)))) return;
        break;
    }
    await this.manager.refreshStatusesNow(touched);
    await this.init();
  }

  /** Squash Commits… (como IntelliJ): junta los commits elegidos en uno, en el lugar del más viejo. */
  private async squash(repo: Repo, hashes: string[]): Promise<boolean> {
    const oldest = hashes[0]!;
    const info = await this.historyCheck('squash', repo, oldest);
    if (!info) return false;
    const { base, commits, merges } = await repo.git.rebaseCommits(oldest);
    const chosen = commits.filter((c) => hashes.includes(c.hash));
    if (merges > 0 || chosen.length !== hashes.length) {
      void vscode.window.showWarningMessage(t('MultiGit: these commits cannot be squashed'), {
        modal: true,
        detail: merges > 0 ? t('There are merge commits between them: use "Interactively rebase from here…".') : t("All of them must be in the current branch of {0} ('{1}').", repo.name, info.branch ?? ''),
      });
      return false;
    }
    const later = commits.length - chosen.length;
    const note = this.pushedNote(info);
    const message = await editMessage(this.extensionUri, {
      title: t('Squash {0} Commits — {1}', hashes.length, repo.name),
      message: squashMessage(chosen.map((c) => c.message)),
      okLabel: t('Squash'),
      note: [later ? t('The {0} later commit(s) will be recreated (rebase).', later) : '', note].filter(Boolean).join('\n') || undefined,
    });
    if (!message?.trim()) return false;
    const plan = squashPlan(commits, hashes, message);
    if (!plan) return false;
    await runInRepos(this.manager, {
      title: t('Squash {0} commits in {1}', hashes.length, repo.name),
      repos: [repo],
      continueAfterConflict: true,
      run: async (r) => {
        await r.git.interactiveRebase(base, plan, { autostash: true });
      },
    });
    return true;
  }

  // ------------------------------------------------------------------ tags

  /** Push Tag: sube el tag al remoto de cada repo (se elige si hay varios). */
  async pushTag(repos: readonly Repo[], name: string): Promise<void> {
    const remote = await this.pickRemote(repos, t("Push tag '{0}' to", name));
    if (!remote) return;
    await runInRepos(this.manager, {
      title: t("Push tag '{0}' to {1}", name, remote),
      repos,
      run: async (r) => {
        await r.git.pushTag(remote, name);
        return `${remote}/${name}`;
      },
    });
    await this.init();
  }

  /** Delete Tag: en local, o en local y en el remoto. */
  async deleteTag(repos: readonly Repo[], name: string): Promise<void> {
    const LOCAL = t('Delete Locally');
    const BOTH = t('Delete Locally and on Remote');
    const where = repos.length === 1 ? repos[0]!.name : t('{0} repositories', repos.length);
    const choice = await vscode.window.showWarningMessage(
      t("Delete tag '{0}' in {1}?", name, where),
      { modal: true, detail: repos.map((r) => `  • ${r.name}`).join('\n') },
      LOCAL,
      BOTH,
    );
    if (!choice) return;
    let remote: string | undefined;
    if (choice === BOTH) {
      remote = await this.pickRemote(repos, t("Delete tag '{0}' from", name));
      if (!remote) return;
    }
    await runInRepos(this.manager, {
      title: t("Delete tag '{0}'", name),
      repos,
      continueAfterConflict: true,
      run: async (r) => {
        if (remote) await r.git.deleteRemoteTag(remote, name).catch((error) => {
          // Si en el remoto ya no está, se sigue con el local.
          if (!/remote ref does not exist|unable to delete/i.test(errorText(error))) throw error;
        });
        await r.git.deleteTag(name);
        return remote ? t('local and {0}', remote) : t('local');
      },
    });
    await this.init();
  }

  /** Remoto común (si solo hay uno, sin preguntar). */
  private async pickRemote(repos: readonly Repo[], title: string): Promise<string | undefined> {
    const names = [...new Set((await Promise.all(repos.map((r) => r.git.listRemotes().catch(() => [])))).flat().map((r) => r.name))];
    if (!names.length) {
      void vscode.window.showWarningMessage(t('MultiGit: there is no remote configured.'));
      return undefined;
    }
    if (names.length === 1) return names[0];
    const preferred = names.includes('origin') ? ['origin', ...names.filter((n) => n !== 'origin')] : names;
    return vscode.window.showQuickPick(preferred, { title });
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

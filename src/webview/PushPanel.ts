// Diálogo "Push Commits" (webview), como el de IntelliJ:
//  izquierda: repos con checkbox y destino `rama → remote : rama-remota` (+ New)
//  derecha: commits por subir del repo elegido y archivos del commit elegido
//  abajo: Push tags, Edit all targets, Push / Force push (with lease)
import * as vscode from 'vscode';
import { GitContentProvider, openCommitFileDiff } from '../git/GitContentProvider';
import { errorText, runInRepos } from '../git/MultiRepoRunner';
import { formatSummary, isRejection } from '../git/preflight';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { PushRepoView, PushState, PushTagsMode, WebviewMessage } from './protocol';
import { floatDialog } from './floating';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';
import { t } from '../i18n';

const MAX_COMMITS = 500;

export interface PushPanelOptions {
  /** Repos a mostrar (por defecto, todos). */
  repos?: readonly Repo[];
  /** Rama a subir en cada repo (por defecto, la actual). */
  branch?: string;
}

export class PushPanel implements vscode.Disposable {
  private static current: PushPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private repos: Repo[] = [];
  private views = new Map<string, PushRepoView>();
  private busy = false;
  private attempted = false;
  private ready = false;

  /** Abre el diálogo (o lo reutiliza si ya está abierto). */
  static async open(extensionUri: vscode.Uri, manager: RepoManager, options: PushPanelOptions = {}): Promise<void> {
    if (PushPanel.current) {
      PushPanel.current.panel.reveal();
      await PushPanel.current.load(options);
      return;
    }
    const panel = new PushPanel(extensionUri, manager);
    PushPanel.current = panel;
    await panel.load(options);
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
  ) {
    this.panel = vscode.window.createWebviewPanel('multigit.push', 'Push Commits', vscode.ViewColumn.Active, {
      ...webviewOptions(extensionUri),
      retainContextWhenHidden: true,
    });
    floatDialog(this.panel);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'push', 'Push Commits');
    this.disposables.push(
      onWebviewMessage(this.panel.webview, (m) => void this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  // ------------------------------------------------------------------ estado

  private async load(options: PushPanelOptions): Promise<void> {
    this.repos = [...(options.repos ?? this.manager.all)];
    this.attempted = false;
    this.busy = true;
    this.post();
    const views = await Promise.all(this.repos.map((repo) => buildView(repo, options.branch)));
    this.views = new Map(views.map((v) => [v.id, v]));
    this.busy = false;
    this.post();
  }

  private post(): void {
    if (!this.ready) return;
    const state: PushState = {
      repos: this.repos.map((r) => this.views.get(r.root)).filter((v): v is PushRepoView => !!v),
      busy: this.busy,
      attempted: this.attempted,
    };
    void postToWebview(this.panel.webview, { type: 'push/state', payload: state });
  }

  private repoById(id: string): Repo | undefined {
    return this.repos.find((r) => r.root === id);
  }

  // ------------------------------------------------------------------ mensajes

  private async onMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.ready = true;
          void postToWebview(this.panel.webview, { type: 'init', payload: { kind: 'push' } });
          this.post();
          break;
        case 'push/toggle':
          for (const id of message.payload.repoIds) {
            const v = this.views.get(id);
            if (v && !v.skipReason) v.checked = message.payload.checked;
          }
          this.post();
          break;
        case 'push/setTarget':
          await this.setTarget(message.payload.repoIds, message.payload.remote, message.payload.branch);
          break;
        case 'push/selectCommit': {
          const repo = this.repoById(message.payload.repoId);
          if (!repo) return;
          const files = await repo.git.commitFiles(message.payload.hash);
          void postToWebview(this.panel.webview, {
            type: 'push/files',
            payload: { repoId: repo.root, hash: message.payload.hash, files },
          });
          break;
        }
        case 'push/selectRepo': {
          // Archivos de todos los commits por subir del repo (base del más viejo → rama).
          const repo = this.repoById(message.payload.repoId);
          const view = this.views.get(message.payload.repoId);
          if (!repo || !view?.branch) return;
          const base = await rangeBase(repo, view);
          const files = base ? await repo.git.diffRefs(base, view.branch) : [];
          void postToWebview(this.panel.webview, { type: 'push/files', payload: { repoId: repo.root, hash: `range:${base ?? ''}`, files } });
          break;
        }
        case 'push/openDiff': {
          const { repoId, hash, file, base } = message.payload;
          if (!base) {
            await openCommitFileDiff(repoId, hash, file);
            break;
          }
          const left = GitContentProvider.uri(repoId, file.status === 'A' ? '' : base, file.oldPath ?? file.path);
          const right = GitContentProvider.uri(repoId, file.status === 'D' ? '' : hash, file.path);
          await vscode.commands.executeCommand('vscode.diff', left, right, `${file.path.split('/').pop()} (${t('changes to push')})`, { preview: true });
          break;
        }
        case 'push/run':
          await this.push(message.payload.repoIds, message.payload.tags, message.payload.force);
          break;
        case 'push/pullAndRetry':
          await this.pullAndRetry(message.payload.tags);
          break;
        case 'push/close':
          this.panel.dispose();
          break;
        case 'log':
          break;
      }
    } catch (error) {
      void postToWebview(this.panel.webview, { type: 'error', payload: { message: errorText(error) } });
    }
  }

  /** Edit target(s): cambia remote y/o rama destino y recalcula New y commits. */
  private async setTarget(ids: string[], remote?: string, branch?: string): Promise<void> {
    this.busy = true;
    this.post();
    await Promise.all(
      ids.map(async (id) => {
        const repo = this.repoById(id);
        const current = this.views.get(id);
        if (!repo || !current?.branch) return;
        const nextRemote = remote && current.remotes.includes(remote) ? remote : current.remote ?? undefined;
        const view = await buildView(repo, current.branch, { remote: nextRemote, branch: branch || current.remoteBranch || undefined });
        this.views.set(id, view);
      }),
    );
    this.busy = false;
    this.post();
  }

  // ------------------------------------------------------------------ push

  private async push(ids: string[], tags: PushTagsMode, force: boolean): Promise<void> {
    const targets = this.repos.filter((r) => ids.includes(r.root) && !this.views.get(r.root)?.skipReason);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(t('MultiGit: check at least one repository to push.'));
      return;
    }

    if (force) {
      const detail = [
        t('"git push --force-with-lease" will run in:'),
        ...targets.map((r) => {
          const v = this.views.get(r.root)!;
          return `  • ${r.name}: ${v.branch} → ${v.remote}:${v.remoteBranch}`;
        }),
        '',
        t('Remote commits you do not have locally will be lost. --force-with-lease only protects you if'),
        t('someone pushed something after your last fetch.'),
      ].join('\n');
      const ok = await vscode.window.showWarningMessage(t('Force push?'), { modal: true, detail }, 'Force push');
      if (ok !== 'Force push') return;
    }

    for (const v of this.views.values()) {
      v.state = 'idle';
      v.message = undefined;
      v.rejected = false;
    }
    this.busy = true;
    this.attempted = true;
    this.post();

    const results = await runInRepos(this.manager, {
      title: force ? 'Force push' : 'Push',
      repos: targets,
      silent: true,
      check: (repo) => {
        const v = this.views.get(repo.root)!;
        return !v.isNew && v.commits.length === 0 && !force && tags === 'none' ? { skip: t('nothing to push') } : undefined;
      },
      onStart: (repo) => {
        this.views.get(repo.root)!.state = 'running';
        this.post();
      },
      onStep: (repo, result) => {
        const v = this.views.get(repo.root)!;
        v.state = result.state;
        v.message = result.message;
        v.rejected = result.state === 'failed' && isRejection(result.message ?? '');
        if (v.rejected) {
          v.message = /stale info/i.test(result.message ?? '')
            ? t('rejected: the remote changed since your last fetch (--force-with-lease protected it)')
            : t('rejected: the remote has commits you don\'t have; use "Pull and Retry"');
          result.message = v.message;
        }
        this.post();
      },
      run: async (repo) => {
        const v = this.views.get(repo.root)!;
        const setUpstream = v.isNew || !(await hasUpstream(repo, v.branch!));
        await repo.git.pushBranch(v.remote!, v.branch!, v.remoteBranch!, { setUpstream, forceWithLease: force, tags });
        return v.isNew ? t('new branch {0}/{1}', v.remote, v.remoteBranch) : `↑${v.commits.length}`;
      },
    });

    this.busy = false;
    this.post();
    if (!results) return; // bloqueado en el preflight (ya se mostró el motivo)

    const summary = formatSummary(results);
    if (results.every((r) => r.state === 'ok' || r.state === 'skipped')) {
      const ok = results.filter((r) => r.state === 'ok').length;
      void vscode.window.showInformationMessage(t('✅ MultiGit: push completed in {0} repositories', ok), {
        modal: false,
        detail: summary,
      });
      this.panel.dispose();
      return;
    }
    const failed = results.find((r) => r.state === 'failed');
    void vscode.window.showErrorMessage(t('MultiGit: push failed in {0}', failed?.repo ?? '?'), { modal: true, detail: summary });
  }

  /** Pull (merge) en los repos rechazados y vuelve a hacer push de los fallidos y no ejecutados. */
  private async pullAndRetry(tags: PushTagsMode): Promise<void> {
    const rejected = this.repos.filter((r) => this.views.get(r.root)?.rejected);
    const retry = this.repos.filter((r) => {
      const s = this.views.get(r.root)?.state;
      return s === 'failed' || s === 'pending';
    });
    if (rejected.length === 0) return;

    const pulled = await runInRepos(this.manager, {
      title: t('Pull before retrying the push'),
      repos: rejected,
      check: (repo, status) => {
        const v = this.views.get(repo.root)!;
        if (status.branch !== v.branch) return { block: t('\'{0}\' is not the current branch; pull it manually', v.branch) };
        if (!status.upstream) return { block: t('the branch has no upstream') };
        return undefined;
      },
      run: async (repo) => {
        await repo.git.fetchAll();
        await repo.git.pull();
      },
    });
    if (!pulled || pulled.some((r) => r.state !== 'ok')) return;

    // Recalcula commits (el merge agregó commits) manteniendo los destinos elegidos.
    await Promise.all(
      retry.map(async (repo) => {
        const v = this.views.get(repo.root)!;
        const next = await buildView(repo, v.branch ?? undefined, { remote: v.remote ?? undefined, branch: v.remoteBranch ?? undefined });
        this.views.set(repo.root, next);
      }),
    );
    await this.push(retry.map((r) => r.root), tags, false);
  }

  dispose(): void {
    if (PushPanel.current === this) PushPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

// ------------------------------------------------------------------ helpers

/** Calcula la fila de un repo: rama, destino, si es New y los commits por subir. */
async function buildView(repo: Repo, branchOverride?: string, target: { remote?: string; branch?: string } = {}): Promise<PushRepoView> {
  const view: PushRepoView = {
    id: repo.root,
    name: repo.name,
    colorIndex: repo.colorIndex,
    branch: null,
    remote: null,
    remoteBranch: null,
    remotes: [],
    isNew: false,
    commits: [],
    truncated: false,
    checked: false,
    state: 'idle',
  };
  try {
    const [status, branches] = await Promise.all([repo.git.getStatus(), repo.git.getBranches()]);
    view.remotes = branches.remotes;
    const branch = branchOverride ?? status.branch;
    if (!branch) return { ...view, skipReason: 'HEAD detached' };
    view.branch = branch;

    const lb = branches.local.find((b) => b.name === branch);
    if (!lb) return { ...view, skipReason: t('branch \'{0}\' does not exist', branch) };

    const remote = target.remote ?? lb.upstreamRemote ?? pickRemote(branches.remotes);
    if (!remote) return { ...view, skipReason: t('the repository has no remotes') };
    const remoteBranch = target.branch ?? (lb.upstreamRemote === remote && !lb.gone ? lb.upstreamBranch : null) ?? branch;
    view.remote = remote;
    view.remoteBranch = remoteBranch;
    view.isNew = !branches.remote.some((b) => b.full === `${remote}/${remoteBranch}`);

    // New: todo lo que no está en ningún branch de ese remote. Si no: remote/rama..local.
    const args = view.isNew ? [branch, '--not', `--remotes=${remote}`] : [`${remote}/${remoteBranch}..${branch}`];
    const commits = await repo.git.logCommits(args, MAX_COMMITS + 1);
    view.truncated = commits.length > MAX_COMMITS;
    view.commits = commits.slice(0, MAX_COMMITS);
    view.checked = view.isNew || view.commits.length > 0;
  } catch (error) {
    view.skipReason = errorText(error);
  }
  return view;
}

/** Árbol vacío de git: base del rango cuando el commit más viejo no tiene padre. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Base para ver todos los cambios por subir: el padre del commit más viejo de la lista. */
async function rangeBase(repo: Repo, view: PushRepoView): Promise<string | undefined> {
  const oldest = view.commits[view.commits.length - 1];
  if (!oldest) return undefined;
  return (await repo.git.revisionExists(`${oldest.hash}^`)) ? `${oldest.hash}^` : EMPTY_TREE;
}

async function hasUpstream(repo: Repo, branch: string): Promise<boolean> {
  const lb = (await repo.git.getBranches()).local.find((b) => b.name === branch);
  return !!lb?.upstream && !lb.gone;
}

function pickRemote(remotes: readonly string[]): string | undefined {
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

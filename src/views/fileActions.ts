// Acciones sobre UN archivo (submenú Git del Explorer, del editor y de Changes), como IntelliJ:
// Show History, Annotate with Git Blame, Show Diff, Compare with Revision / Branch or Tag,
// Show Current Revision, Add, Rollback y Local History.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitContentProvider } from '../git/GitContentProvider';
import { errorText } from '../git/MultiRepoRunner';
import type { Repo, RepoManager } from '../git/RepoManager';
import type { LogView } from '../webview/LogView';
import type { ChangesActions } from './changesActions';
import type { ChangesTree } from './ChangesTree';
import { filesOf, type ChangeNode } from './ChangesTree';
import { t } from '../i18n';

/** Archivo resuelto: su repo y la ruta relativa (con `/`). */
interface Target {
  repo: Repo;
  rel: string;
  uri: vscode.Uri;
}

export class FileActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly log: LogView,
    private readonly changes: ChangesActions,
    private readonly tree: ChangesTree,
  ) {}

  /** Uri (Explorer/editor), nodo de Changes o, si no hay, el editor activo. */
  resolve(arg?: vscode.Uri | ChangeNode): Target | undefined {
    let uri: vscode.Uri | undefined;
    if (arg instanceof vscode.Uri) uri = arg;
    else if (arg && 'kind' in arg) {
      const ref = filesOf(arg)[0];
      if (ref) uri = vscode.Uri.file(path.join(ref.repo.root, ref.file.path));
    }
    uri ??= vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') return undefined;
    // El repo más interno que contiene el archivo (por si hay repos anidados).
    const repo = this.manager.allRepos
      .filter((r) => !path.relative(r.root, uri!.fsPath).startsWith('..') && !path.isAbsolute(path.relative(r.root, uri!.fsPath)))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!repo) {
      void vscode.window.showWarningMessage(t('MultiGit: the file is not in any detected repository.'));
      return undefined;
    }
    return { repo, rel: path.relative(repo.root, uri.fsPath).split(path.sep).join('/'), uri };
  }

  /** Show History: Git Log de ese archivo; al elegir un commit se abre su diff. */
  async showHistory(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = this.resolve(arg);
    if (target) await this.log.showFileHistory(target.repo.root, target.rel);
  }

  /** Annotate with Git Blame: el blame integrado de VS Code en el editor. */
  async blame(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = this.resolve(arg);
    if (!target) return;
    await vscode.window.showTextDocument(target.uri, { preview: false });
    try {
      await vscode.commands.executeCommand('git.blame.toggleEditorDecoration');
    } catch {
      void vscode.window.showWarningMessage(
        t('MultiGit: this VS Code version has no built-in blame. Update VS Code or use Show History.'),
      );
    }
  }

  /** Show Diff: cambios locales del archivo contra HEAD. */
  async showDiff(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = this.resolve(arg);
    if (!target) return;
    const file = (await target.repo.git.getChanges()).find((f) => f.path === target.rel);
    if (!file) {
      void vscode.window.showInformationMessage(t('MultiGit: {0} has no local changes.', path.posix.basename(target.rel)));
      return;
    }
    await this.changes.openDiff({ repo: target.repo, file });
  }

  /** Compare with Revision…: elegir un commit que tocó el archivo y compararlo con la versión local. */
  async compareWithRevision(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = this.resolve(arg);
    if (!target) return;
    const commits = await target.repo.git.fileHistory(target.rel).catch(() => []);
    if (!commits.length) {
      void vscode.window.showInformationMessage(t('MultiGit: the file has no Git history.'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      commits.map((c) => ({
        label: c.subject,
        description: `${c.shortHash} · ${c.author} · ${new Date(c.date).toLocaleString('es')}`,
        hash: c.hash,
        short: c.shortHash,
      })),
      { title: `Compare with Revision — ${path.posix.basename(target.rel)}`, placeHolder: t('Choose the revision'), matchOnDescription: true },
    );
    if (picked) await this.diffAgainstLocal(target, picked.hash, picked.short);
  }

  /** Compare with Branch or Tag…: el archivo en esa rama o tag contra la versión local. */
  async compareWithRef(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = this.resolve(arg);
    if (!target) return;
    const [branches, tags] = await Promise.all([target.repo.git.getBranches(), target.repo.git.listTags().catch(() => [])]);
    const items: Array<vscode.QuickPickItem & { ref?: string }> = [
      { label: 'Local', kind: vscode.QuickPickItemKind.Separator },
      ...branches.local.map((b) => ({ label: b.name, iconPath: new vscode.ThemeIcon(b.current ? 'tag' : 'git-branch'), ref: b.name })),
      { label: 'Remote', kind: vscode.QuickPickItemKind.Separator },
      ...branches.remote.map((b) => ({ label: b.full, iconPath: new vscode.ThemeIcon('cloud'), ref: b.full })),
      ...(tags.length ? [{ label: 'Tags', kind: vscode.QuickPickItemKind.Separator } as const] : []),
      ...tags.map((tag) => ({ label: tag, iconPath: new vscode.ThemeIcon('tag'), ref: `refs/tags/${tag}` })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Compare with Branch or Tag — ${path.posix.basename(target.rel)}`,
      placeHolder: t('Branch or tag'),
    });
    if (picked?.ref) await this.diffAgainstLocal(target, picked.ref, picked.label);
  }

  /** Show Current Revision: el último commit que tocó el archivo, en el Git Log. */
  async showCurrentRevision(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = this.resolve(arg);
    if (!target) return;
    const [last] = await target.repo.git.fileHistory(target.rel, 1).catch(() => []);
    if (!last) {
      void vscode.window.showInformationMessage(t('MultiGit: the file has no Git history.'));
      return;
    }
    await this.log.showFileHistory(target.repo.root, target.rel);
    void vscode.window.setStatusBarMessage(`$(git-commit) ${last.shortHash} ${last.subject} — ${last.author}`, 8000);
  }

  /** Add: `git add` del archivo. */
  async add(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = this.resolve(arg);
    if (!target) return;
    try {
      await target.repo.git.addPaths([target.rel]);
      await this.tree.refresh();
      vscode.window.setStatusBarMessage(`$(add) ${target.rel} agregado a Git`, 4000);
    } catch (error) {
      void vscode.window.showErrorMessage(`MultiGit: ${errorText(error)}`);
    }
  }

  /** Rollback…: el mismo flujo de la vista Changes (con confirmación). */
  async rollback(arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = this.resolve(arg);
    if (!target) return;
    const file = (await target.repo.git.getChanges()).find((f) => f.path === target.rel);
    if (!file || file.kind !== 'tracked') {
      void vscode.window.showInformationMessage(t('MultiGit: {0} has no changes to roll back.', path.posix.basename(target.rel)));
      return;
    }
    await this.changes.rollback([{ repo: target.repo, file }]);
  }

  // ------------------------------------------------------------------ Local History (de VS Code)

  async localHistory(action: 'show' | 'project' | 'label', arg?: vscode.Uri | ChangeNode): Promise<void> {
    const target = action === 'project' ? undefined : this.resolve(arg);
    if (action !== 'project' && !target) return;
    try {
      if (action === 'show') {
        // El historial local de VS Code se ve en la vista Timeline del archivo abierto.
        await vscode.window.showTextDocument(target!.uri, { preview: false });
        await vscode.commands.executeCommand('timeline.focus');
      } else if (action === 'project') {
        await vscode.commands.executeCommand('workbench.action.localHistory.restoreViaPicker');
      } else {
        await vscode.window.showTextDocument(target!.uri, { preview: false });
        await vscode.commands.executeCommand('workbench.action.localHistory.create');
      }
    } catch (error) {
      void vscode.window.showWarningMessage(t('MultiGit: Local History is not available ({0}).', errorText(error)));
    }
  }

  private async diffAgainstLocal(target: Target, ref: string, label: string): Promise<void> {
    const left = GitContentProvider.uri(target.repo.root, ref, target.rel);
    const title = `${path.posix.basename(target.rel)} (${label} ↔ local)`;
    await vscode.commands.executeCommand('vscode.diff', left, target.uri, title, { preview: true });
  }
}

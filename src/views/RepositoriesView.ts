// Vista "Repositorios": color, rama actual, ↑ por subir / ↓ por bajar y badge de cambios.
import * as vscode from 'vscode';
import { formatAheadBehind } from '../git/branchSummary';
import { describeHead } from '../git/parsers';
import { OPERATION_LABEL } from '../git/operations';
import { computeAlignment } from '../git/alignment';
import type { Repo, RepoManager } from '../git/RepoManager';
import { repoDecorationUri } from './RepoDecorations';
import { t } from '../i18n';

export class RepositoriesView implements vscode.TreeDataProvider<Repo>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<Repo | undefined>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly manager: RepoManager) {
    this.subscription = manager.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  getChildren(element?: Repo): Repo[] {
    return element ? [] : [...this.manager.all];
  }

  /** Todos son nodos raíz (necesario para `TreeView.reveal`). */
  getParent(): undefined {
    return undefined;
  }

  getTreeItem(repo: Repo): vscode.TreeItem {
    const item = new vscode.TreeItem(repo.name, vscode.TreeItemCollapsibleState.None);
    item.id = repo.root;
    item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(this.manager.colorIdOf(repo)));
    // Esquema propio: el badge de cambios lo pone RepoDecorations (y no choca con las del git integrado).
    item.resourceUri = repoDecorationUri(repo.root);
    item.contextValue = 'multigit.repo';

    const status = repo.status;
    if (!status) {
      item.description = t('⚠ error reading the status');
      item.tooltip = repo.error ?? repo.root;
      return item;
    }

    const head = describeHead(status);
    const counters = formatAheadBehind(status);
    // Los contadores van primero: la rama suele ser larga y se recorta por la derecha.
    item.description = counters ? `${counters}  ⎇ ${head}` : `⎇ ${head}`;
    const tooltip = buildTooltip(repo, head);
    const alignment = computeAlignment(this.manager.all);
    if (alignment?.outliers.some((o) => o.repo === repo.name)) {
      item.description = `≠ ${item.description}`;
      tooltip.appendMarkdown(t('  \n$(warning) The other repos are on `{0}`', alignment.target));
    }
    if (repo.operation) {
      // Operación a medias: primero el aviso, con botones Resolve / Continue / Abort al pasar el ratón.
      const conflicts = status.changes.conflicted;
      item.description = `⚠ ${OPERATION_LABEL[repo.operation]}${conflicts ? t(' · {0} conflict(s)', conflicts) : ''}  ${item.description}`;
      item.contextValue = 'multigit.repo.operation';
    }
    item.tooltip = tooltip;
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

function buildTooltip(repo: Repo, head: string): vscode.MarkdownString {
  const s = repo.status!;
  const lines = [`**${repo.name}**`, '', `$(git-branch) \`${head}\``];

  if (!s.upstream) {
    lines.push(t('$(cloud) no upstream (the branch has not been pushed)'));
  } else if (s.ahead === null) {
    lines.push(t('$(warning) upstream `{0}` no longer exists', s.upstream));
  } else {
    lines.push(t('$(cloud) `{0}` — ↑{1} to push, ↓{2} to pull', s.upstream, s.ahead, s.behind ?? 0));
  }

  const c = s.changes;
  if (c.total === 0) {
    lines.push(t('$(check) no changes'));
  } else {
    const parts = [
      c.staged && t('{0} staged', c.staged),
      c.unstaged && t('{0} modified', c.unstaged),
      c.untracked && t('{0} unversioned', c.untracked),
      c.conflicted && t('{0} conflicted', c.conflicted),
    ].filter(Boolean);
    lines.push(t('$(diff) {0} uncommitted changes: {1}', c.total, parts.join(', ')));
  }

  lines.push('', `_${repo.root}_`);
  const md = new vscode.MarkdownString(lines.join('  \n'), true);
  return md;
}

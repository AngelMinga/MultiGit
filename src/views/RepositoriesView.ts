// Vista "Repositorios": color, rama actual, ↑ por subir / ↓ por bajar y badge de cambios.
import * as vscode from 'vscode';
import { formatAheadBehind } from '../git/branchSummary';
import { describeHead } from '../git/parsers';
import type { Repo, RepoManager } from '../git/RepoManager';
import { repoDecorationUri } from './RepoDecorations';

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
      item.description = '⚠ error al leer el estado';
      item.tooltip = repo.error ?? repo.root;
      return item;
    }

    const head = describeHead(status);
    const counters = formatAheadBehind(status);
    // Los contadores van primero: la rama suele ser larga y se recorta por la derecha.
    item.description = counters ? `${counters}  ⎇ ${head}` : `⎇ ${head}`;
    item.tooltip = buildTooltip(repo, head);
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
    lines.push('$(cloud) sin upstream (la rama no se ha subido)');
  } else if (s.ahead === null) {
    lines.push(`$(warning) el upstream \`${s.upstream}\` ya no existe`);
  } else {
    lines.push(`$(cloud) \`${s.upstream}\` — ↑${s.ahead} por subir, ↓${s.behind ?? 0} por bajar`);
  }

  const c = s.changes;
  if (c.total === 0) {
    lines.push('$(check) sin cambios');
  } else {
    const parts = [
      c.staged && `${c.staged} en stage`,
      c.unstaged && `${c.unstaged} modificados`,
      c.untracked && `${c.untracked} sin versionar`,
      c.conflicted && `${c.conflicted} en conflicto`,
    ].filter(Boolean);
    lines.push(`$(diff) ${c.total} cambios sin commit: ${parts.join(', ')}`);
  }

  lines.push('', `_${repo.root}_`);
  const md = new vscode.MarkdownString(lines.join('  \n'), true);
  return md;
}

// Vista "Repositorios" (versión mínima de la Fase 0: nombre, color y rama actual).
// En la Fase 1 se agregan ↑/↓ e indicador de cambios.
import * as vscode from 'vscode';
import type { Repo, RepoManager } from '../git/RepoManager';
import { describeHead } from '../git/parsers';

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

  getTreeItem(repo: Repo): vscode.TreeItem {
    const item = new vscode.TreeItem(repo.name, vscode.TreeItemCollapsibleState.None);
    item.id = repo.root;
    item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(this.manager.colorIdOf(repo)));
    item.resourceUri = vscode.Uri.file(repo.root);
    item.contextValue = 'multigit.repo';

    if (repo.status) {
      item.description = `⎇ ${describeHead(repo.status)}`;
      item.tooltip = new vscode.MarkdownString(`**${repo.name}**  \n⎇ \`${describeHead(repo.status)}\`  \n${repo.root}`);
    } else {
      item.description = 'error al leer el estado';
      item.tooltip = repo.error ?? repo.root;
    }
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

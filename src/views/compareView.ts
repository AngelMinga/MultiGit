// Documento de solo lectura con el resultado de "Compare with '<actual>'".
import * as vscode from 'vscode';
import { branchToFolderName } from '../git/branches';

export class CompareView implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = 'multigit-compare';

  private readonly contents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  async show(title: string, markdown: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: CompareView.scheme, path: `/${branchToFolderName(title)}.md` });
    this.contents.set(uri.path, markdown);
    this.changeEmitter.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

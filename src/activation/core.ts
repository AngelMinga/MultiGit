// Servicios compartidos por todas las áreas de la extensión (los crea `activate`).
import type * as vscode from 'vscode';
import type { RepoManager, Repo } from '../git/RepoManager';
import type { BranchActions } from '../views/branchActions';
import type { BranchPopup } from '../views/branchPopup';

export interface Core {
  context: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  manager: RepoManager;
  actions: BranchActions;
  popup: BranchPopup;
  /** Abre el diálogo Push Commits (todos los repos o los indicados). */
  openPush(repos?: readonly Repo[], branch?: string): Promise<void>;
  /** Registra disposables en la extensión. */
  track(...disposables: vscode.Disposable[]): void;
}

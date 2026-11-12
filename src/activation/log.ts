// Panel Git Log (panel inferior).
import * as vscode from 'vscode';
import { LogView } from '../webview/LogView';
import type { Core } from './core';

export function registerLog(core: Core): LogView {
  const logView = new LogView(core.context.extensionUri, core.manager, core.actions);
  core.track(
    logView,
    vscode.window.registerWebviewViewProvider(LogView.viewId, logView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('multigit.openGitLog', () => vscode.commands.executeCommand(`${LogView.viewId}.focus`)),
    vscode.commands.registerCommand('multigit.log.showBranch', (branch?: string | null, repoIds?: string[]) =>
      logView.showBranch(branch ?? null, repoIds ?? []),
    ),
  );
  return logView;
}

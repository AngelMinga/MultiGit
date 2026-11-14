// Diálogo para escribir un mensaje de commit de varias líneas (Edit Commit Message del Git Log, como el
// de IntelliJ). Devuelve el texto, o undefined si se cancela o se cierra la ventana.
import * as vscode from 'vscode';
import type { MessageEditState, WebviewMessage } from './protocol';
import { floatDialog } from './floating';
import { onWebviewMessage, postToWebview, renderWebviewHtml, webviewOptions } from './webviewHtml';

export function editMessage(extensionUri: vscode.Uri, state: MessageEditState): Promise<string | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel('multigit.message', state.title, vscode.ViewColumn.Active, webviewOptions(extensionUri));
    floatDialog(panel);
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'multigit.svg');
    panel.webview.html = renderWebviewHtml(panel.webview, extensionUri, 'message', state.title);
    let result: string | undefined;
    const sub = onWebviewMessage(panel.webview, (m: WebviewMessage) => {
      if (m.type === 'ready') {
        void postToWebview(panel.webview, { type: 'init', payload: { kind: 'message' } });
        void postToWebview(panel.webview, { type: 'message/state', payload: state });
      } else if (m.type === 'message/ok') {
        result = m.payload.message;
        panel.dispose();
      } else if (m.type === 'message/cancel') {
        panel.dispose();
      }
    });
    panel.onDidDispose(() => {
      sub.dispose();
      resolve(result);
    });
  });
}

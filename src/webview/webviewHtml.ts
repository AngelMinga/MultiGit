// Genera el HTML que carga la app React compilada (dist/webview/index.js + index.css)
// con una Content-Security-Policy estricta y un nonce por carga.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostMessage, WebviewKind, WebviewMessage } from './protocol';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
  };
}

export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, kind: WebviewKind, title: string): string {
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'index.css'));
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="${styleUri.toString()}">
</head>
<body data-kind="${kind}">
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

/** Envío tipado host → webview. */
export function postToWebview(webview: vscode.Webview, message: HostMessage): Thenable<boolean> {
  return webview.postMessage(message);
}

/** Suscripción tipada webview → host. */
export function onWebviewMessage(webview: vscode.Webview, handler: (message: WebviewMessage) => void): vscode.Disposable {
  return webview.onDidReceiveMessage((raw: unknown) => {
    if (raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string') {
      handler(raw as WebviewMessage);
    }
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

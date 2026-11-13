// Diálogos flotantes, como en IntelliJ: el panel recién creado se mueve a su propia ventana de VS Code
// (compacta, sin barras) en lugar de quedarse como pestaña del editor.
import * as vscode from 'vscode';

/** Mueve el panel (que acaba de crearse y está activo) a una ventana propia, según `multigit.dialogs`. */
export function floatDialog(panel: vscode.WebviewPanel): void {
  const config = vscode.workspace.getConfiguration('multigit');
  if (config.get<string>('dialogs', 'floating') !== 'floating' || !panel.active) return;
  void (async () => {
    try {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
      await vscode.commands.executeCommand('workbench.action.enableCompactAuxiliaryWindow').then(undefined, () => undefined);
      if (config.get<boolean>('dialogsAlwaysOnTop', false)) {
        await vscode.commands.executeCommand('workbench.action.enableWindowAlwaysOnTop').then(undefined, () => undefined);
      }
    } catch {
      // VS Code sin ventanas auxiliares (versión antigua o web): se queda como pestaña.
    }
  })();
}

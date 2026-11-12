// Credenciales de Git en VS Code: arranca el askpass y muestra los cuadros cuando git o ssh piden
// usuario, contraseña/token, passphrase o confirmar la huella de un host.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AnswerCache, AskpassServer, classifyPrompt } from '../git/askpass';
import { GitService } from '../git/GitService';
import { t } from '../i18n';

export async function startCredentials(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
): Promise<vscode.Disposable> {
  const cache = new AnswerCache();
  const ask = async (prompt: string): Promise<string | undefined> => {
    const cached = cache.get(prompt);
    if (cached !== undefined) return cached;
    const kind = classifyPrompt(prompt);
    let answer: string | undefined;
    if (kind === 'confirm') {
      // ssh: "The authenticity of host … can't be established … (yes/no/[fingerprint])?"
      const choice = await vscode.window.showWarningMessage(
        t('MultiGit: SSH asks to confirm the server identity'),
        { modal: true, detail: prompt.trim() },
        t('Trust and Continue'),
      );
      answer = choice ? 'yes' : 'no';
    } else {
      answer = await vscode.window.showInputBox({
        title: t('MultiGit: Git credentials'),
        prompt: prompt.trim(),
        password: kind === 'secret',
        ignoreFocusOut: true,
        placeHolder: kind === 'secret' ? t('Password, access token or passphrase') : undefined,
      });
    }
    if (answer !== undefined) cache.set(prompt, answer);
    return answer;
  };

  try {
    const server = await AskpassServer.start(path.join(context.globalStorageUri.fsPath, 'askpass'), ask);
    GitService.extraEnv = server.env;
    // Credencial rechazada: olvidar lo recordado para que la próxima vez vuelva a preguntar.
    GitService.onAuthFailure = () => cache.clear();
    log.info('Askpass listo: MultiGit pedirá las credenciales de Git que falten.');
    return new vscode.Disposable(() => {
      GitService.extraEnv = {};
      GitService.onAuthFailure = undefined;
      void server.dispose();
    });
  } catch (error) {
    log.warn('No se pudo iniciar el askpass; las credenciales que falten no se podrán pedir.', error);
    return new vscode.Disposable(() => undefined);
  }
}

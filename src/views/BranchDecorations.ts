// Flecha de color a la derecha de las ramas con commits por bajar (↓ naranja) o por subir
// (↑ verde) en la vista "Ramas", como IntelliJ. Sin estado: los contadores van en la URI
// (`multigit-branch:/<id>?ahead=N&behind=M`), así que cada render del árbol trae los suyos.
// VS Code tiñe también el nombre de la rama con el color del badge.
import * as vscode from 'vscode';
import { t } from '../i18n';

const SCHEME = 'multigit-branch';

export function branchDecorationUri(id: string, track: { ahead: number; behind: number }): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${encodeURIComponent(id)}`,
    query: `ahead=${track.ahead}&behind=${track.behind}`,
  });
}

export class BranchDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) return undefined;
    const params = new URLSearchParams(uri.query);
    const ahead = Number(params.get('ahead')) || 0;
    const behind = Number(params.get('behind')) || 0;
    if (!ahead && !behind) return undefined;
    return {
      // Badge de hasta 2 caracteres: solo la flecha; el número va en la descripción.
      badge: behind && ahead ? '↕' : behind ? '↓' : '↑',
      tooltip: [behind ? t('{0} incoming commit(s) to pull', behind) : '', ahead ? t('{0} outgoing commit(s) to push', ahead) : '']
        .filter(Boolean)
        .join(' · '),
      // Lo entrante manda (es lo que hay que hacer primero: bajar).
      color: new vscode.ThemeColor(behind ? 'charts.orange' : 'charts.green'),
      propagate: false,
    };
  }
}

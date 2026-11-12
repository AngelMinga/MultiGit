// Cuadrados de color por repo (como en IntelliJ) para usarlos donde VS Code no colorea los
// ThemeIcon, p. ej. en los QuickPick. Se generan como SVG en el almacenamiento de la extensión,
// con la variante clara y oscura de cada color de `contributes.colors`.
import * as vscode from 'vscode';
import { REPO_PALETTE_SIZE, repoColorId } from '../git/repoColor';

interface ColorContribution {
  id: string;
  defaults: { light: string; dark: string };
}

export class RepoIcons {
  private ready = false;

  constructor(
    private readonly storage: vscode.Uri,
    private readonly packageJSON: { contributes?: { colors?: ColorContribution[] } },
  ) {}

  /** Escribe los SVG (si faltan). Si falla, `iconFor` devuelve un ícono genérico. */
  async init(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.dir);
      const colors = this.packageJSON.contributes?.colors ?? [];
      for (let i = 0; i < REPO_PALETTE_SIZE; i++) {
        const c = colors.find((x) => x.id === repoColorId(i));
        if (!c) continue;
        await this.write(`repo${i}-light.svg`, c.defaults.light);
        await this.write(`repo${i}-dark.svg`, c.defaults.dark);
      }
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  iconFor(colorIndex: number): vscode.QuickPickItem['iconPath'] {
    if (!this.ready) return new vscode.ThemeIcon('repo');
    return {
      light: vscode.Uri.joinPath(this.dir, `repo${colorIndex}-light.svg`),
      dark: vscode.Uri.joinPath(this.dir, `repo${colorIndex}-dark.svg`),
    };
  }

  private get dir(): vscode.Uri {
    return vscode.Uri.joinPath(this.storage, 'repo-icons');
  }

  private async write(name: string, color: string): Promise<void> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="${color}"/></svg>`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.dir, name), new TextEncoder().encode(svg));
  }
}

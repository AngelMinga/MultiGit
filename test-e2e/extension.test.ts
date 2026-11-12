// Tests dentro de VS Code: activación, comandos registrados y que todas las vistas se dibujan.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { MultiGitTestApi } from '../src/extension';

/** Recorre un TreeDataProvider completo y devuelve cada elemento con su TreeItem. */
async function walk<T>(provider: vscode.TreeDataProvider<T>, parent?: T, depth = 0): Promise<Array<{ node: T; item: vscode.TreeItem }>> {
  const children = (await provider.getChildren(parent)) ?? [];
  const out: Array<{ node: T; item: vscode.TreeItem }> = [];
  for (const node of children) {
    const item = await provider.getTreeItem(node);
    out.push({ node, item });
    if (depth < 8 && item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
      out.push(...(await walk(provider, node, depth + 1)));
    }
  }
  return out;
}

const label = (item: vscode.TreeItem) => (typeof item.label === 'string' ? item.label : item.label?.label ?? '');

describe('MultiGit en VS Code', () => {
  let api: MultiGitTestApi;

  before(async () => {
    const ext = vscode.extensions.getExtension<MultiGitTestApi>('angelminga.multigit');
    assert.ok(ext, 'la extensión está instalada en la instancia de prueba');
    api = await ext.activate();
    // initialize() ya terminó dentro de activate; por si la API de git abrió repos después:
    await api.manager.refresh();
  });

  it('detecta los 3 repos del workspace', () => {
    assert.deepEqual(
      api.manager.all.map((r) => r.name),
      ['mflogin', 'mftheme', 'shell'],
    );
    assert.equal(api.manager.all.find((r) => r.name === 'mflogin')?.status?.branch, 'develop');
  });

  it('cada comando de package.json está registrado', async () => {
    const declared = (vscode.extensions.getExtension('angelminga.multigit')!.packageJSON.contributes.commands as Array<{ command: string }>).map(
      (c) => c.command,
    );
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = declared.filter((c) => !registered.has(c));
    assert.deepEqual(missing, [], `comandos declarados sin registrar: ${missing.join(', ')}`);
  });

  it('Repositorios: todos los ítems se dibujan y el desalineado lleva ≠', async () => {
    const items = await walk(api.repositories);
    assert.equal(items.length, 3);
    const mflogin = items.find((i) => label(i.item) === 'mflogin')!;
    assert.match(String(mflogin.item.description), /^≠ ⎇ develop/);
    const mftheme = items.find((i) => label(i.item) === 'mftheme')!;
    assert.match(String(mftheme.item.description), /⎇ dev-x/);
    assert.ok(mftheme.item.tooltip, 'tooltip armado');
  });

  it('Ramas: el árbol completo se dibuja, con la rama actual marcada', async () => {
    const items = await walk(api.branches);
    const labels = items.map((i) => label(i.item));
    assert.ok(labels.includes('Local') && labels.includes('Remote'));
    const current = items.filter((i) => i.item.description === 'actual').map((i) => label(i.item));
    assert.ok(current.includes('dev-x') && current.includes('develop'), `ramas actuales: ${current.join(', ')}`);
  });

  it('Changes: archivo modificado marcado y archivo nuevo en Unversioned Files', async () => {
    await api.changes.refresh();
    const items = await walk(api.changes);
    const labels = items.map((i) => label(i.item));
    assert.ok(labels.includes('Changes') && labels.includes('Unversioned Files'), labels.join(' | '));
    const modified = items.find((i) => label(i.item) === 'index.js')!;
    assert.equal(modified.item.checkboxState, vscode.TreeItemCheckboxState.Checked);
    const untracked = items.find((i) => label(i.item) === 'nuevo.js')!;
    assert.equal(untracked.item.checkboxState, vscode.TreeItemCheckboxState.Unchecked);
  });

  it('Changes: todas las combinaciones de Group By se dibujan', async () => {
    const toggles = ['toggleGroupByRepo', 'toggleGroupByModule', 'toggleGroupByDir', 'toggleShowIgnored'];
    for (const t of toggles) {
      await vscode.commands.executeCommand(`multigit.changes.${t}`);
      await api.changes.refresh();
      const items = await walk(api.changes);
      assert.ok(items.some((i) => label(i.item) === 'index.js'), `con ${t}`);
    }
    // Volver al estado inicial.
    for (const t of toggles) await vscode.commands.executeCommand(`multigit.changes.${t}`);
  });

  it('comandos sin diálogos se ejecutan sin error', async () => {
    await vscode.commands.executeCommand('multigit.refresh');
    await vscode.commands.executeCommand('multigit.changes.refresh');
    await vscode.commands.executeCommand('multigit.branchesTree.refresh');
    await vscode.commands.executeCommand('multigit.openGitLog');
    await vscode.commands.executeCommand('multigit.showLog');
  });
});

describe('package.json', () => {
  it('ningún submenú aparece dos veces en el mismo menú (VS Code descarta el segundo)', () => {
    const menus = vscode.extensions.getExtension('angelminga.multigit')!.packageJSON.contributes.menus as Record<
      string,
      Array<{ submenu?: string }>
    >;
    const repeated = Object.entries(menus).flatMap(([menu, items]) => {
      const subs = items.map((i) => i.submenu).filter(Boolean);
      return subs.filter((s, i) => subs.indexOf(s) !== i).map((s) => `${menu}: ${s}`);
    });
    assert.deepEqual(repeated, []);
  });
});

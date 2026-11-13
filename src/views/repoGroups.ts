// Grupos de repos: elegir el grupo activo, crear uno o borrarlo. Se guardan en `multigit.repoGroups`
// (configuración del workspace); el activo, en el estado del workspace.
import * as vscode from 'vscode';
import type { RepoManager } from '../git/RepoManager';
import { filterByGroup, isGroupEffective } from '../git/repoGroups';
import { t } from '../i18n';

type Item = vscode.QuickPickItem & { action?: 'all' | 'new' | 'settings'; group?: string };

/** Select Repository Group…: todos, un grupo, nuevo grupo o editar en la configuración. */
export async function selectRepoGroup(manager: RepoManager): Promise<void> {
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = t('Repository Group');
  qp.placeholder = t('MultiGit works only with the repositories of the active group');
  const remove: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: t('Delete group') };
  const build = () => {
    const groups = manager.groups;
    const active = manager.activeGroup;
    const all = manager.allRepos;
    qp.items = [
      { label: `${active ? '$(circle-large-outline)' : '$(pass-filled)'} ${t('All repositories')}`, description: String(all.length), action: 'all' },
      ...(Object.keys(groups).length ? [{ label: t('Groups'), kind: vscode.QuickPickItemKind.Separator } as Item] : []),
      ...Object.keys(groups).map((name) => {
        const effective = isGroupEffective(all, groups, name);
        return {
          label: `${active === name ? '$(pass-filled)' : '$(circle-large-outline)'} ${name}`,
          description: effective ? filterByGroup(all, groups, name).map((r) => r.name).join(', ') : t('empty'),
          group: name,
          buttons: [remove],
        };
      }),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: `$(add) ${t('New Group…')}`, action: 'new' },
      { label: `$(settings-gear) ${t('Edit Groups in Settings')}`, action: 'settings' },
    ];
  };
  build();
  qp.onDidTriggerItemButton(async (e) => {
    const name = e.item.group;
    if (!name) return;
    const groups = { ...manager.groups };
    delete groups[name];
    await saveGroups(groups);
    if (manager.activeGroup === name) await manager.setActiveGroup(undefined);
    build();
  });
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (!item) return;
    if (item.action === 'all') await manager.setActiveGroup(undefined);
    else if (item.group) await manager.setActiveGroup(item.group);
    else if (item.action === 'new') await newRepoGroup(manager);
    else if (item.action === 'settings') await vscode.commands.executeCommand('workbench.action.openWorkspaceSettings', 'multigit.repoGroups');
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/** New Repository Group…: elegir repos, ponerle nombre y activarlo. */
export async function newRepoGroup(manager: RepoManager): Promise<void> {
  const current = new Set(manager.all.map((r) => r.root));
  const picked = await vscode.window.showQuickPick(
    manager.allRepos.map((repo) => ({ label: `$(repo) ${repo.name}`, description: repo.status?.branch ?? '', picked: manager.activeGroup ? current.has(repo.root) : false, repo })),
    { title: t('New Repository Group'), placeHolder: t('Repositories of the group'), canPickMany: true, ignoreFocusOut: true },
  );
  if (!picked?.length) return;
  const groups = manager.groups;
  const name = (
    await vscode.window.showInputBox({
      title: t('New Repository Group'),
      prompt: t('Group name ({0})', picked.map((p) => p.repo.name).join(', ')),
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() ? t('Type a name') : groups[v.trim()] ? t("Group '{0}' already exists", v.trim()) : undefined),
    })
  )?.trim();
  if (!name) return;
  await saveGroups({ ...groups, [name]: picked.map((p) => p.repo.name) });
  await manager.setActiveGroup(name);
}

async function saveGroups(groups: Record<string, string[]>): Promise<void> {
  // En el workspace (si no hay carpeta abierta, en la configuración global).
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('multigit').update('repoGroups', groups, target);
}

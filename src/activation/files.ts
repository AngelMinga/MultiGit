// Submenú Git por archivo (Explorer, editor y Changes) y Local History.
import * as vscode from 'vscode';
import type { ChangesActions } from '../views/changesActions';
import type { ChangeNode, ChangesTree } from '../views/ChangesTree';
import { FileActions } from '../views/fileActions';
import type { LogView } from '../webview/LogView';
import type { Core } from './core';

type FileArg = vscode.Uri | ChangeNode | undefined;

export function registerFileActions(core: Core, logView: LogView, changes: { tree: ChangesTree; actions: ChangesActions }): void {
  const fileActions = new FileActions(core.manager, logView, changes.actions, changes.tree);
  core.track(
    ...(
      [
        ['showHistory', (a) => fileActions.showHistory(a)],
        ['blame', (a) => fileActions.blame(a)],
        ['showDiff', (a) => fileActions.showDiff(a)],
        ['compareRevision', (a) => fileActions.compareWithRevision(a)],
        ['compareRef', (a) => fileActions.compareWithRef(a)],
        ['currentRevision', (a) => fileActions.showCurrentRevision(a)],
        ['add', (a) => fileActions.add(a)],
        ['rollback', (a) => fileActions.rollback(a)],
        ['localHistory', (a) => fileActions.localHistory('show', a)],
        ['projectHistory', () => fileActions.localHistory('project')],
        ['putLabel', (a) => fileActions.localHistory('label', a)],
        [
          'commitFile',
          async (a) => {
            const t = fileActions.resolve(a);
            if (!t) return;
            await changes.tree.refresh();
            const ref =
              changes.tree.checkedFiles.concat(changes.tree.trackedFiles).find((r) => r.repo === t.repo && r.file.path === t.rel) ??
              (await t.repo.git.getChanges()).map((file) => ({ repo: t.repo, file })).find((r) => r.file.path === t.rel);
            if (!ref) {
              void vscode.window.showInformationMessage('MultiGit: el archivo no tiene cambios para commitear.');
              return;
            }
            await changes.actions.commitOnly([ref]);
          },
        ],
        ['push', (a) => vscode.commands.executeCommand('multigit.push', fileActions.resolve(a)?.repo)],
        ['pull', (a) => vscode.commands.executeCommand('multigit.pull', fileActions.resolve(a)?.repo)],
        ['branches', (a) => vscode.commands.executeCommand('multigit.repoBranches', fileActions.resolve(a)?.repo)],
      ] as Array<[string, (arg: FileArg) => unknown]>
    ).map(([id, run]) =>
      vscode.commands.registerCommand(`multigit.file.${id}`, (arg?: FileArg) => void core.popup.safely(async () => run(arg))),
    ),
  );
}

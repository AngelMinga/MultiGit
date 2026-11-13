// Comprobaciones antes del commit: problemas de VS Code (errores/avisos), TODO/FIXME nuevos, marcas
// de conflicto, posibles secretos y archivos grandes. Si hay algo, se pregunta (Revisar / Commit igualmente).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  addedLinesByFile,
  allLines,
  formatSize,
  scanAddedLines,
  type AddedLine,
  type CheckFinding,
  type CheckKind,
} from '../git/commitChecks';
import { parseHunks } from '../git/hunks';
import type { StatusFile } from '../git/changes';
import type { Repo } from '../git/RepoManager';
import type { PartialSelection } from './ChangesTree';
import { t } from '../i18n';

export interface CheckTarget {
  repo: Repo;
  files: ReadonlyArray<{ file: StatusFile; partial?: PartialSelection }>;
}

const READ_LIMIT = 2 * 1024 * 1024;

function settings() {
  const c = vscode.workspace.getConfiguration('multigit.commitChecks');
  return {
    enabled: c.get<boolean>('enabled', true),
    diagnostics: c.get<'off' | 'errors' | 'warnings'>('diagnostics', 'errors'),
    todo: c.get<boolean>('todo', true),
    conflictMarkers: c.get<boolean>('conflictMarkers', true),
    secrets: c.get<boolean>('secrets', true),
    largeFileMB: c.get<number>('largeFileMB', 5),
  };
}

/** Revisa los archivos que van al commit. */
export async function runCommitChecks(targets: readonly CheckTarget[]): Promise<CheckFinding[]> {
  const cfg = settings();
  if (!cfg.enabled) return [];
  const scan = { todo: cfg.todo, conflictMarkers: cfg.conflictMarkers, secrets: cfg.secrets };
  const findings: CheckFinding[] = [];

  await Promise.all(
    targets.map(async ({ repo, files }) => {
      const present = files.filter(({ file }) => file.status !== 'D');
      const added = new Map<string, AddedLine[]>();

      // Versionados completos: un solo diff por repo.
      const tracked = present.filter(({ file, partial }) => file.kind === 'tracked' && !partial).map(({ file }) => file.path);
      if (tracked.length && (scan.todo || scan.conflictMarkers || scan.secrets)) {
        const diff = await repo.git.exec(['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', ...tracked]).catch(() => '');
        for (const [p, lines] of addedLinesByFile(diff)) added.set(p, lines);
      }
      for (const { file, partial } of present) {
        const abs = path.join(repo.root, file.path);
        const size = await fs.stat(abs).then((s) => (s.isFile() ? s.size : 0), () => 0);
        if (cfg.largeFileMB > 0 && size > cfg.largeFileMB * 1024 * 1024) {
          findings.push({ kind: 'large', repo: repo.name, path: file.path, text: formatSize(size) });
        }
        if (partial) {
          // Solo las líneas añadidas que se eligieron.
          const hunks = parseHunks(await repo.git.diffForPartial(file.path).catch(() => '')) ?? [];
          const chosen = new Set(partial.selected);
          added.set(
            file.path,
            hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add' && chosen.has(l.id)).map((l) => ({ line: Number(l.id.slice(1)), text: l.text.replace(/\r?\n$/, '') }))),
          );
        } else if (file.kind === 'untracked' && size > 0 && size <= READ_LIMIT) {
          const buffer = await fs.readFile(abs).catch(() => undefined);
          if (buffer && !buffer.subarray(0, 8000).includes(0)) added.set(file.path, allLines(buffer.toString('utf8')));
        }
        if (cfg.diagnostics !== 'off') {
          const worst = cfg.diagnostics === 'warnings' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
          for (const d of vscode.languages.getDiagnostics(vscode.Uri.file(abs))) {
            if (d.severity > worst) continue;
            findings.push({
              kind: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
              repo: repo.name,
              path: file.path,
              line: d.range.start.line + 1,
              text: d.message.split('\n')[0]!.slice(0, 160),
            });
          }
        }
      }
      for (const [p, lines] of added) findings.push(...scanAddedLines(repo.name, p, lines, scan));
    }),
  );
  const order: CheckKind[] = ['conflict', 'secret', 'error', 'large', 'warning', 'todo'];
  return findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
}

function kindLabel(kind: CheckKind, n: number): string {
  switch (kind) {
    case 'conflict':
      return t('{0} conflict marker(s)', n);
    case 'secret':
      return t('{0} possible secret(s)', n);
    case 'error':
      return t('{0} error(s)', n);
    case 'warning':
      return t('{0} warning(s)', n);
    case 'large':
      return t('{0} large file(s)', n);
    case 'todo':
      return t('{0} new TODO(s)', n);
  }
}

const ICON: Record<CheckKind, string> = {
  conflict: '$(git-merge)',
  secret: '$(key)',
  error: '$(error)',
  warning: '$(warning)',
  large: '$(file-binary)',
  todo: '$(checklist)',
};

/**
 * Si hay hallazgos, pregunta: Commit igualmente (→ true) o Revisar (lista para abrir cada uno → false).
 * Sin hallazgos devuelve true.
 */
export async function confirmFindings(findings: readonly CheckFinding[], roots: ReadonlyMap<string, string>): Promise<boolean> {
  if (findings.length === 0) return true;
  const counts = new Map<CheckKind, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const summary = [...counts].map(([k, n]) => kindLabel(k, n)).join(', ');
  const preview = findings.slice(0, 8).map((f) => `• ${f.repo}/${f.path}${f.line ? `:${f.line}` : ''} — ${f.text}`);
  if (findings.length > 8) preview.push(t('…and {0} more', findings.length - 8));

  const ANYWAY = t('Commit Anyway');
  const REVIEW = t('Review');
  const choice = await vscode.window.showWarningMessage(
    t('Commit checks found: {0}', summary),
    { modal: true, detail: preview.join('\n') },
    REVIEW,
    ANYWAY,
  );
  if (choice === ANYWAY) return true;
  if (choice === REVIEW) void review(findings, roots);
  return false;
}

/** Lista de hallazgos; elegir uno abre el archivo en esa línea. */
async function review(findings: readonly CheckFinding[], roots: ReadonlyMap<string, string>): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    findings.map((f) => ({
      label: `${ICON[f.kind]} ${f.text}`,
      description: `${f.repo}/${f.path}${f.line ? `:${f.line}` : ''}`,
      finding: f,
    })),
    { title: t('Commit checks'), placeHolder: t('Choose an item to open it'), matchOnDescription: true },
  );
  const f = picked?.finding;
  const root = f && roots.get(f.repo);
  if (!f || !root) return;
  const line = Math.max(0, (f.line ?? 1) - 1);
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(root, f.path)), { selection: new vscode.Range(line, 0, line, 0) });
}

// Diff de los archivos marcados en la vista Changes, de varios repos a la vez, con el mismo formato
// que usa claude-commit-vscode (### ESTADO: ruta + diff) y un encabezado por repositorio.
import type { StatusFile } from '../git/changes';
import { git, omittedReason, untrackedDiff } from './diff';

const MAX_TOTAL_CHARS = 100_000;
const MAX_FILE_CHARS = 15_000;
const GIT_TIMEOUT_SEC = 30;

export interface RepoSelection {
  name: string;
  root: string;
  branch: string | null;
  files: readonly StatusFile[];
}

export interface MultiRepoDiff {
  diff: string;
  fileCount: number;
  repoCount: number;
}

/** Estado en el formato del prompt de claude-commit. */
export function changeStatus(file: StatusFile): 'NEW' | 'DELETED' | 'MOVED/RENAMED' | 'MODIFIED' {
  if (file.kind === 'untracked' || file.status === 'A' || file.status === 'C') return 'NEW';
  if (file.status === 'D') return 'DELETED';
  if (file.status === 'R') return 'MOVED/RENAMED';
  return 'MODIFIED';
}

export async function buildMultiRepoDiff(repos: readonly RepoSelection[], signal?: AbortSignal): Promise<MultiRepoDiff> {
  let out = '';
  let fileCount = 0;
  const withFiles = repos.filter((r) => r.files.length > 0);
  outer: for (const repo of withFiles) {
    if (withFiles.length > 1) out += `\n## Repository: ${repo.name}${repo.branch ? ` (branch ${repo.branch})` : ''}\n`;
    for (const file of repo.files) {
      if (out.length >= MAX_TOTAL_CHARS) {
        out += '\n[... diff truncated: more files not shown ...]\n';
        break outer;
      }
      fileCount++;
      out += `\n### ${changeStatus(file)}: ${file.path}\n`;
      if (file.origPath) out += `(previously: ${file.origPath})\n`;

      const omitted = omittedReason(file.path);
      if (omitted !== null) {
        out += `[${omitted}: content omitted]\n`;
        continue;
      }
      const fileDiff = file.kind === 'untracked' ? untrackedDiff(repo.root, file.path) : await trackedDiff(repo.root, file, signal);
      out += fileDiff.slice(0, MAX_FILE_CHARS);
      if (fileDiff.length > MAX_FILE_CHARS) out += '\n[... file truncated ...]';
      out += '\n';
    }
  }
  return { diff: out, fileCount, repoCount: withFiles.length };
}

/** Diff contra HEAD (lo que se commitea con `git commit --only`: índice y working tree). */
async function trackedDiff(root: string, file: StatusFile, signal?: AbortSignal): Promise<string> {
  const paths = file.origPath ? [file.origPath, file.path] : [file.path];
  const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], signal)) !== null;
  const base = hasHead ? ['HEAD'] : ['--cached'];
  const out = await git(root, ['diff', ...base, '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--', ...paths], signal, GIT_TIMEOUT_SEC);
  if (out === null) return '[could not build the diff]';
  if (/^Binary files .* differ$/m.test(out) || out.includes('GIT binary patch')) return '[binary file]';
  return out.trimEnd();
}

/** Instrucción extra cuando el commit abarca varios repos. */
export function multiRepoInstruction(repoNames: readonly string[]): string | null {
  if (repoNames.length < 2) return null;
  return (
    `The changes span ${repoNames.length} repositories of the same project (${repoNames.join(', ')}) and will be ` +
    'committed in each of them with the SAME message. Write one message that describes the whole change; ' +
    'use the scope for the common area, not a repository name, unless one repository dominates.'
  );
}

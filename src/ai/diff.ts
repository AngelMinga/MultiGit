// Copiado de claude-commit-vscode (mismo autor, MIT): https://github.com/AngelMinga/claude-commit
// Mantener en sincronía con ese proyecto; no modificar aquí salvo para adaptarlo a MultiGit.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CancelledError, run } from './shell';

/**
 * Builds the diff sent to Claude, with the same layout as the IntelliJ plugin. VS Code commits what is staged, or every
 * change when nothing is staged (smart commit), so that is what the diff contains: staged changes if there are any,
 * otherwise the working tree against HEAD plus the untracked files.
 */

const MAX_TOTAL_CHARS = 100_000;
const MAX_FILE_CHARS = 15_000;
const GIT_TIMEOUT_SEC = 30;

export type ChangeStatus = 'NEW' | 'DELETED' | 'MOVED/RENAMED' | 'MODIFIED';

export interface FileChange {
    status: ChangeStatus;
    path: string;
    oldPath?: string;
    untracked?: boolean;
}

export interface CollectedDiff {
    diff: string;
    /** True when only the staged changes were used. */
    staged: boolean;
    fileCount: number;
}

/** Output of a git command, or null if it fails or git isn't installed. Cancellation is passed through. */
export async function git(root: string, args: string[], signal?: AbortSignal, timeoutSec = 10): Promise<string | null> {
    try {
        const res = await run(['git', '-c', 'core.quotepath=false', ...args], { cwd: root, timeoutSec, signal });
        return res.exitCode === 0 ? res.stdout : null;
    } catch (error) {
        if (error instanceof CancelledError) throw error;
        return null;
    }
}

/** Parses `git diff --name-status -z -M` output. */
export function parseNameStatus(output: string): FileChange[] {
    const fields = output.split('\0');
    const changes: FileChange[] = [];
    let i = 0;
    while (i < fields.length) {
        const code = fields[i++];
        if (!code) continue;
        const letter = code[0];
        if (letter === 'R' || letter === 'C') {
            const oldPath = fields[i++];
            const newPath = fields[i++];
            if (newPath === undefined) break;
            changes.push({ status: letter === 'R' ? 'MOVED/RENAMED' : 'NEW', path: newPath, oldPath });
        } else {
            const file = fields[i++];
            if (file === undefined) break;
            changes.push({ status: letter === 'A' ? 'NEW' : letter === 'D' ? 'DELETED' : 'MODIFIED', path: file });
        }
    }
    return changes;
}

/**
 * Changes git would commit: staged ones, or (if nothing is staged) the working tree and the untracked files.
 * [beforeWorkingTree] runs before the working tree is read (the extension saves dirty editors there).
 */
export async function collect(root: string, signal?: AbortSignal, beforeWorkingTree?: () => Promise<unknown>): Promise<CollectedDiff> {
    const stagedList = await git(root, ['diff', '--cached', '--name-status', '-z', '-M'], signal, GIT_TIMEOUT_SEC);
    const staged = parseNameStatus(stagedList ?? '');
    if (staged.length > 0) {
        return { diff: await build(root, staged, ['--cached'], signal), staged: true, fileCount: staged.length };
    }

    await beforeWorkingTree?.();
    const hasHead = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], signal)) !== null;
    const tracked = hasHead
        ? parseNameStatus((await git(root, ['diff', 'HEAD', '--name-status', '-z', '-M'], signal, GIT_TIMEOUT_SEC)) ?? '')
        : [];
    const untracked = ((await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal, GIT_TIMEOUT_SEC)) ?? '')
        .split('\0')
        .filter((f) => f.length > 0)
        .map((f): FileChange => ({ status: 'NEW', path: f, untracked: true }));
    const all = [...tracked, ...untracked];
    return { diff: await build(root, all, ['HEAD'], signal), staged: false, fileCount: all.length };
}

async function build(root: string, changes: FileChange[], base: string[], signal?: AbortSignal): Promise<string> {
    let out = '';
    for (const change of changes) {
        if (out.length >= MAX_TOTAL_CHARS) {
            out += '\n[... diff truncated: more files not shown ...]\n';
            break;
        }
        out += `\n### ${change.status}: ${change.path}\n`;
        if (change.oldPath) out += `(previously: ${change.oldPath})\n`;

        // Generated files, lock files and minified bundles are listed but their content is left out: it's noise for
        // the message and wastes most of the size budget.
        const omitted = omittedReason(change.path);
        if (omitted !== null) {
            out += `[${omitted}: content omitted]\n`;
            continue;
        }

        const fileDiff = change.untracked ? untrackedDiff(root, change.path) : await trackedDiff(root, change, base, signal);
        out += fileDiff.slice(0, MAX_FILE_CHARS);
        if (fileDiff.length > MAX_FILE_CHARS) out += '\n[... file truncated ...]';
        out += '\n';
    }
    return out;
}

async function trackedDiff(root: string, change: FileChange, base: string[], signal?: AbortSignal): Promise<string> {
    const paths = change.oldPath ? [change.oldPath, change.path] : [change.path];
    const out = await git(root, ['diff', ...base, '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--', ...paths], signal, GIT_TIMEOUT_SEC);
    if (out === null) return '[could not build the diff]';
    if (/^Binary files .* differ$/m.test(out) || out.includes('GIT binary patch')) return '[binary file]';
    return out.trimEnd();
}

/** A new file as a unified diff against /dev/null (git doesn't diff untracked files without touching the index). */
export function untrackedDiff(root: string, file: string): string {
    let data: Buffer;
    try {
        const full = path.join(root, file);
        const fd = fs.openSync(full, 'r');
        try {
            // Enough to fill the per-file budget; the rest would be truncated anyway.
            data = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_FILE_CHARS * 4));
            fs.readSync(fd, data, 0, data.length, 0);
        } finally {
            fs.closeSync(fd);
        }
    } catch (error) {
        return `[could not build the diff: ${(error as Error).message}]`;
    }
    if (data.subarray(0, 8000).includes(0)) return '[binary file]';
    if (data.length === 0) return `--- /dev/null\n+++ b/${file}`;
    const lines = data.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
    return `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n');
}

const GENERATED_DIRS = new Set([
    'build', 'dist', 'out', 'target', 'bin', 'node_modules', '.gradle', 'coverage', '__pycache__', '.next', '.nuxt',
]);
const LOCK_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock',
    'Pipfile.lock', 'composer.lock', 'Podfile.lock', 'pubspec.lock', 'go.sum', 'gradle.lockfile', 'flake.lock',
    'mix.lock', 'Package.resolved', 'packages.lock.json',
]);
const MINIFIED = /\.min\.(js|css)$|\.(js|css)\.map$/i;

/**
 * Why a file's content should be left out of the diff, or null to include it. Generated directories only count
 * outside source folders (a segment before them named `src`), so packages such as `com/acme/build` are kept.
 */
export function omittedReason(relativePath: string): string | null {
    const segments = relativePath.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
    const name = segments[segments.length - 1];
    if (name === undefined) return null;
    if (LOCK_FILES.has(name)) return 'lock file';
    if (MINIFIED.test(name)) return 'minified file or source map';
    const dirs = segments.slice(0, -1);
    const srcIndex = dirs.indexOf('src') < 0 ? Number.MAX_SAFE_INTEGER : dirs.indexOf('src');
    if (dirs.some((d, i) => i < srcIndex && GENERATED_DIRS.has(d))) return 'generated or build output';
    return null;
}

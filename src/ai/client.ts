// Copiado de claude-commit-vscode (mismo autor, MIT): https://github.com/AngelMinga/claude-commit
// Mantener en sincronía con ese proyecto; no modificar aquí salvo para adaptarlo a MultiGit.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { t } from './l10n';
import { CommitSuggestion, parse } from './parser';
import { run, ShellResult } from './shell';
import * as StreamJson from './streamJson';

/** Calls the `claude -p` CLI (uses your subscription's session, no API key needed). Port of the IntelliJ ClaudeClient. */

// Number of recent titles sent as a style reference, and the maximum length of each one.
export const RECENT_COMMITS = 20;
const MAX_SUBJECT_CHARS = 120;
const MAX_PROJECT_RULES_CHARS = 4000;

export interface ClientSettings {
    model: string;
    effort: string;
    claudePath: string;
    /** English language name for the prompt, e.g. "Spanish". */
    language: string;
    extraInstructions: string;
    alwaysIncludeScope: boolean;
    fastMode: boolean;
    timeoutSec: number;
}

const TYPES_LIST = `Valid types:
- feat: a new feature for the user
- fix: a bug fix
- refactor: a code change that neither adds a feature nor fixes a bug
- perf: a performance improvement
- style: formatting, whitespace, semicolons (no logic change)
- docs: documentation only
- test: adds or fixes tests
- build: build system or dependencies (package.json, gradle, pubspec…)
- ci: CI/CD configuration
- chore: maintenance tasks that don't touch source code or tests
- revert: reverts a previous commit`;

function replyFormat(alwaysIncludeScope: boolean): string {
    const scope = alwaysIncludeScope ? '<scope>' : '<optional scope>';
    return `Reply EXACTLY in this format, without code blocks:
TYPE: <type>
REASON: <one sentence explaining why it is that type>
MESSAGE:
<type>(${scope}): <title in the imperative mood, max. 72 characters>

<optional body with short bullet points, only if it adds value>`;
}

function joinSections(sections: Array<string | null | undefined>): string {
    return sections.filter((s): s is string => s != null).join('\n\n');
}

/** Normal mode prompt (fast mode off). */
export function prompt(
    branch: string,
    language: string,
    recentCommits: string[] = [],
    alwaysIncludeScope = false,
    extraInstructions = '',
    previousSuggestion: string | null = null,
): string {
    const intro = `Analyze the following diff and classify the change according to Conventional Commits.

${TYPES_LIST}

Current branch: ${branch}. If the branch name contains a ticket ID (e.g. ABC-123), include it in the title.

Write the reason, the title and the body in ${language}. The TYPE, REASON and MESSAGE labels are not translated.`;

    return joinSections([
        intro,
        styleSection(recentCommits, language),
        scopeRule(alwaysIncludeScope),
        extraInstructionsSection(extraInstructions),
        retrySection(previousSuggestion),
        replyFormat(alwaysIncludeScope),
    ]);
}

/** The user's own instructions from the settings; null if there are none. */
export function extraInstructionsSection(extraInstructions: string): string | null {
    if (extraInstructions.trim() === '') return null;
    return 'Additional instructions from the user (follow them unless they conflict with the reply format below):\n' +
        extraInstructions.trim();
}

/** Asks for a different message when the user clicked "Retry"; null on the first attempt. */
export function retrySection(previousSuggestion: string | null): string | null {
    if (!previousSuggestion || previousSuggestion.trim() === '') return null;
    return 'The user rejected this previous suggestion and wants a different one. Write a new message with ' +
        'different wording; change the type or scope only if a better one fits.\n' + previousSuggestion.trim();
}

/** Extra rule that makes the scope mandatory; null when the scope stays optional. */
export function scopeRule(alwaysIncludeScope: boolean): string | null {
    if (!alwaysIncludeScope) return null;
    return 'Always include a scope in the title: a short lowercase word naming the area of the code that changed ' +
        '(module, package, component or feature, e.g. settings, client, ui). Reuse a scope from the recent commits ' +
        'when one fits. This rule takes precedence over the style of recent commits.';
}

/** Recent titles of the repo so Claude can match its style; null if there are none. */
export function styleSection(recentCommits: string[], language: string): string | null {
    if (recentCommits.length === 0) return null;
    return 'Titles of the latest commits in the repository, newest first. Match their style ' +
        `(scopes in use, capitalization, length, ticket ID format), but always write in ${language} ` +
        'and follow the requested Conventional Commits format. They are only a reference: do not copy their content.\n' +
        recentCommits.map((c) => `- ${c}`).join('\n');
}

/** Turns the output of `git log --format=%s` into a clean list of titles. */
export function parseRecentCommits(gitLogOutput: string): string[] {
    return gitLogOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => (line.length > MAX_SUBJECT_CHARS ? line.slice(0, MAX_SUBJECT_CHARS) + '…' : line))
        .slice(0, RECENT_COMMITS);
}

/** Fast mode system prompt: the same rules as [prompt], worded for data that arrives in the user message. */
export function systemPrompt(
    language: string,
    options: {
        hasRecentCommits?: boolean;
        alwaysIncludeScope?: boolean;
        extraInstructions?: string;
        isRetry?: boolean;
        projectCommitRules?: string | null;
    } = {},
): string {
    const { hasRecentCommits = false, alwaysIncludeScope = false, extraInstructions = '', isRetry = false } = options;
    const intro = `You write Git commit messages. The user message contains the current branch, optionally the titles of the latest commits and a previous suggestion the user rejected, and then the diff.

Classify the change in the diff according to Conventional Commits.

${TYPES_LIST}

If the branch name contains a ticket ID (e.g. ABC-123), include it in the title.

Write the reason, the title and the body in ${language}. The TYPE, REASON and MESSAGE labels are not translated.`;

    const style = hasRecentCommits
        ? 'Match the style of the latest commit titles listed in the user message ' +
          `(scopes in use, capitalization, length, ticket ID format), but always write in ${language} ` +
          'and follow the requested Conventional Commits format. They are only a reference: do not copy their content.'
        : null;
    const retry = isRetry
        ? 'The user rejected the previous suggestion included in the user message and wants a different one. Write a new ' +
          'message with different wording; change the type or scope only if a better one fits.'
        : null;
    const projectRules = options.projectCommitRules?.trim()
        ? "Commit conventions from the project's CLAUDE.md (follow them unless they conflict with the reply format below):\n" +
          options.projectCommitRules.trim()
        : null;

    return joinSections([
        intro,
        style,
        scopeRule(alwaysIncludeScope),
        projectRules,
        extraInstructionsSection(extraInstructions),
        retry,
        replyFormat(alwaysIncludeScope),
    ]);
}

/** Fast mode user message (sent through stdin): only data, no rules. */
export function userMessage(branch: string, recentCommits: string[], previousSuggestion: string | null, diff: string): string {
    return joinSections([
        `Current branch: ${branch}`,
        recentCommits.length > 0
            ? 'Titles of the latest commits, newest first:\n' + recentCommits.map((c) => `- ${c}`).join('\n')
            : null,
        previousSuggestion && previousSuggestion.trim() ? `Rejected previous suggestion:\n${previousSuggestion.trim()}` : null,
        `Diff:\n${diff}`,
    ]);
}

const HEADING = /^(#{1,6})\s+\S/;
const COMMIT_WORD = /\bcommit/i;

/**
 * Commit-related section of a CLAUDE.md: the first heading that mentions "commit" and everything until the next
 * heading of the same or a higher level (headings inside code fences are ignored). Null if there is none.
 */
export function commitSection(markdown: string, maxChars = MAX_PROJECT_RULES_CHARS): string | null {
    const headings: Array<{ index: number; level: number }> = [];
    let inFence = false;
    const lines = markdown.split(/\r?\n/);
    lines.forEach((line, index) => {
        if (line.trimStart().startsWith('```')) inFence = !inFence;
        const match = inFence ? null : HEADING.exec(line);
        if (match) headings.push({ index, level: match[1]!.length });
    });
    const start = headings.find((h) => COMMIT_WORD.test(lines[h.index]!));
    if (!start) return null;
    const end = headings.find((h) => h.index > start.index && h.level <= start.level)?.index ?? lines.length;
    const section = lines.slice(start.index, end).join('\n').trim();
    return section.length > maxChars ? section.slice(0, maxChars) + '…' : section;
}

/** How to run the CLI: command line, stdin and extra environment variables. */
export interface Invocation {
    command: string[];
    stdin: string;
    env: Record<string, string>;
}

/** Fast mode reply as stream-json events with partial text (`--verbose` is required by stream-json in print mode). */
const STREAM_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

function modelAndEffortArgs(model: string, effort: string): string[] {
    return [...(model.trim() ? ['--model', model] : []), ...(effort.trim() ? ['--effort', effort] : [])];
}

/**
 * CLI arguments for the Windows invocation. `--tools=` rather than `--tools ""` because an empty quoted argument makes
 * `cmd.exe /c` strip quotes and break paths with spaces.
 */
export function claudeArgs(model: string, effort = ''): string[] {
    return ['-p', '--tools=', '--no-session-persistence', ...modelAndEffortArgs(model, effort)];
}

/** PATH, then `--model` and (only if set) `--effort` added to `"$@"` with `set --` (zsh doesn't split `${VAR:+…}`). */
function unixPrelude(effort: string): string {
    return 'export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"; ' +
        'if [ -n "$CLAUDE_COMMIT_MODEL" ]; then set -- --model "$CLAUDE_COMMIT_MODEL"; else set --; fi; ' +
        (effort.trim() ? 'set -- "$@" --effort "$CLAUDE_COMMIT_EFFORT"; ' : '');
}

/** `claude` from PATH, or the configured executable (passed through an environment variable, never interpolated). */
function unixCommand(claudePath: string): string {
    return claudePath.trim() ? '"$CLAUDE_COMMIT_BIN"' : 'claude';
}

function unixExtraEnv(effort: string, claudePath: string): Record<string, string> {
    return {
        ...(effort.trim() ? { CLAUDE_COMMIT_EFFORT: effort } : {}),
        ...(claudePath.trim() ? { CLAUDE_COMMIT_BIN: claudePath } : {}),
    };
}

/**
 * macOS/Linux: runs `claude` through a login shell so it finds the user's PATH (VS Code launched from the Dock may not
 * inherit the terminal's PATH). The prompt and the model go through environment variables, the diff through stdin.
 */
export function unixInvocation(shell: string, promptText: string, diff: string, model: string, effort = '', claudePath = ''): Invocation {
    const script = unixPrelude(effort) +
        `${unixCommand(claudePath)} -p "$CLAUDE_COMMIT_PROMPT" --tools "" --no-session-persistence "$@"`;
    return {
        command: [shell, '-l', '-c', script],
        stdin: diff,
        env: { CLAUDE_COMMIT_PROMPT: promptText, CLAUDE_COMMIT_MODEL: model, ...unixExtraEnv(effort, claudePath) },
    };
}

/** macOS/Linux fast mode: system prompt through an environment variable, user message through stdin. Never `--bare`. */
export function unixFastInvocation(shell: string, system: string, user: string, model: string, effort = '', claudePath = ''): Invocation {
    const script = unixPrelude(effort) +
        `${unixCommand(claudePath)} -p "$@" --system-prompt "$CLAUDE_COMMIT_SYSTEM_PROMPT" --tools "" --strict-mcp-config --no-session-persistence ` +
        STREAM_ARGS.join(' ');
    return {
        command: [shell, '-l', '-c', script],
        stdin: user,
        env: { CLAUDE_COMMIT_SYSTEM_PROMPT: system, CLAUDE_COMMIT_MODEL: model, ...unixExtraEnv(effort, claudePath) },
    };
}

function windowsLauncher(claude: string): string[] {
    return /\.(cmd|bat)$/i.test(claude) ? ['cmd.exe', '/c', claude] : [claude];
}

/** Windows (experimental): no shell; the prompt and the diff both go through stdin (cmd.exe mangles multi-line args). */
export function windowsInvocation(claude: string, promptText: string, diff: string, model: string, effort = ''): Invocation {
    return { command: [...windowsLauncher(claude), ...claudeArgs(model, effort)], stdin: `${promptText}\n\nDiff:\n${diff}`, env: {} };
}

/** Windows fast mode (experimental): the system prompt is read from [systemPromptFile]; no quoted or empty args. */
export function windowsFastInvocation(claude: string, systemPromptFile: string, user: string, model: string, effort = ''): Invocation {
    const args = [
        '-p',
        ...modelAndEffortArgs(model, effort),
        '--system-prompt-file', systemPromptFile, '--tools=', '--strict-mcp-config', '--no-session-persistence',
        ...STREAM_ARGS,
    ];
    return { command: [...windowsLauncher(claude), ...args], stdin: user, env: {} };
}

/**
 * Finds the Claude Code CLI on Windows: first in PATH (native `claude.exe`, then npm's `claude.cmd`), then in the
 * default locations of the native installer and npm. [exists] is injected so the lookup can be tested on any OS.
 */
export function findWindowsClaude(env: Record<string, string | undefined>, exists: (file: string) => boolean): string | null {
    const join = (dir: string, name: string) => dir.replace(/[\\/]+$/, '') + '\\' + name;
    const pathDirs = (env.PATH ?? env.Path ?? '')
        .split(';')
        .map((d) => d.trim().replace(/^"|"$/g, ''))
        .filter((d) => d.length > 0);
    const fromPath = ['claude.exe', 'claude.cmd', 'claude.bat'].flatMap((name) => pathDirs.map((dir) => join(dir, name)));
    const defaults = [
        env.USERPROFILE ? join(join(env.USERPROFILE, '.local\\bin'), 'claude.exe') : null,
        env.APPDATA ? join(join(env.APPDATA, 'npm'), 'claude.cmd') : null,
    ].filter((p): p is string => p !== null);
    return [...fromPath, ...defaults].find(exists) ?? null;
}

export function expandHome(file: string, home: string): string {
    return file === '~' || file.startsWith('~/') || file.startsWith('~\\') ? home + file.slice(1) : file;
}

const UNSUPPORTED_OPTION = /unknown option|unknown argument|unrecognized (option|argument)|unexpected argument/i;
const UNKNOWN_OPTION_NAME = /(--[\w-]+)/;
// Texts the CLI uses to report a missing or expired session (e.g. "Not logged in · Please run /login").
const LOGIN_ERRORS = ['not logged in', 'please run /login', 'invalid api key', 'token has expired', 'authentication_error'];

/** The CLI rejected an option (e.g. `error: unknown option '--strict-mcp-config'` on an older Claude Code). */
export function isUnsupportedOption(res: ShellResult): boolean {
    return res.exitCode !== 0 && UNSUPPORTED_OPTION.test(res.stderr + '\n' + res.stdout);
}

/** Turns a failed CLI result into an actionable, localized message; null if it succeeded. */
export function errorMessage(res: ShellResult): string | null {
    const output = (res.stderr + '\n' + res.stdout).toLowerCase();
    // 127: POSIX shell "command not found"; 9009: cmd.exe "is not recognized as a command".
    if (res.exitCode === 127 || res.exitCode === 9009 || (res.exitCode !== 0 && res.stderr.includes('command not found'))) {
        return t('The "claude" CLI was not found. Install Claude Code and run "claude" once to log in.');
    }
    if (res.exitCode !== 0 && LOGIN_ERRORS.some((e) => output.includes(e))) {
        return t('You are not logged in to Claude Code, or your session has expired. Open a terminal, run "claude" and log in with your subscription, then click the button again.');
    }
    if (res.exitCode !== 0 && UNSUPPORTED_OPTION.test(output)) {
        const option = UNKNOWN_OPTION_NAME.exec(res.stderr + '\n' + res.stdout)?.[1] ?? '?';
        return t('Your Claude Code version does not support the option {0}. Update Claude Code or reset the related setting.', option);
    }
    if (res.exitCode !== 0 || res.stdout.trim() === '') {
        return t('Claude failed (exit code {0}): {1}', res.exitCode, (res.stderr.trim() ? res.stderr : res.stdout).slice(0, 500));
    }
    return null;
}

/**
 * Turns a stream-json run into a plain result, so the parser, [errorMessage] and [isUnsupportedOption] work as in
 * normal mode: stdout becomes the final `result` text (or the accumulated fragments if it's missing), and a result
 * flagged `is_error` never counts as a success. stderr is kept as is.
 */
export function fromStream(raw: ShellResult, accumulated: string): ShellResult {
    const results = raw.stdout.split('\n').map(StreamJson.result).filter((r): r is StreamJson.StreamResult => r !== null);
    const last = results[results.length - 1];
    const exitCode = last?.isError && raw.exitCode === 0 ? 1 : raw.exitCode;
    return { exitCode, stdout: last?.text ?? accumulated, stderr: raw.stderr };
}

/**
 * Set when the installed CLI rejects a fast mode option: fast mode is skipped (and the user told once) until VS Code
 * reloads the extension, so updating Claude Code is picked up.
 */
let fastModeUnsupported = false;

export interface SuggestRequest {
    diff: string;
    branch: string;
    recentCommits: string[];
    previousSuggestion: string | null;
    projectCommitRules: string | null;
    signal: AbortSignal;
    onFastModeUnsupported: () => void;
    onPartialText: (text: string) => void;
}

export async function suggest(settings: ClientSettings, req: SuggestRequest): Promise<CommitSuggestion> {
    if (settings.fastMode && !fastModeUnsupported) {
        const res = await runFast(settings, req);
        if (!isUnsupportedOption(res)) return parseOrThrow(res);
        // Older CLI: fall back to the normal command, now and for the rest of the session.
        fastModeUnsupported = true;
        req.onFastModeUnsupported();
    }
    return parseOrThrow(await runNormal(settings, req));
}

async function runNormal(settings: ClientSettings, req: SuggestRequest): Promise<ShellResult> {
    const text = prompt(
        req.branch,
        settings.language,
        req.recentCommits,
        settings.alwaysIncludeScope,
        settings.extraInstructions,
        req.previousSuggestion,
    );
    const invocation = process.platform === 'win32'
        ? windowsInvocation(windowsClaude(settings), text, req.diff, settings.model, settings.effort)
        : unixInvocation(defaultShell(), text, req.diff, settings.model, settings.effort, unixClaude(settings));
    return runInvocation(invocation, settings, req.signal);
}

async function runFast(settings: ClientSettings, req: SuggestRequest): Promise<ShellResult> {
    const system = systemPrompt(settings.language, {
        hasRecentCommits: req.recentCommits.length > 0,
        alwaysIncludeScope: settings.alwaysIncludeScope,
        extraInstructions: settings.extraInstructions,
        isRetry: !!req.previousSuggestion?.trim(),
        projectCommitRules: req.projectCommitRules,
    });
    const user = userMessage(req.branch, req.recentCommits, req.previousSuggestion, req.diff);
    // Streamed reply: text fragments are accumulated and reported as they arrive.
    let partial = '';
    const onLine = (line: string) => {
        const fragment = StreamJson.textDelta(line);
        if (fragment !== null) req.onPartialText((partial += fragment));
    };

    let raw: ShellResult;
    if (process.platform !== 'win32') {
        const invocation = unixFastInvocation(defaultShell(), system, user, settings.model, settings.effort, unixClaude(settings));
        raw = await runInvocation(invocation, settings, req.signal, onLine);
    } else {
        // cmd.exe can't pass a multi-line argument, so on Windows the system prompt goes through a temporary file.
        const dir = fs.mkdtempSync(path.join(neutralDir(), 'system-prompt-'));
        const file = path.join(dir, 'system-prompt.txt');
        try {
            fs.writeFileSync(file, system, 'utf8');
            const invocation = windowsFastInvocation(windowsClaude(settings), file, user, settings.model, settings.effort);
            raw = await runInvocation(invocation, settings, req.signal, onLine);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    return fromStream(raw, partial);
}

async function runInvocation(
    invocation: Invocation,
    settings: ClientSettings,
    signal: AbortSignal,
    onStdoutLine?: (line: string) => void,
): Promise<ShellResult> {
    try {
        return await run(invocation.command, {
            cwd: neutralDir(),
            stdin: invocation.stdin,
            env: invocation.env,
            timeoutSec: settings.timeoutSec,
            signal,
            onStdoutLine,
        });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === undefined) throw error; // cancelled or timed out
        throw new Error(t('Could not start {0}: {1}', invocation.command[0] ?? '', (error as Error).message));
    }
}

function parseOrThrow(res: ShellResult): CommitSuggestion {
    const error = errorMessage(res);
    if (error) throw new Error(error);
    return parse(res.stdout);
}

function windowsClaude(settings: ClientSettings): string {
    const found = configuredClaude(settings) ?? findWindowsClaude(process.env, (f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!found) throw new Error(t('The "claude" CLI was not found. Install Claude Code and run "claude" once to log in.'));
    return found;
}

/** On macOS/Linux an empty result means "find `claude` through the login shell's PATH". */
function unixClaude(settings: ClientSettings): string {
    return configuredClaude(settings) ?? '';
}

/** The executable set in the settings (with `~` expanded), or null if none; fails clearly if it doesn't exist. */
function configuredClaude(settings: ClientSettings): string | null {
    const raw = settings.claudePath.trim();
    if (!raw) return null;
    const file = expandHome(raw, os.homedir());
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(t('The Claude CLI path set in the settings does not exist: {0}', raw));
    }
    return file;
}

/** `$SHELL`, or the first available shell if it isn't set (e.g. some Linux desktop launchers). */
function defaultShell(): string {
    const fromEnv = process.env.SHELL?.trim();
    if (fromEnv) return fromEnv;
    return ['/bin/zsh', '/bin/bash', '/bin/sh'].find((s) => fs.existsSync(s)) ?? '/bin/sh';
}

/**
 * Directory outside the repo: inside the project the CLI would load its CLAUDE.md, hooks and MCP servers, which slows
 * it down and can change the response format. Everything it needs is in the diff and the prompt.
 */
function neutralDir(): string {
    const dir = path.join(os.tmpdir(), 'claude-commit');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

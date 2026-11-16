// Generación del mensaje de commit con Claude Code (CLI `claude -p`, sin API key) para los archivos
// marcados en la vista Changes. Reutiliza los módulos de claude-commit-vscode (src/ai) y agrega el
// diff multi-repo.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { commitSection, parseRecentCommits, RECENT_COMMITS, suggest, type ClientSettings, type SuggestRequest } from '../ai/client';
import { git } from '../ai/diff';
import { setTranslator } from '../ai/l10n';
import { setTranslator as setAppTranslator } from '../i18n';
import { resolveLanguage } from '../ai/language';
import { buildMultiRepoDiff, multiRepoInstruction, type RepoSelection } from '../ai/multiRepoDiff';
import { partialMessage, type CommitSuggestion } from '../ai/parser';
import { CancelledError } from '../ai/shell';
import { t } from '../i18n';

const MAX_EXTRA_INSTRUCTIONS = 1000;

/**
 * Traducciones: los textos de MultiGit (src/i18n) y los de los módulos copiados de Claude Commit
 * (src/ai/l10n) usan vscode.l10n y el bundle l10n/bundle.l10n.<idioma>.json.
 */
export function installTranslations(): void {
  const translate = (message: string, ...args: Array<string | number | boolean | null | undefined>) =>
    vscode.l10n.t(message, ...args.map((a) => (typeof a === 'number' || typeof a === 'boolean' ? a : String(a))));
  setTranslator(translate);
  setAppTranslator(translate);
}

export type ClaudeSettings = ClientSettings & { imitateRepoStyle: boolean; overwriteWithoutAsking: boolean };

/**
 * Lee `multigit.claude.<clave>`; si el usuario no la configuró, usa `claudeCommit.<clave>`
 * (la extensión Commit Messages for Claude Code) y, si tampoco, el valor por defecto.
 */
export function readClaudeSettings(): ClaudeSettings {
  const own = vscode.workspace.getConfiguration('multigit.claude');
  const legacy = vscode.workspace.getConfiguration('claudeCommit');
  const get = <T>(key: string, fallback: T): T => {
    const i = own.inspect<T>(key);
    const set = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
    if (set !== undefined) return set;
    return legacy.get<T>(key) ?? fallback;
  };
  const timeout = get<number>('timeoutSec', 180);
  return {
    model: get<string>('customModel', '').trim() || get<string>('model', '').trim(),
    effort: get<string>('effort', '').trim(),
    claudePath: get<string>('claudePath', '').trim(),
    language: resolveLanguage(get<string>('language', 'IDE'), vscode.env.language),
    extraInstructions: get<string>('extraInstructions', '').trim().slice(0, MAX_EXTRA_INSTRUCTIONS),
    alwaysIncludeScope: get<boolean>('alwaysIncludeScope', false),
    fastMode: get<boolean>('fastMode', true),
    timeoutSec: Math.min(Math.max(Number.isFinite(timeout) ? timeout : 180, 10), 900),
    imitateRepoStyle: get<boolean>('imitateRepoStyle', true),
    overwriteWithoutAsking: get<boolean>('overwriteWithoutAsking', false),
  };
}

export interface GenerateRequest {
  repos: RepoSelection[];
  /** Mensaje anterior de Claude que el usuario quiere cambiar (reintento), o null. */
  previousSuggestion: string | null;
  signal: AbortSignal;
  onStep: (step: string) => void;
  onPartialMessage: (text: string) => void;
}

export class NoChangesError extends Error {}
export { CancelledError };

/** API de la extensión "Commit Messages for Claude Code" (ver su src/extension.ts, `ClaudeCommitApi`). */
interface ClaudeCommitApi {
  readonly version: number;
  suggest(settings: ClientSettings, request: SuggestRequest): Promise<CommitSuggestion>;
}

/** Ids de la extensión: el actual del Marketplace y el de la 0.1.0. */
const CLAUDE_COMMIT_IDS = ['angelminga.commit-messages-for-claude-code', 'angelminga.claude-commit'];

/** La extensión instalada con API (0.2.0 o posterior), para mostrar en el botón cuál se usa. */
export function claudeCommitExtension(): { name: string; version: string } | undefined {
  for (const id of CLAUDE_COMMIT_IDS) {
    const ext = vscode.extensions.getExtension(id);
    const version = String(ext?.packageJSON?.version ?? '');
    const [major = 0, minor = 0] = version.split('.').map(Number);
    if (ext && (major > 0 || minor >= 2)) return { name: 'Commit Messages for Claude Code', version };
  }
  return undefined;
}

/**
 * La extensión Commit Messages for Claude Code, si está instalada y tiene la API (v1). Si no, MultiGit usa
 * su copia de esos módulos (src/ai).
 */
export async function claudeCommitApi(): Promise<ClaudeCommitApi | undefined> {
  for (const id of CLAUDE_COMMIT_IDS) {
    const ext = vscode.extensions.getExtension<ClaudeCommitApi | undefined>(id);
    if (!ext) continue;
    try {
      const api = ext.isActive ? ext.exports : await ext.activate();
      if (api?.version === 1 && typeof api.suggest === 'function') return api;
    } catch {
      // No se pudo activar: se usa la copia interna.
    }
  }
  return undefined;
}

/** Arma el diff de los repos elegidos y pide el mensaje a Claude. */
export async function generateCommitMessage(settings: ClaudeSettings, req: GenerateRequest): Promise<CommitSuggestion> {
  req.onStep(t('Preparing the diff…'));
  await saveDirtyEditors(req.repos.map((r) => r.root));
  const collected = await buildMultiRepoDiff(req.repos, req.signal);
  if (collected.fileCount === 0) throw new NoChangesError();

  const first = req.repos.find((r) => r.files.length > 0)!;
  const branches = [...new Set(req.repos.filter((r) => r.files.length).map((r) => r.branch).filter(Boolean))];
  const branch = branches.length === 1 ? branches[0]! : branches.join(', ');
  const recentCommits = settings.imitateRepoStyle
    ? parseRecentCommits((await git(first.root, ['log', '-n', String(RECENT_COMMITS), '--no-merges', '--format=%s'], req.signal)) ?? '')
    : [];
  const extra = [settings.extraInstructions, multiRepoInstruction(req.repos.filter((r) => r.files.length).map((r) => r.name))]
    .filter(Boolean)
    .join('\n');

  req.onStep(t('Claude is writing the message…'));
  // Con la extensión instalada se usa la suya (misma versión del prompt y del CLI que su botón).
  const api = await claudeCommitApi();
  const run = api ? api.suggest.bind(api) : suggest;
  const clientSettings: ClientSettings = {
    model: settings.model,
    effort: settings.effort,
    claudePath: settings.claudePath,
    language: settings.language,
    extraInstructions: extra,
    alwaysIncludeScope: settings.alwaysIncludeScope,
    fastMode: settings.fastMode,
    timeoutSec: settings.timeoutSec,
  };
  return run(
    clientSettings,
    {
      diff: collected.diff,
      branch,
      recentCommits,
      previousSuggestion: req.previousSuggestion,
      projectCommitRules: settings.fastMode ? findProjectCommitRules(req.repos.map((r) => r.root)) : null,
      signal: req.signal,
      onFastModeUnsupported: () => void vscode.window.showWarningMessage(t('MultiGit: update Claude Code to use fast mode.')),
      onPartialText: (raw) => {
        const text = partialMessage(raw);
        if (text !== null) req.onPartialMessage(text);
      },
    },
  ).catch((error: unknown) => {
    // El CancelledError de la otra extensión es de otra clase: se reconoce por el nombre.
    if (error instanceof Error && error.name === 'CancelledError' && !(error instanceof CancelledError)) throw new CancelledError();
    throw error;
  });
}

/** El diff de lo no guardado se lee del disco: guarda primero los editores modificados de esos repos. */
async function saveDirtyEditors(roots: readonly string[]): Promise<void> {
  const inRepos = (doc: vscode.TextDocument) =>
    doc.isDirty && doc.uri.scheme === 'file' && roots.some((root) => !path.relative(root, doc.uri.fsPath).startsWith('..'));
  await Promise.all(vscode.workspace.textDocuments.filter(inRepos).map((doc) => doc.save()));
}

/** Sección de commits del CLAUDE.md (raíz del workspace o de los repos), como en claude-commit-vscode. */
function findProjectCommitRules(roots: readonly string[]): string | null {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const dirs = [...new Set([...folders, ...roots])];
  for (const file of dirs.flatMap((d) => [path.join(d, 'CLAUDE.md'), path.join(d, '.claude', 'CLAUDE.md')])) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      const section = commitSection(fs.readFileSync(file, 'utf8'));
      if (section) return section;
    } catch {
      // no existe o no se puede leer
    }
  }
  return null;
}

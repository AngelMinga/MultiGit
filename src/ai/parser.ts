// Copiado de claude-commit-vscode (mismo autor, MIT): https://github.com/AngelMinga/claude-commit
// Mantener en sincronía con ese proyecto; no modificar aquí salvo para adaptarlo a MultiGit.
/** [type] is the raw type Claude returned (may be non-standard), or empty if none could be found. */
export interface CommitSuggestion {
    type: string;
    reason: string;
    message: string;
}

export const TYPES = ['feat', 'fix', 'refactor', 'perf', 'style', 'docs', 'test', 'build', 'ci', 'chore', 'revert'];

// Opening code fence with an optional language tag (```text, ```markdown…) and closing fence.
const OPENING_FENCE = /^```[\w-]*[ \t]*\r?\n?/;
const CLOSING_FENCE = /\r?\n?```\s*$/;

const TYPE_LINE = /^(?:TYPE|TIPO):\s*([a-z]+)/im;
const REASON_LINE = /^(?:REASON|RAZ[OÓ]N):\s*(.+)$/imu;
const MESSAGE_BLOCK = /(?:MESSAGE|MENSAJE):[ \t]*\r?\n?([\s\S]*)/i;
const TITLE_TYPE = /^([a-z]+)(\(.*?\))?!?:/;

function stripFences(text: string): string {
    return text.replace(OPENING_FENCE, '').replace(CLOSING_FENCE, '');
}

/**
 * The commit message part of a reply that is still being streamed: whatever follows `MESSAGE:` so far, or null if
 * that label hasn't arrived yet (the TYPE and REASON lines are not shown to the user).
 */
export function partialMessage(raw: string): string | null {
    const match = MESSAGE_BLOCK.exec(raw.replace(OPENING_FENCE, ''));
    if (!match) return null;
    const text = stripFences(match[1] ?? '').trimStart().replace(/`+$/, '').trimEnd();
    return text.length > 0 ? text : null;
}

/** Parses Claude's reply (TYPE / REASON / MESSAGE format). Also accepts the Spanish labels used by older prompts. */
export function parse(raw: string): CommitSuggestion {
    const text = stripFences(raw.trim()).trim();
    const type = TYPE_LINE.exec(text)?.[1]?.toLowerCase();
    const reason = REASON_LINE.exec(text)?.[1]?.trim() ?? '';
    const block = MESSAGE_BLOCK.exec(text)?.[1];
    const message = block === undefined ? undefined : stripFences(block).trim();

    // If Claude ignored the format, use the whole output as the message and infer the type from the title.
    const finalMessage = message && message.trim().length > 0 ? message : text;
    const finalType = type ?? TITLE_TYPE.exec(finalMessage)?.[1] ?? '';

    return { type: finalType, reason, message: finalMessage };
}

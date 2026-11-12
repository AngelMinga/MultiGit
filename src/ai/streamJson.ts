// Copiado de claude-commit-vscode (mismo autor, MIT): https://github.com/AngelMinga/claude-commit
// Mantener en sincronía con ese proyecto; no modificar aquí salvo para adaptarlo a MultiGit.
/**
 * Reader for the CLI's `--output-format stream-json` lines (one JSON object per line). Only two kinds of events matter:
 * - text fragments: `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`
 * - the final result: `{"type":"result","is_error":false,"result":"..."}`
 */
export interface StreamResult {
    text: string;
    isError: boolean;
}

function parseLine(line: string): any {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
}

/** Text fragment carried by a `text_delta` event, or null for any other line. */
export function textDelta(line: string): string | null {
    if (!line.includes('"content_block_delta"')) return null;
    const event = parseLine(line)?.event;
    const delta = event?.type === 'content_block_delta' ? event.delta : undefined;
    return delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : null;
}

/** Final `result` event, or null for any other line. */
export function result(line: string): StreamResult | null {
    if (!line.includes('"result"')) return null;
    const json = parseLine(line);
    if (json?.type !== 'result' || typeof json.result !== 'string') return null;
    return { text: json.result, isError: json.is_error === true };
}

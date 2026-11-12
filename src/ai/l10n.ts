// Copiado de claude-commit-vscode (mismo autor, MIT): https://github.com/AngelMinga/claude-commit
// Mantener en sincronía con ese proyecto; no modificar aquí salvo para adaptarlo a MultiGit.
/**
 * UI texts. The English text is the key, as with `vscode.l10n.t`; translations live in `l10n/bundle.l10n.<lang>.json`.
 * Pure modules call [t]; the extension plugs in `vscode.l10n.t` on activation, tests keep the English fallback.
 */
export type Translate = (message: string, ...args: Array<string | number>) => string;

const english: Translate = (message, ...args) =>
    message.replace(/\{(\d+)\}/g, (match, index: string) => (Number(index) < args.length ? String(args[Number(index)]) : match));

let translate: Translate = english;

export function setTranslator(fn: Translate): void {
    translate = fn;
}

export function t(message: string, ...args: Array<string | number>): string {
    return translate(message, ...args);
}

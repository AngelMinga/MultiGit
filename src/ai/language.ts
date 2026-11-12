// Copiado de claude-commit-vscode (mismo autor, MIT): https://github.com/AngelMinga/claude-commit
// Mantener en sincronía con ese proyecto; no modificar aquí salvo para adaptarlo a MultiGit.
/** Stored language value meaning "use the VS Code display language". */
export const LANGUAGE_IDE = 'IDE';

/** English name of a locale's language ("Spanish", "Japanese"…), as the prompt expects. */
export function languageName(locale: string): string {
    const code = locale.split(/[-_]/)[0];
    try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(code ?? 'en') || 'English';
    } catch {
        return 'English';
    }
}

/** Language name to put in the prompt; resolves [LANGUAGE_IDE] (or an empty value) to the VS Code language. */
export function resolveLanguage(stored: string | undefined, displayLanguage: string): string {
    const value = stored?.trim() || LANGUAGE_IDE;
    return value === LANGUAGE_IDE ? languageName(displayLanguage) : value;
}

// Textos de la app web: en inglés, traducidos con el bundle que el host pone en el HTML
// (<script type="application/json" id="multigit-l10n">, el de vscode.l10n del idioma activo).
let bundle: Record<string, string> = {};
try {
  bundle = JSON.parse(document.getElementById('multigit-l10n')?.textContent || '{}') as Record<string, string>;
} catch {
  bundle = {};
}

/** Texto traducido; `{0}`, `{1}`… se reemplazan por los argumentos. */
export function t(message: string, ...args: Array<string | number>): string {
  return (bundle[message] ?? message).replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < args.length ? String(args[Number(index)]) : match,
  );
}

/** Idioma de VS Code (para fechas). */
export const locale = document.documentElement.lang || 'en';

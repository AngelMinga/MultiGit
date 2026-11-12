// Textos de la interfaz: se escriben en inglés y se traducen con vscode.l10n (l10n/bundle.l10n.<idioma>.json).
// Este módulo no importa `vscode` para que los módulos puros (y sus tests) lo usen; la extensión
// conecta `vscode.l10n.t` al activarse. Sin traductor (tests), devuelve el inglés con los {n} reemplazados.
/** Las variables se muestran con String() (null/undefined incluidos). */
export type Arg = string | number | boolean | null | undefined;
export type Translate = (message: string, ...args: Arg[]) => string;

export const formatMessage: Translate = (message, ...args) =>
  message.replace(/\{(\d+)\}/g, (match, index: string) => (Number(index) < args.length ? String(args[Number(index)]) : match));

let translate: Translate = formatMessage;

export function setTranslator(fn: Translate): void {
  translate = fn;
}

/** Texto traducido al idioma de VS Code. `message` es el texto en inglés (también es la clave). */
export function t(message: string, ...args: Arg[]): string {
  return translate(message, ...args);
}

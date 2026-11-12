// Mensajes de commit: ticket sacado de la rama, plantilla e historial. Puro, sin `vscode`.

/** Patrón por defecto: claves de Jira/YouTrack/Linear como `ABC-123`. */
export const DEFAULT_TICKET_PATTERN = '[A-Z][A-Z0-9]+-\\d+';
/** Plantilla por defecto: el ticket delante del mensaje (`ABC-123 feat: …`). */
export const DEFAULT_TICKET_TEMPLATE = '{ticket} {message}';
export const HISTORY_SIZE = 30;

/**
 * Ticket de una rama (`feature/ABC-123-login` → `ABC-123`), o undefined. Distingue mayúsculas (así
 * `release-1.2` o `hotfix-123` no cuentan como ticket). Patrón inválido = sin ticket.
 */
export function ticketFromBranch(branch: string | null | undefined, pattern: string): string | undefined {
  if (!branch || !pattern) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return undefined;
  }
  const match = re.exec(branch);
  if (!match) return undefined;
  // Si el patrón tiene un grupo, el ticket es el grupo 1; si no, todo lo que coincide.
  return (match[1] ?? match[0]) || undefined;
}

/** Ticket común a varias ramas: solo si todas las que tienen uno tienen el mismo. */
export function commonTicket(branches: ReadonlyArray<string | null | undefined>, pattern: string): { ticket: string; branch: string } | undefined {
  let found: { ticket: string; branch: string } | undefined;
  for (const branch of branches) {
    const ticket = ticketFromBranch(branch, pattern);
    if (!ticket) continue;
    if (found && found.ticket !== ticket) return undefined;
    found ??= { ticket, branch: branch! };
  }
  return found;
}

function render(text: string, ticket: string, branch: string): string {
  return text.replace(/\{ticket\}/g, ticket).replace(/\{branch\}/g, branch);
}

/**
 * Texto con el que se rellena la caja vacía: la parte de la plantilla antes de `{message}`
 * (`{ticket} {message}` → `ABC-123 `). Vacío si la plantilla pone el ticket después del mensaje.
 */
export function templatePrefix(template: string, ticket: string, branch: string): string {
  if (!template.trim()) return '';
  const at = template.indexOf('{message}');
  return render(at < 0 ? template : template.slice(0, at), ticket, branch);
}

/** Aplica la plantilla a un mensaje que no lleva el ticket (p. ej. el que escribe Claude). */
export function applyTemplate(message: string, template: string, ticket: string, branch: string): string {
  if (!template.trim() || !message.trim() || message.toUpperCase().includes(ticket.toUpperCase())) return message;
  const [subject = '', ...body] = message.split('\n');
  const rendered = template.includes('{message}')
    ? render(template, ticket, branch).replace('{message}', subject)
    : render(template, ticket, branch) + subject;
  return [rendered, ...body].join('\n');
}

/** ¿El mensaje es solo el prefijo de la plantilla (o está vacío)? */
export function isOnlyPrefix(message: string, prefix: string): boolean {
  return !message.trim() || (prefix.trim() !== '' && message.trim() === prefix.trim());
}

/** Añade un mensaje al historial (más reciente primero, sin repetidos, como mucho `max`). */
export function addToHistory(history: readonly string[], message: string, max = HISTORY_SIZE): string[] {
  const text = message.trim();
  if (!text) return [...history];
  return [text, ...history.filter((m) => m !== text)].slice(0, max);
}

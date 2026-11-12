// Formatos de fecha como IntelliJ: "Hoy 08:51", "Ayer 17:20", "10 nov 2026".

export function relativeDate(value: string | number, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const time = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (date.getTime() >= startOfToday) return `Hoy ${time}`;
  if (date.getTime() >= startOfToday - day) return `Ayer ${time}`;
  return date.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Fecha completa para el detalle: "11 nov 2026, 08:51". */
export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** `YYYY-MM-DD` local de hace `days` días. */
export function isoDaysAgo(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

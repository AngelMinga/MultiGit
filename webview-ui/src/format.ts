// Formatos de fecha como IntelliJ: "Hoy 08:51", "Ayer 17:20", "10 nov 2026".

export function relativeDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (date.getTime() >= startOfToday) return `Hoy ${time}`;
  if (date.getTime() >= startOfToday - day) return `Ayer ${time}`;
  return date.toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

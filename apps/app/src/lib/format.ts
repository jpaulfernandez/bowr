/** Local date/time text for server timestamps, in the viewer's timezone. */
export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return 'Not yet';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }).format(
      new Date(iso),
    );
  } catch {
    return new Date(iso).toISOString();
  }
}

export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return 'Not yet';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function formatTimeFromNow(seconds: number): string {
  return formatDateTime(new Date(Date.now() + seconds * 1000).toISOString());
}

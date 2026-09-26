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

/** USD from integer micros ($1 = 1,000,000). Small amounts keep enough digits to be nonzero. */
export function formatMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  const digits = micros === 0 || micros >= 10_000 ? 2 : 6;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(dollars);
}

/** Local date and time with the viewer's timezone name, for reset times. */
export function formatResetTime(iso: string): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))} (${zone})`;
}

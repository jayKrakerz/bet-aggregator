/** Returns today's date as YYYY-MM-DD in the local timezone. */
export function todayDateString(): string {
  const now = new Date();
  return now.toISOString().split('T')[0]!;
}

/** Parses a raw time string like "7:30 PM ET" into a best-effort ISO-ish string. */
export function parseGameTime(raw: string | null): string | null {
  if (!raw) return null;
  return raw.trim();
}

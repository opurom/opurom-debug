// Exact hit counts for DAP breakpoints. hitCondition is a positive integer; the
// breakpoint pauses on that hit only, so a client cannot silently ignore a bad one.
export function parseHitCount(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const count = Number(text);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

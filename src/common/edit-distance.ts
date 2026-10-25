/** Levenshtein distance between two strings, used to suggest a near-miss name */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const curr = [i, ...new Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[cols - 1];
}

/** The candidate within two edits of name for a typo hint, the closest first, or null */
export function nearestName(
  name: string,
  candidates: Iterable<string>,
  options: { ignoreCase?: boolean } = {},
): string | null {
  const fold = (value: string) => (options.ignoreCase ? value.toLowerCase() : value);
  const target = fold(name);
  let best: { name: string; distance: number } | null = null;
  for (const candidate of candidates) {
    // A length gap beyond two edits can never match
    if (Math.abs(candidate.length - target.length) > 2) continue;
    const distance = editDistance(target, fold(candidate));
    if (distance <= 2 && (best === null || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name ?? null;
}

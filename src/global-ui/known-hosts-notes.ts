/**
 * The text of the known-hosts field's two notes
 */

/** Says which servers have no host key, so the configuration cannot be saved */
export function missingHostKeysText(missing: string[]): string {
  const servers =
    missing.length < 2
      ? (missing[0] ?? '')
      : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
  return `Host keys missing: Speicher has no host key for ${servers} yet, so the configuration cannot be saved. To add ${missing.length === 1 ? 'it' : 'them'}, press Fetch host keys.`;
}

/** Says how many lines are not host keys, and where to see them */
export function unreadableLinesText(unreadable: number): string {
  return `${unreadable === 1 ? 'One line is not a host key.' : `${unreadable} lines are not host keys.`} To see them, open Edit manually.`;
}

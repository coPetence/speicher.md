/**
 * Sync failure summaries
 *
 * Formats findings from a sync walk into human-readable messages
 * adminSummary for the admin panel, authorSummary for the repo author
 *
 * Both are produced only when the sync has at least one rejection
 */

import { FindingList } from './findings';

/**
 * Lists each rejection with source location and admin-facing message
 */
export function adminSummary(findings: FindingList): string {
  return findings.rejections
    .map((f) => `${f.source}${f.line ? `:${f.line}` : ''}  ${f.adminMessage ?? f.message}`)
    .join('\n');
}

/**
 * Public-facing sync failure notification with findings and reassurance
 */
export function authorSummary(findings: FindingList): string {
  const subtrees = [...new Set(findings.rejections.map((f) => f.source))];
  return [
    `✗ speicher — sync failed for ${subtrees.join(', ')}`,
    findings.toAuthorText(),
    '  Serving the previous version until this is fixed.',
  ].join('\n');
}

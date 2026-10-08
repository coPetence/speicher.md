/**
 * Document counts per repo that reference a member
 *
 * Queries documents whose effective_principals include a principal matching the
 * member's principal pattern. Groups results by repo namespace and slug, ordered
 * by count descending
 *
 * Called from the admin config page when renaming a member to show affected pages
 */
import { QueryTypes } from 'sequelize';

import { getSequelize } from '../../db/sequelize';
import { memberOf, memberPrincipalPattern } from './config-form/members';
import type { ConfigSectionPayload } from './config-page/payloads';

export interface MemberUsage {
  namespace: string;
  slug: string;
  pages: number;
}

/** Counts documents per repo whose effective_principals match the member pattern */
export async function memberUsage(tenantId: string, pattern: string): Promise<MemberUsage[]> {
  const rows = await getSequelize().query<{ namespace: string; slug: string; pages: string }>(
    `SELECT r.namespace, r.slug, count(*)::text AS pages
       FROM documents d
       JOIN repos r ON r.id = d.repo_id
      WHERE d.tenant_id = :tenantId
        AND EXISTS (
          SELECT 1 FROM unnest(d.effective_principals) AS principal
           WHERE principal LIKE :prefix
        )
      GROUP BY r.namespace, r.slug
      ORDER BY count(*) DESC, r.namespace, r.slug`,
    {
      type: QueryTypes.SELECT,
      replacements: { tenantId, prefix: pattern },
    },
  );

  return rows.map((row) => ({
    namespace: row.namespace,
    slug: row.slug,
    pages: Number(row.pages),
  }));
}

/**
 * The usage a member's page lists beside its rename, written onto the payload.
 *
 * Shared by the page and by a save that hands the page back: every answer to a
 * save re-renders the page, and a modal that came back empty would read as
 * "nothing depends on this name".
 */
export async function stampUsage(
  tenantId: string,
  sectionId: string,
  payload: ConfigSectionPayload,
): Promise<void> {
  if (payload.creating || !payload.section?.renameOp) return;
  const member = memberOf(sectionId);
  const pattern = member && memberPrincipalPattern(member.section, member.id);
  if (!pattern) return;
  payload.usage = await memberUsage(tenantId, pattern);
}

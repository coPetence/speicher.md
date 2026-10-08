import { QueryTypes, Sequelize, Transaction } from 'sequelize';

export interface WritePlan {
  tenantId: string;
  repoId: string;
  namespace: string;
  slug: string;
  forgeKey: string;
  sha: string;
  failed: string[];
}

export interface WriteTx {
  sequelize: Sequelize;
  tx: Transaction;
  plan: WritePlan;
}

export async function exec(
  w: WriteTx,
  sql: string,
  type: QueryTypes.INSERT | QueryTypes.UPDATE | QueryTypes.DELETE,
  replacements: Record<string, unknown>,
): Promise<void> {
  await w.sequelize.query(sql, { transaction: w.tx, type, replacements });
}

export function retained<T>(plan: WritePlan, rows: T[], pathOf: (row: T) => string): T[] {
  return rows.filter((row) => !isUnder(plan.failed, pathOf(row)));
}

export function isUnder(prefixes: string[], slugPath: string): boolean {
  return prefixes.some((p) => p === '' || slugPath === p || slugPath.startsWith(`${p}/`));
}

export function normaliseFailedSubtrees(prefixes: string[]): string[] {
  const unique = [...new Set(prefixes)].sort();
  return unique.filter(
    (p, i) => !unique.slice(0, i).some((shorter) => p === shorter || p.startsWith(`${shorter}/`)),
  );
}

/**
 * The setup can be completed once an administrator can read a synced page
 */
import { Injectable } from '@nestjs/common';
import { QueryTypes, Sequelize } from 'sequelize';

import { Principal } from '../../common/principals';
import { toPgTextArray } from '../../db/pg-array';
import { getSequelize } from '../../db/sequelize';
import { authorizedSql } from '../filter';

@Injectable()
export class SetupReachRepository {
  constructor(private readonly sequelize: Sequelize = getSequelize()) {}

  /** Whether the principals can read any page of the tenant */
  async readsAnyPage(tenantId: string, principals: Principal[]): Promise<boolean> {
    if (principals.length === 0) return false;
    const [row] = await this.sequelize.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM documents d WHERE d.tenant_id = :tenantId AND ${authorizedSql('d')}
       ) AS found`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, principals: toPgTextArray(principals) },
      },
    );
    return row?.found === true;
  }

  /** The repositories of the tenant the principals can read a page of, e.g. `acme/handbook` */
  async readableRepositories(tenantId: string, principals: Principal[]): Promise<string[]> {
    if (principals.length === 0) return [];
    const rows = await this.sequelize.query<{ name: string }>(
      `SELECT DISTINCT d.repo_namespace || '/' || d.repo_slug AS name
         FROM documents d
        WHERE d.tenant_id = :tenantId AND ${authorizedSql('d')}`,
      {
        type: QueryTypes.SELECT,
        replacements: { tenantId, principals: toPgTextArray(principals) },
      },
    );
    return rows.map((row) => row.name);
  }
}

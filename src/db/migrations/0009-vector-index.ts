import { QueryInterface } from 'sequelize';

// In prior versions, we built an ANN index on the chunks table. This was not used by the search query,
// and it tied the migration to the config and the app to DDL rights.
// mutation 0015 removes it from instances that ran this step

export async function up(_args: { context: QueryInterface }): Promise<void> {}

export async function down(_args: { context: QueryInterface }): Promise<void> {}

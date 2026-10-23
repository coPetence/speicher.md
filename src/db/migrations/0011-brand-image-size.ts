import { QueryInterface } from 'sequelize';

export async function up({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`ALTER TABLE brand_images DROP CONSTRAINT brand_images_bytes_bounded`);
  await q.query(`
    ALTER TABLE brand_images ADD CONSTRAINT brand_images_bytes_bounded CHECK (
      octet_length(bytes) > 0 AND octet_length(bytes) <= 5242880
    )
  `);
}

export async function down({ context }: { context: QueryInterface }): Promise<void> {
  const q = context.sequelize;
  await q.query(`ALTER TABLE brand_images DROP CONSTRAINT brand_images_bytes_bounded`);
  await q.query(`
    ALTER TABLE brand_images ADD CONSTRAINT brand_images_bytes_bounded CHECK (
      octet_length(bytes) > 0 AND octet_length(bytes) <= 1048576
    )
  `);
}

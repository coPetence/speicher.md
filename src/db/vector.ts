/**
 * Sequelize data type for pgvector vectors
 *
 * Registered as `VECTOR` so migrations can use `DataTypes.VECTOR`
 * The postgres column type is `vector`, a pgvector extension type that stores
 * fixed-dimension float arrays for similarity search
 *
 * Not re-exporting `DataTypes` from this module because it already exists at
 * `sequelize` root and the datatype is registered side-effectfully at import
 */
import { AbstractDataType, DataTypes } from 'sequelize';

const AbstractDataTypeClass = (
  DataTypes.ABSTRACT as unknown as { prototype: { constructor: new () => AbstractDataType } }
).prototype.constructor;

class VECTOR extends AbstractDataTypeClass {
  toSql(): string {
    return 'vector';
  }

  validate(value: unknown): boolean {
    assertVector(value);
    return true;
  }

  _stringify(value: number[]): string {
    return `'${toVectorLiteral(value)}'::vector`;
  }

  _bindParam(value: number[], options: { bindParam: (value: unknown) => string }): string {
    return `${options.bindParam(toVectorLiteral(value))}::vector`;
  }
}

(VECTOR.prototype as unknown as { escape: boolean }).escape = false;
(VECTOR.prototype as unknown as { key: string }).key = 'VECTOR';
(VECTOR as unknown as { key: string }).key = 'VECTOR';

export const Vector = VECTOR;

export function toVectorLiteral(values: readonly number[]): string {
  assertVector(values);
  return `[${values.join(',')}]`;
}

export function parseVector(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (isVector(value)) return value;
  if (typeof value !== 'string') return null;
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner.trim() === '') return [];
  return inner.split(',').map((n) => Number(n));
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function assertVector(value: unknown): asserts value is number[] {
  if (!isVector(value)) {
    throw new Error(`${JSON.stringify(value)} is not a valid vector`);
  }
}

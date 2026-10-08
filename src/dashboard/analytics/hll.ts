/**
 * HyperLogLog distinct-count estimation
 *
 * Uses 256 registers (8-bit precision) and SHA-256 hashing with caller-salted
 * inputs so multiple users can share one sketch without cross-user linkability
 */

import { createHash, randomBytes } from 'node:crypto';

export const HLL_REGISTERS = 256;

const PRECISION = 8;

const ALPHA = 0.7213 / (1 + 1.079 / HLL_REGISTERS);

export function emptySketch(): Buffer {
  return Buffer.alloc(HLL_REGISTERS, 0);
}

export function newSalt(): Buffer {
  return randomBytes(32);
}

export function addToSketch(sketch: Buffer, salt: Buffer, member: string): void {
  const digest = createHash('sha256').update(salt).update(member, 'utf8').digest();
  const hi = digest.readUInt32BE(0);
  const lo = digest.readUInt32BE(4);

  const index = hi >>> (32 - PRECISION);

  // Count leading zeros in the remaining bits, crossing into the low word if
  // the high word's tail is zero. 57 is the maximum possible rank (32 + 25)
  const tail = (hi << PRECISION) >>> 0;
  const rank =
    tail !== 0 ? Math.clz32(tail) + 1 : lo !== 0 ? 32 - PRECISION + Math.clz32(lo) + 1 : 57;

  if (rank > sketch[index]) sketch[index] = rank;
}

export function unionSketch(a: Buffer | null | undefined, b: Buffer | null | undefined): Buffer {
  const out = emptySketch();
  for (const source of [a, b]) {
    if (!source || source.length !== HLL_REGISTERS) continue;
    for (let i = 0; i < HLL_REGISTERS; i += 1) {
      if (source[i] > out[i]) out[i] = source[i];
    }
  }
  return out;
}

export function estimateSketch(sketch: Buffer | null | undefined): number {
  if (!sketch || sketch.length !== HLL_REGISTERS) return 0;

  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < HLL_REGISTERS; i += 1) {
    sum += 2 ** -sketch[i];
    if (sketch[i] === 0) zeros += 1;
  }

  if (zeros === HLL_REGISTERS) return 0;

  // Linear-counting bias correction for small cardinalities
  const raw = (ALPHA * HLL_REGISTERS * HLL_REGISTERS) / sum;
  if (raw <= 2.5 * HLL_REGISTERS && zeros > 0) {
    return Math.round(HLL_REGISTERS * Math.log(HLL_REGISTERS / zeros));
  }
  return Math.round(raw);
}

/**
 * Document text chunking
 *
 * Splits plain text into overlapping chunks for embedding and storage
 * Chunks respect paragraph, sentence, then character boundaries
 * Consecutive chunks overlap to preserve context across boundaries
 */

import { createHash } from 'node:crypto';

/** Target size for each chunk in characters */
export const CHUNK_TARGET_CHARS = 1200;

/** Overlap between consecutive chunks */
export const CHUNK_OVERLAP_CHARS = 200;

/** Minimum size for the final chunk; a trailing scrap under this is folded into the prior */
export const CHUNK_MIN_CHARS = 200;

/** A segment of the document after chunking */
export interface DocumentChunk {
  ord: number; // Zero-based position within the document
  text: string; // Chunk content
  contentHash: string; // SHA-256 hex of text, for change detection
}

/**
 * Split plain text into overlapping chunks for embedding
 *
 * Folds a trailing scrap under CHUNK_MIN_CHARS into the prior:
 * a very short final chunk adds no useful signal
 */
export function chunkDocument(plain: string): DocumentChunk[] {
  const blocks = splitBlocks(plain);
  if (blocks.length === 0) return [];

  const packed: string[] = [];
  let current = '';

  for (const block of blocks) {
    for (const piece of block.length > CHUNK_TARGET_CHARS ? splitLongBlock(block) : [block]) {
      const candidate = current === '' ? piece : `${current}\n${piece}`;
      if (candidate.length <= CHUNK_TARGET_CHARS || current === '') {
        current = candidate;
        continue;
      }
      packed.push(current);

      current = joinWithOverlap(tailOf(current), piece);
    }
  }
  if (current !== '') packed.push(current);

  if (packed.length > 1 && (packed[packed.length - 1] as string).length < CHUNK_MIN_CHARS) {
    const scrap = packed.pop() as string;
    packed[packed.length - 1] = `${packed[packed.length - 1]}\n${scrap}`;
  }

  return packed.map((text, ord) => ({ ord, text, contentHash: hashChunk(text) }));
}

/** SHA-256 hex digest of chunk text, for change detection */
export function hashChunk(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Split plain text into non-empty trimmed lines */
function splitBlocks(plain: string): string[] {
  return plain
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Split a block at sentence boundaries */
function splitLongBlock(block: string): string[] {
  const sentences = block.match(/[^.!?]+[.!?]*\s*/g) ?? [block];
  const out: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    for (const piece of sentence.length > CHUNK_TARGET_CHARS ? hardCut(sentence) : [sentence]) {
      if (current !== '' && current.length + piece.length > CHUNK_TARGET_CHARS) {
        out.push(current.trim());
        current = '';
      }
      current += piece;
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** Fallback split at target character length */
function hardCut(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_TARGET_CHARS) {
    out.push(text.slice(i, i + CHUNK_TARGET_CHARS));
  }
  return out;
}

/**
 * Tail of a chunk for overlap, trimmed to word boundary
 *
 * Not a fixed-length slice to avoid splitting a word in half
 */
function tailOf(chunk: string): string {
  if (chunk.length <= CHUNK_OVERLAP_CHARS) return chunk;
  const tail = chunk.slice(chunk.length - CHUNK_OVERLAP_CHARS);

  const boundary = tail.search(/\s/);
  return boundary === -1 ? tail : tail.slice(boundary + 1);
}

/** Prepend overlap to piece if it fits within the target */
function joinWithOverlap(overlap: string, piece: string): string {
  if (overlap === '' || overlap.length + piece.length + 1 > CHUNK_TARGET_CHARS) return piece;
  return `${overlap}\n${piece}`;
}

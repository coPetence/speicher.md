import {
  CHUNK_MIN_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkDocument,
  hashChunk,
} from '../../src/ingest/chunk';

describe('chunkDocument', () => {
  const paragraph = (word: string, times: number) => `${word} `.repeat(times).trim();

  it('leaves a short page as one chunk', () => {
    const chunks = chunkDocument('A title\nOne short paragraph.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('One short paragraph.');
    expect(chunks[0].ord).toBe(0);
  });

  it('has nothing to say about an empty page', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('\n\n  \n')).toEqual([]);
  });

  it('packs blocks up to the budget and overlaps them', () => {
    const blocks = Array.from({ length: 6 }, (_, i) => `${i} ${paragraph('lorem', 80)}`);
    const chunks = chunkDocument(blocks.join('\n'));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    }
    for (const block of blocks) {
      expect(chunks.some((c) => c.text.includes(block))).toBe(true);
    }
    const overlap = chunks[1].text.split('\n')[0];
    expect(overlap.length).toBeGreaterThan(CHUNK_OVERLAP_CHARS / 2);
    expect(chunks[0].text.endsWith(overlap)).toBe(true);
  });

  it('cuts a single block that is longer than the whole budget', () => {
    const chunks = chunkDocument('x'.repeat(CHUNK_TARGET_CHARS * 3));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
  });

  it('folds a trailing scrap into the chunk before it', () => {
    const chunks = chunkDocument(`${paragraph('lorem', 300)}\nSee also`);
    expect(chunks[chunks.length - 1].text).toContain('See also');
    expect(chunks[chunks.length - 1].text.length).toBeGreaterThanOrEqual(CHUNK_MIN_CHARS);
  });

  it('numbers chunks from zero, in reading order, and hashes the text alone', () => {
    const chunks = chunkDocument(
      Array.from({ length: 6 }, () => paragraph('lorem', 80)).join('\n'),
    );
    expect(chunks.map((c) => c.ord)).toEqual(chunks.map((_, i) => i));
    for (const chunk of chunks) expect(chunk.contentHash).toBe(hashChunk(chunk.text));
  });
});

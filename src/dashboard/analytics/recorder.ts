/**
 * In-memory buffer for page view and missed-query events
 *
 * View counts and reader sketches are accumulated per bucket (day or hour) per path
 * Miss counts are accumulated per normalised query per day
 *
 * Both data sets are drained periodically by the caller, which writes them to the DB
 * The bucket limit avoids unbounded memory when the writer is offline
 */

import { Granularity, bucketStart } from './buckets';
import { addToSketch, emptySketch, newSalt, unionSketch } from './hll';

export type Surface = 'web' | 'mcp';

export interface ViewKey {
  repoId: string;
  slugPath: string;
  surface: Surface;
}

export interface BufferedView {
  repoId: string;
  slugPath: string;
  bucket: Date;
  granularity: Granularity;
  surface: Surface;
  views: number;

  readers: Buffer | null;
}

export interface BufferedMiss {
  query: string;
  bucket: Date;
  misses: number;
}

export const MAX_BUCKETS = 20_000;

const SALT_RETENTION = 3;

interface Entry {
  repoId: string;
  slugPath: string;
  bucket: Date;
  granularity: Granularity;
  surface: Surface;
  views: number;
  readers: Buffer | null;
}

export class ViewBuffer {
  private entries = new Map<string, Entry>();
  private misses = new Map<string, BufferedMiss>();

  private salts = new Map<string, Buffer>();

  private dropped = 0;

  // Returns or creates a per-bucket salt for the HLL sketch
  // Retains only the SALT_RETENTION most recent salts to bound memory
  private saltFor(bucketKey: string): Buffer {
    let salt = this.salts.get(bucketKey);
    if (!salt) {
      salt = newSalt();
      this.salts.set(bucketKey, salt);

      if (this.salts.size > SALT_RETENTION) {
        const oldest = this.salts.keys().next().value;
        if (oldest !== undefined) this.salts.delete(oldest);
      }
    }
    return salt;
  }

  record(
    key: ViewKey,
    at: Date,
    timeZone: string,
    granularity: Granularity,
    subject: string | null,
  ): void {
    this.add(key, bucketStart(at, timeZone, 'day'), 'day', subject);
    if (granularity === 'hour') {
      // When the requested granularity is hourly, also record a day-level entry so
      // daily rollups have data without re-hashing hour buckets
      this.add(key, bucketStart(at, timeZone, 'hour'), 'hour', null);
    }
  }

  private add(key: ViewKey, bucket: Date, granularity: Granularity, subject: string | null): void {
    const bucketKey = bucket.toISOString();
    const id = [key.repoId, key.slugPath, bucketKey, granularity, key.surface].join(' ');
    let entry = this.entries.get(id);
    if (!entry) {
      if (this.entries.size >= MAX_BUCKETS) {
        this.dropped += 1;
        return;
      }
      entry = {
        repoId: key.repoId,
        slugPath: key.slugPath,
        bucket,
        granularity,
        surface: key.surface,
        views: 0,
        readers: null,
      };
      this.entries.set(id, entry);
    }
    entry.views += 1;
    if (subject !== null) {
      if (!entry.readers) entry.readers = emptySketch();
      addToSketch(entry.readers, this.saltFor(bucketKey), subject);
    }
  }

  recordMiss(query: string, at: Date, timeZone: string): void {
    const normalised = query.trim().toLowerCase();
    if (!normalised) return;
    const bucket = bucketStart(at, timeZone, 'day');
    const id = `${normalised} ${bucket.toISOString()}`;
    const existing = this.misses.get(id);
    if (existing) {
      existing.misses += 1;
      return;
    }
    if (this.misses.size >= MAX_BUCKETS) {
      this.dropped += 1;
      return;
    }
    this.misses.set(id, { query: normalised, bucket, misses: 1 });
  }

  get size(): number {
    return this.entries.size + this.misses.size;
  }

  drain(): { views: BufferedView[]; misses: BufferedMiss[]; dropped: number } {
    const views = [...this.entries.values()].map((entry) => ({
      ...entry,
      readers: entry.readers ? unionSketch(entry.readers, null) : null,
    }));
    const misses = [...this.misses.values()];
    const dropped = this.dropped;
    this.entries = new Map();
    this.misses = new Map();
    this.dropped = 0;
    return { views, misses, dropped };
  }
}

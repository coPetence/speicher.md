/**
 * Tenant resolution for multi-tenant support
 *
 * Currently single-tenant: every request resolves to the default tenant
 * The service caches the default tenant row after first fetch
 */
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { Tenant, initModels } from './models';

@Injectable()
export class TenancyService {
  private cached: { id: string; slug: string } | null = null;

  /**
   * Fetch or return cached default tenant row
   *
   * Throws if no `default` slug exists: migration 0002-tenants-and-forges creates it
   */
  async defaultTenant(): Promise<{ id: string; slug: string }> {
    if (this.cached) return this.cached;
    initModels(); // Ensures models are initialised; returns instantly if so
    const row = await Tenant.findOne({ where: { slug: 'default' } });
    if (!row) {
      throw new Error(
        'no `default` tenant row — migration 0002-tenants-and-forges creates it; the database is not migrated',
      );
    }
    this.cached = { id: row.id, slug: row.slug };
    return this.cached;
  }

  /**
   * Resolve tenant for an incoming request
   *
   * Currently always returns the default tenant
   */
  async resolveTenant(_req?: Request): Promise<{ id: string; slug: string }> {
    return this.defaultTenant();
  }

  /** Clear the cached tenant, forcing a fresh lookup on next call */
  reset(): void {
    this.cached = null;
  }
}

export const tenancy = new TenancyService();

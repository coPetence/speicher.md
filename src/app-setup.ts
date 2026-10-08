/**
 * Express middleware pipeline for the Nest app
 *
 * Configures trust proxy, global error filter, compression, cookie parsing,
 * and request identification
 */

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';

import { UnhandledErrorFilter } from './app-errors';
import { env } from './common/env';
import { runWithLogContext } from './common/logger';
import { ConfigService } from './config/config.service';

export function configureApp(app: INestApplication): void {
  const express = app.getHttpAdapter().getInstance() as {
    set(key: string, value: unknown): void;
  };
  express.set('trust proxy', env('SPEICHER_TRUST_PROXY'));

  app.useGlobalFilters(new UnhandledErrorFilter(app.get(ConfigService)));
  app.use(compression({ filter: shouldCompress }));
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    runWithLogContext({ request_id: requestId }, next);
  });
}

/**
 * Skips compression for responses that reflect caller input (BREACH oracle)
 * and when x-no-compression header is set
 */

export function shouldCompress(req: Request, res: Response): boolean {
  if (reflectsCallerInput(req)) return false;

  if (req.headers['x-no-compression']) return false;

  return compression.filter(req, res);
}

/**
 * True when the request carries caller-supplied content
 *
 * Query params or a non-GET/HEAD body can make the response reflect
 * attacker-controlled text, which turns compression into a BREACH oracle
 */

export function reflectsCallerInput(req: Request): boolean {
  if (req.query && Object.keys(req.query).length > 0) return true;
  return req.method !== 'GET' && req.method !== 'HEAD';
}

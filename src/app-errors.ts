/**
 * Express error handler and NestJS exception filter
 *
 * Client errors (4xx) end the response without logging
 * Server errors (5xx) are logged, and the response carries a request_id in JSON or the
 *  server error page
 * An already-sent response is ended immediately, no body written
 *
 * 404 is special: it returns the frontend index to let client-side routing handle it
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { ErrorRequestHandler, Request, Response } from 'express';

import { wantsJson } from './dashboard/respond';
import { rootLogger } from './common/logger';
import { ConfigService } from './config/config.service';
import type { ChromeConfig } from './content-reader/chrome';
import { sendNotFound } from './global-ui/global-views/not-found/not-found';
import { sendServerError } from './global-ui/global-views/server-error/server-error';

const log = rootLogger.child('http');

function statusOf(exception: unknown): number {
  if (exception instanceof HttpException) return exception.getStatus();
  const carried = (exception as { statusCode?: unknown } | null)?.statusCode;
  if (typeof carried === 'number' && carried >= 400 && carried < 500) return carried;
  return 500;
}

/**
 * Write a failure response, logging server errors
 *
 * Not an Express error handler: some callers pass a raw exception, not the
 *  four-argument signature
 */
export function respondToFailure(
  config: ChromeConfig,
  exception: unknown,
  req: Request,
  res: Response,
): void {
  const status = statusOf(exception);
  const requestId = req.requestId ?? null;

  if (status < 500) {
    if (res.headersSent) {
      res.end();
      return;
    }

    if (status === 404) {
      sendNotFound(req, res, config);
      return;
    }

    res.status(status).end();
    return;
  }

  const error = exception instanceof Error ? exception : new Error(String(exception));
  log.error('request failed', {
    method: req.method,
    path: req.path,
    status,
    error: error.message,
    stack: error.stack,
  });

  if (res.headersSent) {
    // Headers already flushed – cannot write anything meaningful
    res.end();
    return;
  }

  try {
    if (wantsJson(req)) {
      res.setHeader('Vary', 'Accept');
      res.setHeader('Cache-Control', 'private, no-store');

      res.status(500).json({ error: 'internal', request_id: requestId });
      return;
    }
    sendServerError(req, res, config, requestId);
  } catch (renderFailure) {
    // sendServerError calls res.render which can throw on a malformed template
    log.error('the error page could not be rendered', {
      error: (renderFailure as Error).message,
    });
    if (!res.headersSent) res.status(500).type('text/plain').send('Internal error.\n');
  }
}

@Catch()
export class UnhandledErrorFilter implements ExceptionFilter {
  constructor(private readonly config: ChromeConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    respondToFailure(
      this.config,
      exception,
      http.getRequest<Request>(),
      http.getResponse<Response>(),
    );
  }
}

/**
 * Install the Express error handler for the outer NestJS app
 *
 * NestJS's exception filter covers only routed requests; middleware errors (e.g. JSON
 *  body parse failures) need a plain Express handler
 */
export function installErrorHandler(app: INestApplication): void {
  const config = app.get(ConfigService);
  const handler: ErrorRequestHandler = (err, req, res, _next) => {
    respondToFailure(config, err, req, res);
  };
  app.getHttpAdapter().getInstance().use(handler);
}

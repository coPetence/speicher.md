import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';

import { LogFields, Logger } from '../common/logger';
import { WebhookVerification } from './driver';

export type DeliveryHeaders = Record<string, string | string[] | undefined>;

export interface SignedDelivery {
  verification: WebhookVerification;
  payload: Record<string, unknown>;
}

export function readSignedDelivery(
  req: RawBodyRequest<Request>,
  res: Response,
  headers: DeliveryHeaders,
  verify: (headers: DeliveryHeaders, rawBody: Buffer) => WebhookVerification,
  log: Logger,
  context: LogFields,
): SignedDelivery | null {
  if (!req.rawBody) {
    log.error('raw body is unavailable; signature cannot be verified', context);
    res.status(400).end();
    return null;
  }

  const verification = verify(headers, req.rawBody);
  if (!verification.valid) {
    log.warn('rejected an unsigned or mis-signed delivery', {
      ...context,
      event: verification.event,
    });
    res.status(401).end();
    return null;
  }

  try {
    return { verification, payload: JSON.parse(req.rawBody.toString('utf8')) };
  } catch {
    log.warn('delivery body is not JSON', { ...context, delivery_id: verification.deliveryId });
    res.status(400).end();
    return null;
  }
}

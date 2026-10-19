import { rootLogger } from '../../src/common/logger';
import type { WebhookVerification } from '../../src/forge/driver';
import { readSignedDelivery } from '../../src/forge/signed-delivery';

function read(rawBody: Buffer | undefined, valid = true) {
  let status = 0;
  const res = {
    status: (code: number) => {
      status = code;
      return { end: () => undefined };
    },
  };
  const verify = (): WebhookVerification => ({ valid, deliveryId: 'd-1', event: 'push' });
  const delivery = readSignedDelivery(
    { rawBody } as never,
    res as never,
    {},
    verify,
    rootLogger.child('test'),
    { forge: 'gh' },
  );
  return { delivery, status };
}

describe('a signed delivery', () => {
  it('is read when its signature holds and its body is JSON', () => {
    const { delivery, status } = read(Buffer.from('{"ref":"main"}'));
    expect(status).toBe(0);
    expect(delivery?.payload).toEqual({ ref: 'main' });
    expect(delivery?.verification.event).toBe('push');
  });

  it('is refused when its signature does not hold', () => {
    expect(read(Buffer.from('{}'), false)).toEqual({ delivery: null, status: 401 });
  });

  it('is refused when its body is not JSON', () => {
    expect(read(Buffer.from('not json'))).toEqual({ delivery: null, status: 400 });
  });

  it('is refused when the raw body is missing, since nothing can be verified', () => {
    expect(read(undefined)).toEqual({ delivery: null, status: 400 });
  });
});

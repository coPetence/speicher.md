import {
  addLogContext,
  currentLogContext,
  rootLogger,
  runWithLogContext,
} from '../../src/common/logger';

let written: string[];
let spy: jest.SpyInstance;

beforeEach(() => {
  written = [];
  spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => spy.mockRestore());

function lines(): Array<Record<string, unknown>> {
  return written.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the ambient log context', () => {
  it('stamps every line written under it, including from a logger built before it', () => {
    const log = rootLogger.child('somewhere-deep');

    runWithLogContext({ request_id: 'r-1', tenant_id: 't-1' }, () => {
      log.error('it broke');
    });

    expect(lines()[0]).toMatchObject({
      ctx: 'somewhere-deep',
      msg: 'it broke',
      request_id: 'r-1',
      tenant_id: 't-1',
    });
  });

  it('survives an await, which is the only reason it is worth having', async () => {
    await runWithLogContext({ request_id: 'r-2' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      rootLogger.error('after the await');
    });

    expect(lines()[0]).toMatchObject({ request_id: 'r-2' });
  });

  it('takes a field added part-way through, because the tenant arrives late', () => {
    runWithLogContext({ request_id: 'r-3' }, () => {
      rootLogger.error('before');
      addLogContext({ tenant_id: 't-3' });
      rootLogger.error('after');
    });

    expect(lines()[0]).toMatchObject({ request_id: 'r-3' });
    expect(lines()[0].tenant_id).toBeUndefined();
    expect(lines()[1]).toMatchObject({ request_id: 'r-3', tenant_id: 't-3' });
  });

  it('lets the call site win, since it is closer to the truth about its own fields', () => {
    runWithLogContext({ tenant_id: 't-4' }, () => {
      rootLogger.error('a job for somebody else', { tenant_id: 't-other' });
    });

    expect(lines()[0]).toMatchObject({ tenant_id: 't-other' });
  });

  it('writes nothing extra outside a context, rather than throwing', () => {
    addLogContext({ tenant_id: 'nowhere' });
    rootLogger.error('the process itself');

    expect(currentLogContext()).toEqual({});
    expect(lines()[0].tenant_id).toBeUndefined();
  });

  it('does not leak out of the context it was entered for', () => {
    runWithLogContext({ request_id: 'r-5' }, () => undefined);
    rootLogger.error('afterwards');

    expect(lines()[0].request_id).toBeUndefined();
  });

  it('is still redacted — an ambient field is not a privileged one', () => {
    runWithLogContext({ api_key: 'sk-live-1234', actor: 'user:alice@example.test' }, () => {
      rootLogger.error('with something it should not have');
    });

    expect(lines()[0]).toMatchObject({ api_key: '[redacted]', actor: '[principal]' });
  });
});

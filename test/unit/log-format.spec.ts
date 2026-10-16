import { rootLogger, runWithLogContext } from '../../src/common/logger';

let written: string[];
let spy: jest.SpyInstance;
let before: string | undefined;

beforeEach(() => {
  written = [];
  spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  before = process.env.SPEICHER_LOG_FORMAT;
});

afterEach(() => {
  spy.mockRestore();
  if (before === undefined) delete process.env.SPEICHER_LOG_FORMAT;
  else process.env.SPEICHER_LOG_FORMAT = before;
});

describe('the pretty log format', () => {
  it('writes time, level and context, then the message, then one line per field', () => {
    process.env.SPEICHER_LOG_FORMAT = 'pretty';

    runWithLogContext({ job_kind: 'embed' }, () => {
      rootLogger.child('worker').error('job failed', { attempts: 2, error: 'boom, it broke' });
    });

    expect(written[0]).toMatch(/^\d\d:\d\d:\d\d ERROR worker\n/);
    expect(written[0].split('\n').slice(1)).toEqual([
      '  job failed',
      '    job_kind: embed',
      '    attempts: 2',
      '    error: boom, it broke',
      '',
    ]);
  });

  it('writes a list below its key, one item per line, without escaping', () => {
    process.env.SPEICHER_LOG_FORMAT = 'pretty';

    rootLogger.child('config').error('booted on an older version', {
      running: 8,
      skipped: ['v23: unknown key "name_align"', 'v22: unknown key "name_align"'],
    });

    expect(written[0].split('\n').slice(1)).toEqual([
      '  booted on an older version',
      '    running: 8',
      '    skipped:',
      '      - v23: unknown key "name_align"',
      '      - v22: unknown key "name_align"',
      '',
    ]);
  });

  it('still redacts secrets', () => {
    process.env.SPEICHER_LOG_FORMAT = 'pretty';

    rootLogger.error('signed in', { api_key: 'sk-123' });

    expect(written[0]).toContain('api_key: [redacted]');
    expect(written[0]).not.toContain('sk-123');
  });

  it('falls back to JSON for a value it does not know', () => {
    process.env.SPEICHER_LOG_FORMAT = 'fancy';

    rootLogger.error('it broke');

    expect(JSON.parse(written[0])).toMatchObject({ level: 'error', msg: 'it broke' });
  });
});

import { RunRow } from '../../src/dashboard/dashboard.repository';
import { runView } from '../../src/dashboard/ui/views/sync-status/run-status/run-status';

function run(severities: string[]): RunRow {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    sha: null,
    trigger: 'manual',
    started_at: new Date(),
    finished_at: null,
    status: 'ok',
    stats: null,
    findings: severities.map((severity) => ({
      severity,
      code: 'x',
      source: '.speicher.yaml',
      message: 'm',
    })),
  };
}

describe("a run's worst finding", () => {
  it('is the most escalated, wherever in the list it falls', () => {
    // Order of arrival is not order of escalation: the reject is in the middle
    expect(runView('ns', 'repo', run(['info', 'reject', 'warn'])).worst?.severity).toBe('reject');
    expect(runView('ns', 'repo', run(['info', 'warn', 'info'])).worst?.severity).toBe('warn');
    expect(runView('ns', 'repo', run(['info'])).worst?.severity).toBe('info');
  });

  it('is drawn with its own mark and level', () => {
    const worst = runView('ns', 'repo', run(['warn', 'reject'])).worst;
    expect(worst?.level).toBe('fail');
    expect(worst?.iconHtml).toContain('<svg');
  });

  it('is nothing for a run with no findings, so the cell draws no mark', () => {
    expect(runView('ns', 'repo', run([])).worst).toBeNull();
  });
});

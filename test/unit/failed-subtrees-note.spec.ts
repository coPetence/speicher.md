import { failedSubtreesNote } from '../../src/dashboard/ui/views/sync-status/run-status/run-status';

describe('the note on a run that left part of a repository unpublished', () => {
  it('is not there when the run published everything', () => {
    expect(failedSubtreesNote([], 12, true)).toBeNull();
  });

  it('says the whole commit was held back, and that the last good version still shows', () => {
    const note = failedSubtreesNote([''], 12, true);

    expect(note?.text).toBe(
      'None of the changes in this commit were published, because of the problems listed under Findings. Readers still see the pages from the last successful sync.',
    );
  });

  it('says nothing is published when no earlier sync left anything to show', () => {
    const note = failedSubtreesNote([''], 0, true);

    expect(note?.text).toContain('Nothing from this repository is published yet');
    expect(note?.text).toContain('there is no previous version');
  });

  it('names the page paths that were not updated, escaped', () => {
    const note = failedSubtreesNote(['commercial', 'docs/<b>'], 12, true);

    expect(note?.html).toBe(
      'The pages under <code>commercial</code> and <code>docs/&lt;b&gt;</code> were not updated, because of the problems listed under Findings. Readers still see what was published there before.',
    );
  });

  it('points a maintainer, who sees no findings, to the commit instead', () => {
    const note = failedSubtreesNote(['commercial'], 12, false);

    expect(note?.html).toContain('because of problems in this commit');
    expect(note?.html).not.toContain('Findings');
  });
});

import {
  problemSummary,
  problemsOf,
} from '../../src/dashboard/ui/views/sync-status/status-overview/status-overview';

describe('a failed sync’s error, on the status page', () => {
  it('is split into one problem per line, each with where it is', () => {
    const problems = problemsOf(
      '.speicher.yaml:5  unknown group "everyone"\n.speicher.yaml:10  unknown group "everyone"',
    );

    expect(problems).toEqual([
      { location: '.speicher.yaml:5', message: 'unknown group "everyone"' },
      { location: '.speicher.yaml:10', message: 'unknown group "everyone"' },
    ]);
    expect(problemSummary(problems)).toBe('2 problems in .speicher.yaml');
  });

  it('counts the files when the problems are in more than one', () => {
    const problems = problemsOf('.speicher.yaml:5  one\ndocs/.speicher.yaml:2  two');

    expect(problemSummary(problems)).toBe('2 problems in 2 files');
  });

  it('keeps an error of another shape whole, since its lines belong together', () => {
    const error =
      "git rev-parse failed: Command failed: git rev-parse refs/heads/main\nfatal: ambiguous argument 'refs/heads/main'";

    expect(problemsOf(error)).toEqual([{ location: null, message: error }]);
    expect(problemSummary(problemsOf(error))).toBe('1 problem');
  });
});

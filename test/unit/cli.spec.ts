import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { commandUsage, runCli, usage } from '../../src/cli/cli';
import { UsageError } from '../../src/cli/command-types';
import { codedErrorOf } from '../helpers/refuse-with';
import { COMMANDS } from '../../src/cli/commands';
import { parseAdmin } from '../../src/cli/commands/admin';
import { parseClaim } from '../../src/cli/commands/claim';
import { parseConfig } from '../../src/cli/commands/config';
import { parseJobs } from '../../src/cli/commands/jobs';
import { parseMigrate } from '../../src/cli/commands/migrate';
import { parseRebuild } from '../../src/cli/commands/rebuild';
import { parseReembed } from '../../src/cli/commands/reembed';
import { parseReopenClaimWindow } from '../../src/cli/commands/reopen-claim-window';
import { parseSyncRepoContent } from '../../src/cli/commands/sync-repo-content';
import { parseSyncRepoList } from '../../src/cli/commands/sync-repo-list';
import { normalizeClaimCode } from '../../src/dashboard/setup/claim-code';

const ROOT = resolve(__dirname, '../..');
const WRAPPER = join(ROOT, 'bin', 'speicher');

describe('what the CLI refuses before it connects', () => {
  it('takes --purge and refuses anything it does not know', () => {
    expect(parseRebuild([])).toEqual({ purgeFirst: false });
    expect(parseRebuild(['--purge'])).toEqual({ purgeFirst: true });
    expect(() => parseRebuild(['--purgue'])).toThrow(UsageError);
    expect(() => parseRebuild(['--purge', 'everything'])).toFailWith('usage.unknown-argument', {
      argument: 'everything',
    });
  });

  it('defaults migrate to up, and refuses an action it cannot perform', () => {
    expect(parseMigrate([])).toBe('up');
    expect(parseMigrate(['status'])).toBe('status');
    expect(() => parseMigrate(['sideways'])).toFailWith('usage.unknown-action', {
      argument: 'sideways',
    });
    expect(() => parseMigrate(['up', 'down'])).toThrow(UsageError);
  });

  it('gives reembed no arguments to mistype', () => {
    expect(() => parseReembed([])).not.toThrow();
    expect(() => parseReembed(['--all'])).toThrow(UsageError);
  });

  it('lists claims rather than guessing which one was meant', () => {
    expect(parseClaim([])).toEqual({ code: null });
    expect(parseClaim(['quiet-heron-4471'])).toEqual({ code: 'QUIET-HERON-4471' });
    expect(parseClaim([' QUIET-HERON-4471 '])).toEqual({ code: 'QUIET-HERON-4471' });
    expect(() => parseClaim(['QUIET-HERON-4471', 'and-this'])).toThrow(UsageError);
  });

  it('tells a code that could not exist from one that merely does not', () => {
    expect(() => parseClaim(['sudo'])).toFailWith('usage.invalid-value', { argument: 'sudo' });
    expect(normalizeClaimCode('QUIET-HERON-44')).toBeNull();
    expect(normalizeClaimCode('QUIET-HERON-4471')).toBe('QUIET-HERON-4471');
  });

  it('makes exporting with credentials a word somebody had to type', () => {
    expect(parseConfig(['export'])).toEqual({ withSecrets: false, path: null });
    expect(parseConfig(['export', '--with-secrets'])).toEqual({ withSecrets: true, path: null });
    expect(() => parseConfig(['export', '--with-secret'])).toFailWith('usage.unknown-argument', {
      argument: '--with-secret',
    });
    expect(() => parseConfig(['export', '-s'])).toThrow(UsageError);
    expect(() => parseConfig([])).toFailWith('usage.unknown-action');
    expect(() => parseConfig(['import'])).toThrow(UsageError);
  });

  it('takes one path to write the export to, in either position beside the option', () => {
    expect(parseConfig(['export', 'config.yaml'])).toEqual({
      withSecrets: false,
      path: 'config.yaml',
    });
    expect(parseConfig(['export', '--with-secrets', 'config.yaml'])).toEqual({
      withSecrets: true,
      path: 'config.yaml',
    });
    expect(() => parseConfig(['export', 'a.yaml', 'b.yaml'])).toFailWith('usage.argument-count');
  });

  it('takes no arguments for reopen-claim-window', () => {
    expect(() => parseReopenClaimWindow([])).not.toThrow();
    expect(() => parseReopenClaimWindow(['reopen'])).toThrow(UsageError);
  });

  it('makes `admin add` name a person exactly one way, with a note if by subject', () => {
    expect(parseAdmin(['add', '--provider', 'entra', '--email', 'x@y.test'])).toEqual({
      provider: 'entra',
      email: 'x@y.test',
    });
    expect(() => parseAdmin(['add', '--subject', 'oid-1'])).toFailWith('usage.missing-option', {
      argument: '--note',
    });
    expect(() =>
      parseAdmin(['add', '--subject', 'oid-1', '--email', 'x@y.test', '--note', 'n']),
    ).toFailWith('usage.conflicting-options');
    expect(() => parseAdmin(['add'])).toFailWith('usage.missing-option');
    expect(() => parseAdmin(['remove', '--subject', 'x'])).toFailWith('usage.unknown-action');
    expect(parseAdmin(['add', '--subject', 'a/b:c d', '--note', 'n']).subject).toBe('a/b:c d');
    expect(() => parseAdmin(['add', '--subject'])).toFailWith('usage.missing-value', {
      argument: '--subject',
    });
    expect(() => parseAdmin(['add', '--admin', 'x'])).toFailWith('usage.unknown-argument', {
      argument: '--admin',
    });
  });
});

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const plain = (text: string): string => text.replace(ANSI, '');

describe('runCli', () => {
  let out: string;
  let err: string;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    out = '';
    err = '';
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('answers help on stdout and no command on stderr, with different codes', async () => {
    expect(await runCli(['help'])).toBe(0);
    expect(plain(out)).toContain('speicher <command>');
    expect(err).toBe('');

    expect(await runCli([])).toBe(2);
    expect(plain(err)).toContain('speicher <command>');
  });

  it('names the command it does not have', async () => {
    expect(await runCli(['rebiuld'])).toBe(2);
    expect(plain(err)).toContain('unknown command "rebiuld"');
  });

  it('refuses a bad argument with 2, which is what proves it never connected', async () => {
    expect(await runCli(['rebuild', '--purgue'])).toBe(2);
    // The parser's own refusal is what the command prints
    expect(err).toContain(codedErrorOf(() => parseRebuild(['--purgue'])).message);
    expect(await runCli(['migrate', 'sideways'])).toBe(2);
    expect(await runCli(['claim', 'sudo rm -rf /'])).toBe(2);
  });

  it('follows a bad argument with that command’s usage, not every command’s', async () => {
    expect(await runCli(['claim', 'QUIET-HERON-4471', 'and-this'])).toBe(2);
    expect(plain(err)).toContain(
      codedErrorOf(() => parseClaim(['QUIET-HERON-4471', 'and-this'])).message,
    );
    const [usageLine] = commandUsage('claim', COMMANDS.claim).split('\n');
    expect(usageLine).toContain('speicher claim');
    expect(plain(err)).toContain(usageLine);
    expect(plain(err)).not.toContain('speicher rebuild');
  });

  it('decorates the help it writes to a terminal, and nothing else', () => {
    const coloured = commandUsage('claim', COMMANDS.claim, { colored: true, width: 80 });
    const bare = commandUsage('claim', COMMANDS.claim);

    expect(coloured).toContain(`${ESC}[`);
    expect(bare).not.toContain(ESC);
    expect(plain(coloured)).toBe(bare);
  });

  it('refuses a jobs argv that could mean two things', () => {
    expect(parseJobs(['list'])).toMatchObject({ action: 'list', limit: 50 });
    expect(parseJobs(['list', '--status', 'dead'])).toMatchObject({ status: 'dead' });
    expect(parseJobs(['retry', '--all'])).toMatchObject({ action: 'retry', all: true });
    expect(parseJobs(['retry', '--kind', 'sync-repo-list'])).toMatchObject({
      kind: 'sync-repo-list',
    });

    expect(() => parseJobs(['retry'])).toThrow(UsageError);
    expect(() => parseJobs(['retry', 'some-id', '--all'])).toFailWith('usage.conflicting-options');
    expect(() => parseJobs(['list', '--kind', 'sync-repo-content'])).toThrow(UsageError);
    expect(() => parseJobs(['retry', '--kind', 'syncc'])).toFailWith('usage.invalid-value', {
      argument: 'syncc',
    });
    expect(() => parseJobs(['list', '--limit', '0'])).toFailWith('usage.invalid-value', {
      argument: '0',
    });
    expect(() => parseJobs(['sideways'])).toThrow(UsageError);
  });

  it('takes one forge for sync-repo-list and one repository for sync-repo-content', () => {
    expect(parseSyncRepoList([])).toEqual({ forgeKey: null });
    expect(parseSyncRepoList(['gh'])).toEqual({ forgeKey: 'gh' });
    expect(() => parseSyncRepoList(['gh', 'gl'])).toThrow(UsageError);
    expect(() => parseSyncRepoList(['--all'])).toFailWith('usage.unknown-argument', {
      argument: '--all',
    });

    expect(parseSyncRepoContent(['copetence/handbook'])).toEqual({
      repo: 'copetence/handbook',
      force: false,
    });
    expect(() => parseSyncRepoContent([])).toThrow(UsageError);
    expect(() => parseSyncRepoContent(['a', 'b'])).toThrow(UsageError);
  });

  it('takes --force for sync-repo-content on either side of the repository', () => {
    const forced = { repo: 'copetence/handbook', force: true };
    expect(parseSyncRepoContent(['copetence/handbook', '--force'])).toEqual(forced);
    expect(parseSyncRepoContent(['--force', 'copetence/handbook'])).toEqual(forced);
    expect(() => parseSyncRepoContent(['--force'])).toThrow(UsageError);
    expect(() => parseSyncRepoContent(['copetence/handbook', '--forse'])).toFailWith(
      'usage.unknown-argument',
      { argument: '--forse' },
    );
    expect(() => parseSyncRepoContent(['--forse', 'copetence/handbook'])).toFailWith(
      'usage.unknown-argument',
      { argument: '--forse' },
    );
  });

  it('lists every command it has, so help cannot describe a surface that left', () => {
    const text = usage().replace(/\s+/g, ' ');
    for (const [name, command] of Object.entries(COMMANDS)) {
      expect(text).toContain(name);
      expect(text).toContain(command.summary);
    }
    expect(Object.keys(COMMANDS)).toEqual(
      expect.arrayContaining([
        'migrate',
        'rebuild',
        'reembed',
        'claim',
        'reopen-claim-window',
        'admin',
        'jobs',
        'sync-repo-list',
        'sync-repo-content',
        'repos',
        'forges',
      ]),
    );
  });

  it('lets only migrate meet a schema that is behind', () => {
    const permissive = Object.entries(COMMANDS)
      .filter(([, command]) => !command.needsCurrentSchema)
      .map(([name]) => name);
    expect(permissive).toEqual(['migrate']);
  });
});

describe('the binary the image puts on PATH', () => {
  const wrapper = readFileSync(WRAPPER, 'utf8');

  function entryPoint(): string {
    const match = wrapper.match(/\$here\/\.\.\/(dist\/[\w./-]+\.js)/);
    expect(match).not.toBeNull();
    return (match as RegExpMatchArray)[1].replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
  }

  it('reads the path off the line that runs it, not the one that mentions it', () => {
    expect(wrapper).toContain('dist/cli/rebuild.js');
    expect(entryPoint()).toBe('src/cli/cli.ts');
  });

  it('is executable in the checkout', () => {
    expect(statSync(WRAPPER).mode & 0o111).not.toBe(0);
    expect(wrapper.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('runs an entrypoint the build actually produces', () => {
    expect(existsSync(join(ROOT, entryPoint()))).toBe(true);
  });

  it('is the same entrypoint the npm script runs, so the two spellings cannot drift', () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const entry = entryPoint();
    expect(scripts.speicher).toContain(entry);
    for (const name of ['migrate', 'rebuild', 'reembed']) {
      expect(scripts[name]).toContain(entry);
    }
  });

  it('is copied into the image and linked onto PATH', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^COPY bin \.\/bin$/m);
    expect(dockerfile).toMatch(/ln -s \/app\/bin\/speicher \/usr\/local\/bin\/speicher/);
    const ignored = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n');
    expect(ignored).not.toContain('bin');
  });
});

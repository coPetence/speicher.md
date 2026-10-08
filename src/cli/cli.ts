/**
 * Entry point of the `speicher` command-line tool.
 */

import 'reflect-metadata';

import { assertKnownEnv } from '../common/env';
import { rootLogger } from '../common/logger';
import { assertSchemaCurrent } from '../db/migrate';
import { initModels } from '../db/models';
import { closeSequelize } from '../db/sequelize';
import { Command } from './command-types';
import { COMMANDS } from './commands';
import { OutputFormat, PLAIN, createOutputFormat, highlight, highlightTitle } from './format';

/** Wraps text at word boundaries to make sure every line is within the available width and starts at `indent` */
function wrap(text: string, indent: number, format: OutputFormat): string {
  const availableWidth = Math.max(format.width - indent, 20);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > availableWidth) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  const padding = ' '.repeat(indent);
  return lines.map((wrapped) => padding + wrapped).join('\n');
}

function invocation(name: string, command: Command): string {
  return `${name} ${command.args}`.trimEnd();
}

export function usage(format: OutputFormat = PLAIN): string {
  const entries = Object.entries(COMMANDS).map(
    ([name, command]) =>
      `  ${highlight(invocation(name, command), format)}\n${wrap(command.summary, 6, format)}\n`,
  );
  return [
    wrap('speicher cli is a tool for managing a Speicher instance', 0, format),
    '',
    `${highlightTitle('Usage:', format)} speicher <command> [options]`,
    '',
    highlightTitle('Commands:', format),
    ...entries,
  ].join('\n');
}

export function commandUsage(name: string, command: Command, format: OutputFormat = PLAIN): string {
  return [
    `${highlightTitle('Usage:', format)} speicher ${highlight(invocation(name, command), format)}`,
    '',
    wrap(command.summary, 0, format),
    '',
    'Run `speicher help` to list every command.',
    '',
  ].join('\n');
}

export async function runCli(argv: string[]): Promise<number> {
  const [commandName, ...commandArgs] = argv;

  if (commandName === 'help' || commandName === '--help' || commandName === '-h') {
    process.stdout.write(usage(createOutputFormat(process.stdout)));
    return 0;
  }
  if (commandName === undefined) {
    process.stderr.write(usage(createOutputFormat(process.stderr)));
    return 2;
  }

  const command = COMMANDS[commandName];
  if (!command) {
    process.stderr.write(
      `speicher: unknown command ${JSON.stringify(commandName)}\n\n` +
        usage(createOutputFormat(process.stderr)),
    );
    return 2;
  }

  const log = rootLogger.child('cli');
  try {
    command.check(commandArgs);
  } catch (error) {
    process.stderr.write(
      `speicher: ${(error as Error).message}\n\n` +
        commandUsage(commandName, command, createOutputFormat(process.stderr)),
    );
    return 2;
  }

  try {
    assertKnownEnv();
    initModels();
    if (command.needsCurrentSchema) await assertSchemaCurrent();
    return await command.run(commandArgs);
  } catch (error) {
    log.error(`${commandName} failed`, { error: (error as Error).message });
    return 1;
  }
}

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  await closeSequelize();
  process.exitCode = exitCode;
}

if (require.main === module) void main();

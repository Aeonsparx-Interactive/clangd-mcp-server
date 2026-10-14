// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One-shot command line mode: `node dist/index.js cli <command> <args>`.
 *
 * The point is measurement. Comparing two clangd front-ends, timing a cold
 * symbol query, or checking that a query returns at all is a shell job, and
 * driving it through an MCP client means writing a throwaway client every
 * time. This mode starts clangd, runs one query, prints JSON, and exits.
 *
 * Coordinates use the same base as the MCP tools (1-based by default,
 * COORD_BASE=0 for 0-based), so a line copied from a compiler message works
 * in both modes.
 */

import { getProjectSettings } from './utils/settings.js';
import { logger } from './utils/logger.js';

type Options = { positionals: string[]; flags: Map<string, string> };

function parseArgs(argv: string[]): Options {
  const positionals: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, 'true');
      }
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function parseKinds(value: string | undefined): number[] | undefined {
  if (!value) {
    return undefined;
  }
  const kinds = value
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0);
  return kinds.length > 0 ? kinds : undefined;
}

function parseInclude(value: string | undefined): ('hover' | 'definition' | 'declaration' | 'references' | 'outline')[] {
  if (!value) {
    return ['hover', 'definition', 'references'];
  }
  const allowed = ['hover', 'definition', 'declaration', 'references', 'outline'] as const;
  const include = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is (typeof allowed)[number] => (allowed as readonly string[]).includes(entry));
  return include.length > 0 ? include : ['hover', 'definition', 'references'];
}

function requirePositionals(positionals: string[], count: number, usage: string): void {
  if (positionals.length < count) {
    throw new Error(`Usage: ${usage}`);
  }
}

function parseCoordinate(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  const min = getProjectSettings().coordBase;
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min} (COORD_BASE=${min})`);
  }
  return value;
}

/**
 * Run one command and print its JSON result. Returns the process exit code.
 */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);
  const settings = getProjectSettings();

  if (!command) {
    process.stderr.write(
      [
        'commands: status | symbols <query> | lint <file> | context <file> <line> <col> |',
        '          outline <file> | definition <file> <line> <col> | references <file> <line> <col> |',
        '          hover <file> <line> <col> | implementations <file> <line> <col> |',
        '          type-hierarchy <file> <line> <col> | call-hierarchy <file> <line> <col> |',
        '          symbols-in-file <file>',
        `coordinates are ${settings.coordBase}-based (COORD_BASE=0 for 0-based)`
      ].join('\n') + '\n'
    );
    return 2;
  }

  // Imported lazily so `--help` stays cheap and a bad command does not pay
  // for clangd discovery.
  const { detectConfiguration } = await import('./config-detector.js');
  const { ClangdManager } = await import('./clangd-manager.js');
  const { FileTracker } = await import('./file-tracker.js');
  const { DiagnosticsCache, getDiagnostics } = await import('./tools/get-diagnostics.js');
  const { getStatus } = await import('./tools/status.js');
  const { workspaceSymbolSearch } = await import('./tools/workspace-symbol.js');
  const { getDocumentSymbols } = await import('./tools/document-symbols.js');
  const { findDefinition } = await import('./tools/find-definition.js');
  const { findDeclaration } = await import('./tools/find-declaration.js');
  const { findReferences } = await import('./tools/find-references.js');
  const { findImplementations } = await import('./tools/find-implementations.js');
  const { getHover } = await import('./tools/get-hover.js');
  const { getCallHierarchy } = await import('./tools/get-call-hierarchy.js');
  const { getTypeHierarchy } = await import('./tools/get-type-hierarchy.js');
  const { getContext } = await import('./tools/context.js');

  const config = await detectConfiguration();
  const manager = new ClangdManager(config);
  await manager.start();
  const client = manager.getClient();
  const fileTracker = new FileTracker(client);
  const diagnosticsCache = new DiagnosticsCache(client);

  try {
    switch (command) {
      case 'status': {
        process.stdout.write(await getStatus({ manager, fileTracker, config, client }) + '\n');
        break;
      }

      case 'symbols': {
        requirePositionals(positionals, 1, 'symbols <query> [--kinds 5,13] [--max 20] [--timeout 45] [--no-deep]');
        process.stdout.write(
          await workspaceSymbolSearch(client, fileTracker, positionals[0], {
            projectRoot: config.projectRoot,
            limit: flags.has('max') ? Number.parseInt(flags.get('max') as string, 10) : 100,
            timeoutSeconds: flags.has('timeout') ? Number.parseInt(flags.get('timeout') as string, 10) : undefined,
            kinds: parseKinds(flags.get('kinds')),
            deep: flags.get('no-deep') !== 'true'
          }) + '\n'
        );
        break;
      }

      case 'lint': {
        requirePositionals(positionals, 1, 'lint <file> [--timeout 30] [--min-severity warning] [--tidy]');
        process.stdout.write(
          await getDiagnostics(diagnosticsCache, fileTracker, positionals[0], {
            timeoutSeconds: flags.has('timeout') ? Number.parseInt(flags.get('timeout') as string, 10) : undefined,
            minSeverity: flags.get('min-severity') as 'error' | 'warning' | 'information' | 'hint' | undefined,
            includeTidy: flags.get('tidy') === 'true',
            compact: true
          }) + '\n'
        );
        break;
      }

      case 'context': {
        requirePositionals(positionals, 3, 'context <file> <line> <col> [--include hover,definition,references]');
        process.stdout.write(
          await getContext(client, fileTracker, positionals[0], parseCoordinate(positionals[1], 'line'), parseCoordinate(positionals[2], 'column'), {
            include: parseInclude(flags.get('include'))
          }) + '\n'
        );
        break;
      }

      case 'outline': {
        requirePositionals(positionals, 1, 'outline <file>');
        process.stdout.write(await getDocumentSymbols(client, fileTracker, positionals[0]) + '\n');
        break;
      }

      case 'definition': {
        requirePositionals(positionals, 3, 'definition <file> <line> <col>');
        process.stdout.write(
          await findDefinition(client, fileTracker, positionals[0], parseCoordinate(positionals[1], 'line'), parseCoordinate(positionals[2], 'column')) + '\n'
        );
        break;
      }

      case 'declaration': {
        requirePositionals(positionals, 3, 'declaration <file> <line> <col>');
        process.stdout.write(
          await findDeclaration(client, fileTracker, positionals[0], parseCoordinate(positionals[1], 'line'), parseCoordinate(positionals[2], 'column')) + '\n'
        );
        break;
      }

      case 'references': {
        requirePositionals(positionals, 3, 'references <file> <line> <col> [--no-decl]');
        process.stdout.write(
          await findReferences(
            client,
            fileTracker,
            positionals[0],
            parseCoordinate(positionals[1], 'line'),
            parseCoordinate(positionals[2], 'column'),
            flags.get('no-decl') !== 'true'
          ) + '\n'
        );
        break;
      }

      case 'hover': {
        requirePositionals(positionals, 3, 'hover <file> <line> <col>');
        process.stdout.write(
          await getHover(client, fileTracker, positionals[0], parseCoordinate(positionals[1], 'line'), parseCoordinate(positionals[2], 'column')) + '\n'
        );
        break;
      }

      case 'implementations': {
        requirePositionals(positionals, 3, 'implementations <file> <line> <col>');
        process.stdout.write(
          await findImplementations(client, fileTracker, positionals[0], parseCoordinate(positionals[1], 'line'), parseCoordinate(positionals[2], 'column')) + '\n'
        );
        break;
      }

      case 'type-hierarchy': {
        requirePositionals(positionals, 3, 'type-hierarchy <file> <line> <col>');
        process.stdout.write(
          await getTypeHierarchy(client, fileTracker, positionals[0], parseCoordinate(positionals[1], 'line'), parseCoordinate(positionals[2], 'column')) + '\n'
        );
        break;
      }

      case 'call-hierarchy': {
        requirePositionals(positionals, 3, 'call-hierarchy <file> <line> <col>');
        process.stdout.write(
          await getCallHierarchy(client, fileTracker, positionals[0], parseCoordinate(positionals[1], 'line'), parseCoordinate(positionals[2], 'column')) + '\n'
        );
        break;
      }

      case 'symbols-in-file': {
        requirePositionals(positionals, 1, 'symbols-in-file <file>');
        process.stdout.write(await getDocumentSymbols(client, fileTracker, positionals[0]) + '\n');
        break;
      }

      default:
        process.stderr.write(`unknown command: ${command}\n`);
        return 2;
    }

    return 0;
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: true, message: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
    return 1;
  } finally {
    try {
      fileTracker.closeAll();
      await manager.shutdown();
    } catch (shutdownError) {
      logger.debug('CLI shutdown failed:', shutdownError);
    }
  }
}

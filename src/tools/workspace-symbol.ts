// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { uriToPath } from '../utils/uri.js';
import { logger } from '../utils/logger.js';
import { symbolKindNames } from '../utils/lsp-types.js';
import { fromLspLine, fromLspColumn } from '../utils/coords.js';
import { getProjectSettings } from '../utils/settings.js';
import { fileScanSymbols, nameVariants } from './file-scan.js';

interface SymbolInformationLike {
  name: string;
  kind: number;
  location: { uri: string; range: { start: { line: number; character: number } } };
  containerName?: string;
}

export interface WorkspaceSymbolOptions {
  limit?: number;
  /** Seconds to keep retrying an empty index before giving up. */
  timeoutSeconds?: number;
  /** Restrict results to these symbol kinds (numbers or names such as 'Class'). */
  kinds?: (number | string)[];
  /** Run the file-scan fallback when the index has nothing. Default true. */
  deep?: boolean;
  /** Max files the deep scan may open. */
  maxFiles?: number;
  /** Directories the deep scan walks. */
  scanDirs?: string[];
  /** Project root, required for seeding and the deep scan. */
  projectRoot?: string;
}

export interface SymbolEntry {
  name: string;
  kind: string;
  container?: string;
  file: string;
  line: number;
  column: number;
  uri?: string;
}

/** Reverse symbolKindNames so 'Class' can be passed as a filter. */
const kindByName: Record<string, number> = Object.fromEntries(
  Object.entries(symbolKindNames).map(([numeric, name]) => [name.toLowerCase(), Number(numeric)])
);

function resolveKindFilter(kinds?: (number | string)[]): Set<number> | undefined {
  if (!kinds || kinds.length === 0) {
    return undefined;
  }

  const numeric = new Set<number>();
  for (const kind of kinds) {
    if (typeof kind === 'number') {
      numeric.add(kind);
    } else {
      const lookup = kindByName[kind.toLowerCase()];
      if (lookup !== undefined) {
        numeric.add(lookup);
      }
    }
  }

  return numeric.size > 0 ? numeric : undefined;
}

/**
 * Locate compile_commands.json the same way config-detector does, so the
 * server can seed clangd with a real translation unit.
 */
function findCompileCommandsFile(projectRoot: string): string | undefined {
  const candidates: string[] = [];

  if (process.env.COMPILE_COMMANDS_DIR) {
    candidates.push(resolve(process.env.COMPILE_COMMANDS_DIR, 'compile_commands.json'));
  }

  candidates.push(
    join(projectRoot, 'compile_commands.json'),
    join(projectRoot, 'build/compile_commands.json'),
    join(projectRoot, 'out/Default/compile_commands.json'),
    join(projectRoot, 'out/Release/compile_commands.json'),
    join(projectRoot, 'out/Debug/compile_commands.json'),
    join(projectRoot, '.build/compile_commands.json')
  );

  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Files to hand clangd before asking the index anything.
 *
 * clangd answers workspace/symbol from the background index, which is empty
 * until a translation unit has been parsed. Without a seed, a cold server
 * answers "no symbols" in milliseconds and the caller assumes the symbol does
 * not exist.
 */
export function resolveSeedFiles(projectRoot: string, max = 3): string[] {
  const settings = getProjectSettings();
  const seeds = settings.seedFiles
    .map((entry) => (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry) ? entry : join(projectRoot, entry)))
    .filter((entry) => existsSync(entry));

  if (seeds.length > 0) {
    return seeds.slice(0, max);
  }

  const cdb = findCompileCommandsFile(projectRoot);
  if (!cdb) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(cdb, 'utf-8'));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry: any) => (typeof entry?.file === 'string' ? entry.file : undefined))
      .filter((file: string | undefined): file is string => !!file && existsSync(file))
      .slice(0, max);
  } catch (error) {
    logger.warn('Failed to read compile_commands.json for seeding:', error);
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Search the workspace for a symbol name.
 *
 * Unlike a single-shot workspace/symbol call, this seeds clangd, retries with
 * backoff until a deadline, tries prefix variants of the query, and falls back
 * to a file scan for headers the index has never seen.
 */
export async function workspaceSymbolSearch(
  lspClient: LSPClient,
  fileTracker: FileTracker,
  query: string,
  options: WorkspaceSymbolOptions = {}
): Promise<string> {
  const settings = getProjectSettings();
  const limit = options.limit ?? 100;
  const timeoutSeconds = options.timeoutSeconds ?? settings.symbolTimeoutSeconds;
  const projectRoot = options.projectRoot ?? process.cwd();
  const kindFilter = resolveKindFilter(options.kinds);
  const variants = nameVariants(query, settings.namePrefixes);

  const seeds = resolveSeedFiles(projectRoot);
  for (const seed of seeds) {
    try {
      await fileTracker.ensureFileOpen(seed);
    } catch (error) {
      logger.warn(`Failed to open seed file ${seed}:`, error);
    }
  }

  const collected = new Map<string, SymbolEntry>();
  let attempts = 0;
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    attempts++;

    for (const variant of variants) {
      try {
        const result = (await lspClient.request('workspace/symbol', {
          query: variant
        })) as SymbolInformationLike[];

        for (const symbol of result ?? []) {
          if (kindFilter && !kindFilter.has(symbol.kind)) {
            continue;
          }

          const file = uriToPath(symbol.location.uri);
          const key = `${symbol.name}\u0000${file}\u0000${symbol.location.range.start.line}`;

          if (!collected.has(key)) {
            collected.set(key, {
              name: symbol.name,
              kind: symbolKindNames[symbol.kind] ?? String(symbol.kind),
              container: symbol.containerName,
              file,
              line: fromLspLine(symbol.location.range.start.line),
              column: fromLspColumn(symbol.location.range.start.character),
              uri: symbol.location.uri
            });
          }
        }
      } catch (error) {
        logger.warn('workspace/symbol attempt failed:', error);
      }

      if (collected.size > 0) {
        break;
      }
    }

    if (collected.size > 0) {
      break;
    }

    // Index still cold: back off, capped, and ask again.
    const backoff = Math.min(200 * 2 ** Math.min(attempts, 4), 2000);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await sleep(Math.min(backoff, remaining));
  }

  if (collected.size > 0) {
    const symbols = [...collected.values()];

    return JSON.stringify(
      {
        found: true,
        count: symbols.length,
        returned: Math.min(symbols.length, limit),
        truncated: symbols.length > limit,
        attempts,
        seeds,
        foundBy: 'index',
        symbols: symbols.slice(0, limit)
      },
      null,
      2
    );
  }

  // Nothing in the index. Fall back to scanning source files directly.
  if (options.deep !== false) {
    const scan = await fileScanSymbols(lspClient, fileTracker, query, {
      projectRoot,
      scanDirs: options.scanDirs,
      maxFiles: options.maxFiles
    });

    if (scan.symbols.length > 0) {
      const filtered = kindFilter
        ? scan.symbols.filter((symbol) => {
            const numeric = kindByName[symbol.kind.toLowerCase()];
            return numeric !== undefined && kindFilter.has(numeric);
          })
        : scan.symbols;

      return JSON.stringify(
        {
          found: true,
          count: filtered.length,
          returned: Math.min(filtered.length, limit),
          truncated: filtered.length > limit,
          attempts,
          seeds,
          foundBy: 'file-scan',
          filesScanned: scan.filesScanned.length,
          scannedFiles: scan.filesScanned,
          note: 'Not in the background index; found by opening source files. clangd indexes a header only through the translation units that include it.',
          symbols: filtered.slice(0, limit)
        },
        null,
        2
      );
    }

    return JSON.stringify(
      {
        found: false,
        message: `No symbols found for '${query}'`,
        attempts,
        seeds,
        variants,
        scanCandidates: scan.candidates,
        filesScanned: scan.filesScanned.length,
        scannedFiles: scan.filesScanned,
        note: 'Not in the background index (clangd indexes a header only through the .cpp files that include it), and no source file name or content matched the query.'
      },
      null,
      2
    );
  }

  return JSON.stringify(
    {
      found: false,
      message: `No symbols found for '${query}'`,
      attempts,
      seeds,
      note: 'Not in the background index. Deep file scan was disabled with deep:false.'
    },
    null,
    2
  );
}

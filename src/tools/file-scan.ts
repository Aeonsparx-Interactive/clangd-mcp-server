// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Deep file scan: the fallback for symbols the background index does not know.
 *
 * clangd indexes a header only through the translation units that include it,
 * so a header that no compiled .cpp pulls in is invisible to
 * workspace/symbol. This module finds the file by name (falling back to a
 * content scan), opens it, and reads its document symbols.
 *
 * Opening a file costs seconds of AST build, so the number of opened files is
 * capped by maxScanFiles.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { uriToPath } from '../utils/uri.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/errors.js';
import { symbolKindNames } from '../utils/lsp-types.js';
import { fromLspLine, fromLspColumn } from '../utils/coords.js';
import { getProjectSettings } from '../utils/settings.js';

const SCAN_EXTENSIONS = new Set([
  '.h', '.hpp', '.hxx', '.h++', '.cuh',
  '.cpp', '.cxx', '.cc', '.c', '.inl'
]);

const SKIP_DIRECTORIES = new Set([
  '.git', '.cache', '.vs', '.vscode', '.idea', '.pi',
  'Intermediate', 'Binaries', 'DerivedDataCache', 'Saved', 'Build',
  'node_modules', 'ThirdParty'
]);

/** Files larger than this are skipped by the content fallback scan. */
const MAX_CONTENT_SCAN_BYTES = 400 * 1024;

export interface FileScanOptions {
  projectRoot: string;
  scanDirs?: string[];
  maxFiles?: number;
  namePrefixes?: string[];
}

export interface ScannedSymbol {
  name: string;
  kind: string;
  container?: string;
  file: string;
  line: number;
  column: number;
}

export interface FileScanResult {
  symbols: ScannedSymbol[];
  candidates: number;
  filesScanned: string[];
  matchedBy: 'filename' | 'content' | 'none';
}

/**
 * Build the spellings to match against: the query as given, the query with a
 * leading single-letter type prefix removed, and the query with each prefix
 * prepended. Keeps "LpItemService" finding "ULpItemService" without hardcoding
 * any engine convention beyond the configured prefix list.
 */
export function nameVariants(query: string, prefixes: string[] = getProjectSettings().namePrefixes): string[] {
  const variants = new Set<string>([query]);

  const stripped = query.replace(new RegExp(`^[${prefixes.join('')}]?(?=[A-Z])`), '');
  if (stripped.length >= 3) {
    variants.add(stripped);
  }

  for (const prefix of prefixes) {
    variants.add(`${prefix}${query}`);
    if (stripped.length >= 3) {
      variants.add(`${prefix}${stripped}`);
    }
  }

  return [...variants];
}

/** Recursively collect source files under the scan directories. */
export function walkSourceFiles(projectRoot: string, scanDirs: string[] = getProjectSettings().scanDirs): string[] {
  const found: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 12) {
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(dir, entry);

      if (SKIP_DIRECTORIES.has(entry)) {
        continue;
      }

      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        walk(full, depth + 1);
      } else if (SCAN_EXTENSIONS.has(extname(entry).toLowerCase())) {
        found.push(full);
      }
    }
  };

  for (const scanDir of scanDirs) {
    walk(join(projectRoot, scanDir), 0);
  }

  return found;
}

function matchesVariant(haystack: string, variants: string[]): boolean {
  const lower = haystack.toLowerCase();
  return variants.some((variant) => lower.includes(variant.toLowerCase()));
}

/**
 * Files whose own name matches the query. Headers first: a declaration is
 * where a symbol search is expected to land.
 */
export function filesByName(files: string[], variants: string[]): string[] {
  const hits = files.filter((file) => matchesVariant(basename(file), variants));
  return hits.sort((a, b) => {
    const aHeader = SCAN_EXTENSIONS.has(extname(a).toLowerCase()) && !['.cpp', '.cxx', '.cc', '.c'].includes(extname(a).toLowerCase());
    const bHeader = SCAN_EXTENSIONS.has(extname(b).toLowerCase()) && !['.cpp', '.cxx', '.cc', '.c'].includes(extname(b).toLowerCase());
    if (aHeader !== bHeader) {
      return aHeader ? -1 : 1;
    }
    return a.length - b.length;
  });
}

/**
 * Fallback: files whose contents mention the query. Only used when no file
 * name matched, and only for files under MAX_CONTENT_SCAN_BYTES.
 */
export function filesByContent(files: string[], variants: string[]): string[] {
  const hits: string[] = [];

  for (const file of files) {
    let stats;
    try {
      stats = statSync(file);
    } catch {
      continue;
    }

    if (stats.size > MAX_CONTENT_SCAN_BYTES) {
      continue;
    }

    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    if (matchesVariant(text, variants)) {
      hits.push(file);
    }
  }

  return hits;
}

interface DocumentSymbolLike {
  name: string;
  kind: number;
  range: { start: { line: number; character: number } };
  children?: DocumentSymbolLike[];
}

function collectMatchingSymbols(symbols: DocumentSymbolLike[], variants: string[], file: string, container?: string): ScannedSymbol[] {
  const out: ScannedSymbol[] = [];

  for (const symbol of symbols) {
    if (matchesVariant(symbol.name, variants)) {
      out.push({
        name: symbol.name,
        kind: symbolKindNames[symbol.kind] ?? String(symbol.kind),
        container,
        file,
        line: fromLspLine(symbol.range.start.line),
        column: fromLspColumn(symbol.range.start.character)
      });
    }

    if (symbol.children && symbol.children.length > 0) {
      out.push(...collectMatchingSymbols(symbol.children, variants, file, symbol.name));
    }
  }

  return out;
}

/**
 * Scan files for a symbol the background index does not know about.
 */
export async function fileScanSymbols(
  lspClient: LSPClient,
  fileTracker: FileTracker,
  query: string,
  options: FileScanOptions
): Promise<FileScanResult> {
  const settings = getProjectSettings();
  const scanDirs = options.scanDirs ?? settings.scanDirs;
  const maxFiles = Math.min(options.maxFiles ?? settings.maxScanFiles, 20);
  const variants = nameVariants(query, options.namePrefixes ?? settings.namePrefixes);

  // walkSourceFiles yields absolute paths, so every read below is cwd-independent.
  const files = walkSourceFiles(options.projectRoot, scanDirs);
  let candidates = filesByName(files, variants);
  let matchedBy: FileScanResult['matchedBy'] = 'filename';

  if (candidates.length === 0) {
    candidates = filesByContent(files, variants);
    matchedBy = candidates.length > 0 ? 'content' : 'none';
  }

  const result: FileScanResult = {
    symbols: [],
    candidates: candidates.length,
    filesScanned: [],
    matchedBy
  };

  for (const file of candidates.slice(0, maxFiles)) {
    try {
      const uri = await fileTracker.ensureFileOpen(file);
      const symbols = await withRetry(async () =>
        lspClient.request('textDocument/documentSymbol', {
          textDocument: { uri }
        })
      );

      result.filesScanned.push(uriToPath(uri));
      result.symbols.push(...collectMatchingSymbols(symbols ?? [], variants, uriToPath(uri)));
    } catch (error) {
      logger.warn(`Deep scan failed for ${file}:`, error);
    }
  }

  return result;
}

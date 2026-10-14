// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { withRetry } from '../utils/errors.js';
import { normalizeLocationResult, symbolKindNames } from '../utils/lsp-types.js';
import { uriToPath } from '../utils/uri.js';
import { toLspPosition, fromLspStart } from '../utils/coords.js';
import { extractHoverContents } from './get-hover.js';
import { logger } from '../utils/logger.js';

export type ContextSection = 'hover' | 'definition' | 'declaration' | 'references' | 'outline';

const DEFAULT_SECTIONS: ContextSection[] = ['hover', 'definition', 'references'];

export interface ContextOptions {
  include?: ContextSection[];
}

interface DocumentSymbolLike {
  name: string;
  kind: number;
  range: { start: { line: number; character: number } };
  selectionRange?: { start: { line: number; character: number } };
  children?: DocumentSymbolLike[];
}

function flattenSymbols(symbols: DocumentSymbolLike[], container?: string, depth = 0): { name: string; kind: string; container?: string; line: number; column: number }[] {
  const flat: { name: string; kind: string; container?: string; line: number; column: number }[] = [];

  for (const symbol of symbols) {
    const start = symbol.selectionRange?.start ?? symbol.range.start;
    const [line, column] = [fromLspStart(start).line, fromLspStart(start).column];
    flat.push({
      name: symbol.name,
      kind: symbolKindNames[symbol.kind] ?? 'Unknown',
      ...(container ? { container } : {}),
      line,
      column
    });

    if (symbol.children && symbol.children.length > 0 && depth < 4) {
      flat.push(...flattenSymbols(symbol.children, symbol.name, depth + 1));
    }
  }

  return flat;
}

/**
 * Everything clangd knows about one position, in one call.
 *
 * Hover, definition, declaration, references and the file outline are five
 * round trips that a caller almost always wants together — "what is this
 * symbol and where does it live". Splitting them into five tool calls costs
 * five context windows for one question.
 */
export async function getContext(
  lspClient: LSPClient,
  fileTracker: FileTracker,
  filePath: string,
  line: number,
  column: number,
  options: ContextOptions = {}
): Promise<string> {
  const sections = options.include && options.include.length > 0 ? options.include : DEFAULT_SECTIONS;
  const uri = await fileTracker.ensureFileOpen(filePath);
  const position = toLspPosition(line, column);

  const context: Record<string, unknown> = {
    file: filePath,
    line,
    column
  };

  let anyFound = false;

  if (sections.includes('hover')) {
    try {
      const hover = await withRetry(async () =>
        lspClient.request('textDocument/hover', { textDocument: { uri }, position })
      );
      if (hover?.contents) {
        context.hover = extractHoverContents(hover.contents);
        anyFound = true;
      }
    } catch (error) {
      logger.debug('Hover failed:', error);
      context.hoverError = error instanceof Error ? error.message : String(error);
    }
  }

  for (const section of ['definition', 'declaration'] as const) {
    if (!sections.includes(section)) {
      continue;
    }

    try {
      const result = await withRetry(async () =>
        lspClient.request(`textDocument/${section}`, { textDocument: { uri }, position })
      );
      const locations = normalizeLocationResult(result);
      if (locations.length > 0) {
        context[section] = locations.map((loc) => ({
          file: uriToPath(loc.uri),
          ...fromLspStart(loc.range.start)
        }));
        anyFound = true;
      }
    } catch (error) {
      logger.debug(`${section} failed:`, error);
      context[`${section}Error`] = error instanceof Error ? error.message : String(error);
    }
  }

  if (sections.includes('references')) {
    try {
      const result = await withRetry(async () =>
        lspClient.request('textDocument/references', {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true }
        })
      );
      const locations = normalizeLocationResult(result);
      if (locations.length > 0) {
        context.references = {
          count: locations.length,
          locations: locations.map((loc) => ({
            file: uriToPath(loc.uri),
            ...fromLspStart(loc.range.start)
          }))
        };
        anyFound = true;
      }
    } catch (error) {
      logger.debug('References failed:', error);
      context.referencesError = error instanceof Error ? error.message : String(error);
    }
  }

  if (sections.includes('outline')) {
    try {
      const result = await withRetry(async () =>
        lspClient.request('textDocument/documentSymbol', { textDocument: { uri } })
      );
      const symbols = Array.isArray(result) ? (result as DocumentSymbolLike[]) : [];
      if (symbols.length > 0) {
        context.outline = flattenSymbols(symbols);
        anyFound = true;
      }
    } catch (error) {
      logger.debug('Outline failed:', error);
      context.outlineError = error instanceof Error ? error.message : String(error);
    }
  }

  return JSON.stringify({ found: anyFound, ...context }, null, 2);
}

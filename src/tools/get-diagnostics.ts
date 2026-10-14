// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { Diagnostic, DiagnosticSeverity } from '../utils/lsp-types.js';
import { uriToPath } from '../utils/uri.js';
import { TimeoutError, withTimeout } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { existsSync, readFileSync } from 'node:fs';
import { getProjectSettings } from '../utils/settings.js';
import { fromLspLine, fromLspColumn } from '../utils/coords.js';

/**
 * Manages a cache of diagnostics received from clangd via publishDiagnostics notifications
 */
export class DiagnosticsCache {
  private cache: Map<string, Diagnostic[]> = new Map();
  private pendingWaits: Map<string, Array<(diagnostics: Diagnostic[]) => void>> = new Map();

  constructor(lspClient: LSPClient) {
    // Listen for publishDiagnostics notifications from clangd
    lspClient.onNotification('textDocument/publishDiagnostics', (params: any) => {
      const uri = params.uri as string;
      const diagnostics = params.diagnostics as Diagnostic[];

      logger.debug(`Received diagnostics for ${uri}: ${diagnostics.length} items`);

      // Update cache
      this.cache.set(uri, diagnostics);

      // Notify any pending waiters
      const waiters = this.pendingWaits.get(uri);
      if (waiters) {
        for (const resolve of waiters) {
          resolve(diagnostics);
        }
        this.pendingWaits.delete(uri);
      }
    });
  }

  /**
   * Get diagnostics for a file URI
   * If force_refresh is true, clears cache and waits for new diagnostics
   */
  async getDiagnostics(uri: string, forceRefresh: boolean = false, timeoutMs?: number): Promise<Diagnostic[]> {
    if (forceRefresh) {
      logger.info(`Force refresh requested for ${uri}`);
      this.cache.delete(uri);
    }

    // If cached, return immediately
    if (this.cache.has(uri)) {
      return this.cache.get(uri)!;
    }

    // Otherwise, wait for diagnostics to arrive (file should already be opened)
    return this.waitForDiagnostics(uri, timeoutMs ?? 5000);
  }

  /**
   * Wait for diagnostics to be published for a given URI
   */
  private async waitForDiagnostics(uri: string, timeoutMs: number): Promise<Diagnostic[]> {
    // Check if already cached (race condition)
    if (this.cache.has(uri)) {
      return this.cache.get(uri)!;
    }

    const promise = new Promise<Diagnostic[]>((resolve) => {
      // Add to pending waiters
      const waiters = this.pendingWaits.get(uri) || [];
      waiters.push(resolve);
      this.pendingWaits.set(uri, waiters);
    });

    try {
      return await withTimeout(
        promise,
        timeoutMs,
        `Timeout waiting for diagnostics for ${uri}`
      );
    } catch (error) {
      // Clean up pending waiters on timeout
      this.pendingWaits.delete(uri);

      if (error instanceof TimeoutError) {
        logger.warn(`Timeout waiting for diagnostics: ${uri}`);
        // Return empty diagnostics array instead of throwing
        return [];
      }
      throw error;
    }
  }

  /**
   * Clear diagnostics for a specific file (called when FileTracker evicts)
   */
  clearForFile(uri: string): void {
    logger.debug(`Clearing diagnostics cache for ${uri}`);
    this.cache.delete(uri);
    this.pendingWaits.delete(uri);
  }

  /**
   * Get the current cache size (for debugging)
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}

export type SeverityName = 'error' | 'warning' | 'information' | 'hint';

const SEVERITY_RANK: Record<SeverityName, number> = {
  error: 1,
  warning: 2,
  information: 3,
  hint: 4
};

export interface DiagnosticsOptions {
  forceRefresh?: boolean;
  minSeverity?: SeverityName;
  includeTidy?: boolean;
  compact?: boolean;
  timeoutSeconds?: number;
}

function severityName(diag: Diagnostic): SeverityName {
  return diag.severity === DiagnosticSeverity.Error
    ? 'error'
    : diag.severity === DiagnosticSeverity.Warning
      ? 'warning'
      : diag.severity === DiagnosticSeverity.Information
        ? 'information'
        : 'hint';
}

/**
 * Load the lint filter: a JSON file of {"drop": ["pattern", ...]} (a bare
 * array of patterns is also accepted). Patterns are matched case-insensitively
 * against the diagnostic message.
 *
 * A project that turns clang-tidy on inherits hundreds of engine-style
 * findings it never intended to act on; the filter is the project's way of
 * saying which ones are noise without disabling the check wholesale.
 */
function loadLintFilter(path: string): { patterns: string[]; error?: string } {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : ((raw as { drop?: unknown }).drop ?? []);
    const patterns = (Array.isArray(list) ? list : []).map((entry) => String(entry));
    return { patterns };
  } catch (error) {
    logger.warn(`Lint filter unreadable at ${path}:`, error);
    return { patterns: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Tool implementation for get_diagnostics
 */
export async function getDiagnostics(
  diagnosticsCache: DiagnosticsCache,
  fileTracker: FileTracker,
  filePath: string,
  options: DiagnosticsOptions = {}
): Promise<string> {
  const settings = getProjectSettings();

  // Ensure file is opened (will trigger diagnostics)
  const uri = await fileTracker.ensureFileOpen(filePath);

  // Get diagnostics from cache (or wait for them)
  const published = await diagnosticsCache.getDiagnostics(
    uri,
    options.forceRefresh ?? false,
    (options.timeoutSeconds ?? settings.diagnosticsTimeoutSeconds) * 1000
  );

  // clang-tidy findings are attributed to source 'clang-tidy'; drop them unless asked for
  const diagnostics = options.includeTidy === false
    ? published.filter((diag) => diag.source !== 'clang-tidy')
    : published;

  // Count by severity
  const counts = {
    errors: 0,
    warnings: 0,
    information: 0,
    hints: 0
  };

  for (const diag of diagnostics) {
    switch (diag.severity) {
      case DiagnosticSeverity.Error:
        counts.errors++;
        break;
      case DiagnosticSeverity.Warning:
        counts.warnings++;
        break;
      case DiagnosticSeverity.Information:
        counts.information++;
        break;
      case DiagnosticSeverity.Hint:
        counts.hints++;
        break;
    }
  }

  const minSeverity = options.minSeverity;
  let filtered = diagnostics.filter(
    (diag) => !minSeverity || SEVERITY_RANK[severityName(diag)] <= SEVERITY_RANK[minSeverity]
  );

  const filterPath = settings.lintFilterPath;
  let filterDropped = 0;
  let filterError: string | undefined;

  if (filterPath) {
    const { patterns, error } = loadLintFilter(filterPath);
    filterError = error;
    if (patterns.length > 0) {
      const kept = filtered.filter((diag) =>
        !patterns.some((pattern) => diag.message.toLowerCase().includes(pattern.toLowerCase()))
      );
      filterDropped = filtered.length - kept.length;
      filtered = kept;
    }
  }

  // Format diagnostics for output
  const formattedDiagnostics = filtered.map(diag => {
    const severity = severityName(diag);

    const formatted: any = {
      severity,
      message: diag.message,
      location: {
        line: fromLspLine(diag.range.start.line),
        column: fromLspColumn(diag.range.start.character)
      },
      range: {
        start: {
          line: fromLspLine(diag.range.start.line),
          column: fromLspColumn(diag.range.start.character)
        },
        end: {
          line: fromLspLine(diag.range.end.line),
          column: fromLspColumn(diag.range.end.character)
        }
      }
    };

    if (diag.code !== undefined) {
      formatted.code = diag.code;
    }

    if (diag.source) {
      formatted.source = diag.source;
    }

    if (diag.relatedInformation && diag.relatedInformation.length > 0) {
      formatted.relatedInformation = diag.relatedInformation.map(info => ({
        location: {
          file: uriToPath(info.location.uri),
          line: fromLspLine(info.location.range.start.line),
          column: fromLspColumn(info.location.range.start.character)
        },
        message: info.message
      }));
    }

    return formatted;
  });

  // Compact form: one `file:line:col SEVERITY [source(code)] message` line per
  // finding, which is what a shell caller and a compiler-message diff want.
  const lines = filtered.map((diag) => {
    const source = diag.source ? ` [${diag.source}${diag.code !== undefined ? `(${diag.code})` : ''}]` : '';
    return `${filePath}:${fromLspLine(diag.range.start.line)}:${fromLspColumn(diag.range.start.character)} ${severityName(diag).toUpperCase()}${source} ${diag.message.replace(/\s+/g, ' ')}`;
  });

  const result: any = {
    file: filePath,
    published: published.length,
    diagnostic_count: counts,
    returned: filtered.length,
    filtered_out: filterDropped,
    diagnostics: formattedDiagnostics
  };

  if (options.compact) {
    result.lines = lines;
  }

  if (filterPath) {
    result.lintFilter = filterPath;
    if (filterError) {
      result.lintFilterError = filterError;
    }
  }

  if (minSeverity) {
    result.minSeverity = minSeverity;
  }

  return JSON.stringify(result, null, 2);
}

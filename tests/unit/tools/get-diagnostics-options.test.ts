// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MockReadableStream,
  MockWritableStream,
  sendLSPMessage,
} from '../../helpers/mock-streams.js';
import { LSPClient } from '../../../src/lsp-client.js';
import { FileTracker } from '../../../src/file-tracker.js';
import { getDiagnostics, DiagnosticsCache } from '../../../src/tools/get-diagnostics.js';
import { normalizeToUri } from '../../../src/utils/uri.js';

describe('getDiagnostics options', () => {
  let testDir: string;
  let testFile: string;
  let uri: string;
  let stdin: MockWritableStream;
  let stdout: MockReadableStream;
  let client: LSPClient;
  let fileTracker: FileTracker;
  let diagnosticsCache: DiagnosticsCache;
  const savedLintFilter = process.env.LINT_FILTER;

  beforeEach(() => {
    testDir = join(tmpdir(), `diag-options-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, 'Widget.cpp');
    writeFileSync(testFile, 'int main() { return 0; }\n');
    uri = normalizeToUri(testFile);

    stdin = new MockWritableStream();
    stdout = new MockReadableStream();
    client = new LSPClient(stdin, stdout);
    fileTracker = new FileTracker(client);
    diagnosticsCache = new DiagnosticsCache(client);
  });

  afterEach(() => {
    if (savedLintFilter === undefined) {
      delete process.env.LINT_FILTER;
    } else {
      process.env.LINT_FILTER = savedLintFilter;
    }
    fileTracker.closeAll();
    client.close();
    stdin.cleanup();
    stdout.cleanup();
    rmSync(testDir, { recursive: true, force: true });
  });

  async function publish(diagnostics: any[]) {
    sendLSPMessage(stdout, {
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const mixed = [
    {
      range: { start: { line: 63, character: 22 }, end: { line: 63, character: 40 } },
      severity: 2,
      message: "Function 'ApplyMappingContexts' has cognitive complexity of 36",
      source: 'clang-tidy',
      code: 'readability-function-cognitive-complexity',
    },
    {
      range: { start: { line: 205, character: 37 }, end: { line: 205, character: 60 } },
      severity: 2,
      message: "Narrowing conversion from 'double' to 'float'",
      source: 'clang-diagnostic',
    },
    {
      range: { start: { line: 10, character: 0 }, end: { line: 10, character: 10 } },
      severity: 1,
      message: 'use of undeclared identifier Foo',
      source: 'clang-diagnostic',
    },
    {
      range: { start: { line: 376, character: 1 }, end: { line: 376, character: 20 } },
      severity: 4,
      message: 'use auto for this variable',
      source: 'clang-tidy',
      code: 'modernize-use-auto',
    },
  ];

  it('counts severities and converts locations to 1-based', async () => {
    await publish(mixed);
    const parsed = JSON.parse(
      await getDiagnostics(diagnosticsCache, fileTracker, testFile, { timeoutSeconds: 1 })
    );

    expect(parsed.published).toBe(4);
    expect(parsed.diagnostic_count).toEqual({ errors: 1, warnings: 2, information: 0, hints: 1 });
    expect(parsed.diagnostics[0]).toMatchObject({
      severity: 'warning',
      location: { line: 64, column: 23 },
    });
  });

  it('drops clang-tidy findings unless include_tidy is set', async () => {
    await publish(mixed);
    const withoutTidy = JSON.parse(
      await getDiagnostics(diagnosticsCache, fileTracker, testFile, {
        includeTidy: false,
        timeoutSeconds: 1,
      })
    );
    expect(withoutTidy.returned).toBe(2);
    expect(withoutTidy.diagnostics.every((d: any) => d.source !== 'clang-tidy')).toBe(true);

    const withTidy = JSON.parse(
      await getDiagnostics(diagnosticsCache, fileTracker, testFile, {
        includeTidy: true,
        timeoutSeconds: 1,
      })
    );
    expect(withTidy.returned).toBe(4);
  });

  it('filters by minimum severity', async () => {
    await publish(mixed);
    const parsed = JSON.parse(
      await getDiagnostics(diagnosticsCache, fileTracker, testFile, {
        minSeverity: 'error',
        timeoutSeconds: 1,
      })
    );
    expect(parsed.returned).toBe(1);
    expect(parsed.minSeverity).toBe('error');
    expect(parsed.diagnostics[0].severity).toBe('error');
  });

  it('emits compact lines when compact is set', async () => {
    await publish(mixed);
    const parsed = JSON.parse(
      await getDiagnostics(diagnosticsCache, fileTracker, testFile, {
        compact: true,
        timeoutSeconds: 1,
      })
    );
    expect(parsed.lines).toHaveLength(4);
    // Order follows the published order, so match by content, not by index.
    expect(parsed.lines.join('\n')).toContain(`${testFile}:11:1 ERROR [clang-diagnostic] use of undeclared identifier Foo`);
    expect(parsed.lines.join('\n')).toContain('[clang-tidy(readability-function-cognitive-complexity)]');
  });

  it('applies the LINT_FILTER pattern file', async () => {
    const filterPath = join(testDir, 'lint-filter.json');
    writeFileSync(filterPath, JSON.stringify({ drop: ['cognitive complexity'] }));
    process.env.LINT_FILTER = filterPath;

    await publish(mixed);
    const parsed = JSON.parse(
      await getDiagnostics(diagnosticsCache, fileTracker, testFile, { timeoutSeconds: 1 })
    );

    expect(parsed.returned).toBe(3);
    expect(parsed.filtered_out).toBe(1);
    expect(parsed.lintFilter).toBe(filterPath);
  });

  it('reports an unreadable filter without failing the request', async () => {
    process.env.LINT_FILTER = join(testDir, 'missing.json');
    await publish(mixed.slice(0, 1));
    const parsed = JSON.parse(
      await getDiagnostics(diagnosticsCache, fileTracker, testFile, { timeoutSeconds: 1 })
    );
    expect(parsed.returned).toBe(1);
    expect(parsed.lintFilterError).toContain('ENOENT');
  });

  it('reports unpublished files without hanging past the timeout', async () => {
    const parsed = JSON.parse(
      await getDiagnostics(diagnosticsCache, fileTracker, testFile, { timeoutSeconds: 0.2 })
    );
    expect(parsed.published).toBe(0);
    expect(parsed.diagnostic_count.errors).toBe(0);
  });
});

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LSPClient } from '../../../src/lsp-client.js';
import type { FileTracker } from '../../../src/file-tracker.js';
import { workspaceSymbolSearch } from '../../../src/tools/workspace-symbol.js';

const savedSymbolTimeout = process.env.CLANGD_SYMBOL_TIMEOUT;

function makeTracker() {
  return {
    ensureFileOpen: jest.fn(async (p: string) => `file:///C:/${p.replace(/\\/g, '/')}`),
  } as unknown as FileTracker;
}

describe('workspaceSymbolSearch', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `ws-symbol-test-${Date.now()}`);
    mkdirSync(join(projectRoot, 'Source'), { recursive: true });
  });

  afterEach(() => {
    if (savedSymbolTimeout === undefined) {
      delete process.env.CLANGD_SYMBOL_TIMEOUT;
    } else {
      process.env.CLANGD_SYMBOL_TIMEOUT = savedSymbolTimeout;
    }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reports index hits with 1-based coordinates', async () => {
    const request = jest.fn(async () => [
      {
        name: 'ALpOperatorPawn',
        kind: 5,
        containerName: 'Lp',
        location: {
          uri: 'file:///C:/Source/Lp/Public/Character/LpOperatorPawn.h',
          range: { start: { line: 25, character: 13 }, end: { line: 25, character: 27 } },
        },
      },
    ]);
    const client = { request } as unknown as LSPClient;

    const parsed = JSON.parse(
      await workspaceSymbolSearch(client, makeTracker(), 'ALpOperatorPawn', {
        projectRoot,
        timeoutSeconds: 1,
        deep: false,
      })
    );

    expect(parsed.found).toBe(true);
    expect(parsed.foundBy).toBe('index');
    expect(parsed.attempts).toBe(1);
    expect(parsed.count).toBe(1);
    expect(parsed.symbols[0]).toMatchObject({
      name: 'ALpOperatorPawn',
      kind: 'Class',
      line: 26,
      column: 14,
    });
  });

  it('filters by symbol kind names', async () => {
    const request = jest.fn(async () => [
      {
        name: 'ALpCharacterPawn',
        kind: 5,
        location: {
          uri: 'file:///C:/Source/A.h',
          range: { start: { line: 60, character: 12 }, end: { line: 60, character: 26 } },
        },
      },
      {
        name: 'FLpMoverCustomInputs',
        kind: 23,
        location: {
          uri: 'file:///C:/Source/B.h',
          range: { start: { line: 10, character: 7 }, end: { line: 10, character: 27 } },
        },
      },
    ]);
    const client = { request } as unknown as LSPClient;

    const parsed = JSON.parse(
      await workspaceSymbolSearch(client, makeTracker(), 'Lp', {
        projectRoot,
        kinds: ['Class'],
        timeoutSeconds: 1,
        deep: false,
      })
    );

    expect(parsed.count).toBe(1);
    expect(parsed.symbols[0].name).toBe('ALpCharacterPawn');
  });

  it('keeps querying until the index answers', async () => {
    let calls = 0;
    const request = jest.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return [];
      }
      return [
        {
          name: 'ULpProgressionService',
          kind: 5,
          location: {
            uri: 'file:///C:/Source/C.h',
            range: { start: { line: 4, character: 6 }, end: { line: 4, character: 27 } },
          },
        },
      ];
    });
    const client = { request } as unknown as LSPClient;

    const parsed = JSON.parse(
      await workspaceSymbolSearch(client, makeTracker(), 'ULpProgressionService', {
        projectRoot,
        timeoutSeconds: 5,
        deep: false,
      })
    );

    expect(parsed.found).toBe(true);
    // One deadline iteration queries every name variant, so attempts counts rounds, not calls.
    expect(parsed.attempts).toBeGreaterThanOrEqual(1);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('falls back to opening name-matched headers when the index is cold', async () => {
    writeFileSync(join(projectRoot, 'Source', 'LpWidget.h'), '#pragma once\n');
    const request = jest.fn(async (method: string) => {
      if (method === 'workspace/symbol') {
        return [];
      }
      return [
        {
          name: 'ULpWidget',
          kind: 5,
          range: {
            start: { line: 7, character: 6 },
            end: { line: 20, character: 1 },
          },
          selectionRange: {
            start: { line: 7, character: 6 },
            end: { line: 7, character: 15 },
          },
        },
      ];
    });
    const client = { request } as unknown as LSPClient;

    const parsed = JSON.parse(
      await workspaceSymbolSearch(client, makeTracker(), 'ULpWidget', {
        projectRoot,
        scanDirs: ['Source'],
        maxFiles: 2,
        timeoutSeconds: 1,
      })
    );

    expect(parsed.found).toBe(true);
    expect(parsed.foundBy).toBe('file-scan');
    expect(parsed.filesScanned).toBe(1); // count; the list is scannedFiles
    expect(parsed.symbols[0]).toMatchObject({ name: 'ULpWidget', line: 8, column: 7 });
  });

  it('reports the variants it tried when nothing matches', async () => {
    const client = { request: jest.fn(async () => []) } as unknown as LSPClient;

    const parsed = JSON.parse(
      await workspaceSymbolSearch(client, makeTracker(), 'ULpNope', {
        projectRoot,
        scanDirs: ['Source'],
        timeoutSeconds: 1,
      })
    );

    expect(parsed.found).toBe(false);
    expect(parsed.variants).toContain('ULpNope');
    expect(parsed.variants).toContain('LpNope');
    expect(parsed.note).toMatch(/background index/);
  });

  it('honours the limit', async () => {
    const many = Array.from({ length: 10 }, (_unused, index) => ({
      name: `Symbol${index}`,
      kind: 5,
      location: {
        uri: 'file:///C:/Source/D.h',
        range: { start: { line: index, character: 0 }, end: { line: index, character: 8 } },
      },
    }));
    const client = { request: jest.fn(async () => many) } as unknown as LSPClient;

    const parsed = JSON.parse(
      await workspaceSymbolSearch(client, makeTracker(), 'Symbol', {
        projectRoot,
        limit: 4,
        timeoutSeconds: 1,
        deep: false,
      })
    );

    expect(parsed.count).toBe(10);
    expect(parsed.returned).toBe(4);
    expect(parsed.truncated).toBe(true);
  });
});

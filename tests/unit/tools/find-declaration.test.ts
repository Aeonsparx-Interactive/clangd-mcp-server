// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import type { LSPClient } from '../../../src/lsp-client.js';
import type { FileTracker } from '../../../src/file-tracker.js';
import { findDeclaration } from '../../../src/tools/find-declaration.js';

// URIs must be Windows-absolute: uriToPath() wraps fileURLToPath(), which
// throws on 'file:///Source/D.h' when the suite runs on Windows.
const URI = 'file:///C:/Source/Lp/Public/Character/LpOperatorPawn.h';
const FILE = 'Source/Lp/Public/Character/LpOperatorPawn.h';

function makeTracker() {
  return {
    ensureFileOpen: jest.fn(async () => URI),
  } as unknown as FileTracker;
}

describe('findDeclaration', () => {
  it('requests textDocument/declaration and reports 1-based locations', async () => {
    const request = jest.fn(async () => [
      {
        uri: URI,
        range: { start: { line: 60, character: 6 }, end: { line: 60, character: 21 } },
      },
    ]);
    const client = { request } as unknown as LSPClient;

    const parsed = JSON.parse(await findDeclaration(client, makeTracker(), FILE, 61, 7));

    expect(request).toHaveBeenCalledWith('textDocument/declaration', {
      textDocument: { uri: URI },
      position: { line: 60, character: 6 },
    });
    expect(parsed.found).toBe(true);
    expect(parsed.count).toBe(1);
    expect(parsed.locations[0]).toMatchObject({ line: 61, column: 7, uri: URI });
    expect(parsed.locations[0].file).toContain('LpOperatorPawn.h');
  });

  it('reports not-found when clangd returns nothing', async () => {
    const client = { request: jest.fn(async () => null) } as unknown as LSPClient;
    const parsed = JSON.parse(await findDeclaration(client, makeTracker(), FILE, 61, 7));
    expect(parsed.found).toBe(false);
    expect(parsed.message).toBe('No declaration found');
  });
});

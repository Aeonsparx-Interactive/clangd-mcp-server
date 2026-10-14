// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import type { LSPClient } from '../../../src/lsp-client.js';
import type { FileTracker } from '../../../src/file-tracker.js';
import { getContext } from '../../../src/tools/context.js';

const URI = 'file:///C:/Source/Lp/Public/Character/LpOperatorPawn.h';
const FILE = 'Source/Lp/Public/Character/LpOperatorPawn.h';

function makeTracker() {
  return {
    ensureFileOpen: jest.fn(async () => URI),
  } as unknown as FileTracker;
}

const responses: Record<string, unknown> = {
  'textDocument/hover': {
    contents: { kind: 'markdown', value: '```cpp\nclass ALpOperatorPawn\n```' },
    range: { start: { line: 60, character: 6 }, end: { line: 60, character: 21 } },
  },
  'textDocument/definition': [
    { uri: URI, range: { start: { line: 60, character: 6 }, end: { line: 60, character: 21 } } },
  ],
  'textDocument/declaration': [
    { uri: URI, range: { start: { line: 25, character: 13 }, end: { line: 25, character: 28 } } },
  ],
  'textDocument/references': [
    { uri: URI, range: { start: { line: 25, character: 13 }, end: { line: 25, character: 28 } } },
    {
      uri: 'file:///C:/Source/Lp/Private/Character/LpOperatorPawn.cpp',
      range: { start: { line: 35, character: 21 }, end: { line: 35, character: 36 } },
    },
  ],
  'textDocument/documentSymbol': [
    {
      name: 'ALpOperatorPawn',
      kind: 5,
      range: { start: { line: 25, character: 0 }, end: { line: 80, character: 1 } },
      selectionRange: { start: { line: 25, character: 6 }, end: { line: 25, character: 21 } },
      children: [
        {
          name: 'ProduceInput_Implementation',
          kind: 6,
          range: { start: { line: 36, character: 2 }, end: { line: 40, character: 3 } },
          selectionRange: { start: { line: 37, character: 13 }, end: { line: 37, character: 38 } },
        },
      ],
    },
  ],
};

describe('getContext', () => {
  it('aggregates hover, definition and references by default', async () => {
    const request = jest.fn(async (method: string) => responses[method]);
    const client = { request } as unknown as LSPClient;

    const parsed = JSON.parse(await getContext(client, makeTracker(), FILE, 26, 14));

    expect(parsed.found).toBe(true);
    expect(parsed.file).toBe(FILE);
    expect(parsed.line).toBe(26);
    expect(parsed.hover).toContain('class ALpOperatorPawn');
    expect(parsed.definition[0]).toMatchObject({ line: 61, column: 7 });
    expect(parsed.references.count).toBe(2);
    expect(parsed.references.locations[1]).toMatchObject({ line: 36, column: 22 });
    // declaration and outline are not part of the default set
    expect(parsed.declaration).toBeUndefined();
    expect(parsed.outline).toBeUndefined();
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      'textDocument/hover',
      'textDocument/definition',
      'textDocument/references',
    ]);
  });

  it('adds declaration and the flattened outline when asked', async () => {
    const request = jest.fn(async (method: string) => responses[method]);
    const client = { request } as unknown as LSPClient;

    const parsed = JSON.parse(
      await getContext(client, makeTracker(), FILE, 26, 14, {
        include: ['declaration', 'outline'],
      })
    );

    expect(parsed.declaration[0]).toMatchObject({ line: 26, column: 14 });
    expect(parsed.outline).toHaveLength(2);
    expect(parsed.outline[1]).toMatchObject({
      name: 'ProduceInput_Implementation',
      kind: 'Method',
      container: 'ALpOperatorPawn',
      line: 38,
      column: 14,
    });
    expect(parsed.hover).toBeUndefined();
  });

  it('records per-section errors instead of throwing', async () => {
    const request = jest.fn(async (method: string) => {
      if (method === 'textDocument/hover') {
        throw new Error('hover exploded');
      }
      return responses[method];
    });
    const client = { request } as unknown as LSPClient;

    const parsed = JSON.parse(await getContext(client, makeTracker(), FILE, 26, 14));

    expect(parsed.found).toBe(true);
    expect(parsed.hoverError).toBe('hover exploded');
    expect(parsed.definition[0]).toMatchObject({ line: 61, column: 7 });
  });

  it('reports not-found when every section is empty', async () => {
    const client = { request: jest.fn(async () => null) } as unknown as LSPClient;
    const parsed = JSON.parse(
      await getContext(client, makeTracker(), FILE, 26, 14, {
        include: ['hover', 'definition', 'references'],
      })
    );
    expect(parsed.found).toBe(false);
  });
});

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LSPClient } from '../../../src/lsp-client.js';
import type { FileTracker } from '../../../src/file-tracker.js';
import { normalizeToUri } from '../../../src/utils/uri.js';
import {
  nameVariants,
  walkSourceFiles,
  filesByName,
  filesByContent,
  fileScanSymbols,
} from '../../../src/tools/file-scan.js';

let projectRoot: string;

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'file-scan-test-'));
  mkdirSync(join(projectRoot, 'Source', 'Lp', 'Public', 'Character'), { recursive: true });
  mkdirSync(join(projectRoot, 'Plugins', 'Extra', 'Source'), { recursive: true });
  mkdirSync(join(projectRoot, 'Intermediate'), { recursive: true });

  writeFileSync(
    join(projectRoot, 'Source', 'Lp', 'Public', 'Character', 'LpOperatorPawn.h'),
    '#pragma once\nUCLASS()\nclass ALpOperatorPawn\n{\n};\n'
  );
  writeFileSync(
    join(projectRoot, 'Source', 'Lp', 'Public', 'Character', 'LpOperatorPawn.cpp'),
    '#include "Character/LpOperatorPawn.h"\n'
  );
  writeFileSync(join(projectRoot, 'Plugins', 'Extra', 'Source', 'ExtraWidget.h'), '#pragma once\n');
  writeFileSync(join(projectRoot, 'Intermediate', 'StaleWidget.h'), '#pragma once\n');
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('nameVariants', () => {
  it('adds and strips the Unreal prefixes', () => {
    const variants = nameVariants('LpItemService');
    expect(variants).toContain('LpItemService');
    expect(variants).toContain('ULpItemService');
    expect(variants).toContain('ALpItemService');
    // A leading engine prefix is stripped, so the reverse direction works too.
    expect(nameVariants('ULpItemService')).toContain('LpItemService');
  });

  it('keeps a leading letter that is part of the name', () => {
    const variants = nameVariants('LpMoverInputs');
    expect(variants).toContain('LpMoverInputs');
    expect(variants).toContain('FLpMoverInputs');
  });

  it('does not strip a prefix from a short stem', () => {
    expect(nameVariants('Ab')).toContain('Ab');
    expect(nameVariants('Ab')).not.toContain('b');
  });
});

describe('walkSourceFiles', () => {
  it('collects source files under the scan directories only', () => {
    const files = walkSourceFiles(projectRoot);
    expect(files).toContain(join(projectRoot, 'Source', 'Lp', 'Public', 'Character', 'LpOperatorPawn.h'));
    expect(files).toContain(join(projectRoot, 'Plugins', 'Extra', 'Source', 'ExtraWidget.h'));
    expect(files.some((file) => file.includes('Intermediate'))).toBe(false);
  });
});

describe('filesByName', () => {
  it('prefers the header over the implementation file', () => {
    const files = walkSourceFiles(projectRoot);
    const hits = filesByName(files, nameVariants('LpOperatorPawn'));
    expect(hits[0]).toContain('LpOperatorPawn.h');
  });
});

describe('filesByContent', () => {
  it('matches on file contents and skips oversized files', () => {
    const abs = [
      join(projectRoot, 'Source', 'Lp', 'Public', 'Character', 'LpOperatorPawn.h'),
      join(projectRoot, 'Intermediate', 'StaleWidget.h'),
    ];
    writeFileSync(join(projectRoot, 'Intermediate', 'Big.h'), 'x'.repeat(401 * 1024));

    expect(filesByContent(abs, ['ALpOperatorPawn'])).toEqual([abs[0]]);
    expect(filesByContent([join(projectRoot, 'Intermediate', 'Big.h')], ['xxx'])).toEqual([]);
  });
});

describe('fileScanSymbols', () => {
  let client: LSPClient;
  let tracker: FileTracker;
  let ensureFileOpen: jest.Mock<(path: string) => Promise<string>>;

  beforeEach(() => {
    ensureFileOpen = jest.fn<(path: string) => Promise<string>>(
      async (path: string) => normalizeToUri(path)
    );
    tracker = { ensureFileOpen } as unknown as FileTracker;
  });

  it('opens the name-matched header and reports its symbols', async () => {
    const request = jest.fn(async () => [
      {
        name: 'ALpOperatorPawn',
        kind: 5,
        range: { start: { line: 2, character: 6 }, end: { line: 4, character: 1 } },
        selectionRange: { start: { line: 2, character: 6 }, end: { line: 2, character: 21 } },
      },
    ]);
    client = { request } as unknown as LSPClient;

    const result = await fileScanSymbols(client, tracker, 'ALpOperatorPawn', {
      projectRoot,
      scanDirs: ['Source', 'Plugins'],
      maxFiles: 2,
    });

    const header = join(projectRoot, 'Source', 'Lp', 'Public', 'Character', 'LpOperatorPawn.h');
    // walkSourceFiles yields absolute paths; the scan opens them as-is.
    expect(ensureFileOpen).toHaveBeenCalledWith(header);
    expect(result.matchedBy).toBe('filename');
    // maxFiles is 2, and the name matches both the header and its .cpp twin.
    expect(result.filesScanned).toEqual([header, expect.any(String)]);
    expect(result.symbols[0]).toMatchObject({
      name: 'ALpOperatorPawn',
      kind: 'Class',
      file: header,
      line: 3,
      column: 7,
    });
  });

  it('reports no candidates when nothing matches', async () => {
    client = { request: jest.fn(async () => []) } as unknown as LSPClient;
    const result = await fileScanSymbols(client, tracker, 'NothingHere', {
      projectRoot,
      scanDirs: ['Source'],
      maxFiles: 1,
    });
    expect(result.matchedBy).toBe('none');
    expect(result.filesScanned).toEqual([]);
  });
});

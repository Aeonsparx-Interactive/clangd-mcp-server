// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, afterEach } from '@jest/globals';
import {
  coordBase,
  toLspLine,
  toLspColumn,
  fromLspLine,
  fromLspColumn,
  toLspPosition,
  fromLspStart,
  lineDescription,
  columnDescription,
  minLine,
} from '../../../src/utils/coords.js';

describe('coords', () => {
  const savedCoordBase = process.env.COORD_BASE;

  afterEach(() => {
    if (savedCoordBase === undefined) {
      delete process.env.COORD_BASE;
    } else {
      process.env.COORD_BASE = savedCoordBase;
    }
  });

  describe('explicit base (no env dependence)', () => {
    it('converts a 1-based tool line to a 0-based LSP line', () => {
      expect(toLspLine(1, 1)).toBe(0);
      expect(toLspLine(26, 1)).toBe(25);
    });

    it('converts a 0-based LSP line back to 1-based output', () => {
      expect(fromLspLine(0, 1)).toBe(1);
      expect(fromLspLine(25, 1)).toBe(26);
    });

    it('leaves coordinates untouched when the base is 0', () => {
      expect(toLspLine(26, 0)).toBe(26);
      expect(fromLspLine(26, 0)).toBe(26);
      expect(toLspPosition(0, 0, 0)).toEqual({ line: 0, character: 0 });
    });

    it('round-trips a position pair', () => {
      const lsp = toLspPosition(61, 7, 1);
      expect(lsp).toEqual({ line: 60, character: 6 });
      expect(fromLspStart(lsp, 1)).toEqual({ line: 61, column: 7 });
    });

    it('clamps negative input to zero', () => {
      expect(toLspLine(0, 1)).toBe(0);
      expect(toLspColumn(-5, 1)).toBe(0);
    });
  });

  describe('env-driven base', () => {
    it('defaults to 1-based', () => {
      delete process.env.COORD_BASE;
      expect(coordBase()).toBe(1);
      expect(minLine()).toBe(1);
      expect(toLspLine(10)).toBe(9);
    });

    it('honours COORD_BASE=0', () => {
      process.env.COORD_BASE = '0';
      expect(coordBase()).toBe(0);
      expect(minLine()).toBe(0);
      expect(toLspLine(10)).toBe(10);
      expect(fromLspLine(10)).toBe(10);
    });

    it('describes the schema coordinates with the active base', () => {
      delete process.env.COORD_BASE;
      expect(lineDescription()).toBe('Line number (1-indexed)');
      expect(columnDescription()).toBe('Column number (1-indexed)');

      process.env.COORD_BASE = '0';
      expect(lineDescription()).toBe('Line number (0-indexed)');
      expect(columnDescription()).toBe('Column number (0-indexed)');
    });
  });
});

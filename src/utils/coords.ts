// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Coordinate base conversion.
 *
 * LSP wire positions are 0-based. The tool surface is 1-based by default
 * because that is what editors, compiler errors and humans use. Set
 * COORD_BASE=0 to restore the raw LSP convention.
 *
 * Conversion happens at the tool boundary only: every LSP request/response
 * below this layer stays 0-based.
 */

import { getProjectSettings } from './settings.js';

export type CoordBase = 0 | 1;

export function coordBase(): CoordBase {
  return getProjectSettings().coordBase;
}

/** Tool input line -> LSP line. */
export function toLspLine(line: number, base: CoordBase = coordBase()): number {
  return Math.max(0, line - base);
}

/** Tool input column -> LSP character. */
export function toLspColumn(column: number, base: CoordBase = coordBase()): number {
  return Math.max(0, column - base);
}

/** LSP line -> tool output line. */
export function fromLspLine(line: number, base: CoordBase = coordBase()): number {
  return line + base;
}

/** LSP character -> tool output column. */
export function fromLspColumn(character: number, base: CoordBase = coordBase()): number {
  return character + base;
}

/** Tool input pair -> LSP position. */
export function toLspPosition(
  line: number,
  column: number,
  base: CoordBase = coordBase()
): { line: number; character: number } {
  return { line: toLspLine(line, base), character: toLspColumn(column, base) };
}

/**
 * LSP position (a range/selection start) -> tool output pair, using the
 * field names the tools emit. Call sites pass `range.start` / `selectionRange.start`.
 */
export function fromLspStart(
  position: { line: number; character: number },
  base: CoordBase = coordBase()
): { line: number; column: number } {
  return { line: fromLspLine(position.line, base), column: fromLspColumn(position.character, base) };
}

/** Schema description text for a line parameter, honouring the configured base. */
export function lineDescription(): string {
  return coordBase() === 0
    ? 'Line number (0-indexed)'
    : 'Line number (1-indexed)';
}

/** Schema description text for a column parameter, honouring the configured base. */
export function columnDescription(): string {
  return coordBase() === 0
    ? 'Column number (0-indexed)'
    : 'Column number (1-indexed)';
}

/** Smallest accepted tool-input line for the configured base. */
export function minLine(): number {
  return coordBase();
}

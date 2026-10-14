// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Project-level settings for the MCP server, read from environment variables.
 *
 * These are deliberately generic: nothing here knows about Unreal Engine. A
 * project supplies the flavour through env (see README "Project settings"),
 * which keeps the server usable for any clangd-driven codebase.
 */

export type CoordBase = 0 | 1;

export interface ProjectSettings {
  /** Root the project lives in (PROJECT_ROOT, default process.cwd()). Relative file paths in tool inputs resolve against it. */
  projectRoot: string;
  /** Base for line/column in tool inputs and outputs. Default 1 (LSP convention as exposed by every editor). */
  coordBase: CoordBase;
  /** Directories (relative to project root) searched by the deep file scan. */
  scanDirs: string[];
  /** Files opened before a workspace symbol query so clangd has a warm AST. */
  seedFiles: string[];
  /** Single-letter type prefixes stripped/prepended when matching symbol names. */
  namePrefixes: string[];
  /** Path to a JSON file listing diagnostics to drop. */
  lintFilterPath?: string;
  /** How long a workspace symbol query keeps retrying before giving up. */
  symbolTimeoutSeconds: number;
  /** How many files the deep scan is allowed to open (each costs seconds of AST build). */
  maxScanFiles: number;
  /** Default seconds to wait for diagnostics on a freshly opened file. */
  diagnosticsTimeoutSeconds: number;
}

/** Split a comma/semicolon separated env value into trimmed entries. */
export function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function readInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readCoordBase(value: string | undefined): CoordBase {
  return value === '0' ? 0 : 1;
}

/**
 * Read project settings from the environment.
 * Cheap enough to call per request; env is read live so a CLI invocation can
 * override values without a restart.
 */
export function getProjectSettings(): ProjectSettings {
  const env = process.env;

  return {
    projectRoot: env.PROJECT_ROOT && env.PROJECT_ROOT.length > 0 ? env.PROJECT_ROOT : process.cwd(),
    coordBase: readCoordBase(env.COORD_BASE),
    scanDirs: splitList(env.SCAN_DIRS).length > 0 ? splitList(env.SCAN_DIRS) : ['Source', 'Plugins'],
    seedFiles: splitList(env.SEED_FILES),
    namePrefixes: splitList(env.NAME_PREFIXES).length > 0 ? splitList(env.NAME_PREFIXES) : ['A', 'U', 'F', 'I', 'E'],
    lintFilterPath: env.LINT_FILTER && env.LINT_FILTER.length > 0 ? env.LINT_FILTER : undefined,
    symbolTimeoutSeconds: readInt(env.CLANGD_SYMBOL_TIMEOUT, 45),
    maxScanFiles: readInt(env.CLANGD_MAX_SCAN_FILES, 6),
    diagnosticsTimeoutSeconds: readInt(env.CLANGD_DIAGNOSTICS_TIMEOUT, 30)
  };
}

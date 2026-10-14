// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, afterEach } from '@jest/globals';
import { getProjectSettings } from '../../../src/utils/settings.js';

describe('settings', () => {
  const watched = [
    'COORD_BASE',
    'SCAN_DIRS',
    'SEED_FILES',
    'NAME_PREFIXES',
    'LINT_FILTER',
    'CLANGD_SYMBOL_TIMEOUT',
    'CLANGD_MAX_SCAN_FILES',
    'CLANGD_DIAGNOSTICS_TIMEOUT',
  ];
  const saved: Record<string, string | undefined> = {};
  for (const key of watched) {
    saved[key] = process.env[key];
  }

  afterEach(() => {
    for (const key of watched) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key] as string;
      }
    }
  });

  it('returns the Unreal-flavoured defaults with no env set', () => {
    for (const key of watched) {
      delete process.env[key];
    }
    const settings = getProjectSettings();
    expect(settings.coordBase).toBe(1);
    expect(settings.scanDirs).toEqual(['Source', 'Plugins']);
    expect(settings.seedFiles).toEqual([]);
    expect(settings.namePrefixes).toEqual(['A', 'U', 'F', 'I', 'E']);
    expect(settings.lintFilterPath).toBeUndefined();
    expect(settings.symbolTimeoutSeconds).toBe(45);
    expect(settings.maxScanFiles).toBe(6);
    expect(settings.diagnosticsTimeoutSeconds).toBe(30);
  });

  it('reads COORD_BASE=0', () => {
    process.env.COORD_BASE = '0';
    expect(getProjectSettings().coordBase).toBe(0);
  });

  it('splits comma and semicolon separated lists', () => {
    // Deliberately not whitespace: SEED_FILES paths may contain spaces ("Program Files").
    process.env.SCAN_DIRS = 'Source, Plugins; Extras';
    process.env.SEED_FILES = 'Source/Lp/Public/Character/LpOperatorPawn.cpp';
    process.env.NAME_PREFIXES = 'A,U;F';
    const settings = getProjectSettings();
    expect(settings.scanDirs).toEqual(['Source', 'Plugins', 'Extras']);
    expect(settings.seedFiles).toEqual([
      'Source/Lp/Public/Character/LpOperatorPawn.cpp',
    ]);
    expect(settings.namePrefixes).toEqual(['A', 'U', 'F']);
  });

  it('parses the timeout and scan budgets', () => {
    process.env.CLANGD_SYMBOL_TIMEOUT = '12';
    process.env.CLANGD_MAX_SCAN_FILES = '3';
    process.env.CLANGD_DIAGNOSTICS_TIMEOUT = '90';
    const settings = getProjectSettings();
    expect(settings.symbolTimeoutSeconds).toBe(12);
    expect(settings.maxScanFiles).toBe(3);
    expect(settings.diagnosticsTimeoutSeconds).toBe(90);
  });

  it('falls back to defaults for unparseable numbers', () => {
    process.env.CLANGD_SYMBOL_TIMEOUT = 'soon';
    process.env.CLANGD_MAX_SCAN_FILES = '0';
    expect(getProjectSettings().symbolTimeoutSeconds).toBe(45);
    expect(getProjectSettings().maxScanFiles).toBe(6);
  });

  it('exposes LINT_FILTER as the filter path', () => {
    process.env.LINT_FILTER = 'Script/clangd-mcp/lint-filter.json';
    expect(getProjectSettings().lintFilterPath).toBe(
      'Script/clangd-mcp/lint-filter.json'
    );
  });
});

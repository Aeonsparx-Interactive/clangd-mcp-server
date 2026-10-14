// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getStatus } from '../../../src/tools/status.js';
import type { FileTracker } from '../../../src/file-tracker.js';
import type { ClangdConfig } from '../../../src/config-detector.js';

function makeSources(overrides: Record<string, unknown> = {}) {
  const stats = {
    pid: 4752,
    exitCode: null,
    ready: true,
    restartCount: 0,
    uptimeSeconds: 120,
    clangdPath: 'C:/clangd.exe',
    clangdArgs: [
      '--compile-commands-dir=/tmp/cdb',
      '--background-index',
      '--clang-tidy=false',
      '--offset-encoding=utf-16',
    ],
    serverVersion: '22.1.3',
    ...overrides,
  };
  const manager = { getStats: () => stats };
  const fileTracker = { getOpenFiles: () => new Set(['file:///a.cpp']) } as unknown as FileTracker;
  const config: ClangdConfig = {
    clangdPath: stats.clangdPath,
    clangdArgs: stats.clangdArgs,
    projectRoot: '/tmp/project',
    compileCommandsPath: '/tmp/cdb/compile_commands.json',
    isChromiumProject: false,
  };
  const client = { getPendingRequestCount: () => 2 };
  return { manager, fileTracker, config, client };
}

describe('getStatus', () => {
  it('reports clangd process, index and settings state', async () => {
    const parsed = JSON.parse(await getStatus(makeSources()));

    expect(parsed.ready).toBe(true);
    expect(parsed.clangdPid).toBe(4752);
    expect(parsed.clangdVersion).toBe('22.1.3');
    expect(parsed.backgroundIndex).toBe(true);
    expect(parsed.clangTidy).toBe(false);
    expect(parsed.compilationDatabaseExists).toBe(false);
    expect(parsed.openDocuments).toEqual(['file:///a.cpp']);
    expect(parsed.pendingRequests).toBe(2);
    expect(parsed.settings.coordBase).toBe(1);
    expect(parsed.settings.scanDirs).toEqual(['Source', 'Plugins']);
  });

  it('marks the database as present when it exists', async () => {
    const dir = join(tmpdir(), `status-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'compile_commands.json'), '[]');

    const sources = makeSources();
    sources.config.compileCommandsPath = join(dir, 'compile_commands.json');
    sources.config.projectRoot = dir;

    const parsed = JSON.parse(await getStatus(sources));
    expect(parsed.compilationDatabaseExists).toBe(true);
    expect(parsed.compileCommandsDir).toBe(dir);

    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a dead clangd process', async () => {
    const parsed = JSON.parse(
      await getStatus(makeSources({ ready: false, exitCode: 1, restartCount: 2 }))
    );
    expect(parsed.ready).toBe(false);
    expect(parsed.clangdExitCode).toBe(1);
    expect(parsed.restartCount).toBe(2);
  });
});

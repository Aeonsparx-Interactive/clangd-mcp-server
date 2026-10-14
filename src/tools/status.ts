// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Server status: the cheap call that tells you what clangd is actually doing
 * before you spend 45 seconds on a symbol query.
 *
 * Answers three questions a caller cannot otherwise answer: is clangd alive,
 * is the background index running and how far along, and which project
 * settings (coordinate base, scan directories, lint filter) are in effect.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

import { FileTracker } from '../file-tracker.js';
import { ClangdConfig } from '../config-detector.js';
import { logger } from '../utils/logger.js';
import { getProjectSettings } from '../utils/settings.js';

/** The slice of ClangdManager the status tool needs (mockable in tests). */
export interface StatusManager {
  getStats(): {
    pid: number | null;
    exitCode: number | null;
    ready: boolean;
    restartCount: number;
    uptimeSeconds: number;
    clangdPath: string;
    clangdArgs: string[];
    serverVersion?: string;
  };
}

export interface StatusSources {
  manager: StatusManager;
  fileTracker: FileTracker;
  config: ClangdConfig;
  client?: { getPendingRequestCount(): number };
}

/** `--flag` means on, `--flag=false` means off, absent means clangd's default. */
function flagState(args: string[], flag: string): boolean | undefined {
  const arg = args.find((candidate) => candidate === flag || candidate.startsWith(`${flag}=`));
  if (!arg) {
    return undefined;
  }
  return !arg.includes('=false');
}

function countIndexFiles(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * clangd keeps its index next to the compilation database, and falls back to
 * the project root. Report whichever exists.
 */
function findIndexCacheDir(config: ClangdConfig): string | undefined {
  const candidates: string[] = [];

  if (config.compileCommandsPath) {
    const cdbDir = dirname(config.compileCommandsPath);
    candidates.push(join(cdbDir, '.cache', 'clangd', 'index'));
  }

  candidates.push(join(config.projectRoot, '.cache', 'clangd', 'index'));

  return candidates.find((candidate) => existsSync(candidate));
}

function readClangdVersion(clangdPath: string): string | undefined {
  try {
    const result = spawnSync(clangdPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const match = result.stdout.match(/clangd version ([\d.]+\w*)/);
      if (match) {
        return match[1];
      }
    }
  } catch (error) {
    logger.debug('Failed to get clangd version:', error);
  }

  return undefined;
}

export async function getStatus(sources: StatusSources): Promise<string> {
  const { manager, fileTracker, config } = sources;
  const stats = manager.getStats();
  const settings = getProjectSettings();

  const indexCacheDir = findIndexCacheDir(config);
  const compileCommandsDir = config.compileCommandsPath ? dirname(config.compileCommandsPath) : undefined;

  const status = {
    ready: stats.ready,
    clangdPath: stats.clangdPath,
    clangdVersion: stats.serverVersion ?? readClangdVersion(stats.clangdPath),
    clangdPid: stats.pid,
    clangdExitCode: stats.exitCode,
    restartCount: stats.restartCount,
    uptimeSeconds: stats.uptimeSeconds,
    clangdArgs: stats.clangdArgs,
    backgroundIndex: flagState(stats.clangdArgs, '--background-index'),
    clangTidy: flagState(stats.clangdArgs, '--clang-tidy'),
    projectRoot: config.projectRoot,
    compileCommandsDir,
    compilationDatabaseExists: config.compileCommandsPath ? existsSync(config.compileCommandsPath) : false,
    indexCacheDir,
    indexFiles: indexCacheDir ? countIndexFiles(indexCacheDir) : 0,
    openDocuments: [...fileTracker.getOpenFiles()],
    pendingRequests: sources.client?.getPendingRequestCount() ?? 0,
    settings: {
      coordBase: settings.coordBase,
      scanDirs: settings.scanDirs,
      seedFiles: settings.seedFiles,
      namePrefixes: settings.namePrefixes,
      lintFilterPath: settings.lintFilterPath,
      symbolTimeoutSeconds: settings.symbolTimeoutSeconds,
      maxScanFiles: settings.maxScanFiles,
      diagnosticsTimeoutSeconds: settings.diagnosticsTimeoutSeconds
    }
  };

  return JSON.stringify(status, null, 2);
}

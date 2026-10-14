#!/usr/bin/env node

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './utils/logger.js';
import { detectConfiguration } from './config-detector.js';
import { ClangdManager } from './clangd-manager.js';
import { FileTracker } from './file-tracker.js';

import { findDefinition } from './tools/find-definition.js';
import { findReferences } from './tools/find-references.js';
import { getHover } from './tools/get-hover.js';
import { workspaceSymbolSearch } from './tools/workspace-symbol.js';
import { findImplementations } from './tools/find-implementations.js';
import { getDocumentSymbols } from './tools/document-symbols.js';
import { getDiagnostics, DiagnosticsCache } from './tools/get-diagnostics.js';
import { getCallHierarchy } from './tools/get-call-hierarchy.js';
import { getTypeHierarchy } from './tools/get-type-hierarchy.js';
import { findDeclaration } from './tools/find-declaration.js';
import { getContext, ContextSection } from './tools/context.js';
import { getStatus } from './tools/status.js';
import { getProjectSettings } from './utils/settings.js';
import { lineDescription, columnDescription, minLine } from './utils/coords.js';

// Global state
let clangdManager: ClangdManager | null = null;
let fileTracker: FileTracker | null = null;
let diagnosticsCache: DiagnosticsCache | null = null;
let initializationPromise: Promise<void> | null = null;
let isShuttingDown: boolean = false;

/**
 * Validate MCP tool arguments
 */
function validateToolArgs(name: string, args: any): void {
  if (!args || typeof args !== 'object') {
    throw new Error('Invalid arguments: must be an object');
  }

  switch (name) {
    case 'find_definition':
    case 'find_references':
    case 'get_hover':
    case 'find_implementations':
    case 'find_declaration':
      if (typeof args.file_path !== 'string') {
        throw new Error('Invalid file_path: must be a string');
      }
      if (typeof args.line !== 'number' || !Number.isInteger(args.line) || args.line < minLine()) {
        throw new Error(`Invalid line: must be an integer >= ${minLine()} (COORD_BASE=${minLine()})`);
      }
      if (typeof args.column !== 'number' || !Number.isInteger(args.column) || args.column < minLine()) {
        throw new Error(`Invalid column: must be an integer >= ${minLine()} (COORD_BASE=${minLine()})`);
      }
      if (name === 'find_references' && args.include_declaration !== undefined && typeof args.include_declaration !== 'boolean') {
        throw new Error('Invalid include_declaration: must be a boolean');
      }
      break;

    case 'workspace_symbol_search':
      if (typeof args.query !== 'string') {
        throw new Error('Invalid query: must be a string');
      }
      if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit <= 0)) {
        throw new Error('Invalid limit: must be a positive integer');
      }
      if (args.timeout_seconds !== undefined && (typeof args.timeout_seconds !== 'number' || args.timeout_seconds <= 0)) {
        throw new Error('Invalid timeout_seconds: must be a positive number');
      }
      if (args.deep !== undefined && typeof args.deep !== 'boolean') {
        throw new Error('Invalid deep: must be a boolean');
      }
      if (args.max_files !== undefined && (typeof args.max_files !== 'number' || !Number.isInteger(args.max_files) || args.max_files <= 0)) {
        throw new Error('Invalid max_files: must be a positive integer');
      }
      if (args.kinds !== undefined && !Array.isArray(args.kinds)) {
        throw new Error('Invalid kinds: must be an array of symbol kind names or numbers');
      }
      break;

    case 'get_context':
      if (typeof args.file_path !== 'string') {
        throw new Error('Invalid file_path: must be a string');
      }
      if (typeof args.line !== 'number' || !Number.isInteger(args.line) || args.line < minLine()) {
        throw new Error(`Invalid line: must be an integer >= ${minLine()} (COORD_BASE=${minLine()})`);
      }
      if (typeof args.column !== 'number' || !Number.isInteger(args.column) || args.column < minLine()) {
        throw new Error(`Invalid column: must be an integer >= ${minLine()} (COORD_BASE=${minLine()})`);
      }
      if (args.include !== undefined) {
        if (!Array.isArray(args.include)) {
          throw new Error('Invalid include: must be an array of hover|definition|declaration|references|outline');
        }
        const allowed = ['hover', 'definition', 'declaration', 'references', 'outline'];
        const bad = args.include.filter((section: unknown) => typeof section !== 'string' || !allowed.includes(section as string));
        if (bad.length > 0) {
          throw new Error(`Invalid include: ${bad.join(', ')} (allowed: ${allowed.join('|')})`);
        }
      }
      break;

    case 'get_status':
      // No arguments.
      break;

    case 'get_document_symbols':
      if (typeof args.file_path !== 'string') {
        throw new Error('Invalid file_path: must be a string');
      }
      break;

    case 'get_diagnostics':
      if (typeof args.file_path !== 'string') {
        throw new Error('Invalid file_path: must be a string');
      }
      if (args.force_refresh !== undefined && typeof args.force_refresh !== 'boolean') {
        throw new Error('Invalid force_refresh: must be a boolean');
      }
      if (args.min_severity !== undefined) {
        const allowed = ['error', 'warning', 'information', 'hint'];
        if (typeof args.min_severity !== 'string' || !allowed.includes(args.min_severity)) {
          throw new Error(`Invalid min_severity: must be one of ${allowed.join('|')}`);
        }
      }
      if (args.include_tidy !== undefined && typeof args.include_tidy !== 'boolean') {
        throw new Error('Invalid include_tidy: must be a boolean');
      }
      if (args.compact !== undefined && typeof args.compact !== 'boolean') {
        throw new Error('Invalid compact: must be a boolean');
      }
      if (args.timeout_seconds !== undefined && (typeof args.timeout_seconds !== 'number' || args.timeout_seconds <= 0)) {
        throw new Error('Invalid timeout_seconds: must be a positive number');
      }
      break;

    case 'get_call_hierarchy':
    case 'get_type_hierarchy':
      if (typeof args.file_path !== 'string') {
        throw new Error('Invalid file_path: must be a string');
      }
      if (typeof args.line !== 'number' || !Number.isInteger(args.line) || args.line < minLine()) {
        throw new Error(`Invalid line: must be an integer >= ${minLine()} (COORD_BASE=${minLine()})`);
      }
      if (typeof args.column !== 'number' || !Number.isInteger(args.column) || args.column < minLine()) {
        throw new Error(`Invalid column: must be an integer >= ${minLine()} (COORD_BASE=${minLine()})`);
      }
      break;

    default:
      // Unknown tool, will be caught by the switch below
      break;
  }
}

/**
 * Initialize clangd (lazy initialization on first query)
 * Uses a lock to prevent concurrent initialization attempts
 */
async function ensureClangdInitialized(): Promise<void> {
  // Check if shutting down
  if (isShuttingDown) {
    throw new Error('Server is shutting down');
  }

  // Fast path: already initialized
  if (clangdManager && clangdManager.isReady()) {
    return;
  }

  // If initialization is in progress, wait for it
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization with lock
  initializationPromise = (async () => {
    try {
      logger.info('Initializing clangd...');

      const config = detectConfiguration();
      clangdManager = new ClangdManager(config);
      await clangdManager.start();

      fileTracker = new FileTracker(clangdManager.getClient());

      // Initialize diagnostics cache
      diagnosticsCache = new DiagnosticsCache(clangdManager.getClient());

      // Hook diagnostics cache to file tracker eviction
      fileTracker.onFileClosed((uri) => {
        if (diagnosticsCache) {
          diagnosticsCache.clearForFile(uri);
        }
      });

      logger.info('Clangd initialization complete');
    } finally {
      // Release lock after completion (success or failure)
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

/**
 * Main server setup
 */
async function main() {
  // One-shot CLI mode: `clangd-mcp-server cli <command> ...` (see src/cli.ts).
  // Same tools, same coordinate base, no MCP transport — for shell and CI use.
  const argv = process.argv.slice(2);
  if (argv[0] === 'cli' || argv[0] === '--cli') {
    const { runCli } = await import('./cli.js');
    process.exitCode = await runCli(argv.slice(1));
    return;
  }

  logger.info('Starting clangd MCP server');

  const server = new Server(
    {
      name: 'clangd-mcp-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'find_definition',
          description: 'Find the definition of a symbol at a given location in a file',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              line: {
                type: 'number',
                description: lineDescription()
              },
              column: {
                type: 'number',
                description: columnDescription()
              }
            },
            required: ['file_path', 'line', 'column']
          }
        },
        {
          name: 'find_references',
          description: 'Find all references to a symbol at a given location',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              line: {
                type: 'number',
                description: lineDescription()
              },
              column: {
                type: 'number',
                description: columnDescription()
              },
              include_declaration: {
                type: 'boolean',
                description: 'Include the declaration in the results (default: true)',
                default: true
              }
            },
            required: ['file_path', 'line', 'column']
          }
        },
        {
          name: 'get_hover',
          description: 'Get hover information (type, documentation) for a symbol at a given location',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              line: {
                type: 'number',
                description: lineDescription()
              },
              column: {
                type: 'number',
                description: columnDescription()
              }
            },
            required: ['file_path', 'line', 'column']
          }
        },
        {
          name: 'workspace_symbol_search',
          description: 'Search for symbols across the entire workspace',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for symbol names'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of results to return (default: 100)',
                default: 100
              },
              kinds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by symbol kind, e.g. ["Class", "Struct"] or [5, 23]. LSP kind names accepted'
              },
              timeout_seconds: {
                type: 'number',
                description: `Deadline for the index query in seconds (default: ${getProjectSettings().symbolTimeoutSeconds}). clangd answers workspace/symbol from the background index, which can be cold`
              },
              deep: {
                type: 'boolean',
                description: 'When the index returns nothing, scan source file names and open matching headers (default: true)',
                default: true
              },
              max_files: {
                type: 'number',
                description: `Maximum files opened by the deep scan (default: ${getProjectSettings().maxScanFiles}). Each opened header costs seconds of AST build`
              }
            },
            required: ['query']
          }
        },
        {
          name: 'find_implementations',
          description: 'Find implementations of an interface or virtual method at a given location',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              line: {
                type: 'number',
                description: lineDescription()
              },
              column: {
                type: 'number',
                description: columnDescription()
              }
            },
            required: ['file_path', 'line', 'column']
          }
        },
        {
          name: 'get_document_symbols',
          description: 'Get a hierarchical list of all symbols in a document',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              }
            },
            required: ['file_path']
          }
        },
        {
          name: 'get_diagnostics',
          description: 'Get diagnostics (errors, warnings, notes) for a file',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              force_refresh: {
                type: 'boolean',
                description: 'Force re-parsing of the file to get latest diagnostics (default: false)',
                default: false
              },
              min_severity: {
                type: 'string',
                enum: ['error', 'warning', 'information', 'hint'],
                description: 'Drop diagnostics below this severity'
              },
              include_tidy: {
                type: 'boolean',
                description: 'Keep clang-tidy findings (default: true; has effect only when clangd runs with --clang-tidy)',
                default: true
              },
              compact: {
                type: 'boolean',
                description: 'Also emit a `lines` array of `file:line:col SEVERITY [source(code)] message` strings',
                default: false
              },
              timeout_seconds: {
                type: 'number',
                description: `How long to wait for publishDiagnostics (default: ${getProjectSettings().diagnosticsTimeoutSeconds}; a large Unreal TU needs 10-30 s)`
              }
            },
            required: ['file_path']
          }
        },
        {
          name: 'get_call_hierarchy',
          description: 'Get call hierarchy showing incoming callers and outgoing callees for a function',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              line: {
                type: 'number',
                description: lineDescription()
              },
              column: {
                type: 'number',
                description: columnDescription()
              }
            },
            required: ['file_path', 'line', 'column']
          }
        },
        {
          name: 'get_type_hierarchy',
          description: 'Get type hierarchy showing base classes (supertypes) and derived classes (subtypes)',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              line: {
                type: 'number',
                description: lineDescription()
              },
              column: {
                type: 'number',
                description: columnDescription()
              }
            },
            required: ['file_path', 'line', 'column']
          }
        },
        {
          name: 'find_declaration',
          description: 'Find the declaration of a symbol at a given location. In Unreal, UCLASS/USTRUCT declare in the header and define in *.generated.h — this reaches the editable header line that find_definition skips',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              line: {
                type: 'number',
                description: lineDescription()
              },
              column: {
                type: 'number',
                description: columnDescription()
              }
            },
            required: ['file_path', 'line', 'column']
          }
        },
        {
          name: 'get_context',
          description: 'Get several readings of one source position in a single call: hover, definition, declaration, references and/or the file outline',
          inputSchema: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
                description: 'Absolute path to the source file'
              },
              line: {
                type: 'number',
                description: lineDescription()
              },
              column: {
                type: 'number',
                description: columnDescription()
              },
              include: {
                type: 'array',
                items: { type: 'string', enum: ['hover', 'definition', 'declaration', 'references', 'outline'] },
                description: 'Sections to return (default: hover, definition, references)'
              }
            },
            required: ['file_path', 'line', 'column']
          }
        },
        {
          name: 'get_status',
          description: 'Report clangd health: pid, uptime, args, background index state, index cache size, open documents, and the resolved project settings. Cheap and never blocks — call it first',
          inputSchema: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      ]
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      if (!args) {
        throw new Error('Missing arguments for tool call');
      }

      // Validate arguments before initialization
      validateToolArgs(name, args);

      // Initialize clangd on first tool call
      await ensureClangdInitialized();

      if (!clangdManager || !fileTracker) {
        throw new Error('Clangd not initialized');
      }

      switch (name) {
        case 'find_definition': {
          const result = await findDefinition(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string,
            args.line as number,
            args.column as number
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'find_references': {
          const result = await findReferences(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string,
            args.line as number,
            args.column as number,
            args.include_declaration !== false
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'get_hover': {
          const result = await getHover(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string,
            args.line as number,
            args.column as number
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'workspace_symbol_search': {
          const result = await workspaceSymbolSearch(
            clangdManager.getClient(),
            fileTracker,
            args.query as string,
            {
              limit: (args.limit as number) || 100,
              timeoutSeconds: args.timeout_seconds as number | undefined,
              kinds: args.kinds as (number | string)[] | undefined,
              deep: args.deep !== false,
              maxFiles: args.max_files as number | undefined
            }
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'find_implementations': {
          const result = await findImplementations(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string,
            args.line as number,
            args.column as number
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'get_document_symbols': {
          const result = await getDocumentSymbols(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'get_diagnostics': {
          if (!diagnosticsCache) {
            throw new Error('Diagnostics cache not initialized');
          }
          const result = await getDiagnostics(
            diagnosticsCache,
            fileTracker,
            args.file_path as string,
            {
              forceRefresh: args.force_refresh === true,
              minSeverity: args.min_severity as 'error' | 'warning' | 'information' | 'hint' | undefined,
              includeTidy: args.include_tidy !== false,
              compact: args.compact === true,
              timeoutSeconds: args.timeout_seconds as number | undefined
            }
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'get_call_hierarchy': {
          const result = await getCallHierarchy(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string,
            args.line as number,
            args.column as number
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'get_type_hierarchy': {
          const result = await getTypeHierarchy(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string,
            args.line as number,
            args.column as number
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'find_declaration': {
          const result = await findDeclaration(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string,
            args.line as number,
            args.column as number
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'get_context': {
          const result = await getContext(
            clangdManager.getClient(),
            fileTracker,
            args.file_path as string,
            args.line as number,
            args.column as number,
            { include: args.include as ContextSection[] | undefined }
          );
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        case 'get_status': {
          const result = await getStatus({
            manager: clangdManager,
            fileTracker,
            config: clangdManager.getConfig(),
            client: clangdManager.getClient()
          });
          return {
            content: [{ type: 'text', text: result }]
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      logger.error('Tool call failed:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: true,
              message: error instanceof Error ? error.message : String(error)
            })
          }
        ],
        isError: true
      };
    }
  });

  // Graceful shutdown handler
  const shutdownHandler = async (signal: string) => {
    if (isShuttingDown) {
      logger.warn(`Received ${signal} again, forcing exit`);
      process.exit(1);
    }

    isShuttingDown = true;
    logger.info(`Received ${signal}, shutting down...`);

    try {
      if (fileTracker) {
        fileTracker.closeAll();
      }
      if (clangdManager) {
        await clangdManager.shutdown();
      }
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdownHandler('SIGINT'));
  process.on('SIGTERM', () => shutdownHandler('SIGTERM'));

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('Clangd MCP server running on stdio');
}

// Run the server
main().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});

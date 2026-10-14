// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { uriToPath } from '../utils/uri.js';
import { withRetry } from '../utils/errors.js';
import {
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  symbolKindNames
} from '../utils/lsp-types.js';
import { fetchTwoPhaseHierarchy } from '../utils/hierarchy-helper.js';
import { toLspPosition, fromLspStart } from '../utils/coords.js';

export async function getCallHierarchy(
  lspClient: LSPClient,
  fileTracker: FileTracker,
  filePath: string,
  line: number,
  column: number
): Promise<string> {
  // Ensure file is opened
  const uri = await fileTracker.ensureFileOpen(filePath);

  // Fetch call hierarchy with retry
  const result = await withRetry(async () => {
    return await fetchTwoPhaseHierarchy<
      CallHierarchyItem,
      CallHierarchyIncomingCall,
      CallHierarchyOutgoingCall
    >(
      lspClient,
      'textDocument/prepareCallHierarchy',
      'callHierarchy/incomingCalls',
      'callHierarchy/outgoingCalls',
      uri,
      toLspPosition(line, column)
    );
  });

  // Handle no hierarchy available
  if (!result) {
    return JSON.stringify({
      found: false,
      message: 'No call hierarchy available at this position'
    });
  }

  // Format the main item
  const symbolKind = symbolKindNames[result.item.kind] || `Unknown(${result.item.kind})`;
  const mainSymbol = {
    name: result.item.name,
    kind: symbolKind,
    location: {
      file: uriToPath(result.item.uri),
      ...fromLspStart(result.item.selectionRange.start)
    }
  };

  // Format incoming calls (who calls this function)
  const incomingCalls = result.incoming.map((call: CallHierarchyIncomingCall) => {
    const callerKind = symbolKindNames[call.from.kind] || `Unknown(${call.from.kind})`;
    return {
      caller: call.from.name,
      kind: callerKind,
      location: {
        file: uriToPath(call.from.uri),
        ...fromLspStart(call.from.selectionRange.start)
      },
      call_sites: call.fromRanges.map(range => ({
        ...fromLspStart(range.start)
      }))
    };
  });

  // Format outgoing calls (what this function calls)
  const outgoingCalls = result.outgoing.map((call: CallHierarchyOutgoingCall) => {
    const calleeKind = symbolKindNames[call.to.kind] || `Unknown(${call.to.kind})`;
    return {
      callee: call.to.name,
      kind: calleeKind,
      location: {
        file: uriToPath(call.to.uri),
        ...fromLspStart(call.to.selectionRange.start)
      },
      call_sites: call.fromRanges.map(range => ({
        ...fromLspStart(range.start)
      }))
    };
  });

  return JSON.stringify({
    found: true,
    symbol: mainSymbol,
    incoming_calls: incomingCalls,
    incoming_count: incomingCalls.length,
    outgoing_calls: outgoingCalls,
    outgoing_count: outgoingCalls.length
  }, null, 2);
}

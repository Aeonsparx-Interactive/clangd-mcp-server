// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { withRetry } from '../utils/errors.js';
import { normalizeLocationResult } from '../utils/lsp-types.js';
import { uriToPath } from '../utils/uri.js';
import { toLspPosition, fromLspStart } from '../utils/coords.js';

/**
 * Find the declaration of a symbol.
 *
 * In Unreal code the declaration and the definition are deliberately
 * different places: `UCLASS()` expands to a declaration in the header and a
 * definition in `*.generated.h`. `textDocument/declaration` is what lands on
 * the header line you can actually edit, which `textDocument/definition`
 * often skips past.
 */
export async function findDeclaration(
  lspClient: LSPClient,
  fileTracker: FileTracker,
  filePath: string,
  line: number,
  column: number
): Promise<string> {
  const uri = await fileTracker.ensureFileOpen(filePath);

  const result = await withRetry(async () => {
    return await lspClient.request('textDocument/declaration', {
      textDocument: { uri },
      position: toLspPosition(line, column)
    });
  });

  const locations = normalizeLocationResult(result);

  if (locations.length === 0) {
    return JSON.stringify({ found: false, message: 'No declaration found' }, null, 2);
  }

  const formattedLocations = locations.map((loc) => ({
    file: uriToPath(loc.uri),
    ...fromLspStart(loc.range.start),
    uri: loc.uri
  }));

  return JSON.stringify(
    {
      found: true,
      count: formattedLocations.length,
      locations: formattedLocations
    },
    null,
    2
  );
}

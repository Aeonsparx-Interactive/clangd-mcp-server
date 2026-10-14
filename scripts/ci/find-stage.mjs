// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// CI helper for `.github/workflows/publish.yml` - not part of the published package.
//
// Reads the JSON that `npm stage list <pkg> --json` writes and looks for the staged
// entry of one package version. The exact shape of that JSON is not a documented
// contract, so the whole structure is walked and any object carrying a matching
// `version` (and, when present, a matching package name) is accepted.
//
//   node scripts/ci/find-stage.mjs <json-file> <package-name> <version>
//     -> prints `stage_id=<id>` (empty when nothing matches), always exits 0
//
//   node scripts/ci/find-stage.mjs <json-file> <package-name> <version> --exists
//     -> exits 0 when nothing matches, 1 when a stage for that version exists

import { readFileSync } from 'fs';

const [file, name, version, flag] = process.argv.slice(2);

if (!file || !name || !version) {
  console.error('usage: find-stage.mjs <json-file> <package-name> <version> [--exists]');
  process.exit(2);
}

const ID_KEYS = ['id', '_id', 'stageId', 'stage_id', 'uuid'];
const NAME_KEYS = ['package', 'name', 'pkg', 'scope', 'pkgName'];

function packageNames(node) {
  const names = [];
  for (const key of NAME_KEYS) {
    const value = node[key];
    if (typeof value === 'string') names.push(value);
    else if (value && typeof value === 'object') {
      for (const inner of ['name', 'package', 'scope']) {
        if (typeof value[inner] === 'string') names.push(value[inner]);
      }
    }
  }
  return names;
}

function findEntries(root) {
  const matches = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const id = ID_KEYS.map((key) => node[key]).find((v) => typeof v === 'string' && v.length > 0);
    const names = packageNames(node);
    const nameMatches = names.length === 0 || names.includes(name);
    if (id && node.version === version && nameMatches) matches.push({ id, node });
    for (const value of Object.values(node)) walk(value);
  };
  walk(root);
  return matches;
}

const text = readFileSync(file, 'utf8').trim();
let matches = [];
if (text.length > 0) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    console.error(`::error::could not parse npm stage list JSON: ${error.message}`);
    process.exit(2);
  }
  matches = findEntries(data);
}

if (flag === '--exists') {
  process.exit(matches.length > 0 ? 1 : 0);
}

console.log(`stage_id=${matches.length > 0 ? matches[0].id : ''}`);

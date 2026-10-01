#!/usr/bin/env node
/**
 * JSON-aware git merge driver for traceability/manifest.json.
 *
 * Why this exists: manifest.json is one shared, pretty-printed JSON array that every
 * branch appends to (traceability-record / traceability-link) and that drift-check
 * rewrites in place (syncState / lastCheckedAt). Two branches open at once therefore
 * collide on the tail of the same array every time, and git's line-based merge can't
 * resolve it. This driver merges by *entry identity* instead of by line:
 *   - the union of both sides' entries is kept (no one's case data is ever lost), and
 *   - when the SAME entry differs on both sides, the more recently checked one wins.
 *
 * Git invokes it (see .gitattributes + `git config merge.manifest-merge.driver`) as:
 *     node scripts/merge-manifest.mjs %O %A %B %P
 *   %O = common ancestor (base)   %A = ours (WRITE THE RESULT HERE)
 *   %B = theirs                   %P = path being merged (for logging only)
 *
 * Exit 0 => merged cleanly, result written to %A.
 * Exit 1 => could not merge safely; git falls back to normal <<<< / ==== / >>>> markers.
 *           (Fail safe: we never write malformed JSON.)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , basePath, oursPath, theirsPath, dispPath = 'manifest.json'] = process.argv;

function readJson(p, fallback) {
  try {
    const raw = readFileSync(p, 'utf8');
    if (raw.trim() === '') return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback === undefined ? Symbol('parse-error') : fallback;
  }
}

// Largest ISO-8601-looking timestamp anywhere in an object => "how recent is this record".
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
function recordTime(obj) {
  let max = '';
  for (const v of Object.values(obj || {})) {
    if (typeof v === 'string' && ISO.test(v) && v > max) max = v;
  }
  return max;
}

// Identity of one traceability entry: which test it links, plus the case + issue it belongs to.
// Anything the same on both sides is the "same entry"; anything different is preserved separately.
function entryKey(e) {
  return [e.jiraKey, e.externalCaseId, e.testFilePath, e.testTitle].map(x => x ?? '').join(' ');
}
function workflowKey(w) {
  return [w.tenantId, w.jiraKey].map(x => x ?? '').join(' ');
}

/**
 * 3-way keyed union of two lists.
 *  - keep every OURS item, in order
 *  - append every THEIRS item whose key OURS doesn't already have
 *  - when a key is on both sides and the items differ, reconcile:
 *      * if one side is unchanged from base, take the side that changed
 *      * if both changed, take the more recently timestamped item
 *      * tie => keep ours
 */
function mergeList(baseList, oursList, theirsList, keyOf) {
  const baseByKey = new Map();
  for (const it of baseList) baseByKey.set(keyOf(it), it);

  const result = oursList.map(it => ({ ...it }));
  const ourIndex = new Map();
  result.forEach((it, i) => ourIndex.set(keyOf(it), i)); // last occurrence wins the slot

  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  for (const theirs of theirsList) {
    const k = keyOf(theirs);
    if (!ourIndex.has(k)) { // theirs-only -> append (never drop another branch's entry)
      result.push({ ...theirs });
      ourIndex.set(k, result.length - 1);
      continue;
    }
    const idx = ourIndex.get(k);
    const ours = result[idx];
    if (eq(ours, theirs)) continue; // identical, nothing to do
    const base = baseByKey.get(k);
    if (base && eq(ours, base)) { result[idx] = { ...theirs }; continue; } // only theirs changed
    if (base && eq(theirs, base)) { continue; }                            // only ours changed
    // both changed (or no base): newer record wins, tie keeps ours
    if (recordTime(theirs) > recordTime(ours)) result[idx] = { ...theirs };
  }
  return result;
}

const base = readJson(basePath, {});                 // base may legitimately be empty
const ours = readJson(oursPath);
const theirs = readJson(theirsPath);

if (typeof ours === 'symbol' || typeof theirs === 'symbol') {
  console.error(`[merge-manifest] ${dispPath}: could not parse ours/theirs as JSON; leaving conflict for manual resolution.`);
  process.exit(1); // safe fallback: git writes standard conflict markers
}

const out = {};
const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])];
for (const k of keys) {
  const a = ours[k], b = theirs[k];
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyOf = k === 'entries' ? entryKey : k === 'workflow' ? workflowKey
      : (x => JSON.stringify(x)); // any other array: union by full-value identity
    out[k] = mergeList(Array.isArray(base[k]) ? base[k] : [], a, b, keyOf);
  } else if (a === undefined) {
    out[k] = b;
  } else if (b === undefined) {
    out[k] = a;
  } else {
    out[k] = a; // scalar/object on both sides: keep ours (rare for this file)
  }
}

writeFileSync(oursPath, JSON.stringify(out, null, 2) + '\n');
const n = Array.isArray(out.entries) ? out.entries.length : 0;
console.error(`[merge-manifest] ${dispPath}: auto-merged cleanly (${n} entries).`);
process.exit(0);

/**
 * Defect #9b: the tool list `dev-link.sh`'s MATCHER and `replay.mjs`'s
 * IN_SCOPE used to be two separately-typed strings/sets with nothing tying
 * them together, so one could drift from the other in silence — and a tool
 * missing from IN_SCOPE is invisible to replay's "not exercised" warning,
 * which is the exact blind spot AGENTS.md trap #5 is about.
 *
 * These tests don't re-prove the guardrail logic. They pin the three places
 * the list has to stay consistent with something else:
 *
 *   1. scripts/dev-link.sh's MATCHER — built from this array, and validated
 *      there against a regex this file reads out of the script, so the shell
 *      does not hold an untested claim about tool-name syntax.
 *   2. scripts/replay.mjs's IN_SCOPE — the same array, as a Set.
 *   3. src/core/normalize.mjs's TOOL_KINDS — which decides whether any
 *      guardrail can see the tool at all. A name here that normalise() maps
 *      to KIND.OTHER is inspected by nothing while replay counts it in scope
 *      and reports it clean: the #9b hole one hop over.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IN_SCOPE_TOOLS, buildMatcher } from '../src/tier-a/tools.mjs';
import { normalize } from '../src/core/normalize.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe('src/core/tools.mjs', () => {
  test('IN_SCOPE_TOOLS is the known, frozen list', () => {
    assert.deepEqual(
      IN_SCOPE_TOOLS,
      ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'],
    );
    assert.equal(Object.isFrozen(IN_SCOPE_TOOLS), true);
  });

  test('buildMatcher() round-trips to the same members', () => {
    const matcher = buildMatcher();
    assert.deepEqual(matcher.split('|'), [...IN_SCOPE_TOOLS]);
  });

  test('buildMatcher() satisfies the regex dev-link.sh validates it against', () => {
    // dev-link.sh refuses to wire anything if the derived matcher fails its
    // MATCHER_RE, so that regex is a real constraint on what a tool name may
    // contain — and it lived only in the shell, untested, where an addition
    // here (an MCP tool named mcp__server__tool, say) would make the whole
    // installer refuse to wire, blaming tools.mjs. Read the regex out of the
    // script rather than restating it, so the two cannot drift either.
    const script = fs.readFileSync(path.join(REPO, 'scripts', 'dev-link.sh'), 'utf8');
    const m = script.match(/^MATCHER_RE='([^']+)'$/m);
    assert.ok(m, 'dev-link.sh must define MATCHER_RE on its own line for this test to read');
    assert.match(buildMatcher(), new RegExp(m[1]));
  });

  test('every tool in the list is one normalise() actually recognises', () => {
    // The list says which tools the kit has an opinion about; TOOL_KINDS in
    // normalize.mjs decides whether a guardrail can see them. A name here
    // that normalises to KIND.OTHER is inspected by nothing, while replay
    // counts it in scope and omits it from "not exercised" — so it reads as
    // measured and clean. ARCHITECTURE.md: an unrecognised tool is a hole,
    // not a safe default.
    for (const tool of IN_SCOPE_TOOLS) {
      const { kind } = normalize({ tool_name: tool, tool_input: {} });
      assert.notEqual(
        kind, 'other',
        `${tool} is in IN_SCOPE_TOOLS but normalize() maps it to KIND.OTHER — add it to TOOL_KINDS in src/core/normalize.mjs, or no guardrail will ever inspect it`,
      );
    }
  });

  test('buildMatcher() matches the exact MATCHER string dev-link.sh has always used', () => {
    // Locks the literal value the shell side must print byte-for-byte
    // (verified separately via `node --input-type=module -e ...`). A change
    // here should be a deliberate edit to IN_SCOPE_TOOLS, not a silent format
    // change (extra separator, different order, ...).
    assert.equal(buildMatcher(), 'Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep');
  });

  test('buildMatcher() honours a custom list rather than always reading the module default', () => {
    assert.equal(buildMatcher(['Read', 'Write']), 'Read|Write');
  });
});

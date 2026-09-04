/**
 * Defect #9b: the tool list `dev-link.sh`'s MATCHER and `replay.mjs`'s
 * IN_SCOPE used to be two separately-typed strings/sets with nothing tying
 * them together, so one could drift from the other in silence — and a tool
 * missing from IN_SCOPE is invisible to replay's "not exercised" warning,
 * which is the exact blind spot AGENTS.md trap #5 is about.
 *
 * These tests don't re-prove the guardrail logic; they prove the two
 * representations (the array `src/tier-a`'s shell side turns into a
 * pipe-joined matcher, and the array replay.mjs turns into a Set) cannot
 * separate again now that both are built from src/core/tools.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { IN_SCOPE_TOOLS, buildMatcher } from '../src/core/tools.mjs';

describe('src/core/tools.mjs', () => {
  test('IN_SCOPE_TOOLS is the known, frozen list', () => {
    assert.deepEqual(
      IN_SCOPE_TOOLS,
      ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'],
    );
    assert.equal(Object.isFrozen(IN_SCOPE_TOOLS), true);
  });

  test('buildMatcher() round-trips to the same members — the anti-drift guarantee', () => {
    // This is the property that makes drift between dev-link.sh's shell-side
    // MATCHER and replay.mjs's IN_SCOPE structurally impossible now: both are
    // derived from the same array, and the matcher string splits back into
    // exactly that array with nothing added, dropped, or reordered.
    const matcher = buildMatcher();
    assert.deepEqual(matcher.split('|'), [...IN_SCOPE_TOOLS]);
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

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CI that watches a branch nobody uses is indistinguishable from CI that passes.
 *
 * Until 2026-08-25 `ci.yml` triggered on `branches: [main]` while every commit
 * landed on `feat/multitenant-hosted`. The workflow ran ONCE in three months —
 * on main, and it failed. Across that window the suite grew to 283 tests, the
 * container image job verified nothing, and `npm audit` never ran. Guards were
 * authored, reviewed and mutation-tested against a runner that would never
 * execute them.
 *
 * The defect is the ALLOWLIST, not the value in it: an enumerated branch list
 * is a promise to keep the list current, and nothing fails when that promise
 * lapses. So this pins the absence of the filter rather than its contents —
 * pinning `[main, feat/multitenant-hosted]` would just move the expiry date.
 */
const CI = readFileSync(join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

describe('CI triggers', () => {
  it('has no branch allowlist on push or pull_request', () => {
    // Strip comments: the rationale above quotes the old `branches: [main]`
    // filter verbatim, and a whole-file match would flag the explanation.
    const code = CI.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).not.toMatch(/branches:/);
  });

  it('still triggers on both push and pull_request', () => {
    const code = CI.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(code).toMatch(/^\s*push:\s*$/m);
    expect(code).toMatch(/^\s*pull_request:\s*$/m);
  });
});

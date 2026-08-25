import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * KNOWN-GAPS: hermes-terminal-mcp-drops-and-the-agent-narrates-instead-of-failing
 *
 * The terminal writes as hermes-term (10002); vision_analyze and Slack MEDIA
 * delivery read as the gateway user hermes (10001). The two share no group, so
 * a /workspace owned hermes-term:hermes-term at 0750 could not even be
 * TRAVERSED by the gateway. On 2026-08-24 that surfaced as
 * `Permission denied: /workspace/darshan_preflight.png` on a screenshot the
 * terminal had just written — and MEDIA refusing /home/hermes (the one place
 * the gateway COULD read) as an unsafe path. Net effect: no directory existed
 * that the terminal could write AND the gateway could read and attach, so
 * "make an image and send it to Slack" was impossible.
 *
 * Both halves are required and are asserted together here, because fixing
 * either alone leaves the handoff broken and looks like the fix did not work.
 */
const here = dirname(fileURLToPath(import.meta.url));
const setup = readFileSync(join(here, '..', 'container', 'setup-terminal.sh'), 'utf8');
const start = readFileSync(join(here, '..', 'container', 'start-hermes.sh'), 'utf8');

describe('the gateway can read what the terminal writes', () => {
  it('gives /workspace group hermes, not hermes-term', () => {
    expect(setup).toMatch(/chown\s+"\$\{TERM_UID\}:hermes"\s+"\$WORKSPACE"/);
  });

  it('sets setgid so new files and subdirs inherit the group', () => {
    // Without setgid only the top level is reachable, and anything the agent
    // writes into a subdirectory reproduces the original bug.
    expect(setup).toMatch(/chmod\s+2750\s+"\$WORKSPACE"/);
  });

  it('keeps `other` with no access', () => {
    expect(setup).not.toMatch(/chmod\s+2755\s+"\$WORKSPACE"/);
    expect(setup).not.toMatch(/chmod\s+0?777\s+"\$WORKSPACE"/);
  });

  it('re-groups pre-existing content, so an upgraded container is fixed too', () => {
    // setgid only governs files created from here on.
    expect(setup).toMatch(/chgrp -R hermes "\$WORKSPACE"/);
  });

  it('FAILS the boundary if the gateway cannot read the workspace', () => {
    // The assertion that was missing: nothing checked this direction, so an
    // unreadable workspace looked perfectly healthy.
    expect(setup).toMatch(/gosu hermes test -r/);
    expect(setup).toMatch(/cannot read \$\{WORKSPACE\}/);
  });

  it('probes with a group-only file, not a world-readable one', () => {
    // A 0644 probe passes via o+r even when the group is wrong, which would
    // make this guard pass on exactly the broken configuration it exists for.
    expect(setup).toMatch(/umask 0027/);
  });
});

describe('the gateway is allowed to DELIVER from the workspace', () => {
  it('adds /workspace to the MEDIA allowlist', () => {
    expect(start).toMatch(/HERMES_MEDIA_ALLOW_DIRS="\$\{HERMES_MEDIA_ALLOW_DIRS:-\/workspace\}"/);
  });

  it('exports it, or the gateway process never sees it', () => {
    expect(start).toMatch(/export HERMES_MEDIA_ALLOW_DIRS=/);
  });

  it('logs the value, so an unset one is not silently indistinguishable', () => {
    expect(start).toMatch(/media_allow_dirs=/);
  });
});

describe('the image carries a marker', () => {
  it('has a startup marker line to tell images apart after an evict', () => {
    // An evict that did not take cold-boots the OLD image and still reports
    // success; a changed startup line is the only cheap way to tell.
    expect(start).toMatch(/\[startup\] image_marker=/);
  });
});

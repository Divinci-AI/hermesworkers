import { describe, it, expect } from 'vitest';
import { NET_DIAG_COMMAND } from '../src/lib/net-diag';

/**
 * NET_DIAG_COMMAND runs as ROOT inside an agent's container. Its safety rests
 * on one property: it is a CONSTANT. The moment any caller-supplied value is
 * interpolated into it, a read-only diagnostic becomes a root command-injection
 * endpoint — a much larger thing than a network probe, and one that would look
 * harmless in review because the route itself takes no body.
 *
 * These tests pin that property structurally rather than trusting the comment.
 */
describe('NET_DIAG_COMMAND is a constant, not a template', () => {
  it('is a non-empty string', () => {
    expect(typeof NET_DIAG_COMMAND).toBe('string');
    expect(NET_DIAG_COMMAND.length).toBeGreaterThan(0);
  });

  it('contains no unresolved template interpolation', () => {
    // A `${...}` surviving into the emitted string would mean a value was meant
    // to be spliced in at call time.
    expect(NET_DIAG_COMMAND).not.toMatch(/\$\{/);
  });

  it('references only the fixed identities the boundary defines', () => {
    // uid 10002 / hermes-term are the terminal identity. If a probe ever needs a
    // DIFFERENT user, that is a caller-supplied value and must not land here.
    expect(NET_DIAG_COMMAND).toContain('hermes-term');
    expect(NET_DIAG_COMMAND).not.toMatch(/\buid-owner\s+(?!10002)\d+/);
  });

  it('probes BOTH address families — the whole reason the boundary bug was missed', () => {
    // A default-stack probe can only report "at least one family is open", never
    // which. Losing either flag silently re-creates the 2026-08-06 blind spot.
    expect(NET_DIAG_COMMAND).toMatch(/curl -4 /);
    expect(NET_DIAG_COMMAND).toMatch(/curl -6 /);
    expect(NET_DIAG_COMMAND).toContain('ip6tables');
    expect(NET_DIAG_COMMAND).toContain('iptables -L OUTPUT');
  });

  it('is read-only — it must not mutate firewall state', () => {
    // An earlier revision APPLIED candidate ip6 rules from here to prove a fix
    // without a 30-min container eviction. That was deliberate and temporary; a
    // diagnostic that writes firewall rules is not a diagnostic. Adding/removing
    // rules must live in setup-terminal.sh.
    expect(NET_DIAG_COMMAND).not.toMatch(/iptables[^;|]*\s-[AIDFXN]\s/);
    expect(NET_DIAG_COMMAND).not.toMatch(/ip6tables[^;|]*\s-[AIDFXN]\s/);
  });

  it('does not dump the privileged user environment', () => {
    // `env` for hermes-term is expected (it must be empty). Reading the `hermes`
    // user's environment would surface provider credentials into a log.
    expect(NET_DIAG_COMMAND).not.toMatch(/gosu\s+hermes\s+env/);
    expect(NET_DIAG_COMMAND).not.toMatch(/\.hermes\/\.env/);
  });
});

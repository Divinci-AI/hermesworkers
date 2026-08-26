/**
 * The startup `image_marker` must be DERIVED from the image's own contents,
 * never a hand-maintained literal.
 *
 * It began life as a date string carrying the instruction "Bump on every
 * container image change". On 2026-08-25 two commits changed `start-hermes.sh`
 * and `egress-guard.js` without bumping it, so all three production agents
 * cold-booted a NEW image and reported `image_marker=2026-08-24`. The marker
 * exists to answer "did the evict actually take?", and in the first case that
 * mattered it argued for exactly the wrong answer.
 *
 * A stale marker is worse than no marker: an absent line reads as "unknown",
 * while a wrong one reads as authoritative. Discipline lapses; a hash cannot.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(join(__dirname, "..", "container", "start-hermes.sh"), "utf8");

/** The single line that emits the marker. */
function markerLine(): string {
  const m = SCRIPT.match(/^.*\[startup\] image_marker=.*$/m);
  expect(m, "no [startup] image_marker= line in start-hermes.sh").toBeTruthy();
  return (m as RegExpMatchArray)[0];
}

describe("startup image_marker", () => {
  it("is still emitted, and under the name callers grep for", () => {
    // The name is the contract — an absent line reads as a clean run, so a
    // rename silently removes the only evict-took signal we have.
    expect(SCRIPT).toContain("[startup] image_marker=");
  });

  it("interpolates a variable rather than hard-coding a value", () => {
    const line = markerLine();
    expect(
      /image_marker=\$\{?[A-Za-z_]/.test(line),
      `image_marker is hard-coded:\n  ${line.trim()}\n` +
        `It must be derived from the image's contents. A literal goes stale the ` +
        `first time someone changes the image without editing this line, and then ` +
        `reports the OLD image for a NEW one.`,
    ).toBe(true);
  });

  it("derives that value by hashing the files it claims to describe", () => {
    expect(SCRIPT).toMatch(/IMAGE_MARKER="\$\(cat [^)]*sha256sum/);
    // Hashing only start-hermes.sh would miss a guard-only change — which is
    // precisely one of the two 2026-08-25 commits that went unmarked.
    expect(SCRIPT).toMatch(/IMAGE_MARKER="[\s\S]{0,220}egress-guard\.js/);
  });

  it("never regresses to a bare date literal", () => {
    expect(
      /image_marker=\d{4}-\d{2}-\d{2}/.test(markerLine()),
      "image_marker is a date literal again — this is the exact 2026-08-25 regression.",
    ).toBe(false);
  });

  it("still prints a line when the hash cannot be computed", () => {
    // A marker that vanishes on error is indistinguishable from an old image
    // that never printed one, so the failure must be named, not silent.
    expect(SCRIPT).toMatch(/image_marker=\$\{IMAGE_MARKER:-[^}]+\}/);
  });
});

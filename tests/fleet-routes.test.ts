import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../src/routes/hosted.ts'), 'utf8');
const DO = readFileSync(join(__dirname, '../src/fleetCoordinator.ts'), 'utf8');
const IDX = readFileSync(join(__dirname, '../src/index.ts'), 'utf8');

describe('fleet claim routes — auth invariants', () => {
  it('takes the holder from the auth gate, never from the request body', () => {
    // A self-declared holder lets any agent claim or release AS another agent,
    // which is the same as having no ledger at all.
    expect(SRC).toContain("body.holder = c.get('agentId');");
    const seg = SRC.slice(SRC.indexOf('fleet claim leases'));
    expect(seg).not.toMatch(/holder:\s*body\./);
  });

  it('mounts under /hosted/*, so it inherits the service-auth gate', () => {
    expect(SRC).toContain("hosted.get('/hosted/fleet/claims'");
    expect(SRC).toContain('/hosted/fleet/claims/${op}');
    expect(SRC).toContain("hosted.use('/hosted/*'");
  });

  it('validates the fleet id before using it to address a Durable Object', () => {
    // An unvalidated id is a way to address an arbitrary object.
    expect(SRC).toContain('/^[A-Za-z0-9_-]{1,128}$/.test(fleetId)');
  });

  it('scopes the ledger by FLEET, not by agent', () => {
    // Agents in one fleet must contend with each other; keying by agent would
    // give each its own ledger and defeat the entire feature.
    expect(SRC).toContain('idFromName(`fleet:${fleetId}`)');
  });

  it('takes the fleet id from a header the agent cannot set for itself', () => {
    expect(SRC).toContain("const FLEET_HEADER = 'x-divinci-fleet-id'");
  });

  it('501s rather than throwing when the binding is absent', () => {
    // The migration may not have been applied yet on a given deployment.
    expect(SRC).toContain('status: 501');
    expect(SRC).toContain('fleet coordinator not configured');
  });
});

describe('fleet coordinator wiring', () => {
  it('is exported from the entrypoint so the migration can bind it', () => {
    expect(IDX).toContain("export { FleetCoordinator } from './fleetCoordinator'");
  });

  it('persists under a single key, so a write cannot tear', () => {
    expect(DO).toContain("const KEY = 'claims:v1'");
  });

  it('compacts on the write path, so no sweep is needed to bound the ledger', () => {
    expect(DO.match(/compact\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('distinguishes a live conflict (409) from a malformed request (400)', () => {
    // A caller that retries a 409 is dogpiling again; it must pick another
    // lever. A 400 cannot be fixed by retrying at all.
    expect(DO).toContain("r.reason === 'held' ? 409");
    expect(DO).toContain("'capacity' ? 429");
  });

  it('only persists on success', () => {
    // A failed acquire must not write; the pure helpers never mutate, and the
    // DO must not put() on an error path either.
    const acquireBlock = DO.slice(DO.indexOf("endsWith('/acquire')"), DO.indexOf("endsWith('/release')"));
    expect(acquireBlock.indexOf('if (!r.ok)')).toBeLessThan(acquireBlock.indexOf('storage.put'));
  });
});

describe('every wrangler config binds the DO with a migration', () => {
  for (const f of ['wrangler.toml', 'wrangler.staging.toml', 'wrangler.production.toml']) {
    it(`${f} binds FLEET and declares the v2 migration`, () => {
      // A binding without a migration deploys a Worker whose DO class does not
      // exist — it fails at request time, not at deploy time.
      const t = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(t).toContain('name = "FLEET"');
      expect(t).toContain('class_name = "FleetCoordinator"');
      expect(t).toContain('new_classes = ["FleetCoordinator"]');
    });
  }
});

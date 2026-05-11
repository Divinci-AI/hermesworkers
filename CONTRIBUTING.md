# Contributing to hermesworkers

Thanks for considering a contribution. This project is intentionally small — bug fixes, documentation improvements and clarifying comments are especially welcome.

## Before you open a PR

1. **File an issue first** for anything beyond a typo, comment polish or single-line bug fix. A 30-second alignment beats a wasted weekend.
2. **Keep changes focused.** One concern per PR. Refactors live in their own PR.
3. **No dependency creep.** Anything you add to `package.json` should justify its weight. Workers are size-sensitive.
4. **Run `npm run typecheck`** before pushing.

## Scope

`hermesworkers` aims to stay:

- single-tenant (one Hermes instance per deployment),
- BYOK-only (we never ship a provider key, we never proxy through a managed API),
- minimal (small dependency surface, readable code).

Pull requests that drag the project toward multi-tenant SaaS, hosted-mode features, or vendor lock-in are out of scope and will likely be declined.

## Development loop

```bash
npm install
npm run typecheck
# Local Worker (against your real Cloudflare account)
npx wrangler dev
```

Container changes require a full `wrangler deploy` to take effect — `wrangler dev` builds the Worker but does not rebuild the Sandbox image on the fly.

## Reporting security issues

Don't open a public issue. Follow the disclosure process in [`SECURITY.md`](SECURITY.md).

## License

By submitting a contribution you agree it is licensed under the Apache License 2.0, the same as the rest of the project.

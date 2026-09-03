See [AGENTS.md](./AGENTS.md) — orientation, invariants, and the traps that have
already cost time on this repo. It is written to be portable across all four
harnesses this kit targets, so it is the single source rather than a duplicate
kept here.

Two things worth knowing before your first tool call:

- **This kit is probably hooked into your own session.** Commands naming `.env`,
  `*.pem` or `id_rsa` are blocked even when you are only writing test fixtures,
  and listing a `node_modules` root is blocked. AGENTS.md explains the ways
  around it that do not involve disabling anything.
- **Unit tests have missed every serious defect found here.** Run
  `npm run replay` and exercise a real agent before believing a change is good.

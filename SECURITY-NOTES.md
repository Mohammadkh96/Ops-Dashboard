# Dependency advisories

`npm audit` reports 3 high-severity findings that cannot currently be resolved
by upgrading. Both are understood and neither affects the API that handles
payment data. This file exists so nobody has to re-derive that under pressure.

Re-check with `npm audit` after any dependency change.

---

## xlsx (SheetJS) — 2 advisories, no fix on npm

- Prototype Pollution — GHSA-4r6h-8v6p-xvw6
- Regular Expression Denial of Service — GHSA-5pgg-2g8v-p4x9

**Why there is no fix.** SheetJS stopped publishing to npm at 0.18.5 and moved
to their own CDN. The patched releases exist, but not on the registry, so
`npm audit fix` can never resolve this and the warning is permanent.

**Exposure.** `xlsx` is a dependency of `apps/web` only — it is not in
`apps/api`, so nothing on the payment-ingest path touches it. It is imported by
`apps/web/src/lib/recon/parse.ts`, which runs **in the browser**, on
reconciliation files an operator chooses to upload. Both advisories require
parsing a maliciously crafted spreadsheet. The realistic attack is an operator
opening a hostile file that reached them some other way; the blast radius is
that one browser tab, not the server or the database.

**If that risk becomes unacceptable**, the fix is to install from the vendor's
CDN instead of npm:

```jsonc
// apps/web/package.json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

Deliberately not done yet: it makes every install — including Vercel's build —
depend on a host outside the npm registry, which trades a low-likelihood parsing
risk for a build that breaks whenever that CDN is unreachable. Worth revisiting
if untrusted spreadsheets ever get uploaded.

---

## js-yaml under @nestjs/swagger — 1 advisory

- Exponential parsing time in flow collections — GHSA-pm4m-ph32-ghv5

`@nestjs/swagger` pins js-yaml to exactly 5.2.1; the fix is 5.2.2. npm reports
"fix available via npm audit fix", but neither that nor an `overrides` entry
(global or scoped to `@nestjs/swagger`) actually replaces the nested copy — the
pin wins. Resolving it needs a `@nestjs/swagger` release that moves the pin.

**Exposure.** js-yaml is used to serialise the OpenAPI document at
`/api/docs-yaml`. It writes YAML rather than parsing untrusted input, and no
request body reaches it. The advisory is about parsing hostile YAML, which
nothing here does.

If it matters more than the docs endpoint does, drop Swagger from the production
bootstrap by guarding the `SwaggerModule.setup` call in `apps/api/src/bootstrap.ts`.

---

## Never run `npm audit fix --force`

It resolves advisories by installing versions outside the declared ranges,
including major upgrades. On this repo it wanted to move Next past its pinned
version, which also silently breaks `eslint-config-next` — the two are
version-locked and must be bumped together.

The safe form is plain `npm audit fix`. Anything it cannot fix belongs in this
file with a reason, not forced through.

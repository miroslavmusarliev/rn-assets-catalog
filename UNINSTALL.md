# Uninstalling rn-assets-catalog

Running `npm uninstall rn-assets-catalog` doesn't just delete the package — it ejects itself into
your project first, so `npm start`/`ios`/`android`/`web` keep working afterward instead of failing
on a `pre*` hook that calls a bin that no longer exists.

## What happens automatically

`npm uninstall` runs this package's own `preuninstall` script (`uninstall.js`) before removing it.
That script:

1. **Copies itself** into a new `asset-catalog-tool/` folder at your project's root — the exact
   same files and layout this README's "Option B — drop-in folder" section already documents for
   projects that never used npm for this in the first place. You end up in the same place either
   way: a plain folder of scripts you now own outright.
2. **Repoints `generate:images` and `asset-catalog`** in your `package.json` at the copy —
   ```json
   "generate:images": "node ./asset-catalog-tool/generate-asset-catalog.js",
   "asset-catalog": "node ./asset-catalog-tool/asset-catalog-server.js"
   ```
   — but **only if each script still has exactly the value the original `npm install` wired**
   (`asset-catalog-generate` / `asset-catalog`). If you'd already customized either script by hand,
   your version is left alone; this only repoints the untouched default.

Everything else needs no change and is left as-is:

- `pre{start,ios,android,web}` still just say `npm run generate:images` — that now resolves
  locally, no edit needed.
- `tsconfig.json`'s `@/assets`/`@/assets/*` path aliases are **not** touched. Those are consumed by
  your app's own screens (`import { useImage } from '@/assets'`), not by this tool — removing them
  would break your app, not just the tool.
- `hooks/*.js`, `assets/index.ts`, and the generated `assets/*.generated.ts` catalogs are already
  project-owned files that work standalone; uninstalling this package never touches them.

If `asset-catalog-tool/` already exists (e.g. you're on Option B already, or you've ejected once
before), the eject step skips and logs why instead of overwriting it — it won't clobber hand edits
you've made to a previous copy.

## What this can't guarantee

`preuninstall` is an npm-lifecycle convention, not something every tool/flow honors:

- `rm -rf node_modules` followed by hand-editing `package.json`'s `dependencies` skips it entirely.
- `npm install --ignore-scripts` (or an `.npmrc`/CI config that sets `ignore-scripts=true`) skips
  it too.
- Some non-npm package managers don't run a dependency's `preuninstall` the same way npm does.

If you're removing the package through one of those paths, eject manually first, while the package
is still present in `node_modules`:

```bash
node ./node_modules/rn-assets-catalog/uninstall.js
```

Then remove the dependency however you'd planned to.

## Going back

Delete `asset-catalog-tool/`, `npm install rn-assets-catalog` again, and change
`generate:images`/`asset-catalog` back to `asset-catalog-generate`/`asset-catalog` — the next
`npm install` won't do it for you, since both scripts already exist (postinstall's wiring is
additive-only, same as always).

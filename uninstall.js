#!/usr/bin/env node

/**
 * Runs automatically before this package is removed via `npm uninstall rn-assets-catalog` (wired
 * below as this package's own "preuninstall" script). Mirrors postinstall.js's own shape and
 * root-resolution (`INIT_CWD`, for the same reason — npm runs a dependency's lifecycle scripts
 * with cwd set to that dependency's own directory, not the consuming project's).
 *
 * Purpose: eject. Rather than leaving `generate:images`/`asset-catalog` pointed at a now-missing
 * bin (see this repo's git history for the actual breakage that motivated this), copy this
 * package's own runtime files into the consuming project as a `asset-catalog-tool/` folder — the
 * exact same layout README.md already documents as "Option B — drop-in folder" for projects that
 * never used npm for this at all — and repoint those two scripts at the copy. The project ends up
 * fully self-contained: no lingering npm dependency, but also nothing broken.
 *
 * Deliberately does NOT touch: the `pre*` hooks (still `npm run generate:images`, which now
 * resolves locally, no change needed), `tsconfig.json`'s `@/assets` alias (consumed by the app's
 * own screens via `useImage`/`useColor`, not by this tool — removing it would break the app, not
 * just this tool), or `hooks/*.js`/`assets/index.ts`/the generated catalogs (already
 * project-owned, already work standalone). See UNINSTALL.md for the full writeup, including the
 * "some package managers/flows don't run preuninstall at all" caveat and how to eject manually.
 */

const path = require("path");
const {
  ejectAssetCatalogTool,
  repointPackageJsonToEjectedTool,
  AssetCatalogError,
} = require("./lib/asset-catalog-core");

const root = process.env.INIT_CWD || process.cwd();
const packageRoot = __dirname;

try {
  const { copied, targetDir, reason } = ejectAssetCatalogTool(root, packageRoot);
  if (!copied) {
    console.log(`rn-assets-catalog: skipped ejecting into ${path.relative(root, targetDir)} (${reason})`);
  } else {
    console.log(`rn-assets-catalog: copied itself into ${path.relative(root, targetDir)}/ so generate:images/asset-catalog keep working`);
    const { repointedScripts } = repointPackageJsonToEjectedTool(root);
    for (const name of repointedScripts) {
      console.log(`rn-assets-catalog: repointed the "${name}" script at the ejected copy`);
    }
  }
} catch (err) {
  // Best-effort, same as postinstall.js — never fail someone's `npm uninstall` over this.
  const message = err instanceof AssetCatalogError ? err.message : err.stack;
  console.log(`rn-assets-catalog: eject-on-uninstall skipped (${message})`);
}

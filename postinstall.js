#!/usr/bin/env node

/**
 * Runs automatically after `npm install` in a project that depends on this package (wired below
 * as this package's own "postinstall" script) — best-effort scaffolding only, deliberately more
 * lenient than generate-asset-catalog.js's own CLI. That CLI is meant to be wired as a required
 * `pre*` build hook and fails loudly (non-zero exit) on a missing/misconfigured assets/images/ —
 * exactly the right behavior for a build gate, exactly the wrong behavior here: a project that
 * just ran `npm install` for the very first time has no assets/images/ yet, and `npm install`
 * itself must never fail because of that. So this script scaffolds whatever it safely can
 * (hooks/, assets/index.ts, the generated catalogs IF there's already something to generate, the
 * package.json scripts/pre* hooks and tsconfig.json `@/assets` alias — see ensurePackageJsonWiring/
 * ensureTsconfigAssetsAlias) and quietly no-ops the rest — log a note, never throw, never a
 * non-zero exit.
 *
 * Root resolution is the one thing that has to be different from generate-asset-catalog.js's own
 * `process.cwd()`: npm runs a DEPENDENCY's lifecycle scripts (postinstall included) with cwd set
 * to that dependency's own directory (node_modules/rn-assets-catalog/), not the project that
 * depends on it — using `process.cwd()` here would scan/write inside node_modules/ itself, not
 * the consuming project's real assets/. `INIT_CWD` is the npm-provided env var holding wherever
 * `npm install` was actually invoked from, which is what this needs instead. (generate-asset-
 * catalog.js and asset-catalog-server.js don't need this distinction: both only ever run via an
 * npm script IN the consuming project's own package.json, where cwd is already correct.)
 */

const fs = require("fs");
const path = require("path");
const {
  scanImages,
  writeGeneratedCatalog,
  scanColors,
  writeGeneratedColorCatalog,
  ensureAssetCatalogHooks,
  ensureAssetsIndexBarrel,
  scanAppIcon,
  ensurePackageJsonWiring,
  ensureTsconfigAssetsAlias,
  AssetCatalogError,
} = require("./lib/asset-catalog-core");

const root = process.env.INIT_CWD || process.cwd();
const imagesDir = path.join(root, "assets", "images");
const colorsDir = path.join(root, "assets", "colors");
const appIconDir = path.join(root, "assets", "app-icon");
const assetsDir = path.join(root, "assets");
const hooksDir = path.join(root, "hooks");

try {
  // Package.json/tsconfig.json wiring runs unconditionally on every install (unlike the rest of
  // this script, which needs assets/images/ to exist first) — it's the "zero manual setup" half
  // of this tool's pitch, so it shouldn't wait for the project to have added its first asset.
  // Both are additive-only (see their own doc comments), so re-running this on every `npm install`
  // never re-touches a script/path entry the project has already customized.
  const { addedScripts, addedHooks } = ensurePackageJsonWiring(root);
  for (const name of addedScripts) {
    console.log(`rn-assets-catalog: package.json didn't have an "${name}" script — added one`);
  }
  for (const name of addedHooks) {
    console.log(`rn-assets-catalog: package.json didn't have a "${name}" hook — wired it to run generate:images`);
  }
  const { added: addedTsconfigPaths } = ensureTsconfigAssetsAlias(root);
  for (const key of addedTsconfigPaths) {
    console.log(`rn-assets-catalog: tsconfig.json didn't have a "${key}" path alias — added one`);
  }
} catch (err) {
  // Best-effort, same as everything else in this file — a package.json/tsconfig.json this can't
  // safely parse just means the user wires those two by hand, not a failed install.
  const message = err instanceof AssetCatalogError ? err.message : err.stack;
  console.log(`rn-assets-catalog: package.json/tsconfig.json wiring skipped (${message})`);
}

try {
  if (!fs.existsSync(imagesDir)) {
    console.log(
      "rn-assets-catalog: no assets/images/ yet — nothing to scaffold. Run your project's " +
        "generate-images script (or `asset-catalog-generate`) once you've added your first image.",
    );
    process.exit(0);
  }

  const createdHooks = ensureAssetCatalogHooks(hooksDir);
  for (const filename of createdHooks) {
    console.log(`rn-assets-catalog: hooks/${filename} didn't exist — created a default`);
  }

  const { entries, warnings } = scanImages(imagesDir);
  for (const warning of warnings) {
    console.log(`rn-assets-catalog: ${warning}`);
  }
  if (entries.length > 0) {
    const outFile = writeGeneratedCatalog(assetsDir, entries);
    console.log(`rn-assets-catalog: wrote ${path.relative(root, outFile)} (${entries.length} image${entries.length === 1 ? "" : "s"})`);
  }

  const colors = scanColors(colorsDir);
  for (const warning of colors.warnings) {
    console.log(`rn-assets-catalog: ${warning}`);
  }
  if (colors.entries.length > 0) {
    const colorOutFile = writeGeneratedColorCatalog(assetsDir, colors.entries);
    console.log(`rn-assets-catalog: wrote ${path.relative(root, colorOutFile)} (${colors.entries.length} color${colors.entries.length === 1 ? "" : "s"})`);
  }

  if (ensureAssetsIndexBarrel(assetsDir, colors.entries.length > 0)) {
    console.log("rn-assets-catalog: assets/index.ts didn't exist — created a default (import { useImage" + (colors.entries.length > 0 ? ", useColor" : "") + " } from './assets')");
  }

  const appIcon = scanAppIcon(appIconDir);
  for (const warning of appIcon.warnings) {
    console.log(`rn-assets-catalog: ${warning}`);
  }
} catch (err) {
  // Best-effort only, unlike generate-asset-catalog.js — log and exit 0 regardless, never fail
  // someone's `npm install` over a scaffolding hiccup.
  const message = err instanceof AssetCatalogError ? err.message : err.stack;
  console.log(`rn-assets-catalog: postinstall scaffolding skipped (${message})`);
}

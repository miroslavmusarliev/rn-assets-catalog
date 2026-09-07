#!/usr/bin/env node

/**
 * Portable, zero-config codegen — drop this whole `asset-catalog-tool/` folder into any React
 * Native project's repo root. Scans <project>/assets/images/<name>/{<name>_light.png,
 * <name>_dark.png?, config.json?} (see lib/asset-catalog-core.js's slotFilename for the full
 * naming convention, including @2x/@3x density variants) and regenerates
 * <project>/assets/image-catalog.generated.ts — a typed ImageName union + a Record of require()'d
 * sources, so adding/removing/renaming an image folder never needs a hand-edited registry. Also
 * scans <project>/assets/colors/<name>/color.json (a lightweight sibling catalog — no images,
 * just declared light/dark hex pairs, see lib/asset-catalog-core.js's scanColors doc comment) and
 * regenerates <project>/assets/color-catalog.generated.ts the same way — but colors are entirely
 * optional: an empty or missing assets/colors/ directory is not an error, unlike assets/images/.
 *
 * config.json is optional: a folder with just a light appearance infers `mode: 'template'` (the
 * common tintable-glyph case), and one with both light and dark appearances infers
 * `mode: 'original'` (a real second asset implies non-tintable art — a template image never needs
 * a dark file, tinting handles it). Whenever it's missing, this script writes config.json with
 * the inferred mode back to disk — so a folder becomes self-documenting (and hand-overridable) the first time
 * it's generated, rather than silently re-guessing forever. Override it when the inferred guess
 * is wrong (e.g. a non-tintable logo with no dark asset yet — it would otherwise infer
 * 'template'). config.json can also carry a per-image `"tint"` override for 'template' images —
 * see lib/asset-catalog-core.js's parseTintOverride doc comment.
 *
 * Wire it in as an npm script pointed at wherever you drop this folder (e.g.
 * `"generate:images": "node ./asset-catalog-tool/generate-asset-catalog.js"`), then run that
 * script (or chain it as a `pre*` hook on your build/start scripts) whenever assets/images/ or
 * assets/colors/ changes. Or skip hand-editing folders altogether and use
 * asset-catalog-server.js's browser-based editor, which calls this same scanning/writing logic
 * after every change.
 *
 * Also scans <project>/assets/app-icon/{ios,android,web}/ (the app's own icon, special-cased vs.
 * a generic image — see lib/asset-catalog-core.js's scanAppIcon doc comment) purely to surface any
 * warnings; there's no generated .ts output for it since app.json references its files directly by
 * path, not via a useImage()-style lookup.
 */

const path = require("path");
const {
  scanImages,
  writeGeneratedCatalog,
  scanColors,
  writeGeneratedColorCatalog,
  ensureAssetCatalogHooks,
  ensureAssetsIndexBarrel,
  scanAppIcon,
  AssetCatalogError,
} = require("./lib/asset-catalog-core");

const root = process.cwd();
const imagesDir = path.join(root, "assets", "images");
const colorsDir = path.join(root, "assets", "colors");
const appIconDir = path.join(root, "assets", "app-icon");
const assetsDir = path.join(root, "assets");
const hooksDir = path.join(root, "hooks");

try {
  const createdHooks = ensureAssetCatalogHooks(hooksDir);
  for (const filename of createdHooks) {
    console.log(`generate-asset-catalog: hooks/${filename} didn't exist — created a default`);
  }

  const { entries, warnings } = scanImages(imagesDir);
  for (const warning of warnings) {
    console.log(`generate-asset-catalog: ${warning}`);
  }
  if (entries.length === 0) {
    throw new AssetCatalogError(`no image folders found under ${path.relative(root, imagesDir)}`);
  }
  const outFile = writeGeneratedCatalog(assetsDir, entries);
  console.log(`generate-asset-catalog: wrote ${path.relative(root, outFile)} (${entries.length} image${entries.length === 1 ? "" : "s"})`);

  const colors = scanColors(colorsDir);
  for (const warning of colors.warnings) {
    console.log(`generate-asset-catalog: ${warning}`);
  }
  if (colors.entries.length > 0) {
    const colorOutFile = writeGeneratedColorCatalog(assetsDir, colors.entries);
    console.log(`generate-asset-catalog: wrote ${path.relative(root, colorOutFile)} (${colors.entries.length} color${colors.entries.length === 1 ? "" : "s"})`);
  }

  if (ensureAssetsIndexBarrel(assetsDir, colors.entries.length > 0)) {
    console.log("generate-asset-catalog: assets/index.ts didn't exist — created a default (import { useImage" + (colors.entries.length > 0 ? ", useColor" : "") + " } from './assets')");
  }

  const appIcon = scanAppIcon(appIconDir);
  for (const warning of appIcon.warnings) {
    console.log(`generate-asset-catalog: ${warning}`);
  }
} catch (err) {
  const message = err instanceof AssetCatalogError ? err.message : err.stack;
  console.error(`generate-asset-catalog: ${message}`);
  process.exit(1);
}

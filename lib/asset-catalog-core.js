/**
 * Shared logic for the asset-catalog-tool: scanning assets/images/<name>/ folders and writing
 * assets/image-catalog.generated.ts. Used by both generate-asset-catalog.js (the CLI, meant to be
 * wired into the consuming project's build/start scripts) and asset-catalog-server.js (the local
 * browser editor) so the two never drift on validation/inference rules. Framework/project
 * agnostic — this file has no dependency on anything outside plain Node's fs/path.
 */

const fs = require("fs");
const path = require("path");

// A "slot" identifies one physical file an image folder can hold: "light" or "dark" for the bare
// 1x file, "light@2x"/"dark@1.5x"/etc. for a density variant — the slot key IS the filename suffix
// (see slotFilename), so there's no separate encoding step between the two. Density isn't a fixed
// enum here: Metro itself doesn't hardcode which scales exist — metro-config's default
// `resolver.assetResolutions` is ["1", "1.5", "2", "3", "4"], but a project can configure any set
// of numeric resolutions it wants (metro/src/node-haste/DependencyGraph.js builds candidate asset
// paths straight from that list: `basePath + "@" + resolution + "x" + extension`). So instead of
// enumerating a fixed slot list and checking each for existence, this tool DISCOVERS whatever
// density files actually exist per image by pattern-matching filenames (see parseSlotFilename) —
// any `<name>_(light|dark)(@<number>x)?.png` on disk is a recognized slot, whether it's one of the
// common values (1.5/2/3/4, offered as quick-add buttons in the editor) or a fully custom one a
// project's own metro.config.js happens to support.
//
// require('./<name>_light.png') automatically picks up same-folder @Nx siblings at bundle time
// with no code change, and crucially does NOT need the exact bare file to physically exist — see
// metro-resolver's resolveAsset.js: it builds candidate paths from the bare name and just drops
// whichever don't exist on disk, succeeding as long as at least one does. (The one thing that DOES
// break resolution: requiring an already-@Nx-suffixed path directly, e.g.
// require('./foo@2x.png') — resolveAsset.js's own guard skips density resolution entirely for a
// request shaped like that, so generatedCatalogSource must always emit a bare require(), never
// entry.lightSource/darkSource literally.) No single slot is mandatory: an image needs at least ONE
// of its light-appearance files present, and separately, at least one of its dark-appearance files
// if it has a dark appearance at all — see scanImages's `resolvePrimarySlot`, which exists only to
// answer "does this appearance have anything at all, and if I need one physical file to point a
// browser preview at, which one" — not to pick the require() target.
const DENSITY_PATTERN = /^([0-9]+(?:\.[0-9]+)?)$/;
const SLOT_PATTERN = /^(light|dark)(?:@([0-9]+(?:\.[0-9]+)?)x)?$/;

/** The on-disk filename for one image's slot — the slot key already IS the filename's own suffix
 * (`"light"` -> `<name>_light.png`, `"light@2x"` -> `<name>_light@2x.png`), so this is pure string
 * assembly, no lookup table. Named after the image itself (not a generic "image.png") purely for
 * legibility browsing an image's folder in an editor/Finder — the containing per-name folder
 * already disambiguates images from each other regardless of filename. `name` may be namespaced
 * (e.g. "drawer/home") — only the last segment (the leaf folder's own name) is ever used as the
 * filename prefix, since the namespace is already encoded by the folder nesting itself; a bare,
 * unnamespaced name is unaffected (there's no "/" to strip). */
function slotFilename(name, slot) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return `${base}_${slot}.png`;
}

/** True for any string shaped like a valid slot key: "light", "dark", "light@2x", "dark@1.5x", …
 * — any non-negative number is accepted as a density (see the module comment above for why this
 * isn't restricted to a fixed enum). Used to recognize request-body fields as image slots. */
function isSlotKey(key) {
  return typeof key === "string" && SLOT_PATTERN.test(key);
}

/** True for a bare density string like "1", "1.5", "2", "4" — NOT a slot key (no "light@"/"dark@"
 * prefix, no "x" suffix). Used to validate a user-typed custom density value before it's turned
 * into a slot key via `slotForDensity`. */
function isValidDensity(value) {
  return typeof value === "string" && DENSITY_PATTERN.test(value) && Number(value) > 0;
}

/** Builds a slot key from an appearance and a density string — the inverse of parseSlotFilename's
 * `{ appearance, density }`. `density: "1"` is the bare file (no `@Nx` suffix at all). */
function slotForDensity(appearance, density) {
  return density === "1" ? appearance : `${appearance}@${density}x`;
}

/** Parses a filename found inside an image's own folder into `{ slot, appearance, density }`, or
 * returns null if it doesn't match this image's naming convention at all (an unrecognized file).
 * `density` is `"1"` for the bare file, else the numeric string after `@` (e.g. `"2"`, `"1.5"`). */
function parseSlotFilename(name, filename) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = filename.match(new RegExp(`^${escapedName}_(light|dark)(?:@([0-9]+(?:\\.[0-9]+)?)x)?\\.png$`));
  if (!match) return null;
  const appearance = match[1];
  const density = match[2] ?? "1";
  const slot = match[2] ? `${appearance}@${match[2]}x` : appearance;
  return { slot, appearance, density };
}

/** Every recognized slot physically present in an image's folder, as `{ slot, appearance, density
 * }` objects — the ground truth this tool derives everything else (lightSource, densities,
 * warnings about unrecognized files) from. `dir`'s own basename is used as the image name. */
function scanSlotsInDir(dir) {
  const name = path.basename(dir);
  return fs
    .readdirSync(dir)
    .map((filename) => parseSlotFilename(name, filename))
    .filter(Boolean);
}

// A bare segment ("drawer-home"), or several segments joined by "/" for namespacing
// ("drawer/home", arbitrary depth — "nav/drawer/home" is fine too). Each segment follows the same
// lowercase-letters/digits/hyphens rule as before; "/" is only ever a segment separator, never
// part of a segment itself, so "drawer//home", "/drawer", and "drawer/" are all rejected (an empty
// segment). This also means no ".." is ever possible in a name (dots aren't a legal character at
// all), so resolving a namespaced name into a path is exactly as traversal-safe as a flat one.
const NAME_SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";
const NAME_PATTERN = new RegExp(`^${NAME_SEGMENT}(?:/${NAME_SEGMENT})*$`);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

class AssetCatalogError extends Error {}

function isValidName(name) {
  return typeof name === "string" && NAME_PATTERN.test(name);
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_MAGIC);
}

function isHexColor(value) {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value);
}

/** Parses an image's optional per-image tint override from its already-parsed config.json object.
 * Absent or the string "default" means "no override, defer to the app's own
 * _assetCatalogColorPrimaryTint.js" — anything else must be a full { light, dark } hex pair.
 * Returns undefined for "no override", or the validated { light, dark } pair. Throws
 * AssetCatalogError on anything malformed (not silently ignored, since a typo'd hex value should
 * surface immediately rather than quietly falling back to the app default). */
function parseTintOverride(config, name) {
  const raw = config.tint;
  if (raw === undefined || raw === "default") return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AssetCatalogError(`assets/images/${name}/config.json: "tint" must be "default" or { "light": "#hex", "dark": "#hex" }`);
  }
  if (!isHexColor(raw.light) || !isHexColor(raw.dark)) {
    throw new AssetCatalogError(`assets/images/${name}/config.json: "tint" must have valid hex "light" and "dark" colors`);
  }
  return { light: raw.light, dark: raw.dark };
}

/** Resolves assets/images/<name>, rejecting anything that isn't a plain "foo-bar"-style name
 * (optionally namespaced with "/", e.g. "drawer/home") — the only thing image names are ever
 * allowed to be — so a request can't escape the images dir. */
function resolveImageDir(imagesDir, name) {
  if (!isValidName(name)) {
    throw new AssetCatalogError(`invalid image name ${JSON.stringify(name)} — use lowercase letters/digits/hyphens, optionally namespaced with "/", e.g. "drawer-home" or "drawer/home"`);
  }
  return path.join(imagesDir, name);
}

/** Picks which ONE physical file best represents an appearance, among `slots` (as returned by
 * `scanSlotsInDir`, already filtered to one appearance) — prefers the lowest density (usually the
 * bare 1x file), sorting numerically so "1.5" doesn't come before "1" (a lexical stop-gap) but
 * after it. NOT used to build the generated catalog's require() call (that always requires the
 * bare filename regardless of what's on disk — see the module-level comment above for why). This
 * exists for the two places that need one concrete, currently-existing file: (1) determining
 * whether an appearance exists at all (returns null on an empty list — fine for "dark", fatal for
 * "light"), and (2) the browser editor's own image preview, which — unlike Metro at runtime — has
 * no device pixel ratio to resolve against and just needs a real URL to render. */
function pickLowestDensitySlot(slots) {
  if (slots.length === 0) return null;
  return [...slots].sort((a, b) => Number(a.density) - Number(b.density))[0];
}

/**
 * Scans one image's own folder (`dir`, whose catalog name is the namespaced `name`, e.g.
 * "drawer/home") for {<basename>_light.png, <basename>_light@2x.png, ..., config.json?} and, if
 * anything matched, pushes one entry onto `entries` — then unconditionally recurses into every
 * subdirectory of `dir` (namespaced one level deeper) so a folder can be a namespace container, a
 * leaf image, or both at once. A folder holding zero files of its own but at least one
 * subdirectory is treated as a pure namespace node (nothing to validate there, just a grouping
 * level) — anything else with no light-appearance file is still the same authoring error it
 * always was. A folder missing config.json gets one materialized on disk with an inferred mode (a
 * dark appearance present → 'original', otherwise 'template') — see generate-asset-catalog.js's
 * doc comment for why. No single density file is mandatory — an image just needs at least one of
 * its light-appearance files present; same for its dark appearance, if it has one at all (the
 * generated catalog's require() is always the bare filename regardless of which specific file(s)
 * exist — see the module-level comment above). Throws AssetCatalogError on anything structurally
 * wrong (no light-appearance file at all, bad config.json).
 */
function scanImageDir(dir, name, entries, warnings) {
  const dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  const subdirNames = dirEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const files = dirEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  if (files.length > 0) {
    const slots = scanSlotsInDir(dir);
    const recognizedFilenames = new Set([...slots.map((s) => slotFilename(name, s.slot)), "config.json"]);

    for (const file of files) {
      if (!recognizedFilenames.has(file)) {
        warnings.push(`ignoring unrecognized file "${file}" in assets/images/${name}/`);
      }
    }

    const lightSlots = slots.filter((s) => s.appearance === "light");
    const darkSlots = slots.filter((s) => s.appearance === "dark");
    const lightPrimary = pickLowestDensitySlot(lightSlots);
    if (!lightPrimary) {
      const base = name.slice(name.lastIndexOf("/") + 1);
      throw new AssetCatalogError(`assets/images/${name}/ needs at least one light-appearance file (e.g. ${base}_light.png or ${base}_light@2x.png)`);
    }
    const darkPrimary = pickLowestDensitySlot(darkSlots);
    const lightSource = slotFilename(name, lightPrimary.slot);
    const darkSource = darkPrimary ? slotFilename(name, darkPrimary.slot) : null;
    const hasDark = darkSource !== null;

    let mode;
    let tint;
    const configPath = path.join(dir, "config.json");
    if (files.includes("config.json")) {
      let config;
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (err) {
        throw new AssetCatalogError(`assets/images/${name}/config.json is not valid JSON (${err.message})`);
      }
      if (config.mode !== "template" && config.mode !== "original") {
        throw new AssetCatalogError(`assets/images/${name}/config.json: "mode" must be "template" or "original", got ${JSON.stringify(config.mode)}`);
      }
      mode = config.mode;
      tint = parseTintOverride(config, name);
      if (tint !== undefined && mode !== "template") {
        warnings.push(`assets/images/${name}/config.json has a "tint" override but mode is "original" — 'original' images are never tinted, ignoring it`);
        tint = undefined;
      }
    } else {
      mode = hasDark ? "original" : "template";
      fs.writeFileSync(configPath, JSON.stringify({ mode }, null, 2) + "\n");
      warnings.push(`assets/images/${name}/ had no config.json — generated one with inferred mode: '${mode}'`);
    }

    entries.push({
      name,
      mode,
      hasDark,
      tint,
      lightSource,
      darkSource,
      // Every density actually present per appearance, as sorted numeric-density strings — NOT a
      // fixed { light2x, light3x } shape, since density values are open-ended (see the
      // module-level comment above). "1" (the bare file) is included here too, so the editor can
      // treat every slot uniformly instead of special-casing the base file.
      densities: {
        light: lightSlots.map((s) => s.density).sort((a, b) => Number(a) - Number(b)),
        dark: darkSlots.map((s) => s.density).sort((a, b) => Number(a) - Number(b)),
      },
    });
  }

  for (const sub of subdirNames) {
    scanImageDir(path.join(dir, sub), `${name}/${sub}`, entries, warnings);
  }
}

/** Scans assets/images/ for every image, at any namespace depth — see scanImageDir's doc comment
 * for the per-folder rules. Returns { entries, warnings } — never throws for merely informational
 * conditions (only scanImageDir's structural errors propagate). */
function scanImages(imagesDir) {
  if (!fs.existsSync(imagesDir)) {
    throw new AssetCatalogError(`missing directory ${imagesDir}`);
  }

  const names = fs
    .readdirSync(imagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const entries = [];
  const warnings = [];

  for (const name of names) {
    scanImageDir(path.join(imagesDir, name), name, entries, warnings);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, warnings };
}

function generatedCatalogSource(entries) {
  const lines = [];
  lines.push("// AUTO-GENERATED by asset-catalog-tool/generate-asset-catalog.js — do not hand-edit.");
  lines.push("// Regenerated automatically before your app's build/start scripts (however the consuming");
  lines.push("// project wires generate-asset-catalog.js as a pre* hook), and after every change made");
  lines.push("// through asset-catalog-tool's local editor (asset-catalog-server.js). Re-run it directly");
  lines.push("// to refresh this file sooner by hand.");
  lines.push("import type { ImageSourcePropType } from 'react-native';");
  lines.push("");
  lines.push(
    entries.length > 0
      ? `export type ImageName = ${entries.map((e) => `'${e.name}'`).join(" | ")};`
      : "export type ImageName = never;",
  );
  lines.push("");
  lines.push("export type ImageRenderMode = 'template' | 'original';");
  lines.push("");
  lines.push("export interface ImageCatalogEntry {");
  lines.push("  mode: ImageRenderMode;");
  lines.push("  light: ImageSourcePropType;");
  lines.push("  dark?: ImageSourcePropType;");
  lines.push("  /** Per-image tint override for 'template' mode — absent means \"default\": defer to");
  lines.push("   * hooks/_assetCatalogColorPrimaryTint.js. Set via this image's own config.json. */");
  lines.push("  tint?: { light: string; dark: string };");
  lines.push("}");
  lines.push("");
  lines.push("export const IMAGE_CATALOG: Record<ImageName, ImageCatalogEntry> = {");
  for (const entry of entries) {
    // Always require the BARE filename (never entry.lightSource/darkSource directly) — Metro's own
    // asset resolver (metro-resolver's resolveAsset.js + DependencyGraph.js's resolveAsset
    // callback) builds its density-family candidates from the bare name and silently drops
    // whichever @2x/@3x/etc siblings don't exist, succeeding as long as ANY of them do. But if the
    // require() path *itself* already ends in "@Nx", resolveAsset.js's own guard
    // (`!/@\d+(?:\.\d+)?x$/.test(basename)`) skips density resolution entirely and returns null —
    // which Metro then treats as a hard "unable to resolve asset" failure, not a graceful
    // single-file fallback. So requiring entry.lightSource/darkSource directly would BREAK the
    // build the moment an image's 1x file is missing; the bare name always works, with or without
    // that file physically present, precisely because resolveAsset() never requires it to exist.
    const light = `require('./images/${entry.name}/${slotFilename(entry.name, "light")}')`;
    const dark = entry.hasDark ? `, dark: require('./images/${entry.name}/${slotFilename(entry.name, "dark")}')` : "";
    const tint = entry.tint ? `, tint: { light: '${entry.tint.light}', dark: '${entry.tint.dark}' }` : "";
    lines.push(`  '${entry.name}': { mode: '${entry.mode}', light: ${light}${dark}${tint} },`);
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

function writeGeneratedCatalog(assetsDir, entries) {
  const outFile = path.join(assetsDir, "image-catalog.generated.ts");
  fs.writeFileSync(outFile, generatedCatalogSource(entries));
  return outFile;
}

/**
 * Resolves assets/colors/<name>.json. Unlike an image (a family of light/dark/@2x/@3x files plus
 * config.json, which genuinely needs a per-name folder to group them), a color is always exactly
 * one JSON object with no siblings — so the file itself, not a same-named folder wrapping it, is
 * the unit. `<name>.json` directly under colorsDir rather than `<name>/color.json`. `name` may be
 * namespaced (e.g. "brand/primary"), which just becomes real nested directories —
 * assets/colors/brand/primary.json — same as an image's namespace segments become real folders.
 */
function resolveColorFile(colorsDir, name) {
  if (!isValidName(name)) {
    throw new AssetCatalogError(`invalid color name ${JSON.stringify(name)} — use lowercase letters/digits/hyphens, optionally namespaced with "/", e.g. "brand-primary" or "brand/primary"`);
  }
  return path.join(colorsDir, `${name}.json`);
}

/**
 * Scans one directory (`dir`, whose colors are namespaced under `prefix` — e.g. "brand" for
 * assets/colors/brand/) for <name>.json files and subdirectories, recursing into the latter one
 * namespace level deeper. `prefix` is `""` at the assets/colors/ root itself.
 */
function scanColorsDir(dir, prefix, entries, warnings) {
  const dirEntries = fs.readdirSync(dir, { withFileTypes: true });

  for (const dirEntry of dirEntries) {
    const namespacedFilename = prefix ? `${prefix}/${dirEntry.name}` : dirEntry.name;

    if (dirEntry.isDirectory()) {
      scanColorsDir(path.join(dir, dirEntry.name), namespacedFilename, entries, warnings);
      continue;
    }
    if (!dirEntry.isFile()) {
      warnings.push(`ignoring unrecognized entry "${namespacedFilename}" in assets/colors/ (expected a <name>.json file)`);
      continue;
    }
    if (!dirEntry.name.endsWith(".json")) {
      warnings.push(`ignoring unrecognized file "${namespacedFilename}" in assets/colors/`);
      continue;
    }
    const name = namespacedFilename.slice(0, -".json".length);
    if (!isValidName(name)) {
      throw new AssetCatalogError(`invalid color filename "${namespacedFilename}" — use lowercase letters/digits/hyphens, optionally namespaced with "/", e.g. "brand-primary.json" or "brand/primary.json"`);
    }

    let color;
    try {
      color = JSON.parse(fs.readFileSync(path.join(dir, dirEntry.name), "utf8"));
    } catch (err) {
      throw new AssetCatalogError(`assets/colors/${namespacedFilename} is not valid JSON (${err.message})`);
    }
    if (!isHexColor(color.light)) {
      throw new AssetCatalogError(`assets/colors/${namespacedFilename}: "light" must be a valid hex color, got ${JSON.stringify(color.light)}`);
    }
    if (color.dark !== undefined && !isHexColor(color.dark)) {
      throw new AssetCatalogError(`assets/colors/${namespacedFilename}: "dark" must be a valid hex color, got ${JSON.stringify(color.dark)}`);
    }

    entries.push({ name, light: color.light, dark: color.dark ?? color.light });
  }
}

/**
 * Scans assets/colors/ for every <name>.json — { "light": "#hex", "dark"?: "#hex" } — at any
 * namespace depth (a subdirectory namespaces every color inside it one level deeper, recursively).
 * Unlike an image, there's no image to infer a default FROM, so a color's JSON file is required
 * outright (nothing gets materialized if it's missing) — creating a color really is just creating
 * one JSON file, most naturally done through the editor's color picker rather than by hand. `dark`
 * is optional and resolves to `light`'s value at generation time (baked into the generated output,
 * so the runtime hook never has to fall back itself). Throws AssetCatalogError on anything
 * structurally wrong. Returns { entries, warnings } — never throws for merely informational
 * conditions.
 */
function scanColors(colorsDir) {
  if (!fs.existsSync(colorsDir)) {
    return { entries: [], warnings: [] };
  }

  const entries = [];
  const warnings = [];
  scanColorsDir(colorsDir, "", entries, warnings);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, warnings };
}

function generatedColorCatalogSource(entries) {
  const lines = [];
  lines.push("// AUTO-GENERATED by asset-catalog-tool/generate-asset-catalog.js — do not hand-edit.");
  lines.push("// Regenerated automatically before your app's build/start scripts (however the consuming");
  lines.push("// project wires generate-asset-catalog.js as a pre* hook), and after every change made");
  lines.push("// through asset-catalog-tool's local editor (asset-catalog-server.js). Re-run it directly");
  lines.push("// to refresh this file sooner by hand.");
  lines.push("");
  lines.push(
    entries.length > 0
      ? `export type ColorName = ${entries.map((e) => `'${e.name}'`).join(" | ")};`
      : "export type ColorName = never;",
  );
  lines.push("");
  lines.push("export interface ColorCatalogEntry {");
  lines.push("  light: string;");
  lines.push("  dark: string;");
  lines.push("}");
  lines.push("");
  lines.push("export const COLOR_CATALOG: Record<ColorName, ColorCatalogEntry> = {");
  for (const entry of entries) {
    lines.push(`  '${entry.name}': { light: '${entry.light}', dark: '${entry.dark}' },`);
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

function writeGeneratedColorCatalog(assetsDir, entries) {
  const outFile = path.join(assetsDir, "color-catalog.generated.ts");
  fs.writeFileSync(outFile, generatedColorCatalogSource(entries));
  return outFile;
}

/**
 * The app icon is a special, singular catalog entry (not a named collection like images/colors):
 * exactly one icon, split across up to three platform subdirectories under assets/app-icon/ —
 * `ios/`, `android/`, `web/` — each independently deletable ("this app doesn't ship on that
 * platform") and each holding a fixed, platform-specific set of slots that can individually be
 * left empty (e.g. iOS's optional `dark`/`tinted` variants). Unlike a generic image, there's no
 * arbitrary namespace nesting and no config.json — the platform IS the name, and the slot set is
 * fixed per platform rather than open-ended, so there's nothing to infer or validate beyond "is
 * this filename one of the platform's known slots".
 *
 * `light`/`dark`/`tinted` for iOS map straight onto Expo's `ios.icon.{light,dark,tinted}` object
 * form (distinct from the Icon Composer `.icon` bundle format, which this tool doesn't attempt to
 * generate); `foreground`/`background`/`monochrome` for Android map onto
 * `android.adaptiveIcon.{foregroundImage,backgroundImage,monochromeImage}`; `favicon` for web
 * maps onto `web.favicon`. Consult the consuming project's own app.json for the exact paths in
 * use — this tool only manages the files themselves, not app.json.
 */
const APP_ICON_PLATFORMS = {
  ios: { slots: ["light", "dark", "tinted"] },
  android: { slots: ["foreground", "background", "monochrome"] },
  web: { slots: ["favicon"] },
};

/** The on-disk filename for one platform's slot, e.g. `("ios", "tinted")` -> `"ios_tinted.png"` —
 * same `<prefix>_<slot>.png` shape as an image's slotFilename, just prefixed by the platform name
 * instead of an image name (there's no separate "name" here — the platform folder itself is the
 * only identifier this catalog entry has). */
function appIconSlotFilename(platform, slot) {
  return `${platform}_${slot}.png`;
}

function isAppIconPlatform(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(APP_ICON_PLATFORMS, value);
}

function isAppIconSlot(platform, slot) {
  return isAppIconPlatform(platform) && APP_ICON_PLATFORMS[platform].slots.includes(slot);
}

/** Resolves assets/app-icon/<platform>, rejecting anything that isn't one of the fixed known
 * platform keys — the only thing an app-icon "name" is ever allowed to be, so a request can't
 * escape the app-icon dir. */
function resolveAppIconPlatformDir(appIconDir, platform) {
  if (!isAppIconPlatform(platform)) {
    throw new AssetCatalogError(`invalid app-icon platform ${JSON.stringify(platform)} — must be one of "ios", "android", "web"`);
  }
  return path.join(appIconDir, platform);
}

/**
 * Scans assets/app-icon/ for whichever of the three platform subdirectories actually exist — a
 * missing subdirectory means that platform isn't configured at all (deliberately independent of
 * the other two: an app that doesn't ship on Android just never gets an `android/` folder, or has
 * it deleted later via the editor's per-platform delete). Returns
 * `{ platforms: { ios?: { slots: { light: 'ios_light.png' | null, ... } }, android?: {...}, web?:
 * {...} }, warnings }` — a present platform key always has every one of its slots represented
 * (`null` for a slot with no file yet, e.g. iOS's optional `dark`/`tinted`), so the editor never
 * has to special-case "slot key missing entirely" vs. "slot present but empty". Never throws for
 * merely informational conditions — an unrecognized file alongside the known slot files is a
 * warning, not an error, same as an image's own scanImageDir.
 */
function scanAppIcon(appIconDir) {
  const platforms = {};
  const warnings = [];
  if (!fs.existsSync(appIconDir)) {
    return { platforms, warnings };
  }

  for (const platform of Object.keys(APP_ICON_PLATFORMS)) {
    const dir = path.join(appIconDir, platform);
    if (!fs.existsSync(dir)) continue;

    const { slots } = APP_ICON_PLATFORMS[platform];
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const recognized = new Set(slots.map((slot) => appIconSlotFilename(platform, slot)));

    for (const file of files) {
      if (!recognized.has(file)) {
        warnings.push(`ignoring unrecognized file "${file}" in assets/app-icon/${platform}/`);
      }
    }

    const slotState = {};
    for (const slot of slots) {
      const filename = appIconSlotFilename(platform, slot);
      slotState[slot] = files.includes(filename) ? filename : null;
    }
    platforms[platform] = { slots: slotState };
  }

  return { platforms, warnings };
}

/** Relative, "./"-prefixed, POSIX-separated path from the project root to one app-icon slot's
 * file — the exact form Expo's own app.json asset references use (`./assets/app-icon/ios/...`),
 * so a value written here is byte-for-byte what a hand-written app.json would contain. */
function appIconRelativePath(platform, slot) {
  return `./assets/app-icon/${platform}/${appIconSlotFilename(platform, slot)}`;
}

/** Guesses a JSON file's indent unit by finding the first indented line — falls back to two
 * spaces if the file has none (e.g. it's all on one line). Used so rewriting app.json doesn't
 * silently switch a tab-indented file to spaces or vice versa. */
function detectIndent(text) {
  const match = text.match(/\n([ \t]+)\S/);
  return match ? match[1] : "  ";
}

/**
 * Locates the consuming project's Expo config. Only a plain `app.json` can be edited
 * automatically — `app.config.js`/`.ts` computes its config at build time via arbitrary code, so
 * safely patching just its icon fields would mean evaluating and re-serializing a JS/TS module,
 * which this tool deliberately doesn't attempt. Throws a descriptive error either way so the
 * caller can show the user exactly what to do instead of silently no-op'ing.
 */
function resolveAppConfigJsonPath(root) {
  const appJsonPath = path.join(root, "app.json");
  if (fs.existsSync(appJsonPath)) {
    return appJsonPath;
  }
  const dynamicConfig = ["app.config.js", "app.config.ts", "app.config.cjs", "app.config.mjs"].find((f) =>
    fs.existsSync(path.join(root, f)),
  );
  if (dynamicConfig) {
    throw new AssetCatalogError(
      `this project's Expo config is ${dynamicConfig}, not app.json — a dynamic config file can't be edited ` +
        "automatically here; update its icon-related expo.ios/expo.android/expo.web fields by hand",
    );
  }
  throw new AssetCatalogError("no app.json (or app.config.js/.ts) found at the project root");
}

/**
 * Writes the currently-present assets/app-icon/<platform>/ files into app.json's matching
 * `expo.ios.icon` / `expo.android.adaptiveIcon` / `expo.web.favicon` fields — the one piece of
 * app.json wiring this tool otherwise leaves entirely to the user (see scanAppIcon's own doc
 * comment: "app.json references its files directly by path", previously always by hand). Fully
 * synchronizes rather than only adding: a slot with no file on disk has its app.json key removed
 * too, so app.json never keeps pointing at a file that no longer exists. Requires at least the
 * platform's primary slot (iOS "light", Android "foreground", web's only slot "favicon") to be
 * present — that's the minimum Expo itself needs to build an icon for that platform at all.
 * Returns `{ platform, applied }` describing what was written; throws AssetCatalogError (via
 * resolveAppConfigJsonPath) if app.json can't be safely edited, or if the primary slot is missing.
 */
function applyAppIconToAppJson(root, appIconDir, platform) {
  if (!isAppIconPlatform(platform)) {
    throw new AssetCatalogError(`invalid app-icon platform ${JSON.stringify(platform)}`);
  }
  const configPath = resolveAppConfigJsonPath(root);
  const raw = fs.readFileSync(configPath, "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new AssetCatalogError(`app.json isn't valid JSON: ${err.message}`);
  }
  const expo = json.expo || json;

  const dir = resolveAppIconPlatformDir(appIconDir, platform);
  const { slots } = APP_ICON_PLATFORMS[platform];
  const present = {};
  for (const slot of slots) {
    present[slot] = fs.existsSync(path.join(dir, appIconSlotFilename(platform, slot)));
  }

  let applied;
  if (platform === "ios") {
    if (!present.light) {
      throw new AssetCatalogError('iOS needs at least a "light" icon uploaded before it can be set as the app icon');
    }
    const icon = {};
    for (const slot of slots) {
      if (present[slot]) icon[slot] = appIconRelativePath(platform, slot);
    }
    expo.ios = expo.ios || {};
    expo.ios.icon = icon;
    applied = { icon };
  } else if (platform === "android") {
    if (!present.foreground) {
      throw new AssetCatalogError('Android needs at least a "foreground" icon uploaded before it can be set as the app icon');
    }
    expo.android = expo.android || {};
    const adaptiveIcon = expo.android.adaptiveIcon || {};
    adaptiveIcon.foregroundImage = appIconRelativePath(platform, "foreground");
    if (present.background) {
      adaptiveIcon.backgroundImage = appIconRelativePath(platform, "background");
    } else {
      delete adaptiveIcon.backgroundImage;
    }
    if (present.monochrome) {
      adaptiveIcon.monochromeImage = appIconRelativePath(platform, "monochrome");
    } else {
      delete adaptiveIcon.monochromeImage;
    }
    expo.android.adaptiveIcon = adaptiveIcon;
    applied = { adaptiveIcon };
  } else {
    if (!present.favicon) {
      throw new AssetCatalogError('web needs a "favicon" icon uploaded before it can be set as the app icon');
    }
    expo.web = expo.web || {};
    expo.web.favicon = appIconRelativePath(platform, "favicon");
    applied = { favicon: expo.web.favicon };
  }

  const indent = detectIndent(raw);
  const serialized = JSON.stringify(json, null, indent) + (raw.endsWith("\n") ? "\n" : "");
  fs.writeFileSync(configPath, serialized);

  return { platform, applied };
}

/** Locates the Xcode project's `Images.xcassets/AppIcon.appiconset` directory — the exact
 * location `expo prebuild` itself generates an app icon into. Returns null if there's no `ios/`
 * directory at all (never prebuilt yet, or this project doesn't ship iOS) — doesn't require
 * `AppIcon.appiconset` to already exist, since syncAppIconToNative creates it on first use. */
function findIosAppIconSet(root) {
  const iosDir = path.join(root, "ios");
  if (!fs.existsSync(iosDir)) return null;
  const appDir = fs
    .readdirSync(iosDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "Pods")
    .find((entry) => fs.existsSync(path.join(iosDir, entry.name, "Images.xcassets")));
  if (!appDir) return null;
  return path.join(iosDir, appDir.name, "Images.xcassets", "AppIcon.appiconset");
}

/** Locates `android/app/src/main/res` — Android's resource root. Returns null if there's no
 * `android/` directory at all (never prebuilt yet, or this project doesn't ship Android). */
function findAndroidResDir(root) {
  const resDir = path.join(root, "android", "app", "src", "main", "res");
  return fs.existsSync(resDir) ? resDir : null;
}

/** Whether each native platform folder currently exists — cheap enough to compute on every
 * regenerate() so the editor always knows, with no separate round trip, whether "sync to native
 * project" has anywhere to write into yet. */
function appIconNativeStatus(root) {
  return { ios: Boolean(findIosAppIconSet(root)), android: Boolean(findAndroidResDir(root)) };
}

/** iOS Contents.json for the modern (Xcode 14+) single-size, multi-appearance app icon format —
 * one 1024x1024 "universal" image per appearance actually present (light is always required;
 * dark/tinted mirror Expo's optional `ios.icon.{dark,tinted}`). This is the same shape `expo
 * prebuild` itself writes, so a later real prebuild produces no diff against a synced copy. */
function iosAppIconContentsJson(present) {
  const images = [
    { filename: appIconSlotFilename("ios", "light"), idiom: "universal", platform: "ios", size: "1024x1024" },
  ];
  if (present.dark) {
    images.push({
      appearances: [{ appearance: "luminosity", value: "dark" }],
      filename: appIconSlotFilename("ios", "dark"),
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    });
  }
  if (present.tinted) {
    images.push({
      appearances: [{ appearance: "luminosity", value: "tinted" }],
      filename: appIconSlotFilename("ios", "tinted"),
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    });
  }
  return { images, info: { author: "xcode", version: 1 } };
}

// One representative density bucket Android's adaptive-icon foreground/background/monochrome get
// copied into — see syncAppIconToNative's doc comment for why this isn't every mipmap-* density.
const ANDROID_ICON_RES_DENSITY = "mipmap-xxxhdpi";
const ANDROID_ICON_RES_NAMES = { foreground: "ic_launcher_foreground", background: "ic_launcher_background", monochrome: "ic_launcher_monochrome" };

function androidAdaptiveIconXml(hasMonochrome) {
  const monochromeTag = hasMonochrome ? '\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>' : "";
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@mipmap/ic_launcher_background"/>\n' +
    '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>' +
    monochromeTag +
    "\n</adaptive-icon>\n"
  );
}

/**
 * Best-effort direct copy of assets/app-icon/<platform>/ into the native ios/ or android/ project
 * — the alternative to running `expo prebuild`, for whoever wants the change live without a full
 * native regeneration. Requires ios/ or android/ to already exist (i.e. at least one real prebuild
 * has happened before): this never creates a native project from scratch, only updates icon files
 * inside one that's already there.
 *
 * iOS gets full fidelity: Expo's own modern Contents.json format, one 1024x1024 image per
 * appearance, byte-identical to what `expo prebuild` itself would produce.
 *
 * Android is intentionally partial: this copies foreground/background/monochrome into ONE
 * representative density bucket (mipmap-xxxhdpi) instead of resizing into every density Expo's
 * own prebuild plugin generates (mipmap-mdpi through xxxhdpi) — real per-density resizing needs an
 * actual image-processing library (sharp et al.), which this zero-dependency tool doesn't carry. A
 * single xxxhdpi-only icon still renders correctly system-wide (Android scales it for other
 * densities), just without the sharper per-density asset a real prebuild produces — good enough
 * for local iteration, not a substitute for prebuilding before a release build. This also does not
 * attempt the legacy pre-Android-8.0 flattened (non-adaptive) fallback icon, since compositing
 * foreground+background into one flat image is the same "needs real image processing" problem —
 * a warning is returned instead of silently skipping it.
 *
 * Web has no native project to sync into — app.json's `web.favicon` is read directly by the web
 * build, so applyAppIconToAppJson alone is already everything web needs. Throws if called with
 * platform "web" so a caller doesn't have to special-case an always-empty result.
 */
function syncAppIconToNative(root, appIconDir, platform) {
  if (platform === "web") {
    throw new AssetCatalogError(
      "web has no native project to sync into — app.json's web.favicon already points straight at the file",
    );
  }
  if (!isAppIconPlatform(platform)) {
    throw new AssetCatalogError(`invalid app-icon platform ${JSON.stringify(platform)}`);
  }

  const dir = resolveAppIconPlatformDir(appIconDir, platform);
  const { slots } = APP_ICON_PLATFORMS[platform];
  const present = {};
  for (const slot of slots) {
    present[slot] = fs.existsSync(path.join(dir, appIconSlotFilename(platform, slot)));
  }

  const copied = [];
  const warnings = [];

  if (platform === "ios") {
    const appIconSetDir = findIosAppIconSet(root);
    if (!appIconSetDir) {
      throw new AssetCatalogError("no ios/ directory found — run `expo prebuild` at least once before syncing directly into the native project");
    }
    if (!present.light) {
      throw new AssetCatalogError('iOS needs at least a "light" icon uploaded before it can be synced');
    }
    fs.mkdirSync(appIconSetDir, { recursive: true });
    for (const slot of slots) {
      if (!present[slot]) continue;
      const filename = appIconSlotFilename(platform, slot);
      fs.copyFileSync(path.join(dir, filename), path.join(appIconSetDir, filename));
      copied.push(`ios/.../AppIcon.appiconset/${filename}`);
    }
    fs.writeFileSync(path.join(appIconSetDir, "Contents.json"), JSON.stringify(iosAppIconContentsJson(present), null, 2) + "\n");
    copied.push("ios/.../AppIcon.appiconset/Contents.json");
  } else {
    const resDir = findAndroidResDir(root);
    if (!resDir) {
      throw new AssetCatalogError("no android/ directory found — run `expo prebuild` at least once before syncing directly into the native project");
    }
    if (!present.foreground) {
      throw new AssetCatalogError('Android needs at least a "foreground" icon uploaded before it can be synced');
    }
    const densityDir = path.join(resDir, ANDROID_ICON_RES_DENSITY);
    fs.mkdirSync(densityDir, { recursive: true });
    for (const slot of slots) {
      if (!present[slot]) continue;
      const destName = `${ANDROID_ICON_RES_NAMES[slot]}.png`;
      fs.copyFileSync(path.join(dir, appIconSlotFilename(platform, slot)), path.join(densityDir, destName));
      copied.push(`android/.../res/${ANDROID_ICON_RES_DENSITY}/${destName}`);
    }
    const anydpiDir = path.join(resDir, "mipmap-anydpi-v26");
    fs.mkdirSync(anydpiDir, { recursive: true });
    const xml = androidAdaptiveIconXml(present.monochrome);
    fs.writeFileSync(path.join(anydpiDir, "ic_launcher.xml"), xml);
    fs.writeFileSync(path.join(anydpiDir, "ic_launcher_round.xml"), xml);
    copied.push("android/.../res/mipmap-anydpi-v26/ic_launcher.xml", "android/.../res/mipmap-anydpi-v26/ic_launcher_round.xml");
    warnings.push(
      `copied into a single density bucket (${ANDROID_ICON_RES_DENSITY}) only, not every mipmap-* density — run ` +
        "`expo prebuild` for full per-density fidelity before a release build",
    );
    warnings.push(
      "skipped the legacy pre-Android-8.0 flattened fallback icon (needs image compositing this tool doesn't do) " +
        "— only devices on API 26+ (adaptive icons) will see the update from this sync",
    );
  }

  return { platform, copied, warnings };
}

/**
 * The hook contract a consuming project owns in its own `hooks/` directory — plain CommonJS
 * (`.js`, not `.ts`) specifically so `useAssetCatalogColorScheme`'s default can *try* requiring
 * 'react-native' and fall back if it's absent; a static ES `import` can't be caught like that.
 * Each file is written ONLY if missing (never overwritten after — same "materialize once, then
 * it's a normal project file you own" rule as an image's config.json) so a project's own edits are
 * never clobbered by a later generate-asset-catalog.js run.
 *
 * Only the first of these three is an actual hook — the rest are named with a leading underscore
 * instead of "use" precisely so they *aren't* mistaken for one and called somewhere that expects
 * Rules-of-Hooks semantics; useIconSource.ts is their only intended caller either way.
 *
 * (There's deliberately no secondary/tertiary tint here — that's a plausible future extension,
 * not something anything currently consumes, so it isn't scaffolded until it's actually needed.
 * If you add one later, follow _assetCatalogColorPrimaryTint.js's exact shape: a plain function
 * taking `variant: 'light' | 'dark'`, returning a single hex for it.)
 *
 *   useAssetCatalogColorScheme()             -> 'light' | 'dark' — the one real hook here;
 *                                                useIconSource.ts calls it once and passes the
 *                                                result into the tint function below.
 *   _assetCatalogColorPrimaryTint(variant)   -> hex for that variant (black/white by default) —
 *                                                takes 'light' | 'dark', not { light, dark }:
 *                                                being a plain function (not a hook) it can't
 *                                                resolve the scheme itself, so the caller already
 *                                                knows which variant it wants before calling.
 *   _assetCatalogEditorBackgroundColor()     -> { light, dark } hex — the one exception that
 *                                                DOES return both at once: read by
 *                                                asset-catalog-server.js (a plain Node process, no
 *                                                bundler, no live "current theme" to resolve) to
 *                                                build a CSS media query the browser picks from,
 *                                                not a single value picked ahead of time.
 */
const HOOK_SCAFFOLDS = {
  "useAssetCatalogColorScheme.js": `/**
 * useAssetCatalogColorScheme — asset-catalog-tool's hooks/ contract, file 1 of 3.
 *
 * AUTO-GENERATED DEFAULT — created just now because hooks/useAssetCatalogColorScheme.js didn't
 * exist yet. This file is written ONLY when missing: asset-catalog-tool will never touch it again
 * after this, so everything below is yours to edit freely — this comment included.
 *
 * DO NOT CALL THIS FROM YOUR APP'S OWN SCREENS/COMPONENTS.
 * This whole hooks/ directory is a bridge for asset-catalog-tool's internal use only —
 * useIconSource.ts (and the other files in this directory) are its only intended callers. If a
 * component elsewhere in your app needs to know light-vs-dark, read it from your app's own
 * theme/appearance code, not by importing this file — that keeps this bridge free to change
 * shape later without hunting down unrelated call sites across your app.
 *
 * WHAT THIS IS FOR
 * The single place every color decision in the image catalog ultimately asks "light or dark right
 * now?" — useAssetCatalogColorPrimaryTint (below) derives its black/white default from this, and
 * useImage (in asset-catalog-tool/useIconSource.ts) calls it directly to decide whether an
 * 'original'-mode image should swap in its dark-mode asset. It is called on every render of every
 * component that uses an image, so keep it cheap and side-effect-free, same as any other hook.
 *
 * CONTRACT
 * Must return exactly the string 'light' or 'dark' — never null, undefined, or anything else,
 * so every caller can branch on it with a plain === check instead of also handling a third state.
 *
 * DEFAULT BEHAVIOR
 * Tries to use React Native's own built-in useColorScheme() hook, tracking the OS-level
 * appearance setting. If 'react-native' can't be required at all (e.g. this were dropped into a
 * non-RN project), falls back to a hook that always returns 'light' rather than crashing — that
 * fallback only ever engages if the require() below throws; the require() is written this way
 * (dynamic, wrapped in try/catch) specifically because a static ES \`import\` can't be caught if
 * it fails to resolve, unlike this CommonJS require().
 *
 * WHEN TO REPLACE THIS
 * If your app already has its own theme system — most commonly a manual light/dark/system
 * toggle the user can pick independently of their device's actual OS setting — replace the body
 * of useAssetCatalogColorScheme() below with a call into your own theme hook, mapped down to the
 * same 'light' | 'dark' return type. Nothing else needs to change: every other file in hooks/
 * and useIconSource.ts itself are unaffected by how this one function is implemented, only by
 * which of the two strings it returns. Example, if your app exports \`useTheme()\` returning
 * \`{ colorScheme: 'light' | 'dark' }\`:
 *
 *   const { useTheme } = require('../src/components/theme/ThemeProvider');
 *   function useAssetCatalogColorScheme() {
 *     return useTheme().colorScheme;
 *   }
 */
let useColorScheme;
try {
  useColorScheme = require("react-native").useColorScheme;
} catch {
  useColorScheme = () => "light";
}

function useAssetCatalogColorScheme() {
  const scheme = useColorScheme();
  return scheme === "dark" ? "dark" : "light";
}

module.exports = { useAssetCatalogColorScheme };
`,
  "_assetCatalogColorPrimaryTint.js": `/**
 * _assetCatalogColorPrimaryTint — asset-catalog-tool's hooks/ contract, file 2 of 3.
 *
 * AUTO-GENERATED DEFAULT — created just now because hooks/_assetCatalogColorPrimaryTint.js
 * didn't exist yet. Written ONLY when missing — never regenerated over your edits after this.
 *
 * DO NOT CALL THIS FROM YOUR APP'S OWN SCREENS/COMPONENTS.
 * This whole hooks/ directory is a bridge for asset-catalog-tool's internal use only —
 * useIconSource.ts is its only intended caller. A screen that wants "the app's primary tint
 * color" for something unrelated to an image should read that from your own theme/color system,
 * not by importing this file.
 *
 * NOT A HOOK — deliberately named with a leading underscore instead of "use", the same way
 * _assetCatalogEditorBackgroundColor (file 3 of 3) is: a plain function, no React dependency, so
 * there's nothing to violate the Rules of Hooks even if you glance at this file and call it from
 * somewhere you shouldn't (still don't — see above). Being a plain function is exactly why it
 * takes \`variant\` as a parameter instead of calling hooks/useAssetCatalogColorScheme.js itself —
 * useIconSource.ts already calls that one real hook and passes its result straight through here.
 *
 * WHAT THIS IS FOR
 * The tint color useImage applies to a 'template'-mode image (a single-color mask) when no
 * explicit \`color\` argument is passed to useImage(name, color) — i.e. the common, no-args
 * call site \`useImage('some-image')\` gets whatever this returns for the current scheme, as
 * its tintColor.
 *
 * There's deliberately no secondary/tertiary tint alongside this one — a plausible future
 * extension (a distinct accent color, say), not something anything here consumes yet. If you add
 * one later, follow this file's exact shape: a plain function taking the same \`variant\`
 * parameter, returning a single hex for it.
 *
 * CONTRACT
 * \`_assetCatalogColorPrimaryTint(variant)\` — \`variant\` is exactly \`'light'\` or \`'dark'\` (the
 * same union hooks/useAssetCatalogColorScheme.js returns). Returns a single color string usable
 * as an RN <Image>'s tintColor prop for that variant — not a { light, dark } pair; the pick
 * already happened by the time you call this, via whichever \`variant\` you passed in.
 *
 * DEFAULT BEHAVIOR
 * '#000000' for 'light', '#ffffff' for 'dark' — plain black/white, independent of anything else
 * in hooks/.
 *
 * WHEN TO REPLACE THIS
 * If your brand has its own default image tint (rather than plain black/white), replace the two
 * literal hex values below. Example, a brand red that goes lighter in dark mode:
 *
 *   function _assetCatalogColorPrimaryTint(variant) {
 *     return variant === "dark" ? "#ff6b60" : "#c62828";
 *   }
 */
function _assetCatalogColorPrimaryTint(variant) {
  return variant === "dark" ? "#ffffff" : "#000000";
}

module.exports = { _assetCatalogColorPrimaryTint };
`,
  "_assetCatalogEditorBackgroundColor.js": `/**
 * _assetCatalogEditorBackgroundColor — asset-catalog-tool's hooks/ contract, file 3 of 3.
 *
 * AUTO-GENERATED DEFAULT — created just now because
 * hooks/_assetCatalogEditorBackgroundColor.js didn't exist yet. Written ONLY when missing —
 * never regenerated over your edits after this.
 *
 * DO NOT CALL THIS FROM YOUR APP'S OWN SCREENS/COMPONENTS.
 * This whole hooks/ directory is a bridge for asset-catalog-tool's internal use only —
 * asset-catalog-server.js is its only intended caller. It has no effect on your app itself and
 * your app never needs to import this file at all, hook-shaped naming aside (it isn't one — see
 * below).
 *
 * WHAT THIS IS FOR
 * Themes the LOCAL EDITOR PAGE's own background (npm run asset-catalog / asset-catalog.html) —
 * purely cosmetic, so the editor's chrome can match whatever colors your actual app uses instead
 * of this tool's generic gray default.
 *
 * NOT A HOOK — despite living alongside useAssetCatalogColorScheme.js and
 * _assetCatalogColorPrimaryTint.js in this same directory, this one is a plain function with no
 * "use" prefix and no React/render dependency whatsoever. That's deliberate: asset-catalog-server.js
 * is a plain Node HTTP server with no bundler and no React runtime, so it calls this function
 * directly (via a bare require()) every time it serves the editor page — never call it from
 * inside a React component regardless.
 *
 * CONTRACT
 * Returns a plain object { light: '#rrggbb', dark: '#rrggbb' } — both keys required, both must
 * be strings, or asset-catalog-server.js silently falls back to its own built-in gray default
 * rather than fail to serve the page.
 *
 * DEFAULT BEHAVIOR
 * { light: '#f2f2f7', dark: '#1c1c1e' } — a neutral gray pair with no dependency on anything
 * else in hooks/ (deliberately not derived from the tint hooks above, since a background and an
 * image tint are unrelated concerns).
 *
 * WHEN TO REPLACE THIS
 * Match your app's own light/dark background colors. Example:
 *
 *   function _assetCatalogEditorBackgroundColor() {
 *     return { light: "#ffffff", dark: "#0d0d0f" };
 *   }
 */
function _assetCatalogEditorBackgroundColor() {
  return { light: "#f2f2f7", dark: "#1c1c1e" };
}

module.exports = { _assetCatalogEditorBackgroundColor };
`,
};

/** Writes whichever of the hook-contract files are missing from `hooksDir` — never touches one
 * that already exists. Returns the filenames actually created (empty array if all already existed). */
function ensureAssetCatalogHooks(hooksDir) {
  fs.mkdirSync(hooksDir, { recursive: true });
  const created = [];
  for (const [filename, source] of Object.entries(HOOK_SCAFFOLDS)) {
    const filePath = path.join(hooksDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, source);
      created.push(filename);
    }
  }
  return created;
}

/**
 * Source for the unified `assets/index.ts` barrel — the single import surface a consuming project
 * is meant to use (`import { useImage, useColor } from './assets'`), instead of reaching into
 * asset-catalog-tool/ directly for two separate hooks. Mirrors useIconSource.ts/useCatalogColor.ts
 * exactly (same precedence rules, same hooks/ bridge), just merged into one file and renamed
 * useImage → useImage / useCatalogColor → useColor. `hasColors` controls whether the
 * color-catalog half is emitted at all — assets/color-catalog.generated.ts only exists once at
 * least one color has been declared (see writeGeneratedColorCatalog), so importing from it
 * unconditionally would break a project with zero colors declared.
 */
function generatedAssetsIndexSource(hasColors) {
  const lines = [];
  lines.push("// AUTO-GENERATED DEFAULT by asset-catalog-tool — created just now because assets/index.ts");
  lines.push("// didn't exist. Written ONLY when missing — never overwritten after, so it's yours to edit");
  lines.push("// freely from here (same \"materialize once, then you own it\" rule as hooks/*.js and an");
  lines.push("// image's own config.json). This is the one barrel a consuming project should import from —");
  lines.push("// `import { useImage, useColor } from './assets'` — instead of reaching into");
  lines.push("// asset-catalog-tool/ directly.");
  lines.push("//");
  lines.push("// If your project already has its own theme system (a manual light/dark/system toggle, a");
  lines.push("// live ThemeProvider/context), the cleanest integration is usually replacing");
  lines.push("// hooks/useAssetCatalogColorScheme.js's body with that theme's equivalent (and/or");
  lines.push("// hooks/_assetCatalogColorPrimaryTint.js's with your brand color) rather than rewriting this");
  lines.push("// file — useImage/useColor below only orchestrate the catalog lookup and defer every color");
  lines.push("// decision to hooks/. Rewrite this file directly only if you need a different *shape* of API");
  lines.push("// (e.g. a hook that reads your theme context directly instead of going through hooks/).");
  lines.push("import { ImageSourcePropType } from 'react-native';");
  lines.push("import { IMAGE_CATALOG, ImageName, ImageRenderMode } from './image-catalog.generated';");
  if (hasColors) {
    lines.push("import { COLOR_CATALOG, ColorName } from './color-catalog.generated';");
  }
  lines.push("// @ts-ignore — hooks/useAssetCatalogColorScheme.js is materialized by generate-asset-catalog.js /");
  lines.push("// asset-catalog-server.js the first time either runs, if the project hasn't already provided");
  lines.push("// its own. Plain CommonJS by design (not .ts) so its default can *try* requiring 'react-native'");
  lines.push("// and fall back if it's absent — a static ES import can't be caught like that.");
  lines.push("import { useAssetCatalogColorScheme } from '../hooks/useAssetCatalogColorScheme';");
  lines.push("// @ts-ignore — see above; materialized alongside useAssetCatalogColorScheme.js.");
  lines.push("import { _assetCatalogColorPrimaryTint } from '../hooks/_assetCatalogColorPrimaryTint';");
  lines.push("");
  lines.push("export type { ImageName } from './image-catalog.generated';");
  if (hasColors) {
    lines.push("export type { ColorName } from './color-catalog.generated';");
  }
  lines.push("");
  lines.push("export interface ImageSource {");
  lines.push("  source: ImageSourcePropType;");
  lines.push("  tintColor?: string;");
  lines.push("}");
  lines.push("");
  lines.push("export interface UseImageOptions {");
  lines.push("  /** Override the tint applied to a 'template' image instead of this image's own config.json");
  lines.push("   * `tint` (if it has one) or hooks/_assetCatalogColorPrimaryTint.js (if it doesn't). Ignored");
  lines.push("   * for 'original'-mode images. Precedence: this `color` > the image's own tint > the app");
  lines.push("   * default. */");
  lines.push("  color?: string;");
  lines.push("  /** Render as if the current scheme were this, instead of hooks/useAssetCatalogColorScheme.js's");
  lines.push("   * live value. The real scheme hook is still called every render regardless (Rules of Hooks),");
  lines.push("   * this only overrides which value gets *used*. */");
  lines.push("  scheme?: 'light' | 'dark';");
  lines.push("  /** Render as this mode instead of the catalog's own configured mode for this image. Rare. */");
  lines.push("  mode?: ImageRenderMode;");
  lines.push("}");
  lines.push("");
  lines.push("/**");
  lines.push(" * Zero-config default: resolves a catalog image's source/tint via the project's own");
  lines.push(" * hooks/useAssetCatalogColorScheme + hooks/_assetCatalogColorPrimaryTint (see this file's own");
  lines.push(" * header comment). `template` images (a single-color mask) tint to `options.color` if given,");
  lines.push(" * else this image's own per-image `tint` override if it has one, else the app-wide primary tint");
  lines.push(" * for the current scheme. `original` images (non-tintable multi-color art) swap in their");
  lines.push(" * `dark` asset when one exists and the current scheme is dark, otherwise render the light");
  lines.push(" * asset untinted either way.");
  lines.push(" */");
  lines.push("export function useImage(name: ImageName, options?: UseImageOptions): ImageSource {");
  lines.push("  const liveScheme = useAssetCatalogColorScheme();");
  lines.push("  const colorScheme = options?.scheme ?? liveScheme;");
  lines.push("  const isDark = colorScheme === 'dark';");
  lines.push("  const entry = IMAGE_CATALOG[name];");
  lines.push("  const mode = options?.mode ?? entry.mode;");
  lines.push("");
  lines.push("  if (mode === 'template') {");
  lines.push("    const perImageTint = entry.tint ? entry.tint[colorScheme] : undefined;");
  lines.push("    return { source: entry.light, tintColor: options?.color ?? perImageTint ?? _assetCatalogColorPrimaryTint(colorScheme) };");
  lines.push("  }");
  lines.push("");
  lines.push("  const useDark = isDark && entry.dark !== undefined;");
  lines.push("  return { source: useDark ? entry.dark! : entry.light };");
  lines.push("}");
  if (hasColors) {
    lines.push("");
    lines.push("/**");
    lines.push(" * Zero-config default: resolves a named color from assets/colors/<name>.json for the");
    lines.push(" * current scheme (the same hooks/useAssetCatalogColorScheme.js useImage uses, so a color and");
    lines.push(" * an image's default tint always agree on what \"dark\" means). Unlike an image, there's no");
    lines.push(" * per-color \"default\" fallback — the color's own <name>.json IS the source of truth.");
    lines.push(" */");
    lines.push("export function useColor(name: ColorName): string {");
    lines.push("  const scheme = useAssetCatalogColorScheme();");
    lines.push("  const entry = COLOR_CATALOG[name];");
    lines.push("  return scheme === 'dark' ? entry.dark : entry.light;");
    lines.push("}");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Writes assets/index.ts ONLY if it's missing — never touches one that already exists (same
 * "materialize once, then it's a normal file you own" rule as hooks/*.js and an image's own
 * config.json). `hasColors` should reflect whether assets/color-catalog.generated.ts exists (or is
 * about to) at the moment of scaffolding — see generatedAssetsIndexSource's own doc comment for
 * why. Returns true if the file was just created, false if it already existed.
 */
function ensureAssetsIndexBarrel(assetsDir, hasColors) {
  const filePath = path.join(assetsDir, "index.ts");
  if (fs.existsSync(filePath)) {
    return false;
  }
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(filePath, generatedAssetsIndexSource(hasColors));
  return true;
}

/**
 * One-time project wiring this tool otherwise leaves to the README's manual setup steps: the two
 * npm scripts a consuming project needs (`generate:images`, `asset-catalog`) and chaining
 * `generate:images` in as a `pre*` build hook. Called from postinstall.js so a fresh `npm install`
 * ends up with a working setup with zero manual package.json editing in the common case —
 * additive only, same "materialize once, then it's yours" rule as hooks/*.js: a script name that
 * already exists (even pointing at something completely different) is left untouched rather than
 * overwritten, so a project's own customization is never clobbered by a later `npm install`.
 *
 * `pre*` hooks are only added for a base script that already exists (`start`/`ios`/`android`/
 * `web`) — this never invents a project's own top-level scripts, only hooks into ones already
 * there. Returns `{ addedScripts, addedHooks }` (both empty if package.json is missing/unparseable,
 * or everything this would add already existed).
 *
 * `generate:images`/`asset-catalog` are wired straight to this package's own bins — no local
 * shim/copy of any kind while the package is actually installed, so a consuming project's repo
 * carries zero extra files for this to work. Uninstalling is handled separately (see
 * ejectAssetCatalogTool/repointPackageJsonToEjectedTool in this same file, and this repo's
 * UNINSTALL.md) by copying this tool's own files into the project and repointing these same two
 * script entries at the copy — so there's never a permanent shim sitting in a project's `scripts/`
 * "just in case", only ever the real npm dependency or, after an explicit uninstall, a real local
 * copy a project then owns outright.
 */
function ensurePackageJsonWiring(root, { generateBin = "asset-catalog-generate", serverBin = "asset-catalog" } = {}) {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return { addedScripts: [], addedHooks: [] };
  }
  const raw = fs.readFileSync(pkgPath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { addedScripts: [], addedHooks: [] };
  }
  pkg.scripts = pkg.scripts || {};

  const addedScripts = [];
  if (!pkg.scripts["generate:images"]) {
    pkg.scripts["generate:images"] = generateBin;
    addedScripts.push("generate:images");
  }
  if (!pkg.scripts["asset-catalog"]) {
    pkg.scripts["asset-catalog"] = serverBin;
    addedScripts.push("asset-catalog");
  }

  const addedHooks = [];
  for (const base of ["start", "ios", "android", "web"]) {
    const preName = `pre${base}`;
    if (pkg.scripts[base] && !pkg.scripts[preName]) {
      pkg.scripts[preName] = "npm run generate:images";
      addedHooks.push(preName);
    }
  }

  if (addedScripts.length === 0 && addedHooks.length === 0) {
    return { addedScripts, addedHooks };
  }
  const indent = detectIndent(raw);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  return { addedScripts, addedHooks };
}

/**
 * One-time project wiring: adds the `@/assets` (and `@/assets/*`) bare-import alias to
 * tsconfig.json's `compilerOptions.paths`, if missing — the one piece of setup the README calls
 * out as needing a manual edit "since it means editing a file it doesn't own"; called from
 * postinstall.js to close that gap automatically wherever it's safe to. Additive only, mirroring
 * ensurePackageJsonWiring: an existing `@/assets`/`@/assets/*` entry is left untouched no matter
 * what it already points at. Silently no-ops (rather than throwing) if tsconfig.json is missing or
 * fails to parse as plain JSON — a hand-written tsconfig.json with `//` comments (technically
 * JSONC, which `tsc` itself tolerates) would otherwise have those comments silently stripped by a
 * naive JSON.parse + re-stringify round-trip, which this deliberately avoids risking. Returns the
 * keys actually added (empty if tsconfig.json is missing/unparseable, or both already existed).
 */
function ensureTsconfigAssetsAlias(root) {
  const tsconfigPath = path.join(root, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    return { added: [] };
  }
  const raw = fs.readFileSync(tsconfigPath, "utf8");
  let tsconfig;
  try {
    tsconfig = JSON.parse(raw);
  } catch {
    return { added: [] };
  }
  tsconfig.compilerOptions = tsconfig.compilerOptions || {};
  tsconfig.compilerOptions.paths = tsconfig.compilerOptions.paths || {};
  const paths = tsconfig.compilerOptions.paths;

  const added = [];
  if (!paths["@/assets"]) {
    paths["@/assets"] = ["./assets/index.ts"];
    added.push("@/assets");
  }
  if (!paths["@/assets/*"]) {
    paths["@/assets/*"] = ["./assets/*"];
    added.push("@/assets/*");
  }
  if (added.length === 0) {
    return { added };
  }
  const indent = detectIndent(raw);
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  return { added };
}

/**
 * Name of the folder ejectAssetCatalogTool copies this package's own runtime files into, at a
 * consuming project's root — deliberately the SAME name/layout as this README's own documented
 * "Option B — drop-in folder" (a project that never used npm at all copies this tool in by hand
 * under this same name). Ejecting on uninstall just means a project that started on Option A (npm
 * install) automatically lands in the exact same place a project that started on Option B was
 * always in — one drop-in folder, fully self-contained, no ongoing dependency either way.
 */
const EJECT_DIR_NAME = "asset-catalog-tool";

/**
 * This package's own files that ejectAssetCatalogTool copies, as [source-relative-to-package-root,
 * dest-relative-to-EJECT_DIR_NAME] pairs — everything generate-asset-catalog.js/
 * asset-catalog-server.js need at runtime (their own `require("./lib/asset-catalog-core")` stays
 * correct once both sides move together) plus this README for reference. Intentionally NOT
 * package.json/postinstall.js/uninstall.js/node_modules-management files — the ejected copy is a
 * plain folder of scripts, not a package a project would ever `npm install` a second time.
 */
const EJECT_FILES = [
  "generate-asset-catalog.js",
  "asset-catalog-server.js",
  "asset-catalog.html",
  path.join("lib", "asset-catalog-core.js"),
  "README.md",
];

/**
 * Copies this package's own files (see EJECT_FILES) from `packageRoot` (this package's own
 * installed location — pass `__dirname` from a file at the package root, e.g. uninstall.js) into
 * `<root>/asset-catalog-tool/` — run from this package's own `preuninstall` lifecycle script (see
 * uninstall.js) so a project keeps a fully working, self-contained copy of the tool the moment
 * it's removed as a dependency, instead of losing `generate:images`/`asset-catalog` entirely.
 *
 * Refuses to overwrite an existing `asset-catalog-tool/` (returns `{ copied: false, reason }`
 * instead) rather than guessing whether it's safe to clobber — a project that already has a folder
 * by this name almost certainly put it there on purpose (Option B's own manual drop-in, or a
 * previous eject), and silently overwriting it on every uninstall/reinstall cycle risks discarding
 * hand edits made to the ejected copy. Returns `{ copied: true, targetDir }` on success.
 */
function ejectAssetCatalogTool(root, packageRoot) {
  const targetDir = path.join(root, EJECT_DIR_NAME);
  if (fs.existsSync(targetDir)) {
    return { copied: false, targetDir, reason: `${EJECT_DIR_NAME}/ already exists — left as-is` };
  }
  for (const relativeFile of EJECT_FILES) {
    const srcPath = path.join(packageRoot, relativeFile);
    if (!fs.existsSync(srcPath)) {
      continue; // best-effort: an older/newer package layout just means fewer files land
    }
    const destPath = path.join(targetDir, relativeFile);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }
  return { copied: true, targetDir };
}

/**
 * Repoints `generate:images`/`asset-catalog` at the just-ejected copy (see ejectAssetCatalogTool)
 * — ONLY if each still equals EXACTLY what ensurePackageJsonWiring would have written (the same
 * conservative "don't touch what the user may have customized" rule ensurePackageJsonWiring
 * itself uses, just applied on the way out instead of the way in). A script a project edited after
 * install — even trivially — is left alone, since this tool has no way to know whether the edit
 * still makes sense once pointed at a local copy instead of the npm package. `pre*` hooks need no
 * change either way: they call `npm run generate:images`, and that script now resolves locally.
 * Returns `{ repointedScripts }`.
 */
function repointPackageJsonToEjectedTool(root, { generateBin = "asset-catalog-generate", serverBin = "asset-catalog" } = {}) {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return { repointedScripts: [] };
  }
  const raw = fs.readFileSync(pkgPath, "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { repointedScripts: [] };
  }
  const scripts = pkg.scripts || {};

  const ejectedGenerate = `node ./${EJECT_DIR_NAME}/generate-asset-catalog.js`;
  const ejectedServer = `node ./${EJECT_DIR_NAME}/asset-catalog-server.js`;
  const repointedScripts = [];
  if (scripts["generate:images"] === generateBin) {
    scripts["generate:images"] = ejectedGenerate;
    repointedScripts.push("generate:images");
  }
  if (scripts["asset-catalog"] === serverBin) {
    scripts["asset-catalog"] = ejectedServer;
    repointedScripts.push("asset-catalog");
  }

  if (repointedScripts.length === 0) {
    return { repointedScripts };
  }
  const indent = detectIndent(raw);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + (raw.endsWith("\n") ? "\n" : ""));
  return { repointedScripts };
}

/** Reads the consuming project's `_assetCatalogEditorBackgroundColor` (materializing it first if
 * missing) and returns its `{ light, dark }` result — falling back to this function's own
 * built-in default if the file is missing/broken/returns something malformed, so the editor page
 * can never fail to render over a bad or absent hook file. */
function readEditorBackgroundColor(hooksDir) {
  const fallback = { light: "#f2f2f7", dark: "#1c1c1e" };
  ensureAssetCatalogHooks(hooksDir);
  const filePath = path.join(hooksDir, "_assetCatalogEditorBackgroundColor.js");
  try {
    delete require.cache[require.resolve(filePath)];
    const mod = require(filePath);
    const fn = mod._assetCatalogEditorBackgroundColor || mod.default || mod;
    const result = typeof fn === "function" ? fn() : fn;
    if (result && typeof result.light === "string" && typeof result.dark === "string") {
      return result;
    }
  } catch {
    // fall through to the built-in default below
  }
  return fallback;
}

/** Reads the consuming project's `_assetCatalogColorPrimaryTint` (materializing hooks/ first if
 * missing) for both variants, returning a `{ light, dark }` pair — falling back to this
 * function's own built-in black/white default per-variant if the file is missing/broken/returns
 * something malformed, so the editor's preview can never fail to render over a bad hook file.
 * Called by asset-catalog-server.js so the editor's own image previews use the *real* configured
 * tint (via a CSS mask, not an approximation) instead of a generic invert-filter guess. */
function readPrimaryTint(hooksDir) {
  ensureAssetCatalogHooks(hooksDir);
  const filePath = path.join(hooksDir, "_assetCatalogColorPrimaryTint.js");
  function resolve(variant, fallback) {
    try {
      delete require.cache[require.resolve(filePath)];
      const mod = require(filePath);
      const fn = mod._assetCatalogColorPrimaryTint || mod.default;
      const result = typeof fn === "function" ? fn(variant) : undefined;
      return typeof result === "string" && result.length > 0 ? result : fallback;
    } catch {
      return fallback;
    }
  }
  return { light: resolve("light", "#000000"), dark: resolve("dark", "#ffffff") };
}

module.exports = {
  AssetCatalogError,
  slotFilename,
  isSlotKey,
  isValidDensity,
  slotForDensity,
  parseSlotFilename,
  scanSlotsInDir,
  isValidName,
  isPng,
  isHexColor,
  resolveImageDir,
  scanImages,
  generatedCatalogSource,
  writeGeneratedCatalog,
  resolveColorFile,
  scanColors,
  generatedColorCatalogSource,
  writeGeneratedColorCatalog,
  ensureAssetCatalogHooks,
  generatedAssetsIndexSource,
  ensureAssetsIndexBarrel,
  readEditorBackgroundColor,
  readPrimaryTint,
  APP_ICON_PLATFORMS,
  appIconSlotFilename,
  isAppIconPlatform,
  isAppIconSlot,
  resolveAppIconPlatformDir,
  scanAppIcon,
  appIconRelativePath,
  applyAppIconToAppJson,
  findIosAppIconSet,
  findAndroidResDir,
  appIconNativeStatus,
  syncAppIconToNative,
  ensurePackageJsonWiring,
  ensureTsconfigAssetsAlias,
  EJECT_DIR_NAME,
  EJECT_FILES,
  ejectAssetCatalogTool,
  repointPackageJsonToEjectedTool,
};

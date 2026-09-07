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
};

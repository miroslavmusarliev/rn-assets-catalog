#!/usr/bin/env node

/**
 * Portable, zero-config asset-catalog editor — drop this whole `asset-catalog-tool/` folder into
 * any React Native project's repo root. A tiny HTTP server + static page (asset-catalog.html)
 * that lets you create, edit, and delete <project>/assets/images/<name>/ entries (<name>_light.png,
 * <name>_dark.png, config.json, plus optional <name>_light@2x.png/@3x.png/<name>_dark@2x.png/@3x.png
 * density variants — see lib/asset-catalog-core.js's slotFilename) from a browser instead of
 * hand-editing files — a lightweight stand-in for Xcode's asset catalog editor. Every action here
 * writes to disk immediately — there is no save step — so every mutating request captures
 * whatever it's about to overwrite first (only the slot(s) actually touched, not the whole
 * folder — see the undo stack comment below), and POST /api/undo pops the most recent entry and
 * restores it (undo history is in-memory only and clears when the server restarts). Every
 * mutation also re-scans assets/images/ and rewrites assets/image-catalog.generated.ts (the same
 * output generate-asset-catalog.js produces on its own), so the catalog never goes stale while
 * you use the tool. Also manages assets/app-icon/{ios,android,web}/ — the app's own icon, special
 * cased vs. a generic image because it's one singular thing split across per-platform folders
 * (each independently deletable) rather than a named collection; see lib/asset-catalog-core.js's
 * scanAppIcon doc comment for the full model. No generated .ts output exists for it — app.json
 * references its files directly by path, so there's nothing to regenerate there.
 *
 * On startup (and before every mutation-triggered regenerate), materializes whichever of the
 * project's `hooks/useAssetCatalogColor*`/`_assetCatalogEditorBackgroundColor` files don't
 * already exist yet (see asset-catalog-core.js's HOOK_SCAFFOLDS) — and reads the latter to theme
 * this very page's own background, so the editor matches whatever the app itself would use.
 *
 * Binds to 127.0.0.1 only — never exposed beyond this machine. Uses only Node builtins (no new
 * dependencies): uploads travel as base64 inside JSON bodies rather than multipart/form-data.
 * Wire up as an npm script (`"asset-catalog": "node ./asset-catalog-tool/asset-catalog-server.js"`)
 * pointed at wherever this folder ends up, then run it, open the printed URL, Ctrl+C to stop.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const {
  slotFilename,
  isSlotKey,
  parseSlotFilename,
  scanSlotsInDir,
  isValidName,
  isPng,
  isHexColor,
  resolveImageDir,
  scanImages,
  writeGeneratedCatalog,
  resolveColorFile,
  scanColors,
  writeGeneratedColorCatalog,
  ensureAssetCatalogHooks,
  ensureAssetsIndexBarrel,
  readEditorBackgroundColor,
  readPrimaryTint,
  APP_ICON_PLATFORMS,
  appIconSlotFilename,
  isAppIconSlot,
  resolveAppIconPlatformDir,
  scanAppIcon,
  applyAppIconToAppJson,
  syncAppIconToNative,
  appIconNativeStatus,
  AssetCatalogError,
} = require("./lib/asset-catalog-core");

// assets/images/, hooks/, and the generated catalog belong to whichever project this is run from
// (cwd — i.e. wherever the wiring npm script executes), but asset-catalog.html ships as a fixed
// part of this tool itself, so it's resolved relative to this file, not the caller's cwd.
const root = process.cwd();
const imagesDir = path.join(root, "assets", "images");
const colorsDir = path.join(root, "assets", "colors");
const appIconDir = path.join(root, "assets", "app-icon");
const assetsDir = path.join(root, "assets");
const hooksDir = path.join(root, "hooks");
const htmlFile = path.join(__dirname, "asset-catalog.html");

ensureAssetCatalogHooks(hooksDir);

const PORT = Number(process.env.ASSET_CATALOG_PORT) || 4756;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB — generous for a handful of small PNGs

// In-memory undo stack: each entry records only what a mutation is about to overwrite — not
// the whole folder — so e.g. a mode-only change or a single density replace doesn't drag copies
// of unrelated image bytes along with it. Shared across both catalogs (images and colors), tagged
// by `domain` (`'image'` | `'color'`) so a single Undo button/stack works across both without the
// user needing two separate mental models; each entry's `kind` then means:
//   'remove'  — undoes a create: the folder didn't exist before, so undo just deletes it again.
//   'patch'   — undoes an update: only what that request is about to touch carries its prior
//               value (image: the specific slot(s) and/or config — mode/tint; color: the whole
//               color.json, since it's a single small object with no per-field granularity worth
//               the complexity) — everything else is left alone.
//   'restore' — undoes a delete: the whole folder is gone, so recreating it needs everything that
//               existed — there's no smaller representation for "everything was removed".
// Lives only for this server process — restarting the tool clears undo history, same as it
// clears nothing else on disk. Capped so a long session can't grow this unboundedly.
const MAX_UNDO = 50;
const undoStack = [];

/** Reads an image's config.json as `{ mode, tint }` — `tint` is the raw stored value (`undefined`
 * when absent/"default", or `{ light, dark }` when a per-image override is set) so undo can
 * round-trip exactly what was there, not a re-validated/normalized copy. */
function readImageConfig(dir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    const mode = config.mode === "template" || config.mode === "original" ? config.mode : "template";
    const tint = config.tint && typeof config.tint === "object" ? config.tint : undefined;
    return { mode, tint };
  } catch {
    // Fall through to defaults — reading a snapshot should never itself throw.
  }
  return { mode: "template", tint: undefined };
}

function writeImageConfig(dir, config) {
  const toWrite = { mode: config.mode };
  if (config.tint !== undefined) toWrite.tint = config.tint;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(toWrite, null, 2) + "\n");
}

function readSlot(dir, slot) {
  const filePath = path.join(dir, slotFilename(path.basename(dir), slot));
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

/** Full folder snapshot (every slot actually present, discovered via scanSlotsInDir — density
 * values are open-ended, so this can't iterate a fixed list) — only needed ahead of a delete,
 * since restoring one means recreating everything from nothing. */
function fullImageSnapshot(dir) {
  const slots = {};
  for (const { slot } of scanSlotsInDir(dir)) slots[slot] = readSlot(dir, slot);
  return { config: readImageConfig(dir), slots };
}

/** A color's <name>.json as `{ light, dark }` — `dark` is `undefined` when absent (falls back to
 * `light` only at generation time, not stored), same "keep the raw shape" rule as image config.
 * `file` is the color's own JSON file directly (see resolveColorFile) — unlike an image, a color
 * has no sibling files to share a folder with, so there's no per-color directory to resolve into. */
function readColorConfig(file) {
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    return { light: config.light, dark: config.dark !== undefined ? config.dark : undefined };
  } catch {
    return { light: undefined, dark: undefined };
  }
}

function writeColorConfig(file, config) {
  const toWrite = { light: config.light };
  if (config.dark !== undefined) toWrite.dark = config.dark;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(toWrite, null, 2) + "\n");
}

function pushUndo(name, entry, label, domain = "image") {
  undoStack.push({ name, domain, ...entry, label });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function restoreImageEntry(dir, entry) {
  const name = path.basename(dir);
  if (entry.kind === "remove") {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  if (entry.kind === "restore") {
    fs.mkdirSync(dir, { recursive: true });
    for (const [slot, value] of Object.entries(entry.snapshot.slots)) {
      if (value !== null) fs.writeFileSync(path.join(dir, slotFilename(name, slot)), value);
    }
    writeImageConfig(dir, entry.snapshot.config);
    return;
  }
  // 'patch': the folder still exists — only rewrite whichever slot(s)/config this update touched.
  if (entry.config !== undefined) {
    writeImageConfig(dir, entry.config);
  }
  for (const [slot, value] of Object.entries(entry.slots || {})) {
    const filePath = path.join(dir, slotFilename(name, slot));
    if (value === null) {
      if (fs.existsSync(filePath)) fs.rmSync(filePath);
    } else {
      fs.writeFileSync(filePath, value);
    }
  }
}

/** Reads one already-present slot file for a platform, or null if that slot has no file. Mirrors
 * readSlot's image-side counterpart. */
function readAppIconSlot(dir, platform, slot) {
  const filePath = path.join(dir, appIconSlotFilename(platform, slot));
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

/** Full platform-folder snapshot — every slot the platform's fixed slot list defines, present or
 * not — only needed ahead of deleting the whole platform folder, since restoring one means
 * recreating everything from nothing (mirrors fullImageSnapshot). */
function fullAppIconPlatformSnapshot(dir, platform) {
  const slots = {};
  for (const slot of APP_ICON_PLATFORMS[platform].slots) {
    slots[slot] = readAppIconSlot(dir, platform, slot);
  }
  return { slots };
}

function restoreColorEntry(file, entry) {
  if (entry.kind === "remove") {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    return;
  }
  if (entry.kind === "restore") {
    writeColorConfig(file, entry.snapshot);
    return;
  }
  // 'patch': the file still exists — a color is just one small config, so undo rewrites all of it.
  writeColorConfig(file, entry.config);
}

function restoreAppIconEntry(dir, platform, entry) {
  if (entry.kind === "remove") {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  if (entry.kind === "restore") {
    fs.mkdirSync(dir, { recursive: true });
    for (const [slot, value] of Object.entries(entry.snapshot.slots)) {
      const filePath = path.join(dir, appIconSlotFilename(platform, slot));
      if (value !== null) fs.writeFileSync(filePath, value);
    }
    return;
  }
  // 'patch': the platform folder still exists — only rewrite whichever slot(s) this update touched.
  for (const [slot, value] of Object.entries(entry.slots || {})) {
    const filePath = path.join(dir, appIconSlotFilename(platform, slot));
    if (value === null) {
      if (fs.existsSync(filePath)) fs.rmSync(filePath);
    } else {
      fs.writeFileSync(filePath, value);
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AssetCatalogError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new AssetCatalogError("request body is not valid JSON");
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function decodePng(base64, label) {
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new AssetCatalogError(`${label} is required`);
  }
  let buf;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    throw new AssetCatalogError(`${label} is not valid base64`);
  }
  if (!isPng(buf)) {
    throw new AssetCatalogError(`${label} is not a PNG file`);
  }
  return buf;
}

/** Re-scans assets/images/, assets/colors/, AND assets/app-icon/ and rewrites the two generated
 * catalogs that have one (a catalog is skipped if it has nothing to generate, e.g. right after
 * deleting the only image, or colors were never used at all) — called after every mutation to any
 * of the three so no generated file ever drifts from what the tool just wrote to disk, and so
 * every response can report all three regardless of which one the mutation actually touched (they
 * share one undo stack/UI). The app icon has no generated .ts output at all — it's consumed
 * directly by app.json's own path references, not via a useImage()-style catalog lookup — so
 * scanAppIcon's result is only ever reported back to the editor, never written anywhere. */
function regenerate() {
  const { entries, warnings } = scanImages(imagesDir);
  if (entries.length > 0) {
    writeGeneratedCatalog(assetsDir, entries);
  }
  const colors = scanColors(colorsDir);
  if (colors.entries.length > 0) {
    writeGeneratedColorCatalog(assetsDir, colors.entries);
  }
  ensureAssetsIndexBarrel(assetsDir, colors.entries.length > 0);
  const appIcon = scanAppIcon(appIconDir);
  return {
    entries,
    warnings,
    colorEntries: colors.entries,
    colorWarnings: colors.warnings,
    appIconPlatforms: appIcon.platforms,
    appIconWarnings: appIcon.warnings,
    appIconNativeStatus: appIconNativeStatus(root),
  };
}

function withUndoMeta(payload) {
  return { ...payload, undoCount: undoStack.length, nextUndoLabel: undoStack.length ? undoStack[undoStack.length - 1].label : null };
}

async function handleList(req, res) {
  sendJson(res, 200, withUndoMeta(regenerate()));
}

/** Validates and normalizes a request body's `tint` field for a `template`-mode image:
 * `undefined`/`"default"` both mean "no per-image override, defer to the app's own primary tint" —
 * stored as `undefined`. Anything else must be `{ light, dark }` valid hex strings. Rejects the
 * field outright for an `"original"`-mode image (a per-image tint doesn't mean anything there —
 * nothing gets tinted). */
function parseTintBody(raw, mode) {
  if (raw === undefined || raw === "default") return undefined;
  if (mode !== "template") {
    throw new AssetCatalogError('"tint" only applies to "template"-mode images');
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !isHexColor(raw.light) || !isHexColor(raw.dark)) {
    throw new AssetCatalogError('"tint" must be "default" or { "light": "#hex", "dark": "#hex" }');
  }
  return { light: raw.light, dark: raw.dark };
}

async function handleCreate(req, res) {
  const body = await readJsonBody(req);
  const { name, mode } = body;
  if (!isValidName(name)) {
    throw new AssetCatalogError('name must be lowercase letters/digits/hyphens, optionally namespaced with "/", e.g. "drawer-home" or "drawer/home"');
  }
  if (mode !== "template" && mode !== "original") {
    throw new AssetCatalogError('mode must be "template" or "original"');
  }
  const tint = parseTintBody(body.tint, mode);
  const dir = resolveImageDir(imagesDir, name);
  if (fs.existsSync(dir)) {
    throw new AssetCatalogError(`assets/images/${name}/ already exists`);
  }

  // No single slot is mandatory — an image just needs at least one of its light-appearance files
  // (any density: "light", "light@1.5x", "light@2x", ...); a dark appearance, if provided at all,
  // is likewise satisfied by any one dark-appearance file. Density isn't a fixed set here — any
  // request field shaped like a slot key (isSlotKey) is accepted, matching Metro's own
  // configurable resolver.assetResolutions rather than hardcoding 2x/3x only. The generated
  // catalog always requires the bare filename regardless of which file(s) actually exist (see
  // lib/asset-catalog-core.js's module comment), so a 2x/3x/4x/1.5x-only image is fully supported,
  // not an orphan.
  const toWrite = {};
  for (const [key, value] of Object.entries(body)) {
    if (isSlotKey(key) && value) toWrite[key] = decodePng(value, `${key} image`);
  }
  if (!Object.keys(toWrite).some((slot) => slot === "light" || slot.startsWith("light@"))) {
    throw new AssetCatalogError("needs at least one light-appearance file (e.g. \"light\" or \"light@2x\")");
  }

  pushUndo(name, { kind: "remove" }, `create "${name}"`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [slot, buf] of Object.entries(toWrite)) {
    fs.writeFileSync(path.join(dir, slotFilename(name, slot)), buf);
  }
  writeImageConfig(dir, { mode, tint });

  sendJson(res, 201, withUndoMeta(regenerate()));
}

async function handleUpdate(req, res, name) {
  const dir = resolveImageDir(imagesDir, name);
  if (!fs.existsSync(dir)) {
    throw new AssetCatalogError(`assets/images/${name}/ does not exist`);
  }
  const body = await readJsonBody(req);

  // Validate/decode everything before touching disk, so a bad request never leaves a
  // half-applied change with no matching undo entry.
  if (body.mode !== undefined && body.mode !== "template" && body.mode !== "original") {
    throw new AssetCatalogError('mode must be "template" or "original"');
  }
  const priorConfig = readImageConfig(dir);
  const nextMode = body.mode !== undefined ? body.mode : priorConfig.mode;
  const tint = body.tint !== undefined ? parseTintBody(body.tint, nextMode) : undefined;
  const toWrite = {};
  for (const [key, value] of Object.entries(body)) {
    if (isSlotKey(key) && value) toWrite[key] = decodePng(value, `${key} image`);
  }
  // No slot cascades off another anymore — every light/dark density file is independently
  // removable (generatedCatalogSource always requires the bare filename regardless of which
  // exist). A removal is requested via a "remove:<slot>" field (e.g. "remove:light@2x") set to
  // true — any density, not just a fixed 2x/3x set. The only thing that can never happen is the
  // image's light appearance dropping to zero files — a dark appearance is fine going to zero,
  // that just means the image has no dark variant, same as never having had one.
  const toRemove = new Set();
  for (const [key, value] of Object.entries(body)) {
    if (value !== true) continue;
    const match = key.match(/^remove:(.+)$/);
    if (match && isSlotKey(match[1])) toRemove.add(match[1]);
  }
  const existingSlots = scanSlotsInDir(dir).map((s) => s.slot);
  const isLight = (slot) => slot === "light" || slot.startsWith("light@");
  const willHaveLight =
    Object.keys(toWrite).some(isLight) || existingSlots.some((slot) => isLight(slot) && !toRemove.has(slot));
  if (!willHaveLight) {
    throw new AssetCatalogError("needs at least one light-appearance file — can't remove the last one");
  }

  // Only capture the prior value of whichever slot(s)/config this request is about to overwrite —
  // not the whole folder — so e.g. a mode/tint-only toggle or a single density replace doesn't
  // drag copies of unrelated image bytes into the undo stack.
  const touchedSlots = new Set([...Object.keys(toWrite), ...toRemove]);
  const patchSlots = {};
  for (const slot of touchedSlots) patchSlots[slot] = readSlot(dir, slot);
  const undoEntry = { kind: "patch", slots: patchSlots };
  if (body.mode !== undefined || body.tint !== undefined) undoEntry.config = priorConfig;
  pushUndo(name, undoEntry, `update "${name}"`);

  if (body.mode !== undefined || body.tint !== undefined) {
    writeImageConfig(dir, { mode: nextMode, tint: body.tint !== undefined ? tint : priorConfig.tint });
  }
  for (const [slot, buf] of Object.entries(toWrite)) {
    fs.writeFileSync(path.join(dir, slotFilename(name, slot)), buf);
  }
  for (const slot of toRemove) {
    if (toWrite[slot] !== undefined) continue; // a fresh write for this slot wins over removing it
    const filePath = path.join(dir, slotFilename(name, slot));
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
  }

  sendJson(res, 200, withUndoMeta(regenerate()));
}

async function handleDelete(req, res, name) {
  const dir = resolveImageDir(imagesDir, name);
  if (!fs.existsSync(dir)) {
    throw new AssetCatalogError(`assets/images/${name}/ does not exist`);
  }
  pushUndo(name, { kind: "restore", snapshot: fullImageSnapshot(dir) }, `delete "${name}"`);
  fs.rmSync(dir, { recursive: true, force: true });

  sendJson(res, 200, withUndoMeta(regenerate()));
}

async function handleColorList(req, res) {
  sendJson(res, 200, withUndoMeta(regenerate()));
}

async function handleColorCreate(req, res) {
  const body = await readJsonBody(req);
  const { name } = body;
  if (!isValidName(name)) {
    throw new AssetCatalogError('name must be lowercase letters/digits/hyphens, optionally namespaced with "/", e.g. "brand-primary" or "brand/primary"');
  }
  if (!isHexColor(body.light)) {
    throw new AssetCatalogError('"light" must be a valid hex color');
  }
  if (body.dark !== undefined && !isHexColor(body.dark)) {
    throw new AssetCatalogError('"dark" must be a valid hex color');
  }
  const file = resolveColorFile(colorsDir, name);
  if (fs.existsSync(file)) {
    throw new AssetCatalogError(`assets/colors/${name}.json already exists`);
  }

  pushUndo(name, { kind: "remove" }, `create color "${name}"`, "color");
  writeColorConfig(file, { light: body.light, dark: body.dark });

  sendJson(res, 201, withUndoMeta(regenerate()));
}

async function handleColorUpdate(req, res, name) {
  const file = resolveColorFile(colorsDir, name);
  if (!fs.existsSync(file)) {
    throw new AssetCatalogError(`assets/colors/${name}.json does not exist`);
  }
  const body = await readJsonBody(req);
  if (body.light !== undefined && !isHexColor(body.light)) {
    throw new AssetCatalogError('"light" must be a valid hex color');
  }
  // `dark: null` explicitly clears a per-color dark override (back to "same as light"); omitting
  // `dark` from the body leaves whatever was already there untouched.
  if (body.dark !== undefined && body.dark !== null && !isHexColor(body.dark)) {
    throw new AssetCatalogError('"dark" must be "null" (to clear) or a valid hex color');
  }

  const priorConfig = readColorConfig(file);
  pushUndo(name, { kind: "patch", config: priorConfig }, `update color "${name}"`, "color");

  const nextConfig = {
    light: body.light !== undefined ? body.light : priorConfig.light,
    dark: body.dark === null ? undefined : body.dark !== undefined ? body.dark : priorConfig.dark,
  };
  writeColorConfig(file, nextConfig);

  sendJson(res, 200, withUndoMeta(regenerate()));
}

async function handleColorDelete(req, res, name) {
  const file = resolveColorFile(colorsDir, name);
  if (!fs.existsSync(file)) {
    throw new AssetCatalogError(`assets/colors/${name}.json does not exist`);
  }
  pushUndo(name, { kind: "restore", snapshot: readColorConfig(file) }, `delete color "${name}"`, "color");
  fs.rmSync(file, { force: true });

  sendJson(res, 200, withUndoMeta(regenerate()));
}

async function handleAppIconList(req, res) {
  sendJson(res, 200, withUndoMeta(regenerate()));
}

/** Uploads one platform/slot's image — creates assets/app-icon/<platform>/ first if this is the
 * platform's very first file (implicitly "adding support for that platform", no separate create
 * step needed, unlike an image/color which has an explicit create request). */
async function handleAppIconUpload(req, res, platform, slot) {
  if (!isAppIconSlot(platform, slot)) {
    throw new AssetCatalogError(`invalid app-icon platform/slot ${JSON.stringify(platform)}/${JSON.stringify(slot)}`);
  }
  const body = await readJsonBody(req);
  const buf = decodePng(body.image, `${platform} ${slot} image`);
  const dir = resolveAppIconPlatformDir(appIconDir, platform);
  const dirExisted = fs.existsSync(dir);

  // If the platform folder didn't exist yet, this upload is what creates it — undoing it should
  // remove the whole folder again, not just this one slot (mirrors handleCreate's 'remove' entry).
  const undoEntry = dirExisted
    ? { kind: "patch", slots: { [slot]: readAppIconSlot(dir, platform, slot) } }
    : { kind: "remove" };
  pushUndo(platform, undoEntry, `${platform} ${slot}: ${dirExisted && readAppIconSlot(dir, platform, slot) ? "replace" : "add"}`, "appicon");

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, appIconSlotFilename(platform, slot)), buf);

  sendJson(res, 200, withUndoMeta(regenerate()));
}

/** Deletes one platform/slot's file, leaving the platform folder (and its other slots) in place —
 * "left empty" per-slot, distinct from handleAppIconPlatformDelete's "delete the whole platform"
 * ("deleted on their own"). */
async function handleAppIconSlotDelete(req, res, platform, slot) {
  if (!isAppIconSlot(platform, slot)) {
    throw new AssetCatalogError(`invalid app-icon platform/slot ${JSON.stringify(platform)}/${JSON.stringify(slot)}`);
  }
  const dir = resolveAppIconPlatformDir(appIconDir, platform);
  const filePath = path.join(dir, appIconSlotFilename(platform, slot));
  if (!fs.existsSync(filePath)) {
    throw new AssetCatalogError(`assets/app-icon/${platform}/${appIconSlotFilename(platform, slot)} does not exist`);
  }
  pushUndo(platform, { kind: "patch", slots: { [slot]: readAppIconSlot(dir, platform, slot) } }, `${platform} ${slot}: remove`, "appicon");
  fs.rmSync(filePath);

  sendJson(res, 200, withUndoMeta(regenerate()));
}

/** Deletes an entire platform folder — "this app doesn't support that platform" — undoable via
 * the same full-snapshot 'restore' shape fullImageSnapshot/handleDelete use for an image. */
async function handleAppIconPlatformDelete(req, res, platform) {
  const dir = resolveAppIconPlatformDir(appIconDir, platform);
  if (!fs.existsSync(dir)) {
    throw new AssetCatalogError(`assets/app-icon/${platform}/ does not exist`);
  }
  pushUndo(platform, { kind: "restore", snapshot: fullAppIconPlatformSnapshot(dir, platform) }, `remove ${platform} app icon`, "appicon");
  fs.rmSync(dir, { recursive: true, force: true });

  sendJson(res, 200, withUndoMeta(regenerate()));
}

/** "Set this icon as the app icon" — writes the platform's currently-present assets/app-icon/
 * files into app.json's matching expo.ios.icon/expo.android.adaptiveIcon/expo.web.favicon fields.
 * Doesn't touch any native ios/ or android/ folder — that's handleAppIconSyncNative's job — so a
 * project still needs a `expo prebuild` (or the sync-native button below) before this actually
 * shows up in a running app. */
async function handleAppIconApplyToAppJson(req, res, platform) {
  const applied = applyAppIconToAppJson(root, appIconDir, platform);
  sendJson(res, 200, { ...withUndoMeta(regenerate()), appJsonApplied: applied });
}

/** Direct best-effort copy of the platform's assets/app-icon/ files into the native ios/ or
 * android/ project, bypassing `expo prebuild` — see syncAppIconToNative's own doc comment for
 * exactly what this does (and doesn't) reproduce per platform. */
async function handleAppIconSyncNative(req, res, platform) {
  const synced = syncAppIconToNative(root, appIconDir, platform);
  sendJson(res, 200, { ...withUndoMeta(regenerate()), nativeSync: synced });
}

async function handleUndo(req, res) {
  const entry = undoStack.pop();
  if (!entry) {
    throw new AssetCatalogError("nothing to undo");
  }
  if (entry.domain === "color") {
    restoreColorEntry(resolveColorFile(colorsDir, entry.name), entry);
  } else if (entry.domain === "appicon") {
    restoreAppIconEntry(resolveAppIconPlatformDir(appIconDir, entry.name), entry.name, entry);
  } else {
    restoreImageEntry(resolveImageDir(imagesDir, entry.name), entry);
  }

  sendJson(res, 200, withUndoMeta({ ...regenerate(), undone: entry.label }));
}

/** Best-effort "reveal in Finder/Explorer" — spawns the OS's own file manager pointed at
 * `absPath`, mirroring what right-click > "Reveal in Finder" does in Xcode's asset catalog.
 * `selectInParent` (the default) opens the CONTAINING folder with `absPath` itself pre-selected —
 * what you want for a single file (macOS's `open -R`, Windows' `explorer.exe /select,`). Passing
 * `selectInParent: false` instead opens `absPath` itself as a folder to browse — what you want for
 * a directory path like assets/images/ (there's nothing to "select" one level up; you want to be
 * inside it). There's no equivalent single command across Linux file managers for the
 * select-in-parent case, so that branch just opens the containing folder there via `xdg-open`
 * (nothing pre-selected). Never rejects on a non-zero exit code — explorer.exe in particular is
 * known to return a nonzero code on success — only a missing binary (ENOENT) surfaces as a real
 * error. */
function revealInFileExplorer(absPath, { selectInParent = true } = {}) {
  return new Promise((resolve, reject) => {
    let cmd;
    let args;
    if (process.platform === "darwin") {
      cmd = "open";
      args = selectInParent ? ["-R", absPath] : [absPath];
    } else if (process.platform === "win32") {
      cmd = "explorer.exe";
      args = selectInParent ? [`/select,${absPath}`] : [absPath];
    } else {
      cmd = "xdg-open";
      args = [selectInParent ? path.dirname(absPath) : absPath];
    }
    execFile(cmd, args, (err) => {
      if (err && err.code === "ENOENT") {
        reject(new AssetCatalogError(`could not find "${cmd}" on this system`));
        return;
      }
      resolve();
    });
  });
}

// The fixed set of top-level catalog directories the sidebar's "assets/<x>/" subtitle can reveal
// — a closed list (not a user-suppliable path) so there's nothing to validate beyond membership.
const REVEALABLE_DIRS = { images: imagesDir, colors: colorsDir, "app-icon": appIconDir };

/** Resolves one of body.{image,app-icon,dir} into `{ absPath, selectInParent }` for an
 * already-existing physical file or directory, reusing the exact same name/filename validation
 * serveImageFile/serveAppIconFile use for the first two (so a request can't escape its recognized
 * directory) — the one addition here is confirming the target is actually present on disk, since
 * revealing something nonexistent makes no sense (unlike the GET routes, which 404 in that case;
 * here it's a plain validation error instead). Colors have no physical per-file path to reveal (a
 * color.json isn't shown/managed as a file in the editor the way an image/app-icon slot is), so
 * there's no "color" kind here — only "dir" for assets/colors/ itself. */
function resolveRevealTarget(body) {
  if (body.kind === "image") {
    const dir = resolveImageDir(imagesDir, body.name);
    if (!parseSlotFilename(body.name, body.filename)) {
      throw new AssetCatalogError("invalid image file");
    }
    return { absPath: path.join(dir, body.filename), selectInParent: true };
  }
  if (body.kind === "app-icon") {
    const dir = resolveAppIconPlatformDir(appIconDir, body.platform);
    if (!isAppIconSlot(body.platform, body.slot) || appIconSlotFilename(body.platform, body.slot) !== body.filename) {
      throw new AssetCatalogError("invalid app-icon file");
    }
    return { absPath: path.join(dir, body.filename), selectInParent: true };
  }
  if (body.kind === "dir") {
    const dir = REVEALABLE_DIRS[body.name];
    if (!dir) {
      throw new AssetCatalogError('"name" must be "images", "colors", or "app-icon"');
    }
    return { absPath: dir, selectInParent: false };
  }
  throw new AssetCatalogError('"kind" must be "image", "app-icon", or "dir"');
}

async function handleReveal(req, res) {
  const body = await readJsonBody(req);
  const { absPath, selectInParent } = resolveRevealTarget(body);
  if (!fs.existsSync(absPath)) {
    throw new AssetCatalogError("path does not exist");
  }
  await revealInFileExplorer(absPath, { selectInParent });
  sendJson(res, 200, { revealed: true });
}

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendError(res, 404, "not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length });
    res.end(data);
  });
}

/** `filename` is the real on-disk filename (`<name>_light.png`, `<name>_light@2x.png`, ...) —
 * validated via parseSlotFilename against this image's own naming pattern (any density, not a
 * fixed enum) so a request can't read anything outside its recognized slots. 404s (not 400s) when
 * the image exists but that particular slot doesn't — e.g. requesting the @2x file for an image
 * with no 2x density is a normal "not present" case. */
function serveImageFile(res, name, filename) {
  let dir;
  try {
    dir = resolveImageDir(imagesDir, name);
  } catch {
    sendError(res, 400, "invalid image name");
    return;
  }
  if (!parseSlotFilename(name, filename)) {
    sendError(res, 400, "invalid image file");
    return;
  }
  serveStaticFile(res, path.join(dir, filename), "image/png");
}

/** `filename` must be one of `platform`'s own known slot filenames (appIconSlotFilename) — 404s
 * (not 400s) when the platform is valid but that particular slot isn't present, mirroring
 * serveImageFile's "not present" vs. "invalid request" distinction. */
function serveAppIconFile(res, platform, filename) {
  let dir;
  try {
    dir = resolveAppIconPlatformDir(appIconDir, platform);
  } catch {
    sendError(res, 400, "invalid app-icon platform");
    return;
  }
  const slot = APP_ICON_PLATFORMS[platform].slots.find((s) => appIconSlotFilename(platform, s) === filename);
  if (!slot) {
    sendError(res, 400, "invalid app-icon file");
    return;
  }
  serveStaticFile(res, path.join(dir, filename), "image/png");
}

/** Serves asset-catalog.html with the consuming project's `_assetCatalogEditorBackgroundColor`
 * AND `_assetCatalogColorPrimaryTint` spliced in as a small override `<style>` block right before
 * `</head>` — CSS custom properties declared later in source order win the cascade over the
 * page's own defaults with no specificity tricks needed, so this never has to parse/rewrite the
 * existing stylesheet. The tint pair drives the page's own CSS-mask-based image previews (see
 * asset-catalog.html's `maskedImage()`), so a 'template' image's preview shows the *actual*
 * configured tint — not a generic invert-filter approximation. */
function serveIndexHtml(res) {
  fs.readFile(htmlFile, "utf8", (err, html) => {
    if (err) {
      sendError(res, 404, "not found");
      return;
    }
    const bg = readEditorBackgroundColor(hooksDir);
    const tint = readPrimaryTint(hooksDir);
    const override =
      `<style>:root{--bg:${bg.light};--tint-light:${tint.light};--tint-dark:${tint.dark}}` +
      `@media (prefers-color-scheme: dark){:root{--bg:${bg.dark}}}</style>\n</head>`;
    const patched = html.replace("</head>", override);
    const buf = Buffer.from(patched, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": buf.length });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const segments = url.pathname.split("/").filter(Boolean);

  Promise.resolve()
    .then(async () => {
      if (req.method === "GET" && segments.length === 0) {
        serveIndexHtml(res);
        return;
      }
      if (req.method === "GET" && segments[0] === "image-src" && segments.length === 3) {
        serveImageFile(res, segments[1], segments[2]);
        return;
      }
      if (segments[0] === "api" && segments[1] === "images") {
        if (req.method === "GET" && segments.length === 2) return handleList(req, res);
        if (req.method === "POST" && segments.length === 2) return handleCreate(req, res);
        if (req.method === "PUT" && segments.length === 3) return handleUpdate(req, res, segments[2]);
        if (req.method === "DELETE" && segments.length === 3) return handleDelete(req, res, segments[2]);
      }
      if (segments[0] === "api" && segments[1] === "colors") {
        if (req.method === "GET" && segments.length === 2) return handleColorList(req, res);
        if (req.method === "POST" && segments.length === 2) return handleColorCreate(req, res);
        if (req.method === "PUT" && segments.length === 3) return handleColorUpdate(req, res, segments[2]);
        if (req.method === "DELETE" && segments.length === 3) return handleColorDelete(req, res, segments[2]);
      }
      if (req.method === "GET" && segments[0] === "app-icon-src" && segments.length === 3) {
        serveAppIconFile(res, segments[1], segments[2]);
        return;
      }
      if (segments[0] === "api" && segments[1] === "app-icon") {
        if (req.method === "GET" && segments.length === 2) return handleAppIconList(req, res);
        if (req.method === "PUT" && segments.length === 4) return handleAppIconUpload(req, res, segments[2], segments[3]);
        if (req.method === "DELETE" && segments.length === 4) return handleAppIconSlotDelete(req, res, segments[2], segments[3]);
        if (req.method === "DELETE" && segments.length === 3) return handleAppIconPlatformDelete(req, res, segments[2]);
        if (req.method === "POST" && segments.length === 4 && segments[3] === "apply-app-json") return handleAppIconApplyToAppJson(req, res, segments[2]);
        if (req.method === "POST" && segments.length === 4 && segments[3] === "sync-native") return handleAppIconSyncNative(req, res, segments[2]);
      }
      if (req.method === "POST" && segments[0] === "api" && segments[1] === "undo" && segments.length === 2) {
        return handleUndo(req, res);
      }
      if (req.method === "POST" && segments[0] === "api" && segments[1] === "reveal" && segments.length === 2) {
        return handleReveal(req, res);
      }
      sendError(res, 404, "not found");
    })
    .catch((err) => {
      if (err instanceof AssetCatalogError) {
        sendError(res, 400, err.message);
      } else {
        console.error(err);
        sendError(res, 500, "internal error");
      }
    });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`asset-catalog: open http://127.0.0.1:${PORT} in your browser (Ctrl+C to stop)`);
});

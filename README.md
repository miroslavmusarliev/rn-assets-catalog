# rn-assets-catalog

A portable, zero-config asset catalog for React Native — a lightweight stand-in for Xcode's
asset catalog. Install it as an npm package (`npm install github:miroslavmusarliev/rn-assets-catalog`)
or just drop this whole folder into any RN project's repo root — either way it works as-is: no
config file, no setup beyond wiring two npm scripts (see Setup below).

## What it is

An image lives in `assets/images/<name>/`:

```
assets/images/drawer-home/
  drawer-home_light.png       # its light appearance — needs at least one of these three present
  drawer-home_light@2x.png    # Metro's own density convention, picked up automatically
  drawer-home_light@3x.png
  drawer-home_dark.png        # its dark appearance — fully optional; same "at least one of three" rule
  drawer-home_dark@2x.png     # applies to whichever of these three you provide, if any
  drawer-home_dark@3x.png
  config.json                 # optional — { "mode": "template" | "original", "tint"?: {...} }
```

- `template` — a single-color mask, tinted at runtime (the common case: nav images, chevrons).
- `original` — non-tintable multi-color art (a logo, a photo-style image), optionally with a real
  dark-mode asset swapped in for dark mode.

Every file is named `<image-name>_light`/`<image-name>_dark`, optionally suffixed `@2x`/`@3x` —
`slotFilename` in `lib/asset-catalog-core.js` computes this for every read/write, both codegen
scripts and the editor use it exclusively (nothing hardcodes a filename). The name-scoped filename
(vs. a generic `image.png` in every folder) buys no new disambiguation — the containing per-name
folder already does that — it's purely for legibility browsing `assets/images/*/` in an editor or
Finder.

No single density file is mandatory. An image's light appearance needs at least one of its three
files present — providing only the `@2x` one, say, is a supported (if unusual) case, not an error.
A dark appearance is optional as a whole, but if you provide one at all, the same rule applies: any
one of its three files is enough. The generated catalog's `require()` call always targets the
*bare* filename (`<name>_light.png`/`<name>_dark.png`) regardless of which of the three physically
exist — **not** whichever file `resolvePrimarySlot` (in `lib/asset-catalog-core.js`) picked as "the"
representative one (that function exists only for the editor's own preview image and for
determining whether an appearance exists at all). This matters because of how Metro's asset
resolver actually works (see `node_modules/metro-resolver/src/resolveAsset.js` and
`metro/src/node-haste/DependencyGraph.js`'s `resolveAsset` callback): a bare-name `require()`
builds its candidate list as `[bare, @1x, @1.5x, @2x, @3x, @4x]` and just drops whichever don't
exist on disk, succeeding as long as at least one does — so it resolves correctly whether the 1x
file is there or not, and a 1x device just gets served the nearest available density (no crash, no
missing image, only slightly-off-optimal pixel density). But requiring an already-`@Nx`-suffixed
path *directly* — e.g. `require('./name_light@2x.png')` — hits an early-exit guard in
`resolveAsset.js` that skips density resolution entirely and fails outright. So removing a 1x file
never orphans its density siblings or requires "renaming" anything — the bare `require()` keeps
working exactly as before, Metro just resolves it to whichever `@2x`/`@3x` file remains. The editor
enforces only one real constraint: an image's light appearance can never drop to zero files (there'd be
nothing left to require at all) — its dark appearance can freely go to zero, same as never having
had one.

Density isn't limited to `@2x`/`@3x` either — Metro's own `resolver.assetResolutions` config
(default `["1", "1.5", "2", "3", "4"]`, but a project can set it to anything) determines what it
actually looks for at bundle time, so this tool doesn't hardcode a fixed set of density slots.
`assets/images/<name>/` can hold any `<name>_light@<number>x.png` / `<name>_dark@<number>x.png` file
and it's recognized automatically (`parseSlotFilename`/`scanSlotsInDir` in
`lib/asset-catalog-core.js` discover whatever's actually on disk by pattern rather than checking a
fixed list). The editor offers `1.5`/`2`/`3`/`4` as one-click quick-add buttons (matching Metro's
default resolutions) plus an "Add custom…" input for anything else your project's own
`resolver.assetResolutions` supports. A sidebar checkbox, **"Show density variants"**, purely
visually hides/shows these extra density controls in the detail view to declutter the common case
of an image with just a base image — it has no effect on disk, isn't per-image, and isn't persisted
across a page reload (defaults to hidden every time you open the editor).

`config.json` is optional: a folder with just a light appearance infers `template`; one with both
light and dark appearances infers `original` (a dark asset only makes sense for non-tintable art —
a `template` image never needs one, tinting covers both themes). Whenever it's missing,
`generate-asset-catalog.js` writes it back to disk with the inferred mode the first time it's
generated, so a folder becomes self-documenting rather than silently re-guessing forever.

A `template` image can also carry a per-image tint override in its `config.json`:

```json
{ "mode": "template", "tint": { "light": "#ff3b30", "dark": "#ff6961" } }
```

Omitting `tint` (or setting it to `"default"`) means "no override" — the image defers to your
app's own `hooks/_assetCatalogColorPrimaryTint.js` (see below), same as before this existed.
Setting it to `{ light, dark }` hex pairs overrides just that one image's tint, without touching
the app-wide default. `useImage`'s per-call `options.color` still wins over both, for the
rare one-off case (see Setup below) — the precedence is call-site override > this image's own
`tint` > the app default. Only valid for `template` images — `original` images have nothing to
tint, and both codegen and the editor reject/ignore a `tint` on one.

## Namespaces

A name — image or color — can be namespaced by nesting it inside a subdirectory, at any depth:
`assets/images/drawer/home/` (an image named `drawer/home`) or `assets/colors/brand/primary.json`
(a color named `brand/primary`). The catalog name is just the path relative to `assets/images/`
or `assets/colors/`, `/`-joined — `IconName`/`ColorName` (whatever the generated catalog's own
name is) include the full namespaced string as a literal, e.g. `type ImageName = 'drawer/home' |
...`, and `useImage('drawer/home')`/`useColor('brand/primary')` work exactly like any other name.

A directory holding only further subdirectories (no image/color files of its own) is a pure
namespace node — nothing to validate there, just a grouping level. A directory can also be both at
once: `assets/images/drawer/` could itself be an image (if it has its own `drawer_light.png`) while
`assets/images/drawer/home/` nests a second image, `drawer/home`, one level under it. Only the
leaf segment of a namespaced name is ever used as the actual filename prefix (e.g.
`drawer/home`'s files are `home_light.png`/`home_dark.png`, not `drawer/home_light.png`) — the
namespace itself is carried entirely by the folder nesting, matching how the flat case already
worked (folder name = file prefix), just with intermediate directories now allowed in between.

## Colors — an optional sibling catalog

Alongside images, this tool also manages a lightweight **colors** catalog — no images, just
declared light/dark hex pairs, useful for a brand/semantic color you want typed and centrally
editable the same way an image is, instead of a raw hex literal scattered across call sites. Unlike
images, having zero colors declared is not an error — an empty or missing `assets/colors/` is a
normal, common case, and neither codegen script complains about it.

A color lives in `assets/colors/<name>.json` — one flat file, not a folder. Unlike an image (a
family of light/dark/`@2x`/`@3x` files plus `config.json`, which genuinely needs a per-name folder
to group them), a color is always exactly one JSON object with no siblings, so there's no folder
to nest it inside:

```
assets/colors/brand-primary.json   # required — { "light": "#hex", "dark"?: "#hex" }
```

`light` is required; `dark` is optional and, unlike an image's `tint`, has no "app default" to fall
back to — if omitted, the color's own `dark` value is just resolved to `light`'s value at
generation time (i.e. "no separate dark variant" rather than "defer to something else"). There's
no mode inference here (nothing to infer from — it's not an image), so a color's JSON file is
always required, hand-written or (far more commonly) created through the browser editor's "+ New
Color" flow, which is just writing this one small file.

Either hex value may carry an alpha channel — 4-digit (`#rgba`) or 8-digit (`#rrggbbaa`) shorthand
works exactly like 3-/6-digit opaque hex everywhere a color is accepted. The browser editor exposes
this as an "Opacity" slider next to each light/dark color picker (since `<input type=color>` itself
has no alpha support), and shows a checkerboard behind translucent swatches so partial transparency
is visible at a glance.

Regenerating produces `assets/color-catalog.generated.ts` (a typed `ColorName` union + a `Record`
of `{ light, dark }` pairs), consumed via `useColor(name)` (see Setup below — this is exported
from your project's own auto-scaffolded `assets/index.ts`, alongside `useImage`):

```tsx
const brandPrimary = useColor('brand-primary'); // resolves light/dark for the live scheme
<View style={{ backgroundColor: brandPrimary }} />
```

Like images, this reads the current scheme from your project's own
`hooks/useAssetCatalogColorScheme.js` — so a color and an image's default tint always agree on what
"dark" means, since both defer to the exact same hook. There's no per-call override here (unlike
`useImage`'s `options.color`/`options.scheme`) — a color's own JSON file values ARE the source
of truth; if you need a one-off variant, declare a second named color rather than overriding this
hook's call site.

## App icon — a special, singular catalog entry

Unlike images and colors (named collections, arbitrarily many entries), the **app icon** is exactly
one thing, so it gets its own tab in the editor ("App") instead of living in the Images catalog. It
lives at `assets/app-icon/{ios,android,web}/` — one subdirectory per platform, each independently
present or absent (a missing subdirectory just means "this app doesn't ship on that platform" —
delete it via the editor's "Remove … Support" button, or just never create it) and each holding a
fixed, platform-specific set of slots:

```
assets/app-icon/
  ios/           # ios_light.png (required), ios_dark.png (optional), ios_tinted.png (optional)
  android/       # android_foreground.png, android_background.png (both required),
                 # android_monochrome.png (optional)
  web/           # web_favicon.png
```

Every slot is independently addable/replaceable/removable — an existing platform folder can be left
with some slots empty (e.g. iOS with no `tinted` variant yet) without that being an error; nothing
here is inferred or validated the way an image's `config.json` mode is, since the slot set is fixed
per platform rather than open-ended. Uploading a platform's very first slot through the editor
implicitly creates that platform's folder — there's no separate "create" step like an image/color
has.

**No generated `.ts` file exists for this.** Unlike images/colors, the app icon isn't consumed via a
`useImage()`/`useColor()`-style typed lookup from React code — it's referenced directly by path from
your project's own `app.json`:

```json
{
  "icon": "./assets/app-icon/ios/ios_light.png",
  "ios": { "icon": { "light": "./assets/app-icon/ios/ios_light.png", "dark": "...", "tinted": "..." } },
  "android": {
    "adaptiveIcon": {
      "foregroundImage": "./assets/app-icon/android/android_foreground.png",
      "backgroundImage": "./assets/app-icon/android/android_background.png",
      "monochromeImage": "./assets/app-icon/android/android_monochrome.png"
    }
  },
  "web": { "favicon": "./assets/app-icon/web/web_favicon.png" }
}
```

Only include the `dark`/`tinted`/`monochromeImage` keys for slots that actually exist — this tool
manages the files themselves, not `app.json`, so keeping the two in sync (adding/removing a key when
you add/remove a slot) is on you. `ios.icon` here is Expo's plain light/dark/tinted object form, not
the Icon Composer `.icon` bundle format (a separate, much richer layered-asset format this tool
doesn't attempt to generate or edit).

## Setup (one-time, per project)

This tool ships as its own package (`package.json`, `bin` entries — this folder is a standalone
repo in its own right, not a fragment of the app it happens to also live inside for development).
Get it into a consuming project either way:

**Option A — npm install from GitHub (recommended once this is pushed to its own repo):**
```
npm install github:miroslavmusarliev/rn-assets-catalog
```
This gives you two CLI commands via npm's `bin` linking — no `node ./path/to/script.js`, no
caring where in `node_modules` it physically landed:
```json
"scripts": {
  "generate:images": "asset-catalog-generate",
  "asset-catalog": "asset-catalog"
}
```
The install itself also runs a `postinstall` script that scaffolds `hooks/` and `assets/index.ts`
(and regenerates the catalogs, if `assets/images/` already has something in it) — best-effort
only, so a brand-new project with no images yet just logs a note instead of failing the install.
It's the same "materialize once" scaffolding `generate-asset-catalog.js`/`asset-catalog-server.js`
already do on their own first run — this just means you get it immediately after `npm install`
too, without needing to run either command yourself first. It never replaces actually wiring
`generate:images` as a `pre*` hook (see step 3 below) — that's still what keeps the generated
catalogs in sync as you add/change images afterward.

**Uninstalling** (`npm uninstall rn-assets-catalog`) doesn't leave `generate:images`/`asset-catalog`
pointed at a bin that no longer exists — a `preuninstall` script ejects this package's own files
into an `asset-catalog-tool/` folder in your project (same layout as Option B below) and repoints
those two scripts at the copy, so `npm start`/`ios`/`android`/`web` keep working with zero ongoing
dependency. See [UNINSTALL.md](./UNINSTALL.md) for the full writeup, including what's deliberately
left untouched and how to eject manually if your uninstall flow skips lifecycle scripts.

(Pin a tag/commit instead of a branch for anything beyond local experimentation —
`github:miroslavmusarliev/rn-assets-catalog#v0.1.4` — so a later push to the tool's own repo can't
silently change what a consuming project's `npm install` pulls in.)

**Option B — drop-in folder (no package manager involved at all):**
1. Copy this whole `asset-catalog-tool/` folder into your project's repo root (same level as
   `assets/`) — some consuming projects keep a byte-identical copy this way (e.g. as `scripts/`)
   rather than installing via `npm install`.
2. Add to `package.json`:
   ```json
   "scripts": {
     "generate:images": "node ./asset-catalog-tool/generate-asset-catalog.js",
     "asset-catalog": "node ./asset-catalog-tool/asset-catalog-server.js"
   }
   ```

Either way, from here setup is identical:

3. Chain `generate:images` as a `pre*` hook on whatever starts your app, e.g.:
   ```json
   "prestart": "npm run generate:images",
   "preios": "npm run generate:images",
   "preandroid": "npm run generate:images"
   ```
   so `assets/image-catalog.generated.ts` is always regenerated before a build/run, never
   hand-maintained.
4. Use `useImage(name)`/`useColor(name)` wherever you render an image or need a catalog color:
   ```tsx
   import { useImage, useColor } from './assets'; // or '@/assets' if your tsconfig paths it there

   const { source, tintColor } = useImage('drawer-home');
   <Image source={source} tintColor={tintColor} />

   const brandPrimary = useColor('brand-primary');
   ```
   An optional second argument to `useImage` overrides what would otherwise come from `hooks/` or
   the image's own `config.json`, for the rare one-off case — a specific tint, a forced light/dark
   preview (e.g. a "preview dark mode" toggle unrelated to the app's actual theme), or a forced
   render mode:
   ```tsx
   useImage('drawer-home', { color: '#ff3b30' });
   useImage('drawer-home', { scheme: 'dark' }); // render as dark regardless of the real scheme
   useImage('some-logo', { mode: 'template' }); // force untinted-mask rendering, rare
   ```

That's it — no config file, no CLI flags to learn. The first time you run either
`generate-asset-catalog.js` or `asset-catalog-server.js`, they'll also create, next to `assets/`
(see below):
- a `hooks/` directory with the theming bridge files, if it doesn't already have everything this
  tool needs;
- `assets/index.ts` — the unified barrel exporting `useImage` (and `useColor`, once at least one
  color is declared) — **only if that file doesn't already exist**, so it's yours to edit freely
  once it's there (e.g. to wire in your app's own theme system instead of `hooks/`'s defaults; see
  that file's own header comment for the recommended way to do that). This is what makes
  `import { useImage, useColor } from './assets'` work out of the box in every project this tool
  is dropped into, with zero manual wiring beyond the two npm scripts above — you don't need to
  hand-write this barrel yourself.

If you'd rather import it as `@/assets` (a bare alias instead of a relative `./assets`/`../assets`
path), add an exact-match entry to your project's own `tsconfig.json` (this is the one piece of
setup the tool can't safely do for you, since it means editing a file it doesn't own):
```json
{
  "compilerOptions": {
    "paths": {
      "@/assets": ["./assets/index.ts"]
    }
  }
}
```
A wildcard-only `"@/assets/*": ["./assets/*"]` entry (if your project already has one, e.g. for
importing individual generated files directly) does **not** cover the bare `@/assets` import on
its own — it needs this exact-match entry alongside it.

## The two things this exposes

- **`generate-asset-catalog.js`** — the build-time codegen. Scans `assets/images/`, writes
  `assets/image-catalog.generated.ts` (a typed `ImageName` union + a `Record` of `require()`'d
  sources). Also scans `assets/colors/` and writes `assets/color-catalog.generated.ts` the same
  way, but only if at least one color is declared — an empty/missing `assets/colors/` writes
  nothing and isn't an error, unlike `assets/images/`. Run directly, or via the `pre*` hooks above.
- **`asset-catalog-server.js`** (+ `asset-catalog.html`) — `npm run asset-catalog` starts a
  localhost-only browser editor covering both catalogs (a sidebar toggle switches between Images
  and Colors): create/replace/delete image entries, drag-and-drop images onto a swatch to replace it
  or onto the sidebar to create a new entry, set a per-image tint override, create/edit/delete
  colors via light/dark color pickers, undo any of it (one shared undo stack across both
  catalogs — Ctrl/Cmd+Z). Every change re-runs the same codegen, so neither generated file ever
  drifts while you use it.

  The detail view also shows and manages `@2x`/`@3x` density variants for both the light and dark
  appearance — none of the three files in either appearance depend on each other, so removing a 1x
  asset just promotes its `@2x` (or, failing that, `@3x`) sibling to be the require target instead
  of orphaning it; the one thing the editor won't let you do is remove the last file backing the
  light appearance, since then there'd be nothing left to require at all. Dropping a same-batch set
  of files onto the sidebar — e.g.
  `bill.png`/`bill@2x.png`/`bill@3x.png`/`bill-dark.png` — groups them into **one** image instead
  of four separate ones; the grouping recognizes the standard `@2x`/`@3x` suffix and a
  case-insensitive `-dark`/`_dark`/`@dark` suffix for the dark variant.

## The `hooks/` contract

`useImage` doesn't hardcode any theming decisions itself — it defers everything to three
functions your project owns in its own `hooks/` directory. Neither codegen script ever *requires*
you to have written these: the first time either runs, it creates whichever of these files are
missing with a sensible default, then never touches an existing one again — same "materialize
once, then it's a normal file you own" rule as an image's `config.json`.

Only the first is an actual hook — the other two are named with a leading underscore instead of
`use` precisely so they read as plain functions, not something meant to be called like a hook:

| Export | Returns | Default behavior |
|---|---|---|
| `useAssetCatalogColorScheme()` | `'light' \| 'dark'` | Tries `require('react-native').useColorScheme()`, falls back to always `'light'` if that import fails (e.g. not an RN project) |
| `_assetCatalogColorPrimaryTint(variant)` | a hex string | `variant === 'dark' ? '#ffffff' : '#000000'` — plain black/white; `useIconSource.ts` passes in whatever the scheme hook above returned |
| `_assetCatalogEditorBackgroundColor()` | `{ light, dark }` hex | `{ light: '#f2f2f7', dark: '#1c1c1e' }` — the one exception that returns both at once (no `variant` param): read directly by `asset-catalog-server.js`, a plain Node process with no live "current theme" to resolve, to build a CSS media query the browser picks from at render time |

There's deliberately no secondary/tertiary tint here — that's a plausible future extension (a
distinct accent color, say) rather than something anything currently consumes, so it isn't
scaffolded until it's actually needed. If you add one later, follow `_assetCatalogColorPrimaryTint.js`'s
exact shape: a plain function taking the same `variant` parameter, returning a single hex for it.

Override any of these by editing the generated file in `hooks/` directly — there's no registration
step, no config to point at it, the file's own name **is** the contract. The common case: your app
already has its own theme system (a manual light/dark/system toggle the user can pick
independently of their device's OS setting, a brand-specific tint instead of plain black/white) —
replace `hooks/useAssetCatalogColorScheme.js`'s body with your theme hook's equivalent and/or
`_assetCatalogColorPrimaryTint.js`'s body with your brand color. `useIconSource.ts` itself never
needs to change; it only orchestrates the catalog lookup and defers every color decision to these
three exports.

**Don't call any of these three directly from your app's own screens/components.** They're an
internal bridge for asset-catalog-tool's own use — `useIconSource.ts` is the only intended caller
of the scheme hook and the tint function, and `asset-catalog-server.js` the only intended caller
of `_assetCatalogEditorBackgroundColor`. If a component elsewhere in your app needs a light/dark
check or a tint color for something unrelated to an image, read it from your app's own
theme/appearance system instead of importing from `hooks/` — that keeps this bridge free to
change shape later without you having to hunt down unrelated call sites across the app. Each
generated file repeats this same warning at the top for anyone who opens it later without having
read this README.

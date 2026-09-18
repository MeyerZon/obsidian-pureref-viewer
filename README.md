# PureRef Viewer for Obsidian

View [PureRef](https://www.pureref.com/) reference boards (`.pur`) inside Obsidian and embed them in notes. Read-only: the plugin never writes to `.pur` files.

## Features

- Opens `.pur` files in a tab as a pannable, zoomable board: images at their real position, scale, rotation and crop; text notes; pen strokes.
- `![[board.pur]]` embeds in notes (reading view and live preview). `![[board.pur#height=300]]` sets the embed height, `#view=actual` starts at 100%.
- Commands: fit board to view, zoom to actual size, zoom in/out, export board images, open in PureRef.
- File context menu: open in PureRef, reveal in folder, export board images.
- Settings: initial view, canvas background, show notes/drawings, embed height, export folder.

Controls: drag to pan, wheel to zoom (in embeds: Ctrl/Cmd+wheel), double-click an image to frame it, pinch on touch screens.

Getting content out: right-click an image for "Copy image" (PNG, cropped as shown on the board), "Save image to vault" and "Copy image source path"; right-click a note for "Copy text" and "Copy as Markdown". Text inside notes is selectable, so drag across a note to select and Ctrl/Cmd+C to copy. Because dragging on a note selects text, pan by dragging the canvas or an image instead.

## Supported files

PureRef 2.x boards (format `2.0`–`2.2`, tested with 2.1.3). PureRef 1.x boards are rejected with a message; open and re-save them in PureRef 2 to convert.

The 2.x format is an SQLite database with a small header; see [FyorDev/pur-2-file-format](https://github.com/FyorDev/pur-2-file-format). The parser in `src/pur/` is dependency-free.

### Known limitations

- Linked (non-embedded) images show a placeholder with the original path.
- Animated GIF/WebP images always play; PureRef's paused-frame state is ignored.
- Notes use Open Sans if it is installed, otherwise the interface font, so text may wrap slightly differently than in PureRef.
- Paths verified only on a real board: uncropped images, embedded PNGs, auto-sized and fixed-width notes, drawings. Cropped images, groups and linked images follow the format spec but have not been checked against a sample yet.
- Embeds rely on Obsidian's undocumented embed registry; if it is unavailable the plugin falls back to reading-view-only embeds.

## Development

```
npm install
npm run dev          # esbuild watch -> main.js
npm test             # parser tests against "UI Explorations.pur" (or $PUR_FIXTURE)
npm run build        # type-check + minified main.js
npm run install-vault [-- --vault <path>]   # copy main.js/manifest.json/styles.css into a vault
```

Then enable the plugin under Settings → Community plugins. With the [Hot Reload](https://github.com/pjeby/hot-reload) plugin installed, the `.hotreload` marker written by `install-vault` reloads the plugin on every build.

## Release

Bump `manifest.json`/`versions.json` (`npm version patch`), push a tag equal to the version; the GitHub workflow attaches `main.js`, `manifest.json` and `styles.css` to a draft release.

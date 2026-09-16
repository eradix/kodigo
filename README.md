# Kodigo

A small, local-first Markdown notes app — a mini Obsidian. Point it at a folder,
and it gives you a file tree, a tabbed Markdown editor with live styling, and
full-text search across everything.

Your notes stay plain `.md` files on disk. Kodigo keeps a SQLite index in its own
app-data directory, never inside your vault; deleting that index only costs you a
rescan.

## Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 (Rust) |
| Frontend | React 19 + TypeScript + Vite |
| Editor | CodeMirror 6 |
| Index | SQLite FTS5 (bundled, via `rusqlite`) |
| State | Zustand |

The frontend has no filesystem access of its own. Every read, write and query goes
through a Rust command, so path handling and the index can never disagree about
what happened.

## Getting started

Install the Rust toolchain and the Linux WebKit dependencies:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

```bash
sudo apt install -y build-essential libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libssl-dev patchelf
```

Then:

```bash
npm install && npm run tauri dev
```

To produce a bundle (`.deb` / AppImage under `src-tauri/target/release/bundle/`):

```bash
npm run tauri build
```

### Running under WSL

WSLg provides the display, but WebKitGTK's DMA-BUF renderer does not work there. If
the window comes up blank or the process dies on GPU init, launch with:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 npm run tauri dev
```

## Using it

Open any folder as a vault. Kodigo reopens the last one on launch, and the sidebar
menu button switches to another. `.md`, `.markdown` and `.txt` files are treated as
notes; hidden folders, `node_modules`, `target`, `.git` and `.obsidian` are ignored.

Drop Markdown files from your file manager onto the window to import them. They land
next to the note you have open, are never overwritten (a clashing name gets ` 2`
appended), and anything that is not a note is reported back rather than silently
dropped.

Notes save themselves 600 ms after you stop typing, and always before you switch
tabs or close the window. Deletes go to the system trash. If a note changes on disk
while you have it open, Kodigo reloads it — unless you have unsaved edits, in which
case it asks which version wins.

### Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl+O` / `Ctrl+P` | Quick switcher — jump to a note by name |
| `Ctrl+Shift+F` | Focus full-text search |
| `Ctrl+N` | New note |
| `Ctrl+W` | Close tab |
| `Ctrl+B` / `Ctrl+I` | Bold / italic |
| `Ctrl+E` | Inline code |
| `Ctrl+Shift+C` | Fenced code block |
| `Ctrl+Shift+X` | Strikethrough |
| `Ctrl+K` | Link |
| `Ctrl+1` … `Ctrl+3` | Heading level |
| `Ctrl+Shift+Q` / `L` / `T` | Quote / bullet / task line |

Type `/` at the start of a line for the insert menu (code block, table, task,
headings, frontmatter, and so on). Selecting text brings up a floating toolbar with
the same commands.

### Tags

Both `#inline-tags` and a `tags:` key in YAML frontmatter are indexed and listed in
the Tags panel. A `#tag` inside a code fence, inside backticks, or in a URL fragment
is not a tag.

## Layout

```
src/                      React frontend
  lib/ipc.ts              the only module that calls invoke()
  state/store.ts          Zustand store
  components/Editor/      CodeMirror setup, live styling, code blocks, slash menu
  components/Sidebar/     file tree, search, tags
src-tauri/src/            Rust backend
  vault.rs                vault identity, path safety, recents
  notes.rs                tree building, atomic note writes
  parse.rs                frontmatter, titles, tag extraction
  index/                  schema, indexer, queries
  watcher.rs              debounced filesystem watching
  commands.rs             the IPC surface
```

## Tests

```bash
cd src-tauri && cargo test
```

Covers frontmatter and tag-extraction edge cases, path-traversal rejection, FTS5
query building, and quick-switcher ranking.

## Not built yet

Wikilinks and backlinks are deliberately absent. The index schema carries an unused
`links` table so they can be added later without a migration or a full reindex.

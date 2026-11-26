# notedid: spec

Status: milestones 1–5 built (2026-11-25). The phone milestone took another road (2026-11-26): instead of a server on the home network with a login, the app runs in the browser, syncs through Dropbox and installs on phones (§15). AI is postponed. §15 lists where the build differs from this plan.

## 1. What we're building

notedid is a personal notes app, used from a desktop browser and a phone. It runs with a small server, or entirely in a browser.

It solves four problems:

1. **Writing a note must take no decisions.** Open the app and type. This works on desktop and phone, and on the phone even offline.
2. **Notes must be easy to find later.** Search, links and views do the organizing, not folders.
3. **Notes are never lost or silently rewritten.** They are plain markdown files with a full history.
4. **There is a safe vault.** Some notes are encrypted so that only you can read them, now and after AI features arrive.

It covers:

- daily journaling and task logging
- tasks and lists (groceries)
- tables and links
- reading and reviewing PDFs and markdown with highlights and comments
- project boards that gather everything for one project on one page

Not in scope for now:

- other users and sharing
- access from the public internet
- real-time co-editing
- an outliner
- plugins
- AI features, which are planned for after the vault (§12)

## 2. Principles

1. **Plain markdown files are the source of truth.** The search index and caches are derived from them and can be rebuilt at any time. Notes open fine in any text editor.
2. **The app only changes what you change.** It never reformats or "fixes" text you didn't edit. Line endings and syntax it doesn't understand round-trip byte for byte. Every note's earlier versions are kept as plain files beside it, so any version can be restored.
3. **Capture takes no decisions.** No title, folder or tag is required. Everything you capture goes into today's note.
4. **Finding matters more than organizing.** Finding relies on a quick switcher, full-text search with filters, backlinks and unlinked mentions. Sidebar views are saved searches.
5. **Notes are documents, not an outliner.** Use bullets when you want a list and paragraphs when you don't.
6. **The phone is a first-class client.** Every screen works at phone width, and capture works offline.

## 3. Architecture

```
 phone (installed web app) ─┐
 desktop browser ───────────┼── HTTPS ──► Caddy ──► app server (Node + Hono)
 `note` CLI ────────────────┘  notes.example.com        │
                                                         ├─► $NOTES_DIR/**/*.md     source of truth; versions in .notedid/history
                                                         ├─► $NOTES_DIR/.notedid/   settings
                                                         └─► $NOTES_DIR/vault/      ciphertext only (M5)
```

- **App server.** Node 26 LTS, TypeScript and Hono. It handles file I/O, the search index, git commits, login, link-title fetching and live change events (SSE).
- **Web client.** React, Vite and the CodeMirror 6 editor. It is an installable web app (PWA) with a service worker and an offline outbox.
- **Shared code (`src/shared`).** Types and markdown parsing used by both sides. Both parse with `@lezer/markdown` plus GFM and our `[[link]]` and `#tag` extensions. That way the editor and the index always agree on what counts as a link, a task or a tag, down to the exact character offsets.
- **Index.** SQLite with FTS5 (Node's built-in `node:sqlite`), kept in memory and rebuilt from the files at startup. A file watcher picks up edits made outside the app.
- **Notes folder.** It lives outside the code repository. Development uses `dev-notes/` (gitignored), so building the app never touches real notes.
- **Two hosts for one backend.** The backend code (`src/server`) works on two small interfaces: `Disk` (the files below the notes folder) and `SqlDatabase` (the index's SQLite). On a computer they are a real folder (`NodeDisk`) and `node:sqlite`, behind the Node server. In the browser-only app (`src/browser`) they are IndexedDB (`IdbDisk`) and SQLite compiled to WebAssembly, behind a service worker that answers the same `/api` requests, so the web client is the same in both. Live change events go over a `BroadcastChannel` instead of SSE.

## 4. Data model

### 4.1 Folder layout

```
$NOTES_DIR/
  journal/2026-11-25.md        daily notes, created on first write
  notes/<slug>.md              all other notes, flat
  papers/<key>.pdf, <key>.md   a paper and its review note (M3)
  boards/<slug>.md             project boards (M4)
  files/2026/<name>.<ext>      attachments: images, other files
  trash/                       deleted notes, restorable
  vault/                       encrypted blobs (M5)
  .notedid/                    settings.json (committed with the notes)
```

### 4.2 Notes

- A note is a `.md` file. Its title comes from frontmatter `title`, then the first `# heading`, then the file name.
- Frontmatter (YAML) is optional. The app writes it when you set something that needs it, such as `type: paper`, and for the note's id.
- A note's identity is its id: `id:` in its front matter, 12 random characters, permanent. Its path and title are names that can change. New notes are made with an id; older notes get one only when asked (Ctrl+K, "Give every note an ID").
- A new note's file name is a slug of its title.
- Renaming is an explicit action. The app first shows which notes link to the old name, then updates those links in one commit.
- Deleting a note moves it to `trash/`.

### 4.3 Syntax

| Thing | Syntax | Notes |
|---|---|---|
| Link to a note | `[[Title]]`, `[[Title\|label]]`, `[[Title#Heading]]` | Matched by title, then file name, ignoring case. Clicking a link to a missing note creates it. |
| Markdown link | `[text](https://…)`, `[text](../notes/x.md)` | |
| Tag | `#tag`, `#project/sub` | Not inside code or URLs |
| Task | `- [ ] text`, `- [x] text` | Optional `due:2026-11-28`. Ticking in the app adds `done:2026-11-25`. |
| Date | `2026-11-25` anywhere | Links to that day's journal note |
| Note id | `id: k7q9m2vbfz4r` in front matter | A letter, then 11 letters or digits (no i, l, o, u), so YAML always reads it as text. Set when a note is made; ids people wrote themselves are kept. |
| Table | GFM pipe table | |
| Card | `### Heading` with `key:: value` lines right under it | A `##`–`######` heading with properties; its text runs to the next heading of the same or a higher level. Commas separate values. A space must follow `::` (so `std::vector` stays text). |
| Attachment | `![](../files/2026/photo.jpg)` | Relative paths, so other markdown viewers show it |

### 4.4 Capture

- A capture is added to the end of today's journal note as `- 14:32 call dentist fri`. Further lines are indented as part of the same item.
- A leading `[] ` or `todo ` turns the capture into a task: `- [ ] call dentist fri`.
- A capture can name a target note, such as Groceries, and is added there instead.
- The device sends its own timestamp. A capture made offline at 23:50 lands on that day even if it syncs the next morning.
- Each capture carries an ID generated on the device, so a retry never adds it twice.

## 5. Finding things

- **Quick switcher (Ctrl+K).** Fuzzy title match, plus recent notes and commands.
- **Search.** Words, `"phrases"` and `-exclusions`, combined with filters:

  | Filter | Example |
  |---|---|
  | tag | `tag:thesis` |
  | kind | `is:task`, `is:open`, `is:done` |
  | due | `due:today`, `due:overdue`, `due:<2026-12-01` |
  | place | `in:journal`, `in:papers`, `in:boards` |
  | time | `after:2026-10-01`, `before:2026-11-01` |
  | content | `has:link`, `has:pdf`, `has:task` |

- **Views.** Saved searches pinned in the sidebar, such as Tasks, Papers, Groceries and This week. They are stored in `.notedid/settings.json`.
- **Backlinks and unlinked mentions.** Every note shows both. Unlinked mentions are notes that use this note's title without linking it; one click turns each mention into a link.
- **Tasks view.** Open tasks from all notes, grouped into overdue, today, upcoming and no date. Ticking a task there changes only that line in its note.

## 6. Editing

- **Editor.** CodeMirror 6 edits the markdown text itself and styles it as you type:
  - markup is hidden on lines without the cursor
  - checkboxes are clickable and links open
  - headings and tables are styled

  The file is exactly what you typed. Line endings (LF or CRLF) are detected and kept.
- **Autoformat as you type** (no AI):
  - `[]` becomes a checkbox.
  - Enter continues lists and tasks. Tab and Shift-Tab indent.
  - In a table, Tab moves between cells, and the table is realigned when you leave it.
  - A pasted URL becomes `[Page title](url)`.
  - A paste from a spreadsheet (TSV or HTML) becomes a table.
  - `due:fri` becomes `due:2026-11-28`.
  - `[[` opens a note picker and `/` opens a command menu.
- **Saving.** The editor saves about a second after you stop typing. Each save sends the hash of the version the edit started from. If the file changed in the meantime, the server answers 409:
  - If only the copy on disk changed, the editor reloads quietly.
  - If both changed, you choose: use the saved version, keep yours, or merge (a 3-way merge comes later).
- **Live updates.** When a file changes on disk, open editors are notified over SSE.

## 7. Phone, home-network hosting, offline

*Postponed on 2026-11-25. For now the app runs on this machine's localhost only. This section is the design for when the phone work is picked up again.*

- **Hosting.** For now the app is hosted on the current workstation, where the app and Caddy run in Docker Compose. Development already runs in Docker on the same machine.
  - `notes.example.com` points to that machine's LAN IP.
  - A local DNS override is recommended for this. Some routers block public DNS records that point at private IPs, as protection against DNS rebinding.
- **HTTPS is required.** Phones allow installing, offline mode (service workers) and in-browser encryption (WebCrypto, used by the vault) only over HTTPS.
  - The server isn't reachable from the internet, so the certificate must come through an ACME DNS-01 challenge. Use Caddy with your DNS provider's module, or certbot.
  - Fallback: Caddy's internal CA, with its root certificate installed on each device.
- **Installable app.** The home-screen icon opens straight to capture. Android also gets shortcuts to Today and Groceries.
- **Share to notes.** Android registers the app as a share target for text, links, PDFs and images. iPhone uses an Apple Shortcut that posts to `/api/capture` with a capture token. Both go through the same endpoint.
- **Offline.**
  - The app shell is cached.
  - Captures and checkbox ticks go into an outbox on the device (IndexedDB) and sync when the server is reachable. Captures only add text, so they can't conflict. A tick is applied only if the line's text still matches.
  - Today's note, pinned notes (e.g. Groceries) and recently opened notes are cached for reading.
  - Editing other notes needs a connection; offline, the editor turns read-only. This avoids sync conflicts.
- **Away from home.** Capture and cached notes work offline. For full access, a VPN (WireGuard or Tailscale) can be added later without changing the app.

## 8. Security

- **Login.**
  - Single user. The password is stored as an argon2id hash.
  - Sessions are server-side, in a long-lived cookie (`__Host-` prefix, Secure, HttpOnly, SameSite=Lax).
  - A Devices page lists the sessions and can revoke any of them.
  - Login attempts are rate-limited.
- **Capture tokens.** Random, stored hashed, revocable and limited to adding captures. They are for the CLI and the iPhone Shortcut.
- **Request checks.**
  - The server answers only to known host names, which protects against DNS rebinding.
  - It rejects state-changing requests from other origins, which protects against CSRF.
  - Until login exists, it listens only on localhost.
- **Files.**
  - All file access stays inside `$NOTES_DIR`: relative paths only, no `..`, no hidden files, and symlinks can't lead outside.
  - Writes are atomic (temp file, fsync, rename), and new files get mode 600.
  - Files that aren't valid UTF-8 are refused rather than decoded lossily and overwritten.
- **Untrusted content.** Rendered markdown never executes HTML. Fetching a link's title works only for http(s) links and has a timeout and a size cap.
- **Secrets.** The password hash, session store and tokens live in a config folder outside the notes folder, so they never enter the notes' git history.
- **Backups.** Ctrl+K → Export all notes saves everything as one zip. In the Docker version the notes folder is also a git repo: push it to a private remote or copy it to another disk. The vault is ciphertext, so it is safe to store anywhere.

## 9. Papers and review (M3)

- **Files.** A paper is `papers/<key>.pdf` plus a review note `papers/<key>.md`. The review note's frontmatter holds `type: paper`, the title, authors and year, the DOI or arXiv ID, and the PDF's file name.
- **Viewer.** A PDF.js viewer sits beside the review note.
  - Select text to highlight it and add a comment.
  - The review note gets the quote, a link to its page, and the comment.
  - The exact position (page, rectangles and quoted text) is kept in `papers/<key>.highlights.json`.
  - The PDF itself is never modified.
- **Page links.** `[[smith2024.pdf#page=4]]` opens the PDF at page 4.
- **Import** from an arXiv ID or URL, or a DOI. The app fetches the metadata and the PDF.
- **Markdown documents** get the same highlight-and-comment flow. Comments live in a separate note, anchored by the quoted text.

## 10. Project boards (M4)

One page per project gathers its notes, tasks, PDFs and links into named clusters.

A board is a markdown file. Each `##` heading is a cluster and each list item is a card:

```markdown
---
type: board
tag: projectx
---
# Project X

## Reading
- [[papers/smith2024]]
- [[Related work]]

## Open tasks
- query: is:task is:open tag:projectx

## Ideas
- [[Batch sweeps by size]]
- Ask about the shared cluster quota
```

- **Cards are live views, not copies.**
  - A note card shows the note's title, its first lines and its number of open tasks.
  - A PDF card opens the paper.
  - A `query:` card shows live search results.
  - A plain-text item becomes a sticky card.
  - A note can be on several boards. Removing a card never deletes anything.
- **Board view.**
  - Clusters show as columns or sections. Dragging cards within or between clusters rewrites only the board file.
  - Cards are added through the switcher, and clusters can be collapsed.
  - On a phone, clusters stack vertically.
- **Tray.** Notes tagged with the board's tag but not yet on the board wait in a tray. For example, capture `#projectx …` on your phone and place it on the board later.
- **Later, maybe:** a freeform canvas with x/y positions, as another view of the same board.

## 11. Vault (M5)

The vault is end-to-end encrypted in the browser. The server only ever stores ciphertext.

- **Keys.**
  - The passphrase goes through Argon2id to make a key-encryption key, which wraps a random vault key.
  - A one-time recovery code wraps the same vault key a second time.
  - Both wrapped copies are kept in `vault/key.json`.
- **Notes.** Each vault note is one blob, `vault/<random-id>.bin`, encrypted with AES-256-GCM through WebCrypto. The note's title is inside the ciphertext, so file names reveal nothing. The blob ID is bound into the encryption (as associated data), so blobs can't be swapped.
- **Unlocking.**
  - You unlock in the browser, and the vault's search index is built in memory.
  - The vault locks when idle and when the tab closes.
  - Nothing decrypted is ever written to disk, the SQLite index or the offline cache.
- **Links.** Vault notes can link to normal notes, but normal notes can't link into the vault.
- **What it protects against.** Anything that can read the server's disk or process: future AI or MCP tools, backups, a compromised dependency.
- **What it doesn't protect against.** Someone who controls the server *and* changes the app's code to capture your passphrase the next time you unlock.
- **Losing the keys.** If you lose both the passphrase and the recovery code, the vault is gone. Setup says so plainly.

## 12. Milestones

| | Milestone | Done when |
|---|---|---|
| M1 | **Core**, on desktop, localhost only | - Typing in today's note autosaves to `journal/<date>.md`, and an edit made in another editor shows up within a second.<br>- Ctrl+K and search with filters work.<br>- Links, backlinks and unlinked mentions work.<br>- The Tasks view works.<br>- Every change is committed to git. |
| M2 | **Autoformat and polish** | Table editing, pasted URL → titled link, pasted spreadsheet → table, date shortcuts, the `/` menu, pinned lists and saved views all work. |
| M3 | **Papers** | The PDF viewer, highlights and comments, arXiv/DOI import, and comments on markdown documents all work. |
| M4 | **Project boards** | Board files, card types, drag and drop, and the tray all work. |
| M5 | **Vault** | The vault works as described in §11. |
| later | **Phone and home network** (replaced 2026-11-26 by the browser-only app, Dropbox sync and installing it; §15) | Login, HTTPS via Caddy, the installable app, a capture screen, the offline outbox, share to notes (Android share target, iPhone Shortcut) and the `note` CLI all work, with the app and Caddy in Docker Compose. |
| later | **AI**, only after M5 | - An MCP connector that can only add and create, with every write its own git commit.<br>- "Tidy": the AI proposes structure and you accept or reject a diff. |

M3 to M5 can be reordered. If the vault is needed sooner, move M5 up.

## 13. Stack

| Area | Choice | Why |
|---|---|---|
| Runtime | Node 26 LTS, TypeScript | One language for server, client and CLI |
| Server | Hono | Small, typed, web-standard; SSE built in |
| Index | SQLite with FTS5 (`node:sqlite`, built in) | Fast, local, no native packages to install |
| Client | React and Vite | Largest ecosystem for PDF, drag and drop and offline |
| Editor | CodeMirror 6 | Edits the text itself, so files round-trip unchanged |
| Markdown | `@lezer/markdown` with GFM | The same parser in the editor and the indexer |
| PDF | PDF.js | |
| Offline | vite-plugin-pwa (Workbox), IndexedDB | |
| Tests | Vitest; Playwright later | |
| Deploy | Docker Compose (app and Caddy) | Development runs in the same Node 26 image (`make dev`) |

## 14. Open questions

- Is the workstation that hosts the app on all the time? If not, phone captures wait in the outbox until it is back.
- iPhone or Android? This decides which share path is built first.
- Is a VPN for access away from home wanted later?

## 15. Build notes (2026-11-25)

Built: milestones 1–5, and in place of the phone milestone (§7): the browser-only app, Dropbox sync and installing it on phones. Postponed: AI.

Where the build differs from the plan above:

- **Search index.** The index lives in memory and is rebuilt from the files at startup, so there is no index file to keep in sync.
- **History timing.** A note's version is kept about 60 seconds after changes stop, and at least every 3 minutes while they continue (`HISTORY_DELAY_SECONDS`; the git backup commits on the same rhythm).
- **Version history** (`src/server/versions.ts`). Versions are plain files: `.notedid/history/<note id>/<YYYY-MM-DD HH.MM.SS> UTC.md`, the note's exact text, named after the note's last change when it had that text (a second later if that name is taken). Notes without an id (or with one that can't name a folder) keep none. Every app write to a note goes through `beforeChange` and then `touch`:
  - `beforeChange` keeps the text about to be replaced when it has been left alone for the delay (or the newest version is older than 3 minutes) and isn't the newest version. That keeps the text from before an edit, even when the app stopped before keeping it (a browser stops an idle service worker). A restore always keeps it.
  - `touch` adds the note to the pending set; one timer keeps the pending notes' versions after the delay, or at the latest 3 minutes after the first change. Skipped when the text is the newest version already.
  - Not versioned: giving notes ids (the first version comes with the next change) and imports (they bring their own versions). External edits are versioned after they settle.
  - Thinning, after each kept version: all of the last 24 hours, then the last version per UTC hour for 7 days, then the last per UTC day.
  - The service worker extends itself (`waitUntil`) after each change until the versions are kept.
  - `GET /api/history?path=` → `{ id, versions: [{ version, date }] }`, newest first. `GET /api/history/version?path=&version=` and `POST /api/note/restore { path, version }` find the file by the note's current id; a restored version keeps the note's own id.
- **Git backup** (`src/server/git.ts`, server only). The notes folder is also its own git repository, committed on the same rhythm, so files, data, the vault and settings have a past too. `.notedid/history/` is in the repository's own `info/exclude`. The app doesn't show it; it's for `git log`.
- **Conflicts.** A saving conflict offers "use the saved version" or "keep my version". The 3-way merge isn't built.
- **Live preview.** Markup is hidden for headings, emphasis, links, lists, quotes, rules and images. Tables show as editable tables (a block widget per table: each cell edit is written back to the markdown at once, lined up; with the cursor in a table's text, the text shows).
- **Board moves.** Drag and drop on boards uses the mouse. Each card also has a "Move to…" menu.
- **Vault links.** Following a link from a vault note never creates a note or runs a search, so text from the vault doesn't reach the server.

Added after the first review (2026-11-25):

- **PDF comments.** The paper page has a side pane with Comments and Review notes tabs. A comment is a highlight block in the review note: the quote, a `> — [p. N](file.pdf#page=N&hl=ID)` line and the comment below it, so the note is still the source of truth. Words broken across lines with a hyphen are joined when quoted. Comments stored inside the PDF file are listed read-only.
- **Theme.** There is an Auto, Light and Dark switch in the sidebar and in Ctrl+K. It is saved in the browser (`localStorage`), not in the notes folder.
- **Comments like a shared document.** Each comment card has Resolve, Edit and Delete. A resolved comment keeps its text in the note, its page-link line ends with `· resolved`, and it moves to a folded Resolved list.
- **Paper status and index.** A paper's reading status (to-read, reading, read) is `status:` in its front matter. The Papers page filters by status, tag and text instead of using folders. New review notes no longer repeat the title as a `# heading`.
- **Properties.** The editor folds front matter into one "Properties" line until the cursor enters it.
- **Comparing versions.** Opening a version in History marks the changes since then in the note's editor, as tracked changes: added text highlighted, removed text drawn struck through as widgets (not in the document), recomputed 300 ms after typing pauses. The diff is word-level Myers, falling back to whole lines for very different texts.
- **Resizable paper panes.** The divider between the PDF and the side pane can be dragged; the width is saved in the browser.
- **Dashboards.** `dashboards/*.md` with `type: dashboard`: each `## heading` is a tab, each `- [[link]]` an item, so the board parser and card moves are reused. Items open in place: notes as editors, papers as the paper view (PDF, comments, review notes), boards as boards. Only the open tab's items are mounted. The open tab and folded items are remembered in the browser. An item's width is `{full}` or `{half}` after its link (written only when it differs from the default: notes half, papers and boards full). Items reorder by dragging a handle (drop on an item or a tab) or from the item menu.
- **Paper library.** The Papers page is a three-pane library (collections, sortable table, details) instead of folders. Collections are made by you and kept in `papers/collections.md` (board format: each ## heading a collection, each [[link]] a paper; a paper can be in several); reading status and tags are filters below them, and Unfiled means in no collection. Details edit the review note's front matter (lists written as YAML lists); a new title renames the note. New papers record `added:`. BibTeX is generated from the front matter (@misc for arXiv, @inproceedings or @article by venue). Renaming any note now moves its `.highlights.json` and `.comments.md` with it.
- **Folding quotes.** In the editor a quote block can fold to a one-line summary (view only, remembered per note in the browser, never for the vault).
- **Paper side pane.** It can be hidden (a strip keeps the comment count and reopens it); the review note stays mounted, so highlights still save. Below 760 px the pane folds into the strip by itself.
- **Cards.** A heading with `key:: value` lines directly under it is a card (`src/shared/cards.ts`: headings outside code and front matter, levels 2–6; deeper headings are part of the card's text; cards one after another at one level form a set, identified by the section it's in). The editor draws each card as a block widget and puts a bar above each set (counts, a status colour bar, filter chips per property whose values are short words, search, + Card). The card with the cursor shows as its markdown, framed. Filtered-out cards are replaced without a widget: the arrow keys pass over them through a transaction filter, not atomic ranges, so a deletion next to one never removes it. ↑ ↓ enter a card from the lines around it, because CodeMirror would otherwise jump over a block widget. Pills change one value on its line; + Card copies the last card's keys and fills in any filtered values. + Attach (and dropping files on a card) adds `[[note]]` links or uploaded files (`files/`, as relative links) to an `attached::` line, made after the last property when missing; a note's link is its title when that resolves to it, otherwise its path labelled with the title. The × on a link chip removes that value, and the line when it empties (unless it is the card's only property). Filters are view state in `localStorage` (`notesapp-card-filters:<path>`), never for vault notes. While comparing versions, cards show as text so the change marks stay visible. Cards and the bar are drawn by `cardView.ts`, which the reading view uses too: there they are read-only, and the filters work without being saved.
- **Note ids.** Front matter `id:` (`src/shared/noteIds.ts`). The server writes it into notes it makes (new notes, boards, dashboards, papers, a day's first capture), and the browser into notes it makes: a new journal day's or new note's first save (added to the open editor too, outside the undo history), the reading view's comments note, the papers' collections. A save never adds or changes an id, so the file is always exactly what the editor sent. `GET /api/ids` counts notes without an id and copies that share one; `POST /api/ids` gives the first a new id each and the copies new ones (the oldest file keeps the shared id), changing only that line: no versions are kept for it, and the git backup commits it as one step. The index keeps each note's id (`NoteSummary.id`). The editor hides front matter that holds nothing but the id. A note's history follows its id, on every device.
- **The browser-only app.** `npm run build:browser` (`make browser` serves it on :4323) builds the web client with `__BROWSER_APP__` set, plus `/sw.js`: one classic script (so every browser with service workers can run it) holding the backend. Its `import.meta.url` is the worker's address, so SQLite finds its `.wasm`. The worker answers `/api/*` with the backend (started on the first request, the index rebuilt from IndexedDB) and serves the app's files from a cache filled at install, so the app opens offline. A new build is a new worker and cache. Not there: the git backup. arXiv details come from DataCite (arXiv's API doesn't allow browser requests; the server falls back to it too when arXiv is down); page titles for pasted links aren't fetched. The app asks the browser to keep its storage (`navigator.storage.persist()`).
- **Sync with Dropbox** (`src/server/sync.ts`, `dropbox.ts`; the page side in `src/web/sync.ts`). The backend syncs the notes folder with a Dropbox app folder (scoped app, "App folder" access, so it sees nothing else). Signing in is OAuth with PKCE and no redirect (`src/shared/dropboxAuth.ts`): Dropbox shows a code that is pasted into the app, which works the same on laptops, phones and installed apps. `POST /api/sync/connect { appKey, code, verifier }` trades it for a refresh token, kept in `.notedid/sync/account.json`. That file and the state are hidden, never synced or exported, and left out of the git backup.
  - What syncs: what an export holds (every visible file, the trash, the vault's ciphertext, settings, versions), filtered like an import.
  - Each run compares every file three ways: here (size and date, hashed only when they changed, with Dropbox's content hash), on Dropbox (`list_folder` the first time, then `list_folder/continue` from the saved cursor), and as both were when last in sync (`.notedid/sync/state.json`: path, revision, hash, size, date). A change on one side is copied over (uploads name the revision they replace, so a file changed on Dropbox meanwhile is never overwritten), a deletion too, unless the other side changed the file: then the change wins.
  - A note changed on both sides is merged against the last synced text (Dropbox keeps it as a revision): line-based diff3 (`src/shared/merge3.ts`), where lines added at the same place on both sides are all kept. If both changed the same lines, or there is no common text (two devices' first sync), the newer text stays and the other is kept as a version in the note's history (a copy beside it for a note without an id), and the note is listed on the Sync screen. Other files: the newer one stays; Dropbox keeps the one it replaced in its own history.
  - Version files go first, so notes merged later find their history. Notes synced in are indexed and announced, without versions of their own (they come with the device that wrote them).
  - Every step is safe to repeat. The state is saved every 25 files, and the cursor only when a run gets through everything. A run stops after about 45 s (a service worker can't take long) and the page runs it again.
  - Deleting more than 10 files on Dropbox, and more than a quarter of what was synced, waits for a yes (`POST /api/sync { deletes: 'allow' | 'restore' }`).
  - Files are matched by path, not id. A note renamed on one device while edited on another ends up twice (the edit at the old name, with the same id); Give every note an ID gives the copy a new id.
  - The page syncs at start, 8 s after a change it didn't make, every minute while visible and online, and on coming back to the app or the network.
- **Hosting and installing.** The browser-only build is static files; `BASE_PATH` (default `/`) sets the folder it is served from. App paths are written without it, and the router (`appUrl`, `currentHref`), the API calls and the worker's registration add it; the worker's scope is the folder, and it hands `/api/…` to the backend with the folder taken off. `404.html` is a copy of `index.html`, so hosts without a fallback (GitHub Pages) still open a note's address. The manifest (`public/manifest.webmanifest`, relative URLs) and the icons (`scripts/make-icons.mjs` draws them as PNG) make it installable: Chrome finds no installability errors. `.github/workflows/pages.yml` tests and publishes it on GitHub Pages. Opened over plain http on a host that isn't this computer, the app moves to https (service workers need it).
- **On the network** (`make lan`). Caddy (`lan/Caddyfile`) serves a build of its own (`BROWSER_OUT=dist/lan`) over HTTPS on port 4443, and on 4480, over plain http, only a page of instructions and the certificate authority's certificate. `scripts/lan-certs.sh` makes the authority once (EC P-256, ten years, name-constrained to the private IPv4 ranges, localhost, `.local` and this computer's name) and this computer's certificate each run (800 days, within iOS's 825-day limit for authorities people add; the address the default route uses, and the host name only if it leads to that address). Phones connecting by address send no server name, so Caddy's `default_sni` is the address. Checked with curl and OpenSSL trusting only that authority, and in Chrome trusting the certificate: worker, installable, note addresses, offline.
- **Browsers.** End-to-end runs in Chrome (CDP) and in Firefox 153 and ESR 140 (WebDriver BiDi through puppeteer-core): the browser-only app (notes, search, cards, PDF viewer, history, sync, export, offline) and the server version (saving, live changes, history, sync screen). The PDF viewer uses pdf.js's legacy build, with fallbacks for browsers a little behind the newest (the regular build needs `Map.prototype.getOrInsertComputed`, which ESR 140 lacks).
- **Example notes** (`src/server/examples.ts`). `POST /api/examples?today=` adds the files that aren't there (notes get ids; nothing is overwritten): a start page, one note per feature, a board (every kind of card, a live search for the project's tagged tasks, and a tagged note left in its tray), a dashboard, a paper with a generated one-page PDF, a comments note for the reading view, and an SVG picture. Task dates are relative to the day they're added. `DELETE /api/examples` moves them to the trash. Tests check that every link resolves inside the examples (but for the one showing a missing note) and that each part parses as what it shows.
- **Export and import.** `GET /api/export` is the notes folder as a zip: every visible file, the trash, the vault's ciphertext, `.notedid/settings.json` and the versions in `.notedid/history/`, but not `.git`. `POST /api/import` takes a zip (`application/zip`, up to 1 GB). It adds the files that are the app's: notes, data files, PDFs and pictures, vault files, settings and versions. It drops a single top folder the zip was made from (`dev-notes/`), and never overwrites: identical files count as already there, and different ones are listed and left alone. Then it rescans. A folder import is zipped in the browser first, without hidden folders. The browser saves an export by fetching it and saving the result, because a download link would bypass the browser-only app's service worker.
- **The name.** The app is called notedid (it was "notesapp" while it was being built). Its folder in the notes folder is `.notedid/`; settings found in the old `.notesapp/` are moved there at startup, and an old export's settings import to the new place. Names nobody sees stay as they were, because existing data depends on them: browser storage keys, the browser app's database, the vault's encryption label.
- **Ticked tasks.** A ticked task's text is struck through and greyed: in the editor a mark over the GFM `Task` node after its checkbox, in cards and the reading view by CSS on the list item.
- **Widget spacing.** Block widgets (cards, tables, folded quotes) get their spacing from padding on their outer element. CodeMirror measures a widget's height without its margins, so margins made clicks and arrow keys land on the wrong line below a few widgets.
- **Adding to boards.** Note and paper pages have an "Add to a project board" button. On a board, **+ Add card** accepts a title, a journal date, an arXiv link or DOI, or a URL, and offers **Create note** for anything else. A board tag typed as `[[x]]` or `#x` is stored as `x`.

Known gaps:

- **Fonts in PDFs.** PDFs whose fonts aren't embedded (some older or East Asian PDFs) may show substitute fonts.
- **Vault and HTTPS.** The vault needs a secure page: localhost now, HTTPS once the phone milestone adds hosting on the network.
- **Testing.** Browser-level checks were run by hand with a headless browser and are not part of `make check`.

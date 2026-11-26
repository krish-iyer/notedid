# notesapp

A personal notes app: plain markdown files, quick capture, fast search, papers with PDF highlights, project boards, and an encrypted vault. Self-hosted; your notes are ordinary files in a folder you choose.

[docs/SPEC.md](docs/SPEC.md) has the design and the milestones. Milestones 1–5 are built; the phone milestone and AI features are postponed.

## Run it

Everything runs in Docker (Node 26) as your own user, so Docker and `make` are all you need.

```sh
make start    # start the app in the background → http://localhost:4322
make logs     # follow its output
make down     # stop it
make dev      # or run it in the foreground (Ctrl-C stops it)
make check    # type-check, run the tests and build
make shell    # a shell in the container, e.g. for `npm install <package>`
```

Notes go to `dev-notes/` in this folder (gitignored). To use a real notes folder, keep it outside this repository:

```sh
make start NOTES_HOST_DIR=$HOME/notes
```

The app is published on this machine's localhost only, because there is no login yet. Login comes with the phone milestone, which is postponed. The first `make` writes a gitignored `.env` with your uid, gid and time zone.

### Without a server: the browser-only app

The same app can also run entirely in a browser, with no server: a service worker answers the app's requests, the notes live in the browser's storage (IndexedDB), and search runs on SQLite compiled to WebAssembly. It works offline, and it is plain static files, so it can be hosted anywhere (GitHub Pages, say).

```sh
make browser  # build it and serve it → http://localhost:4323
```

Notes there are kept in that browser only, separately from the Docker version's folder. To bring notes in, use Ctrl+K → **Import notes from a folder…** (your notes folder) or **Import notes from a .zip…**. Ctrl+K → **Export all notes (.zip)** saves everything: notes, PDFs, the vault (still encrypted) and settings, as a backup or to move them. Import never replaces a note you already have. Both work in the Docker version too.

Syncing between devices (through Dropbox) is the next step. Until then, a few things differ:

- There is no version history yet (git needs a server). It comes back with the sync work.
- Adding an arXiv paper gets its details from DataCite, because arXiv's own service doesn't answer browser requests. The PDF still comes from arXiv.
- A pasted link stays a plain URL: most websites don't let a browser app read their page titles.

## What it does

**Capture.** Today's journal note is the home screen. Press **Ctrl+K** anywhere to find any note. In that box, **Shift+Enter** creates a note from what you typed, and **Alt+Enter** adds it to today. In the editor:

- `[]` followed by a space makes a task.
- `due:fri` (or `tomorrow`, `+3d`) becomes a date.
- **Ctrl+Enter** ticks the task on the current line. Ticked tasks show struck through and greyed.
- `/` opens commands: table, cards, code block, headings, due dates, image upload.

**Writing.** You edit the markdown text itself, and the markup hides on lines you're not editing.

- Pasting a URL turns it into `[Page title](url)`.
- **Tables show as tables** in the editor. Click a cell to type in it; Tab / Shift+Tab and Enter move between cells (and add a row at the end); ↑ ↓ move between rows and leave the table at its edges. The ⋯ button on a cell (or a right-click) inserts, moves and deletes rows and columns, aligns a column and sorts by it; + Row and + Column add at the end. `/table` makes one, and pasting cells from a spreadsheet or a web page makes one too. Underneath it is a plain markdown table, kept lined up; **Edit as markdown** shows the text.
- **Cards.** A heading with `key:: value` lines right under it shows as a card: the title, the values as coloured pills, links as chips, and the text below formatted (quotes folded, tasks tickable). It's still plain markdown:

  ```markdown
  ### A1 · Missing baseline
  reviewer:: A
  status:: needs answer
  theme:: Evaluation, Clarity
  paper:: [§5.2](paper.pdf#page=7)

  **They said.** … **My take.** …
  ```

  Click a pill to pick another value (the line in the file changes). Click anywhere else on a card to edit its markdown; Esc shows the card again, and ↑ ↓ move into a card from the text around it. Cards one after another get a bar on top: how many there are, a colour bar of their status, each property's values with counts (click one to show only those cards; values of different properties narrow it further), a search box and **+ Card**, which adds a card with the same properties. **+ Attach** on a card links a note or paper (type to find it) or uploads a PDF or image, and dropping files on a card does the same: they go in its `attached::` line and show as chips, and the × on a chip takes it off. `/cards` starts one. Commas separate values, and a `[§3](paper.pdf#page=3)` chip opens the PDF at that page. Colours: done or resolved is green, in progress blue, needs answer or todo amber, disagree or blocked red, and any other value gets a colour of its own. Filters only change what you see; they're remembered per note in this browser (not for vault notes). The reading view (the eye icon) shows cards too, read-only, with the same bar.
- Pasting or dropping images adds them to `files/`.
- A quote (`> ` lines) can fold to one line showing that a quote is there, its first words and its length: hover it and click ▴, and click the folded line to open it. `/fold quotes` and `/unfold quotes` do the whole note, handy in a paper's review notes. Folds are remembered per note in this browser (not for vault notes). The file doesn't change.
- A note's YAML front matter (the `---` block at the top) folds into one **▸ Properties** line. Click it to edit the YAML.
- Every note has a permanent ID: an `id:` line (12 random letters and digits) at the top of its front matter. It stays the same when you rename or move the note, so syncing between devices can follow it. New notes get one when they're made. For notes made before, Ctrl+K → **Give every note an ID** adds them, and asks first. Front matter that holds only the ID isn't shown in the editor.
- Files keep their exact bytes. Line endings are preserved, and the app never reformats text you didn't touch.

**Finding things.**

- `[[` links a note, with autocomplete. Clicking a link to a missing note creates it.
- `#tags` and dates like `2026-11-25` are clickable.
- Next to every note are the notes that link to it, mentions of it without a link (with a **Link it** button), its outline and its history.
- **Search** understands `tag:x`, `is:open`, `due:week`, `due:overdue`, `in:papers`, `after:2026-10-01`, `"exact phrase"` and `-word`. Any search can be saved as a view in the sidebar.

**Tasks.** Every `- [ ]` line in every note appears on the **Tasks** page, grouped as overdue, today, upcoming and no date. Ticking a task there ticks it in its note and adds `done:<date>`. Today's page lists what's due.

**Papers.**

- Import a paper by pasting an arXiv link or ID (details and PDF) or a DOI (details; attach the PDF later), or drop in PDF files.
- The PDF opens with a side pane that has three tabs: **Comments**, **Review notes** and **History**. Drag the line between the PDF and the pane to resize them (double-click it to reset). The ⇥ button at the end of the tabs hides the pane so the PDF gets the whole width; a slim strip on the right (with the number of comments) brings it back, and so does clicking a comment marker in the PDF. Highlights and comments still save while it is hidden. A narrow paper (half a dashboard, a small window) folds the pane into the strip by itself.
- Select text in the PDF, then choose **Comment** (type it and press Ctrl+Enter) or **Highlight** (no comment yet). The quote, a page link and your comment go into the review note, so search finds them.
- The **Comments** tab lists every highlight in page order. Each card has **✓ Resolve**, **✎ Edit** and **🗑 Delete**. Resolved comments move to a folded **Resolved** list, where you can reopen them, and their highlight fades in the PDF. In the note, a resolved comment's page link ends with `· resolved`. Delete removes the quote and comment from the note too. Clicking a card scrolls the PDF to the passage, and clicking a comment marker in the PDF selects its card.
- Comments already stored inside the PDF file (made in Acrobat, Zotero, Preview and so on) are listed below yours. They are read-only, and clicking one shows where it is.
- The **Review notes** tab is the whole note, for a summary and anything else. A page link in it scrolls the PDF to that spot.
- Each paper has a reading status, **To read / Reading / Read**, under its title. It is saved as `status:` in the review note.
- The **Papers** page is your library, laid out like Zotero:
  - **On the left:** My library (All papers, Unfiled = in no collection, No PDF yet), then **Collections**: ones you make with **+** (rename or delete the selected one with its ✎ and 🗑; deleting keeps the papers). Below them, filters by reading status and by tag.
  - **Putting papers in collections:** drag rows onto a collection (Shift-drag moves them from the collection you are in), or use **Add to collection…** in the details; × or the Delete key takes a paper out (with Undo). A paper can be in several collections. Ctrl/⌘-click and Shift-click pick several papers, to add, remove, set status or copy BibTeX for all of them. A PDF added or imported while you look at a collection goes into it.
  - Collections are kept in `papers/collections.md`: each `## heading` is a collection and each `- [[Paper]]` a paper in it.
  - **A table** in the middle: Title, Authors, Year, Venue, Added, Status and Highlights. Click a column to sort. Search matches title, authors, venue, year, DOI or #tag. ↑ ↓ move, Enter or double-click opens.
  - **Details** on the right: status, tags (add or remove), DOI, arXiv and web links, the abstract, **Edit details** (title, authors, year, venue, DOI, arXiv, URL), **Copy BibTeX** and the board/dashboard button.
  - **Export .bib** saves the papers in the current view as a BibTeX file.
  - Everything is written to the paper's review note (`status:`, `tags:`, `authors:`…), so it is plain text with history. Changing the title renames the note and takes its highlights and comments along.
- Any note can also be opened in a reading view (the eye icon). Select a passage to comment on it; comments are kept in `<note>.comments.md`.

**Project boards.** A board gathers one project on one page.

- It's a markdown file: each `## heading` is a cluster, and each list item is a card.
- A card can be a note, a `query: is:open tag:x` that shows live results, a link, or plain text.
- Drag cards between clusters, or use each card's **Move to…** menu.
- To put a note or paper on a board:
  - On the note or paper, click the board icon at the top right and pick the board and cluster.
  - On the board, click **+ Add card** in a cluster and type a note or paper title, a journal date, an arXiv link or DOI (it imports the paper), or a URL. Anything else gives you a choice: **Create note** or **Add as text**.
  - Or tag the note with the board's tag. Tagged notes wait in a tray until you place them.
- **+ New project board** is at the bottom of the sidebar.

**Dashboards.** A dashboard keeps the notes, PDFs and boards you work on together in named tabs, each opened right there.

- **Dashboards** in the sidebar → **New dashboard**. Ctrl+K understands `New dashboard` too.
- **+ New tab** adds a named tab. Double-click a tab, or use its menu, to rename it, move it left or right, or delete it. Deleting a tab removes only the links; the notes stay.
- In a tab, **Add Note**, **Add PDF** and **Add Board** each open a search. Pick an existing one or make a new one: a new note, an uploaded PDF, a paper imported from an arXiv link or DOI, or a new board.
- Notes open as editors, papers with their PDF, comments and review notes, and boards with their clusters. Each item's title opens it on its own page and ▾ folds it.
- **Width:** ↔ switches an item between half and full width. Notes start half width (two side by side), papers and boards full width. Two papers at half width sit side by side for comparing. The choice is saved in the file as `{full}` or `{half}` after the link.
- **Order:** drag an item by its ⋮⋮ handle and drop it before or after another, or onto another tab's name to move it there. The item's menu also has **Move up**, **Move down**, **Move to** another tab and **Remove** (with Undo). Items flow like text: left to right, then down.
- The board icon on a note or paper page can also add it to a dashboard tab.
- It's a markdown file in `dashboards/`: each `## heading` is a tab and each `- [[link]]` an item. The **Text** view shows it.

**Vault.**

- Notes in the vault are encrypted in the browser (Argon2id and AES-256-GCM) before they're saved.
- The server, the notes folder, its history and any AI tool only ever see ciphertext.
- It locks itself when idle.
- Keep the recovery code safe: without it or the passphrase, nobody can open the vault.

**Theme.** The **Auto / Light / Dark** switch is at the bottom of the sidebar, and Ctrl+K understands `theme dark` too. Auto follows the system setting. The choice is kept per browser.

**History.** The notes folder is its own git repository. Changes are committed about a minute after you stop typing (`HISTORY_DELAY_SECONDS` changes this), and at least every 3 minutes while you keep going. Open a version in a note's History tab and the note itself shows what changed since then, like tracked changes: added text is highlighted green (new lines get a green bar) and removed text is shown struck through in red where it was. The removed text is only shown, not put back in the file. You can keep editing while comparing; press **Done** at the top of the note to stop. On a paper, History switches to the review note to show the changes. You can also view that version as it was, or restore it. Deleted notes go to `trash/`.

## The notes folder

```
journal/2026-11-25.md         one note per day
notes/<title>.md              everything else
papers/<key>.pdf, <key>.md    a paper and its review note (+ <key>.highlights.json)
boards/<name>.md              project boards
files/2026/…                  pasted images and files
trash/                        deleted notes
vault/                        encrypted vault notes and key file
.notesapp/settings.json       pinned notes, saved views, vault lock time
.git/                         the history
```

Edit these files with any editor; the app notices changes within a second.

## Without Docker

With Node 26 installed (see `.nvmrc`):

```sh
npm install
npm run dev                                   # http://localhost:4322
npm run build && NOTES_DIR=~/notes npm start  # built app on http://127.0.0.1:4321
```

The ports can be changed with `WEB_PORT` (web client, default 4322) and `PORT` (API, default 4321).

## Code layout

| Path | What |
|---|---|
| `src/shared` | Markdown parsing (links, tags, tasks), search queries, boards, tables, dates; used by both sides |
| `src/server` | HTTP API (Hono), file storage, search index (SQLite FTS5), git history, papers, vault storage. All of it but the Node parts (`nodeDisk.ts`, `nodeSqlite.ts`, git, the file watcher, `main.ts`) also runs in the browser-only app |
| `src/browser` | The browser-only app's backend: the service worker, notes in IndexedDB (`idbDisk.ts`), SQLite in WebAssembly |
| `src/web` | React client: CodeMirror editor, screens, PDF viewer (PDF.js), vault crypto |
| `docs/SPEC.md` | Design, milestones and build notes |
| `Dockerfile`, `compose.yaml`, `Makefile` | The Docker development setup |

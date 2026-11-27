import { appendComment, newCommentsNote } from '../shared/comments.ts';
import { addDays, type ISODate } from '../shared/dates.ts';
import { EXAMPLES_START } from '../shared/examples.ts';
import { newNoteId, withNoteId } from '../shared/noteIds.ts';
import { isWhiteboardPath } from '../shared/whiteboards.ts';
import { NoteService } from './notes.ts';
import { extname } from './posixPath.ts';
import type { NoteStore } from './storage.ts';

/**
 * Example notes: one for each thing the app does, with real content to try it on (tasks due around
 * today, a table, cards, a board, a dashboard, a paper with its PDF, comments). Ctrl+K adds them
 * (never over a file that is there already) and takes them away again (to the trash). They are
 * ordinary notes, tagged #example.
 */

export const EXAMPLE_TAG = 'example';
export { EXAMPLES_START };

export interface ExampleFile {
  path: string;
  content: string | Uint8Array;
}

const READING = 'notes/examples/reading-view-and-comments.md';

/** A one-page PDF with these lines of text, to try the PDF viewer on. */
export function examplePdf(lines: readonly { text: string; size: number; gap?: number }[]): Uint8Array {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  let y = 720;
  const body = lines
    .map(({ text, size, gap = 0 }) => {
      y -= gap + size * 1.5;
      return `BT /F1 ${size} Tf 72 ${y} Td (${escape(text)}) Tj ET`;
    })
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0) & 0xff);
}

const DIAGRAM = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120" viewBox="0 0 480 120" font-family="system-ui, sans-serif" font-size="14">
  <rect width="480" height="120" rx="10" fill="#eef3fb"/>
  <g fill="#ffffff" stroke="#2f6fd0" stroke-width="2">
    <rect x="20" y="35" width="120" height="50" rx="8"/>
    <rect x="180" y="35" width="120" height="50" rx="8"/>
    <rect x="340" y="35" width="120" height="50" rx="8"/>
  </g>
  <g fill="#1d2a3a" text-anchor="middle">
    <text x="80" y="65">A note</text>
    <text x="240" y="65">[[a link]]</text>
    <text x="400" y="65">Another note</text>
  </g>
  <g stroke="#2f6fd0" stroke-width="2" fill="none">
    <path d="M140 60h34m-8-6 8 6-8 6"/>
    <path d="M300 60h34m-8-6 8 6-8 6"/>
  </g>
  <text x="240" y="108" fill="#5b6675" text-anchor="middle" font-size="12">The note it links to lists it under backlinks.</text>
</svg>
`;

/** The example files, with dates around `today`. */
/** An example whiteboard, as Excalidraw saves one: two frames, a small diagram, and links to notes. */
export const EXAMPLE_WHITEBOARD = 'whiteboards/Example whiteboard.excalidraw';

function exampleWhiteboard(): string {
  let n = 0;
  const element = (type: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) => {
    n++;
    return {
      id: `example-${n}`,
      type,
      x,
      y,
      width,
      height,
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: type === 'rectangle' ? { type: 3 } : null,
      seed: 1000 + n,
      version: 1,
      versionNonce: 2000 + n,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      index: `a${n.toString(36)}`,
      ...extra,
    };
  };
  const text = (x: number, y: number, value: string, frameId: string, size = 20) => {
    const lines = value.split('\n');
    return element('text', x, y, Math.max(...lines.map((l) => l.length)) * size * 0.55, lines.length * size * 1.25, {
      frameId,
      text: value,
      originalText: value,
      fontSize: size,
      fontFamily: 5,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    });
  };
  const arrow = (x: number, y: number, dx: number, frameId: string) =>
    element('arrow', x, y, dx, 0, { frameId, points: [[0, 0], [dx, 0]], startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false });
  const architecture = element('frame', 0, 0, 780, 300, { name: 'Architecture' });
  const ideas = element('frame', 0, 360, 780, 260, { name: 'Ideas' });
  const box = (x: number, label: string) => [element('rectangle', x, 110, 190, 80, { frameId: architecture.id, backgroundColor: '#e7f5ff' }), text(x + 22, 136, label, architecture.id)];
  const elements = [
    architecture,
    text(30, 30, 'How notedid keeps your notes', architecture.id, 28),
    ...box(30, 'The editor'),
    arrow(225, 150, 70, architecture.id),
    ...box(300, 'The index'),
    arrow(495, 150, 70, architecture.id),
    ...box(570, 'Your folder'),
    text(30, 225, 'Notes are markdown files in a folder you choose; the index finds them.', architecture.id, 16),
    ideas,
    element('rectangle', 30, 400, 330, 180, { frameId: ideas.id, backgroundColor: '#fff3bf', link: '[[Example · Writing and linking]]' }),
    text(50, 420, 'A shape can link to a note:\nselect this one, and open\nits link (the link icon).', ideas.id),
    text(400, 410, 'Text on a whiteboard is\nsearchable, and a link like\n[[Example · Tasks and dates]]\ncounts as one. #example', ideas.id),
  ];
  return `${JSON.stringify({ type: 'excalidraw', version: 2, source: 'notedid', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: 20 }, files: {} }, null, 2)}\n`;
}

export function exampleFiles(today: ISODate): ExampleFile[] {
  const day = (n: number) => addDays(today, n);
  const note = (path: string, content: string): ExampleFile => ({ path, content });
  return [
    note(
      EXAMPLES_START,
      `# Examples: start here

#example

These notes show what notedid does, one thing each. They're ordinary notes: change them, try things, break them. When you're done, **Ctrl+K → Remove example notes** moves them all to the trash.

1. [[Example · Writing and linking]]: markdown, links, backlinks, tags, quotes, pictures, properties
2. [[Example · Tasks and dates]]: tasks, due dates and the Tasks page
3. [[Example · Tables]]: tables you edit like a spreadsheet
4. [[Example · Cards]]: notes as cards with properties, and filters
5. [[Example · Search and views]]: search filters, saved views and Ctrl+K
6. [[Example · Papers and PDFs]] and [[An example paper]]: reading, highlighting and commenting on PDFs
7. [[Example project]]: a project board
8. [[Example dashboard]]: a paper, notes and a board side by side, in tabs
9. [[Example · Reading view and comments]]: commenting on a note
10. [[Example · History, sync and safety]]: versions, Dropbox sync, backups and the vault
11. [[Example whiteboard]]: drawings and diagrams, made with Excalidraw. A link can open one of its frames: [[Example whiteboard#Architecture]]

**Today**, at the top of the sidebar, is your journal: one note per day, and the page the app opens on. Type anything there. From anywhere, **Ctrl+K** then **Alt+Enter** adds what you typed to it.
`,
    ),
    note(
      'notes/examples/writing-and-linking.md',
      `---
status: draft
audience: future me
---
# Example · Writing and linking

#example

You type markdown, and the markup hides on lines you're not editing: **bold**, *italic*, \`code\`, ~~struck out~~ and [a link to a website](https://commonmark.org/help/). Pasting a web address turns it into a link with the page's title.

## Links between notes

- [[Example · Tables]] links a note by its title: click it to open it. Type \`[[\` to pick a note as you type.
- [[Example · Cards#How cards work|This link]] goes to a heading in another note, and shows your own words.
- [[Example · A note that doesn't exist yet]] doesn't exist yet: clicking it makes it.
- This sentence mentions Example · Search and views without linking it. Open that note: its side panel lists this note as a mention, with a **Link it** button.

The side panel, on the right of a note, shows the notes that link to it (backlinks), its outline and its history. Try it on [[Example · Tables]]: this note is listed there.

## Tags and dates

#idea and #reading are tags: click one to see every note that has it. Dates such as ${today} are clickable too, and open that day's journal.

## Quotes, code and pictures

> A quote can fold to one line: hover it and click ▴, and click the folded line to open it.
> In a long note, /fold quotes folds them all.

\`\`\`js
// A code block keeps its text exactly as typed.
const answer = 42;
\`\`\`

![A small diagram](../../files/examples/diagram.svg)

Paste or drop a picture into a note: it's kept in the files folder and shown like this one.

## Properties

The \`---\` block at the top of this note holds its properties, and folds into one **▸ Properties** line above the title. Click it to edit them. Every note also has an \`id:\` there, its permanent name, which stays the same when you rename it.

## Commands

Type \`/\` at the start of a line for commands: a table, cards, a code block, headings, a due date or a picture.
`,
    ),
    note(
      'notes/examples/tasks-and-dates.md',
      `# Example · Tasks and dates

#example #example-project

Every line starting with \`- [ ]\` is a task, in any note. They all show on the **Tasks** page (sidebar), grouped as overdue, today, upcoming and no date, and today's are listed at the top of Today.

- [ ] Send the response to the reviewers due:${day(-2)} #example-project
- [ ] Book the lab for the experiment due:${today} #example-project
- [ ] Read the related work section due:${day(1)}
- [ ] Prepare the group meeting slides due:${day(5)} #example-project
- [ ] Order more coffee
- [x] Install notedid done:${day(-1)}

Try it:

- At the start of a line, type \`[]\` and a space: the line becomes a task.
- After a task, type \`due:fri\`, \`due:tomorrow\` or \`due:+3d\`: it becomes a date.
- Press **Ctrl+Enter** on a task to tick it. It gets \`done:\` and today's date, and shows struck through.
- Tick a task on the Tasks page and it's ticked here too.

Three of the tasks are tagged #example-project: [[Example project]] lists them with a live search, and this note waits in that board's tray until you put it on the board.
`,
    ),
    note(
      'notes/examples/tables.md',
      `# Example · Tables

#example

Tables show as tables. Click a cell to type in it. **Tab** and **Shift+Tab** move between cells, and **Enter** goes down a row (at the end it adds one). The **⋯** button on a cell, or a right-click, inserts, moves and deletes rows and columns, aligns a column and sorts by it. \`/table\` makes a new table, and pasting cells from a spreadsheet makes one too.

## Experiments

| Experiment | Dataset | Accuracy | Status |
| --- | --- | ---: | --- |
| Baseline | CIFAR-10 | 91.2 | done |
| + augmentation | CIFAR-10 | 93.4 | done |
| + new loss | CIFAR-10 | 94.1 | running |
| Baseline | ImageNet | 76.5 | planned |

## Groceries

| Item | How many | Got it |
| --- | ---: | --- |
| Oat milk | 2 | yes |
| Coffee beans | 1 |  |
| Apples | 6 |  |

Underneath, a table is plain markdown text, kept lined up. **Edit as markdown** shows it.
`,
    ),
    note(
      'notes/examples/cards.md',
      `# Example · Cards

#example

## How cards work

A heading with \`key:: value\` lines right under it shows as a card: its values are coloured pills, links are chips, and the text below is formatted. Click a pill to pick another value. Click anywhere else on a card to edit its markdown, and press **Esc** to see the card again.

Cards one after another get a bar: how many there are, their statuses, and each property's values. Click a value to show only those cards. **+ Card** adds one with the same properties, and **+ Attach** links a note or a paper, or adds a file. \`/cards\` starts a set of cards in any note.

## Review points

### R1 · Missing baseline
reviewer:: A
status:: needs answer
theme:: Evaluation
paper:: [[An example paper]]

**They said.** The comparison leaves out the obvious baseline.

**My take.** Fair: add it to Table 2.

- [ ] Run the baseline due:${day(3)}

### R2 · Notation in section 3
reviewer:: B
status:: in progress
theme:: Clarity

> The notation changes halfway through the section.

Use the same names throughout.

### R3 · Typo in the abstract
reviewer:: B
status:: done
theme:: Writing

Fixed.

### R4 · The conclusion claims too much
reviewer:: C
status:: disagree
theme:: Clarity, Evaluation

We only claim what Table 3 shows.
`,
    ),
    note(
      'notes/examples/search-and-views.md',
      `# Example · Search and views

#example

**Search** (in the sidebar, or **Ctrl+Shift+F**) looks through every note. It understands filters. Try these:

| Search | Finds |
| --- | --- |
| \`tag:example\` | every example note |
| \`is:open\` | open tasks |
| \`due:week\` | tasks due in the next seven days |
| \`due:overdue\` | tasks that are late |
| \`in:papers\` | papers only |
| \`after:${day(-30)}\` | notes changed since a date |
| \`"exact phrase"\` | those words, in that order |
| \`coffee -beans\` | coffee, but not beans |
| \`is:open tag:example-project due:week\` | all three at once |

**Save as view** on the search page keeps a search in the sidebar, under Views, like **Open tasks** and **Due this week**.

**Ctrl+K** opens a box that finds any note by its title. In it, **Shift+Enter** makes a new note from what you typed, and **Alt+Enter** adds it to today's journal. It has commands too: type \`theme\`, \`export\`, \`import\`, \`sync\` or \`example\`.
`,
    ),
    note(
      'notes/examples/papers-and-pdfs.md',
      `# Example · Papers and PDFs

#example

[[An example paper]] is a paper in your library: a PDF, and a review note with its details and your notes. Open it to try:

- Select a sentence in the PDF, then choose **Comment** (type it and press **Ctrl+Enter**) or **Highlight**. The quote, a link to its page and your comment go into the paper's review note, so search finds them.
- The **Comments** tab lists them in page order, with **Resolve**, **Edit** and **Delete**.
- Under the title, the reading status: **To read**, **Reading** or **Read**.

The **Papers** page (sidebar) is your library:

- On the left: collections. Make one with **+**, then drag papers onto it.
- In the middle: a table you can sort and search.
- On the right: the selected paper's details, tags, DOI, and **Copy BibTeX**. **Export .bib** saves the papers in view.

To add a paper, paste an arXiv link or ID (such as 1706.03762) or a DOI on the Papers page, or drop PDF files on it.
`,
    ),
    {
      path: 'papers/example-paper.md',
      content: `---
type: paper
title: An example paper
authors:
  - Ada Example
  - Grace Sample
year: 2026
venue: Proceedings of Examples
tags:
  - example
status: reading
pdf: example-paper.pdf
added: ${today}
---
## Abstract

A short PDF to try the viewer on: select a sentence, comment on it or highlight it, and see the comment appear in this review note.

## Summary

Write the paper's point in your own words here.

## Notes

## Highlights
`,
    },
    {
      path: 'papers/example-paper.pdf',
      content: examplePdf([
        { text: 'An example paper', size: 22 },
        { text: 'Ada Example and Grace Sample', size: 12, gap: 6 },
        { text: 'Abstract', size: 14, gap: 24 },
        { text: 'This is a short PDF to try the viewer on. Select a sentence with the mouse,', size: 11, gap: 4 },
        { text: 'then choose Comment or Highlight. Your comment goes into the review note,', size: 11 },
        { text: 'with a link back to this page.', size: 11 },
        { text: '1  Introduction', size: 14, gap: 24 },
        { text: 'Notes on papers are most useful when they say what you think, not only', size: 11, gap: 4 },
        { text: 'what the paper says. A highlight keeps the passage; a comment keeps your', size: 11 },
        { text: 'reaction to it, and both stay searchable with the rest of your notes.', size: 11 },
        { text: '2  Results', size: 14, gap: 24 },
        { text: 'The proposed method reaches 94.1% accuracy, up from a baseline of 91.2%.', size: 11, gap: 4 },
        { text: 'A reviewer would ask whether that baseline is the strongest one.', size: 11 },
      ]),
    },
    note(
      'boards/example-project.md',
      `---
type: board
tag: example-project
---
# Example project

#example. A board gathers one project on one page. Each \`##\` heading is a column of cards, and each list item a card: a note, a live search (\`query:\`), a link, or plain text. Drag cards between columns, or use a card's **Move to…** menu. **+ Add card** in a column adds a note, a paper, a link or text. Notes tagged #example-project wait in the tray until you place them.

## To do

- [[Example · Tables]]
- query: is:open tag:example-project
- Write the project plan

## Doing

- [[Example · Cards]]
- [CommonMark help](https://commonmark.org/help/)

## Done

- [[Example · Writing and linking]]
`,
    ),
    note(
      'dashboards/example-dashboard.md',
      `---
type: dashboard
---
# Example dashboard

## Reading

- [[An example paper]] {full}
- [[Example · Papers and PDFs]] {half}
- [[Example · Reading view and comments]] {half}

## Project

- [[Example project]] {full}
- [[Example · Tasks and dates]] {half}
- [[Example · Cards]] {half}

## Design

- [[Example whiteboard#Architecture]]

## How it works

- [[Examples: start here]] {half}
`,
    ),
    note(
      READING,
      `# Example · Reading view and comments

#example

The eye icon at the top right of a note opens its reading view: the note as a page, without the editor. There you can select a passage and comment on it, as on a PDF. The comments are kept in a note of their own, next to this one.

## A passage to comment on

Good notes are written for your future self: they say what you decided and why, not only what you did.

Open the reading view and select a sentence above. One comment is there already, on the first sentence.
`,
    ),
    note(
      'notes/examples/reading-view-and-comments.comments.md',
      appendComment(
        newCommentsNote('Example · Reading view and comments', READING),
        'Good notes are written for your future self: they say what you decided and why, not only what you did.',
        'An example comment. In the reading view it sits next to the passage it is about.',
      ),
    ),
    note(
      'notes/examples/history-sync-and-safety.md',
      `# Example · History, sync and safety

#example

## History

Every note keeps its earlier versions. The **History** tab in the side panel lists them. Open one to see what changed since, marked in the note itself, and restore it if you like. A version is kept a minute after you stop typing, and older ones thin out: all of today's, then one an hour for a week, then one a day.

## Sync between devices

**Sync** in the sidebar keeps your notes the same on your laptop and your phone, through a folder in your Dropbox that only this app can see. A note changed on two devices is merged, and if both changed the same lines, the newer text stays and the other goes into the note's History.

## Backups and moving

**Ctrl+K → Export all notes (.zip)** saves everything: notes, papers, files, settings and versions. **Import notes from a .zip** or **from a folder** adds notes without ever replacing yours.

## The vault

The **Vault** keeps notes encrypted with a passphrase you choose. They're encrypted on this device before they're saved, so the notes folder, sync and any AI tool only ever see scrambled text. Keep the recovery code it gives you: without it or the passphrase, nobody can open the vault.

## Looks

**Auto / Light / Dark** is at the bottom of the sidebar.
`,
    ),
    { path: 'files/examples/diagram.svg', content: DIAGRAM },
    { path: EXAMPLE_WHITEBOARD, content: exampleWhiteboard() },
  ];
}

/** Every example file's path. */
export function examplePaths(): string[] {
  return exampleFiles('2026-01-01').map((f) => f.path);
}

/** Adds the example files that aren't there yet. Notes get ids, as new notes do. */
export async function addExamples(store: NoteStore, notes: NoteService, today: ISODate): Promise<{ added: string[]; kept: string[] }> {
  const added: string[] = [];
  const kept: string[] = [];
  for (const file of exampleFiles(today)) {
    if (await store.exists(file.path)) {
      kept.push(file.path);
      continue;
    }
    // Notes get an id; a whiteboard is Excalidraw's file, which has no place for one.
    if (typeof file.content === 'string' && isWhiteboardPath(file.path)) await notes.save(file.path, file.content, null);
    else if (typeof file.content === 'string' && NoteService.indexable(file.path)) await notes.save(file.path, withNoteId(file.content, newNoteId()), null);
    else await store.createBytes(file.path, typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content);
    added.push(file.path);
  }
  return { added, kept };
}

/** Moves the example files that are still there to the trash. */
export async function removeExamples(store: NoteStore, notes: NoteService): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const path of examplePaths()) {
    if (!(await store.exists(path))) continue;
    if (NoteService.indexable(path)) await notes.remove(path);
    else {
      const stem = path.slice(0, path.length - extname(path).length);
      let target = `trash/${path}`;
      for (let n = 2; await store.exists(target); n++) target = `trash/${stem}-${n}${extname(path)}`;
      await store.move(path, target);
    }
    removed.push(path);
  }
  return { removed };
}

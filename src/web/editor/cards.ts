import { completionStatus } from '@codemirror/autocomplete';
import { EditorSelection, EditorState, type Extension, Prec, type Range, StateEffect, StateField, type TransactionSpec } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, keymap, WidgetType } from '@codemirror/view';
import {
  type Card,
  type CardFilter,
  cardFacets,
  cardMatches,
  cardValueIds,
  type Facet,
  findCards,
  headingsIn,
  isFiltering,
  NO_FILTER,
  newCardLines,
  propertyParts,
  propertyValues,
  setPropertyValue,
  statusFacet,
  type Tone,
  taskLinesIn,
  toneOf,
  valueId,
  valueKind,
} from '../../shared/cards.ts';
import type { NoteSummary } from '../../shared/api.ts';
import { localISODate } from '../../shared/dates.ts';
import { fuzzyFilter } from '../../shared/fuzzy.ts';
import { toggleTaskLine } from '../../shared/tasks.ts';
import { api } from '../api.ts';
import { notesStore, resolveNote } from '../stores.ts';
import { showToast } from '../toast.ts';
import { dirname, messageOf, relativePath } from '../util.ts';
import { comparingWith } from './compare.ts';
import { notePathFacet, privateModeFacet } from './context.ts';
import { openLink } from './links.ts';
import { blocksHtml, type HtmlOptions, inlineHtml } from './markdownHtml.ts';
import { type MenuEntry, menuElement } from './widgetMenu.ts';

/**
 * Cards in the editor. A heading with `key:: value` lines under it shows as a card: its title,
 * its values as coloured pills (click one to change it), links as chips and its text formatted.
 * Above each set of cards: counts, a colour bar for the status, filters and a search box. Click a
 * card to edit its markdown; with the cursor inside, the text shows. Filters change only what is
 * shown, never the file, and are remembered per note in this browser (not for vault notes).
 * "+ Attach" links a note or paper to a card, or uploads a PDF or image for it (also by dropping
 * files on the card): they go in its `attached::` line.
 */

interface CardBlock {
  /** Document positions: the heading's start, the end of the card's last line with text, and the end of its last line before what follows. */
  from: number;
  to: number;
  last: number;
  /** The card's markdown, from..to. */
  text: string;
  /** Line numbers are 0-based document lines. */
  card: Card;
}

interface SetBlock {
  /** Stays the same while the note is edited: the section it is in, and which set there. */
  key: string;
  level: number;
  from: number;
  cards: CardBlock[];
}

function setsIn(state: EditorState): SetBlock[] {
  const { doc } = state;
  const lines = doc.toJSON();
  const seen = new Map<string, number>();
  return findCards(lines).map((set) => {
    const parent = set.parent ?? '';
    const n = seen.get(parent) ?? 0;
    seen.set(parent, n + 1);
    const cards = set.cards.map((card) => {
      const from = doc.line(card.start + 1).from;
      const to = doc.line(card.end + 1).to;
      return { from, to, last: doc.line(card.last + 1).to, text: doc.sliceString(from, to), card };
    });
    return { key: `${parent}\n${n}`, level: set.level, from: cards[0]?.from ?? 0, cards };
  });
}

// ---------------------------------------------------------------------------
// Filters, remembered per note
// ---------------------------------------------------------------------------

const setFilter = StateEffect.define<{ key: string; filter: CardFilter }>();
const focusChanged = StateEffect.define<boolean>();

function storageKey(state: EditorState): string | null {
  const path = state.facet(notePathFacet);
  return path && !state.facet(privateModeFacet) ? `notesapp-card-filters:${path}` : null;
}

function loadFilters(state: EditorState): Map<string, CardFilter> {
  const filters = new Map<string, CardFilter>();
  const key = storageKey(state);
  if (!key) return filters;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (saved && typeof saved === 'object') {
      for (const [set, values] of Object.entries(saved as Record<string, unknown>)) {
        if (!values || typeof values !== 'object') continue;
        const clean: Record<string, string[]> = {};
        for (const [id, list] of Object.entries(values as Record<string, unknown>)) if (Array.isArray(list)) clean[id] = list.map(String);
        filters.set(set, { values: clean, search: '' });
      }
    }
  } catch {
    // Nothing remembered.
  }
  return filters;
}

function saveFilters(state: EditorState, filters: ReadonlyMap<string, CardFilter>): void {
  const key = storageKey(state);
  if (!key) return;
  const saved: Record<string, CardFilter['values']> = {};
  for (const [set, filter] of filters) {
    const values = Object.fromEntries(Object.entries(filter.values).filter(([, list]) => list.length > 0));
    if (Object.keys(values).length) saved[set] = values;
  }
  try {
    if (Object.keys(saved).length) localStorage.setItem(key, JSON.stringify(saved));
    else localStorage.removeItem(key);
  } catch {
    // Not remembered in a private window.
  }
}

// ---------------------------------------------------------------------------
// The bar above a set: counts, the status colours, filters, search, + Card
// ---------------------------------------------------------------------------

interface BarValue {
  id: string;
  value: string;
  count: number;
  tone: Tone | null;
  /** For values of other properties: the status colours of the cards that have it. */
  mix: { tone: Tone; count: number }[];
}

interface BarData {
  key: string;
  total: number;
  shown: number;
  filter: CardFilter;
  facets: { id: string; key: string; status: boolean; values: BarValue[] }[];
  /** The status of all the set's cards, value by value. */
  status: { value: string; tone: Tone; count: number }[];
}

function barData(set: SetBlock, facets: Facet[], status: Facet | null, filter: CardFilter, shown: number): BarData {
  const cards = set.cards.map((b) => b.card);
  const statusOf = (card: Card) => (status ? cardValueIds(card, status.id)[0] : undefined);
  const toneById = new Map(status?.values.map((v) => [v.id, toneOf(v.value)]) ?? []);
  return {
    key: set.key,
    total: cards.length,
    shown,
    filter,
    facets: facets.map((facet) => ({
      id: facet.id,
      key: facet.key,
      status: facet === status,
      values: facet.values.map((v) => {
        const mix = new Map<Tone, number>();
        if (status && facet !== status) {
          for (const card of cards) {
            if (!cardValueIds(card, facet.id).includes(v.id)) continue;
            const tone = toneById.get(statusOf(card) ?? '');
            if (tone) mix.set(tone, (mix.get(tone) ?? 0) + 1);
          }
        }
        return { id: v.id, value: v.value, count: v.count, tone: facet === status ? toneOf(v.value) : null, mix: [...mix].map(([tone, count]) => ({ tone, count })) };
      }),
    })),
    status: status?.values.map((v) => ({ value: v.value, tone: toneOf(v.value), count: v.count })) ?? [],
  };
}

const barHosts = new WeakMap<HTMLElement, BarHost>();

class BarHost {
  readonly dom: HTMLElement;
  readonly view: EditorView;
  readonly #count: HTMLElement;
  readonly #clear: HTMLButtonElement;
  readonly #mix: HTMLElement;
  readonly #search: HTMLInputElement;
  readonly #facets: HTMLElement;
  #data: BarData | null = null;

  constructor(view: EditorView) {
    this.view = view;
    // The widget's root has no margins (the editor can't measure them): spacing is its padding.
    this.dom = document.createElement('div');
    this.dom.className = 'cm-card-bar-outer';
    const bar = document.createElement('div');
    bar.className = 'cm-card-bar';
    this.dom.append(bar);
    const top = document.createElement('div');
    top.className = 'cm-card-bar-top';
    this.#count = document.createElement('span');
    this.#count.className = 'cm-card-count';
    this.#clear = this.#button('Show all', 'cm-card-clear', 'Clear the filters and the search');
    this.#mix = document.createElement('span');
    this.#mix.className = 'cm-card-mix';
    this.#search = document.createElement('input');
    this.#search.type = 'search';
    this.#search.className = 'cm-card-search';
    this.#search.placeholder = 'Search cards';
    this.#search.setAttribute('aria-label', 'Search these cards');
    this.#search.spellcheck = false;
    const add = this.#button('+ Card', 'cm-card-add', 'Add a card at the end of this set');
    top.append(this.#count, this.#clear, this.#mix, this.#search, add);
    this.#facets = document.createElement('div');
    this.#facets.className = 'cm-card-facets';
    bar.append(top, this.#facets);

    // Using the bar leaves the cursor where it was (the search box takes the focus, though).
    this.dom.addEventListener('mousedown', (e) => {
      if (e.target !== this.#search) e.preventDefault();
    });
    this.dom.addEventListener('click', (e) => this.#onClick(e));
    this.#search.addEventListener('input', () => this.#setFilter({ ...this.#filter, search: this.#search.value }));
    this.#search.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this.#search.value = '';
      this.#setFilter({ ...this.#filter, search: '' });
      this.view.focus();
    });
    barHosts.set(this.dom, this);
  }

  get #filter(): CardFilter {
    return this.#data?.filter ?? NO_FILTER;
  }

  #button(label: string, className: string, title: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.title = title;
    return button;
  }

  #setFilter(filter: CardFilter): void {
    if (!this.#data) return;
    this.view.dispatch({ effects: setFilter.of({ key: this.#data.key, filter }) });
  }

  #onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const data = this.#data;
    if (!data) return;
    if (target.closest('.cm-card-add')) return addCard(this.view, data.key);
    if (target.closest('.cm-card-clear')) {
      this.#search.value = '';
      return this.#setFilter(NO_FILTER);
    }
    const chip = target.closest<HTMLElement>('.cm-card-filter');
    if (!chip) return;
    const facet = chip.dataset.facet ?? '';
    const value = chip.dataset.value ?? '';
    const current = data.filter.values[facet] ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    this.#setFilter({ ...data.filter, values: { ...data.filter.values, [facet]: next } });
  }

  update(data: BarData): void {
    this.#data = data;
    const filtering = isFiltering(data.filter);
    const noun = data.total === 1 ? 'card' : 'cards';
    this.#count.textContent = filtering ? (data.shown ? `${data.shown} of ${data.total} ${noun}` : `No cards match (of ${data.total})`) : `${data.total} ${noun}`;
    this.#clear.hidden = !filtering;

    this.#mix.hidden = data.status.length === 0 || data.total < 2;
    this.#mix.replaceChildren(
      ...data.status.map((s) => {
        const part = document.createElement('span');
        part.className = `tone-${s.tone}`;
        part.style.flexGrow = String(s.count);
        part.title = `${s.value}: ${s.count}`;
        return part;
      }),
    );
    this.#mix.title = data.status.map((s) => `${s.value}: ${s.count}`).join(' · ');

    // Search only pays off with a few cards; a search in progress stays visible.
    this.#search.hidden = data.total < 4 && !data.filter.search;
    if (document.activeElement !== this.#search && this.#search.value !== data.filter.search) this.#search.value = data.filter.search;

    this.#facets.hidden = data.total < 2;
    this.#facets.replaceChildren(
      ...data.facets.map((facet) => {
        const row = document.createElement('div');
        row.className = 'cm-card-facet';
        const label = document.createElement('span');
        label.className = 'cm-card-facet-key';
        label.textContent = facet.key;
        row.append(label);
        const wanted = data.filter.values[facet.id] ?? [];
        for (const v of facet.values) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = `cm-card-filter${v.tone ? ` tone-${v.tone}` : ''}`;
          chip.dataset.facet = facet.id;
          chip.dataset.value = v.id;
          chip.setAttribute('aria-pressed', String(wanted.includes(v.id)));
          chip.title = `Show only cards with ${facet.key} “${v.value}” (click again to stop)`;
          if (v.tone) {
            const dot = document.createElement('span');
            dot.className = 'cm-card-dot';
            chip.append(dot);
          }
          const count = document.createElement('span');
          count.className = 'cm-card-n';
          count.textContent = String(v.count);
          chip.append(v.value, count);
          if (v.mix.length) {
            const mix = document.createElement('span');
            mix.className = 'cm-card-chip-mix';
            for (const m of v.mix) {
              const part = document.createElement('span');
              part.className = `tone-${m.tone}`;
              part.style.flexGrow = String(m.count);
              mix.append(part);
            }
            chip.append(mix);
          }
          row.append(chip);
        }
        return row;
      }),
    );
  }
}

class BarWidget extends WidgetType {
  readonly data: BarData;
  readonly signature: string;

  constructor(data: BarData) {
    super();
    this.data = data;
    this.signature = JSON.stringify(data);
  }

  override eq(other: BarWidget): boolean {
    return other.signature === this.signature;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = new BarHost(view);
    host.update(this.data);
    return host.dom;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const host = barHosts.get(dom);
    if (!host) return false;
    host.update(this.data);
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override get estimatedHeight(): number {
    return 44 + (this.data.total > 1 ? 26 * this.data.facets.length : 0);
  }
}

// ---------------------------------------------------------------------------
// A card
// ---------------------------------------------------------------------------

/** The menu or popup that is open on a card (one at a time). */
let openMenu: { menu: HTMLElement; anchor: HTMLElement; close: () => void } | null = null;

function closeMenu(): void {
  openMenu?.close();
  openMenu = null;
}

function showMenu(container: HTMLElement, anchor: HTMLElement, entries: (MenuEntry | 'line')[], fromKeyboard: boolean): void {
  const menu = menuElement(
    entries.map((entry) =>
      entry === 'line'
        ? entry
        : {
            ...entry,
            run: () => {
              closeMenu();
              entry.run();
            },
          },
    ),
  );
  showPopup(container, anchor, menu);
  if (fromKeyboard) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

/** Shows `menu` under `anchor`, inside the card; a click elsewhere or Escape closes it. */
function showPopup(container: HTMLElement, anchor: HTMLElement, menu: HTMLElement): void {
  closeMenu();
  const box = anchor.getBoundingClientRect();
  const root = container.getBoundingClientRect();
  menu.style.top = `${box.bottom - root.top + 4}px`;
  container.append(menu);
  // Under the anchor, but never past the card's right edge.
  menu.style.left = `${Math.max(0, Math.min(box.left - root.left, root.width - menu.offsetWidth))}px`;
  const onDown = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!menu.contains(target) && !anchor.contains(target)) closeMenu();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  openMenu = {
    menu,
    anchor,
    close: () => {
      menu.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    },
  };
}

const STATUS_KEYS = new Set(['status', 'state', 'stage', 'progress']);

function wordCount(text: string): number {
  return text ? text.split(' ').length : 0;
}

class CardWidget extends WidgetType {
  readonly text: string;
  readonly card: Card;
  readonly tone: Tone | null;
  readonly options: HtmlOptions;

  constructor(text: string, card: Card, tone: Tone | null, options: HtmlOptions) {
    super();
    this.text = text;
    this.card = card;
    this.tone = tone;
    this.options = options;
  }

  override eq(other: CardWidget): boolean {
    return other.text === this.text && other.tone === this.tone;
  }

  toDOM(view: EditorView): HTMLElement {
    const { card, options } = this;
    const dom = document.createElement('div');
    dom.className = `cm-card${this.tone ? ` tone-${this.tone}` : ''}`;

    const title = document.createElement('div');
    title.className = 'cm-card-title';
    title.dataset.line = '0';
    title.dataset.endLine = '0';
    if (card.title) title.innerHTML = inlineHtml(card.title, options);
    else title.innerHTML = '<span class="cm-card-untitled">Untitled</span>';
    dom.append(title);

    const props = document.createElement('div');
    props.className = 'cm-card-props';
    card.properties.forEach((property, index) => {
      const group = document.createElement('span');
      group.className = 'cm-card-prop';
      const key = document.createElement('span');
      key.className = 'cm-card-key';
      key.textContent = property.key;
      group.append(key);
      const values = propertyValues(property.value);
      if (values.length === 0 && property.key.toLowerCase() === ATTACH_KEY) return;
      if (values.length === 0) group.append(pill(property.key, index, 0, null));
      values.forEach((value, part) => {
        const kind = valueKind(value);
        if (kind === 'word') {
          group.append(pill(property.key, index, part, value));
        } else if (kind === 'link') {
          group.append(linkChip(value, index, part, options));
        } else {
          const span = document.createElement('span');
          span.className = 'cm-card-text';
          span.innerHTML = inlineHtml(value, options);
          group.append(span);
        }
      });
      props.append(group);
    });
    if (!options.privateMode) {
      const attach = document.createElement('button');
      attach.type = 'button';
      attach.className = 'cm-card-attach-button';
      attach.textContent = '+ Attach';
      attach.title = 'Attach a note, a paper or a PDF to this card (or drop files on it)';
      attach.setAttribute('aria-haspopup', 'dialog');
      props.append(attach);
    }
    dom.append(props);

    // The text: everything after the property lines, block by block.
    const lines = this.text.split('\n');
    const offset = card.properties.length + 1;
    const body = document.createElement('div');
    body.className = 'cm-card-body';
    for (const block of blocksHtml(lines.slice(offset).join('\n'), options)) {
      const el = document.createElement('div');
      el.className = 'cm-card-block';
      el.dataset.line = String(block.from + offset);
      el.dataset.endLine = String(block.to + offset);
      if (block.type === 'blockquote') {
        el.classList.add('cm-card-quote', 'folded');
        const full = document.createElement('div');
        full.className = 'cm-card-quote-full';
        full.innerHTML = block.html;
        const fold = document.createElement('button');
        fold.type = 'button';
        fold.className = 'cm-card-quote-fold';
        fold.textContent = '▴';
        fold.title = 'Fold this quote';
        fold.setAttribute('aria-label', 'Fold this quote');
        full.prepend(fold);
        const text = (full.querySelector('blockquote')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        const summary = document.createElement('div');
        summary.className = 'cm-quote-folded cm-card-quote-summary';
        summary.title = 'Folded quote: click to open it';
        const mark = document.createElement('span');
        mark.className = 'cm-quote-folded-mark';
        mark.textContent = '❝';
        const words = document.createElement('span');
        words.className = 'cm-quote-folded-text';
        words.textContent = text || 'Quote';
        const size = document.createElement('span');
        size.className = 'cm-quote-folded-size';
        const n = wordCount(text);
        size.textContent = `${n} word${n === 1 ? '' : 's'}`;
        summary.append(mark, words, size);
        el.append(summary, full);
      } else {
        el.innerHTML = block.html;
        for (const box of el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
          if (box.closest('blockquote')) continue;
          box.disabled = false;
          box.classList.add('cm-card-task');
          box.setAttribute('aria-label', box.checked ? 'Done. Mark as not done' : 'Not done. Mark as done');
        }
      }
      body.append(el);
    }
    if (body.childElementCount) dom.append(body);

    // The widget's root has no margins (the editor can't measure them): spacing is its padding.
    const root = document.createElement('div');
    root.className = 'cm-card-outer';
    root.append(dom);
    // Keep the browser from putting a caret or focus into the card; clicks are handled below.
    root.addEventListener('mousedown', (event) => {
      if (!(event.target as Element).closest('.cm-md-menu')) event.preventDefault();
    });
    root.addEventListener('click', (event) => onCardClick(view, root, event));
    // Files dropped on a card are uploaded and attached to it.
    const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');
    root.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      root.classList.add('cm-card-drop');
    });
    root.addEventListener('dragleave', (event) => {
      if (!root.contains(event.relatedTarget as Node | null)) root.classList.remove('cm-card-drop');
    });
    root.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      root.classList.remove('cm-card-drop');
      void attachFiles(view, root, [...(event.dataTransfer?.files ?? [])]);
    });
    return root;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override destroy(dom: HTMLElement): void {
    if (openMenu && dom.contains(openMenu.menu)) closeMenu();
  }

  override get estimatedHeight(): number {
    return 64 + 24 * Math.min(30, this.text.split('\n').length - this.card.properties.length - 1);
  }
}

function pill(key: string, property: number, part: number, value: string | null): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `cm-card-pill ${value === null ? 'empty' : `tone-${toneOf(value)}`}`;
  button.dataset.property = String(property);
  button.dataset.part = String(part);
  button.setAttribute('aria-haspopup', 'menu');
  button.title = value === null ? `Choose a ${key}` : `${key}: ${value}. Click to change it`;
  button.textContent = value ?? 'set…';
  return button;
}

/** A link value (a note, a paper, a file, a web page) as a chip, with a button to remove it. */
function linkChip(value: string, property: number, part: number, options: HtmlOptions): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'cm-card-link';
  chip.innerHTML = inlineHtml(value, options);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'cm-card-unlink';
  remove.dataset.property = String(property);
  remove.dataset.part = String(part);
  remove.textContent = '×';
  remove.title = 'Remove this link from the card';
  remove.setAttribute('aria-label', 'Remove this link from the card');
  chip.append(remove);
  return chip;
}

/** The card a widget shows, as the document is now. */
function locate(view: EditorView, dom: HTMLElement): { set: SetBlock; block: CardBlock } | null {
  if (!dom.isConnected) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(dom);
  } catch {
    return null;
  }
  for (const set of view.state.field(cardsField).sets) for (const block of set.cards) if (block.from === pos) return { set, block };
  return null;
}

/**
 * Focuses the editor and applies `spec`. The editor hears of the focus a moment later; telling the
 * cards now means the card being edited shows as text at once.
 */
function focusAndDispatch(view: EditorView, spec: TransactionSpec): void {
  view.focus();
  const effects = spec.effects === undefined ? [] : Array.isArray(spec.effects) ? spec.effects : [spec.effects];
  view.dispatch({ ...spec, effects: [...effects, focusChanged.of(view.hasFocus)] });
}

function onCardClick(view: EditorView, dom: HTMLElement, event: MouseEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('.cm-md-menu')) return;
  const { state } = view;
  const unlink = target.closest<HTMLElement>('.cm-card-unlink');
  if (unlink) {
    event.preventDefault();
    removeLink(view, dom, Number(unlink.dataset.property), Number(unlink.dataset.part));
    return;
  }
  const attach = target.closest<HTMLElement>('.cm-card-attach-button');
  if (attach) {
    event.preventDefault();
    if (openMenu?.anchor === attach) closeMenu();
    else attachPopup(view, dom, attach);
    return;
  }
  const anchor = target.closest('a');
  if (anchor) {
    event.preventDefault();
    if (!state.facet(privateModeFacet)) followLink(anchor, state.facet(notePathFacet));
    return;
  }
  const pillButton = target.closest<HTMLElement>('.cm-card-pill');
  if (pillButton) {
    event.preventDefault();
    if (openMenu?.anchor === pillButton) closeMenu();
    else valueMenu(view, dom, pillButton, event.detail === 0);
    return;
  }
  if (target instanceof HTMLInputElement && target.classList.contains('cm-card-task')) {
    event.preventDefault();
    toggleTask(view, dom, target);
    return;
  }
  const quote = target.closest<HTMLElement>('.cm-card-quote');
  if (quote && (target.closest('.cm-card-quote-summary') || target.closest('.cm-card-quote-fold'))) {
    quote.classList.toggle('folded');
    view.requestMeasure();
    return;
  }
  editAt(view, dom, target.closest<HTMLElement>('[data-end-line]'));
}

function followLink(anchor: HTMLAnchorElement, notePath: string | null): void {
  const { target, heading, tag } = anchor.dataset;
  if (target !== undefined) return void openLink({ kind: 'wiki', target, heading: heading || null }, notePath);
  if (tag) return void openLink({ kind: 'tag', tag }, notePath);
  const href = anchor.getAttribute('href') ?? '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return void openLink({ kind: 'url', url: href }, notePath);
  if (href && !href.startsWith('#')) void openLink({ kind: 'file', href }, notePath);
}

/** Into the card's markdown: the cursor goes to the end of the block that was clicked (or of the title). */
function editAt(view: EditorView, dom: HTMLElement, block: HTMLElement | null): void {
  const found = locate(view, dom);
  if (!found) return;
  const { doc } = view.state;
  const relative = Number(block?.dataset.endLine ?? 0) || 0;
  const line = doc.line(Math.min(doc.lines, found.block.card.start + 1 + relative));
  focusAndDispatch(view, { selection: { anchor: line.to }, scrollIntoView: true });
}

function valueMenu(view: EditorView, dom: HTMLElement, anchor: HTMLElement, fromKeyboard: boolean): void {
  const found = locate(view, dom);
  if (!found) return;
  const propertyIndex = Number(anchor.dataset.property);
  const part = Number(anchor.dataset.part);
  const property = found.block.card.properties[propertyIndex];
  if (!property) return;
  const current = propertyValues(property.value)[part] ?? null;
  const id = property.key.toLowerCase();
  // The values this property has on the set's cards, as words, first seen first.
  const choices: string[] = [];
  const known = new Set<string>();
  const offer = (value: string) => {
    if (valueKind(value) !== 'word' || known.has(valueId(value))) return;
    known.add(valueId(value));
    choices.push(value);
  };
  for (const block of found.set.cards) for (const p of block.card.properties) if (p.key.toLowerCase() === id) propertyValues(p.value).forEach(offer);
  if (STATUS_KEYS.has(id)) ['todo', 'in progress', 'done'].forEach(offer);

  const change = (value: string | null) => () => {
    const now = locate(view, dom);
    const line = now ? now.block.card.properties[propertyIndex]?.line : undefined;
    if (line === undefined) return;
    const docLine = view.state.doc.line(line + 1);
    const next = setPropertyValue(docLine.text, part, value);
    if (next !== null && next !== docLine.text) view.dispatch({ changes: { from: docLine.from, to: docLine.to, insert: next }, userEvent: 'input.card' });
  };
  const entries: (MenuEntry | 'line')[] = choices.map((value) => ({
    label: value,
    checked: current !== null && valueId(value) === valueId(current),
    className: `cm-card-choice tone-${toneOf(value)}`,
    run: change(value),
  }));
  if (entries.length) entries.push('line');
  entries.push({ label: current === null ? 'Type a value…' : 'Type a new value…', run: () => typeValue(view, dom, propertyIndex, part) });
  if (current !== null) entries.push({ label: 'Remove', danger: true, run: change(null) });
  showMenu(dom.querySelector<HTMLElement>('.cm-card') ?? dom, anchor, entries, fromKeyboard);
}

/** Into the markdown with the value selected, to type over it (or at the end of an empty one). */
function typeValue(view: EditorView, dom: HTMLElement, propertyIndex: number, part: number): void {
  const found = locate(view, dom);
  const lineNumber = found?.block.card.properties[propertyIndex]?.line;
  if (lineNumber === undefined) return;
  const line = view.state.doc.line(lineNumber + 1);
  const value = propertyParts(line.text)?.parts[part];
  if (value) {
    focusAndDispatch(view, { selection: { anchor: line.from + value.from, head: line.from + value.to }, scrollIntoView: true });
  } else if (/\s$/.test(line.text)) {
    focusAndDispatch(view, { selection: { anchor: line.to }, scrollIntoView: true });
  } else {
    focusAndDispatch(view, { changes: { from: line.to, insert: ' ' }, selection: { anchor: line.to + 1 }, scrollIntoView: true, userEvent: 'input.card' });
  }
}

function toggleTask(view: EditorView, dom: HTMLElement, box: HTMLInputElement): void {
  const found = locate(view, dom);
  if (!found) return;
  const index = [...dom.querySelectorAll('input.cm-card-task')].indexOf(box);
  const { card } = found.block;
  const { doc } = view.state;
  const bodyStart = card.start + card.properties.length + 1;
  const lines: string[] = [];
  for (let n = bodyStart; n <= card.end; n++) lines.push(doc.line(n + 1).text);
  const relative = taskLinesIn(lines)[index];
  if (relative === undefined) return;
  const line = doc.line(bodyStart + relative + 1);
  const next = toggleTaskLine(line.text, localISODate());
  if (next !== null && next !== line.text) view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: 'input.card' });
}

// ---------------------------------------------------------------------------
// Attachments: notes, papers and files linked in a card's `attached::` line
// ---------------------------------------------------------------------------

const ATTACH_KEY = 'attached';

/** A [[link]] to a note: by its title when that finds it, otherwise by its path, labelled with the title. */
function wikiLinkTo(note: NoteSummary): string {
  if (!/[[\]|#\n]/.test(note.title) && resolveNote(note.title)?.path === note.path) return `[[${note.title}]]`;
  const label = note.title.replace(/[[\]|#\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `[[${note.path.replace(/\.md$/, '')}${label ? `|${label}` : ''}]]`;
}

/** The card again after an upload: where it was if it hasn't changed, else the first card with its title. */
function relocate(view: EditorView, dom: HTMLElement, title: string): CardBlock | null {
  const found = locate(view, dom);
  if (found) return found.block;
  for (const set of view.state.field(cardsField).sets) for (const block of set.cards) if (block.card.title === title) return block;
  return null;
}

/** Adds links to the card's `attached::` line, making the line if there is none. Links already there are skipped. */
function addAttachments(view: EditorView, block: CardBlock, links: readonly string[]): void {
  const { state } = view;
  const existing = block.card.properties.find((p) => p.key.toLowerCase() === ATTACH_KEY);
  const have = new Set(existing ? propertyValues(existing.value) : []);
  const wanted = [...new Set(links)].filter((link) => !have.has(link));
  if (wanted.length === 0) return;
  if (existing) {
    const line = state.doc.line(existing.line + 1);
    let text: string | null = line.text;
    for (const link of wanted) text = text === null ? null : setPropertyValue(text, Number.MAX_SAFE_INTEGER, link);
    if (text !== null) view.dispatch({ changes: { from: line.from, to: line.to, insert: text }, userEvent: 'input.card' });
    return;
  }
  const last = block.card.properties.at(-1);
  if (!last) return;
  const line = state.doc.line(last.line + 1);
  view.dispatch({ changes: { from: line.to, insert: `${state.lineBreak}${ATTACH_KEY}:: ${wanted.join(', ')}` }, userEvent: 'input.card' });
}

/** Uploads files (PDFs, images) to the notes folder and attaches them to the card. */
async function attachFiles(view: EditorView, dom: HTMLElement, files: File[]): Promise<void> {
  if (files.length === 0) return;
  if (view.state.facet(privateModeFacet)) {
    showToast('Files can’t be added to the vault: they would be stored unencrypted.', 'error');
    return;
  }
  const title = locate(view, dom)?.block.card.title ?? '';
  const notePath = view.state.facet(notePathFacet) ?? '';
  const links: string[] = [];
  for (const file of files) {
    try {
      const { path } = await api.uploadFile(file);
      links.push(`[${file.name.replace(/[[\]]/g, '')}](${relativePath(dirname(notePath), path).replace(/ /g, '%20')})`);
    } catch (err) {
      showToast(`Could not add ${file.name}: ${messageOf(err)}`, 'error');
    }
  }
  const block = relocate(view, dom, title);
  if (block) addAttachments(view, block, links);
  else if (links.length) showToast('The card changed while uploading: the files are in the files folder, but not attached.', 'error');
}

/** "+ Attach": find a note or paper to attach, or upload a file. */
function attachPopup(view: EditorView, dom: HTMLElement, anchor: HTMLElement): void {
  const notePath = view.state.facet(notePathFacet);
  const popup = document.createElement('div');
  popup.className = 'cm-md-menu cm-card-attach';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Attach to this card');
  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'cm-card-attach-search';
  input.placeholder = 'Find a note or paper';
  input.setAttribute('aria-label', 'Find a note or paper to attach');
  input.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'cm-card-attach-results';
  list.setAttribute('role', 'listbox');
  const upload = document.createElement('button');
  upload.type = 'button';
  upload.textContent = 'Upload a PDF or image…';
  upload.addEventListener('mousedown', (e) => e.preventDefault());
  popup.append(input, list, document.createElement('hr'), upload);

  let results: NoteSummary[] = [];
  let active = 0;
  const attachNote = (note: NoteSummary | undefined) => {
    if (!note) return;
    closeMenu();
    const found = locate(view, dom);
    if (found) addAttachments(view, found.block, [wikiLinkTo(note)]);
  };
  const render = () => {
    const notes = (notesStore.get() ?? []).filter((n) => n.kind !== 'comments' && n.path !== notePath);
    const query = input.value.trim();
    results = query ? fuzzyFilter(notes, query, (n) => n.title, 8).map((r) => r.item) : [...notes].sort((a, b) => b.mtime - a.mtime).slice(0, 8);
    active = Math.min(active, Math.max(0, results.length - 1));
    list.replaceChildren(
      ...results.map((note, i) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = `cm-card-attach-result${i === active ? ' active' : ''}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(i === active));
        const name = document.createElement('span');
        name.className = 'cm-card-attach-title';
        name.textContent = note.title;
        const kind = document.createElement('span');
        kind.className = 'cm-card-attach-kind';
        kind.textContent = note.kind === 'note' ? (note.path.split('/')[0] ?? 'note') : note.kind;
        option.append(name, kind);
        option.addEventListener('mousedown', (e) => e.preventDefault());
        option.addEventListener('click', () => attachNote(note));
        return option;
      }),
    );
    if (results.length === 0) {
      const none = document.createElement('p');
      none.className = 'cm-card-attach-none';
      none.textContent = query ? 'No note or paper matches.' : 'No notes yet.';
      list.append(none);
    }
  };
  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length) active = (active + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      attachNote(results[active]);
    }
  });
  upload.addEventListener('click', () => {
    closeMenu();
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.accept = '.pdf,application/pdf,image/*';
    picker.onchange = () => void attachFiles(view, dom, [...(picker.files ?? [])]);
    picker.click();
  });
  render();
  showPopup(dom.querySelector<HTMLElement>('.cm-card') ?? dom, anchor, popup);
  input.focus();
}

/** × on a link chip: takes that link off its line; a line left empty goes (unless it is the card's only property). */
function removeLink(view: EditorView, dom: HTMLElement, propertyIndex: number, part: number): void {
  const found = locate(view, dom);
  const { card } = found?.block ?? {};
  const property = card?.properties[propertyIndex];
  if (!card || !property) return;
  const { state } = view;
  const line = state.doc.line(property.line + 1);
  const next = setPropertyValue(line.text, part, null);
  if (next === null || next === line.text) return;
  const emptied = (propertyParts(next)?.parts.length ?? 0) === 0;
  if (emptied && card.properties.length > 1) view.dispatch({ changes: { from: line.from - 1, to: line.to }, userEvent: 'delete.card' });
  else view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: 'delete.card' });
}

// ---------------------------------------------------------------------------
// Adding cards
// ---------------------------------------------------------------------------

/** "+ Card": a card at the end of the set, with the same properties as the last one, title selected. */
function addCard(view: EditorView, key: string): void {
  const { sets, filters } = view.state.field(cardsField);
  const set = sets.find((s) => s.key === key);
  const lastBlock = set?.cards.at(-1);
  if (!set || !lastBlock) return;
  const filter = filters.get(key) ?? NO_FILTER;
  const facets = cardFacets(set.cards.map((b) => b.card));
  // A new card in a filtered set gets the values filtered on, so it stays in view.
  const filtered = (id: string) => {
    const wanted = filter.values[id]?.[0];
    return (wanted && facets.find((f) => f.id === id)?.values.find((v) => v.id === wanted)?.value) || '';
  };
  const properties: [string, string][] = [];
  const keys = new Set<string>();
  for (const p of lastBlock.card.properties) {
    const id = p.key.toLowerCase();
    if (keys.has(id)) continue;
    keys.add(id);
    properties.push([p.key, filtered(id)]);
  }
  for (const [id, wanted] of Object.entries(filter.values)) {
    const facet = facets.find((f) => f.id === id);
    if (!keys.has(id) && wanted.length && facet) properties.push([facet.key, filtered(id)]);
  }
  const title = 'New card';
  const text = `\n\n${newCardLines(set.level, title, properties).join('\n')}`;
  const { state } = view;
  const titleFrom = lastBlock.to + 2 + set.level + 1;
  focusAndDispatch(view, {
    changes: { from: lastBlock.to, insert: state.toText(text.replace(/\n/g, state.lineBreak)) },
    selection: { anchor: titleFrom, head: titleFrom + title.length },
    effects: filter.search ? setFilter.of({ key, filter: { ...filter, search: '' } }) : [],
    scrollIntoView: true,
    userEvent: 'input.card',
  });
}

/** "/cards": a card at the cursor, one level below the section it is in (a card's own level inside a card), title selected. */
export function insertCards(view: EditorView, from: number, to: number): void {
  const { state } = view;
  const lines = state.doc.toJSON();
  const at = state.doc.lineAt(from);
  const index = at.number - 1;
  const inside = findCards(lines)
    .flatMap((s) => s.cards)
    .find((c) => index > c.start && index <= c.last);
  const above = headingsIn(lines)
    .filter((h) => h.line < index)
    .at(-1);
  const level = inside ? inside.level : Math.min(6, Math.max(2, (above?.level ?? 1) + 1));
  const title = 'Card title';
  const breakBefore = from > at.from ? '\n' : '';
  const text = `${breakBefore}${newCardLines(level, title, [['status', 'todo']]).join('\n')}\n`;
  const titleFrom = from + breakBefore.length + level + 1;
  view.dispatch({
    changes: { from, to, insert: state.toText(text.replace(/\n/g, state.lineBreak)) },
    selection: { anchor: titleFrom, head: titleFrom + title.length },
    userEvent: 'input.complete',
  });
}

// ---------------------------------------------------------------------------
// Which cards show as cards: all, except the one with the cursor (its text shows) and the ones
// filtered out (hidden). While comparing with an older version, all show as text.
// ---------------------------------------------------------------------------

const keyMark = Decoration.mark({ class: 'cm-card-key-raw' });

/** How each card shows now: as a card, as its markdown (being edited), or not at all (filtered out). */
interface Shown {
  from: number;
  to: number;
  last: number;
  as: 'card' | 'text' | 'hidden';
}

interface CardsState {
  sets: SetBlock[];
  focused: boolean;
  filters: Map<string, CardFilter>;
  decorations: DecorationSet;
  shown: Shown[];
}

function build(state: EditorState, sets: SetBlock[], focused: boolean, filters: ReadonlyMap<string, CardFilter>): Pick<CardsState, 'decorations' | 'shown'> {
  if (sets.length === 0 || comparingWith(state) !== null) return { decorations: Decoration.none, shown: [] };
  const options: HtmlOptions = { notePath: state.facet(notePathFacet), privateMode: state.facet(privateModeFacet) };
  const ranges: Range<Decoration>[] = [];
  const shown: Shown[] = [];
  for (const set of sets) {
    const filter = filters.get(set.key) ?? NO_FILTER;
    const facets = cardFacets(set.cards.map((b) => b.card));
    const status = statusFacet(facets);
    const matches = set.cards.map((b) => cardMatches(b.card, b.text, filter));
    ranges.push(Decoration.widget({ widget: new BarWidget(barData(set, facets, status, filter, matches.filter(Boolean).length)), side: -1, block: true }).range(set.from));
    set.cards.forEach((block, i) => {
      const { from, to, last } = block;
      const editing = focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
      if (editing) {
        shown.push({ from, to, last, as: 'text' });
        const first = state.doc.lineAt(from).number;
        const end = state.doc.lineAt(to).number;
        for (let n = first; n <= end; n++) {
          const classes = ['cm-card-raw', n === first ? 'cm-card-raw-first' : '', n === end ? 'cm-card-raw-last' : ''].filter(Boolean).join(' ');
          ranges.push(Decoration.line({ class: classes }).range(state.doc.line(n).from));
        }
        for (const p of block.card.properties) {
          const line = state.doc.line(p.line + 1);
          ranges.push(keyMark.range(line.from, line.from + p.key.length + 2));
        }
      } else if (!matches[i]) {
        shown.push({ from, to, last, as: 'hidden' });
        ranges.push(Decoration.replace({ block: true }).range(from, last));
      } else {
        shown.push({ from, to, last, as: 'card' });
        const statusValue = status ? propertyValues(block.card.properties.find((p) => p.key.toLowerCase() === status.id)?.value ?? '')[0] : undefined;
        const tone = statusValue ? toneOf(statusValue) : null;
        ranges.push(Decoration.replace({ widget: new CardWidget(block.text, block.card, tone, options), block: true }).range(from, to));
      }
    });
  }
  return { decorations: Decoration.set(ranges, true), shown };
}

const cardsField = StateField.define<CardsState>({
  create(state) {
    const sets = setsIn(state);
    const filters = loadFilters(state);
    return { sets, focused: false, filters, ...build(state, sets, false, filters) };
  },
  update(value, tr) {
    let { focused, filters } = value;
    let filtersChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(focusChanged)) {
        focused = effect.value;
      } else if (effect.is(setFilter)) {
        filters = new Map(filters);
        if (isFiltering(effect.value.filter)) filters.set(effect.value.key, effect.value.filter);
        else filters.delete(effect.value.key);
        filtersChanged = true;
      }
    }
    const comparingChanged = comparingWith(tr.startState) !== comparingWith(tr.state);
    if (!tr.docChanged && !tr.selection && focused === value.focused && !filtersChanged && !comparingChanged) return value;
    const sets = tr.docChanged ? setsIn(tr.state) : value.sets;
    if (filtersChanged) saveFilters(tr.state, filters);
    return { sets, focused, filters, ...build(tr.state, sets, focused, filters) };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

/** Where a cursor that moved into a hidden card goes instead: past it, the way it was going. */
function pastHidden(shown: readonly Shown[], pos: number, forward: boolean, end: number): number {
  for (;;) {
    const hidden = shown.find((s) => s.as === 'hidden' && s.from <= pos && pos <= s.last);
    const next = hidden ? (forward ? Math.min(end, hidden.last + 1) : Math.max(0, hidden.from - 1)) : pos;
    if (next === pos) return pos;
    pos = next;
  }
}

/**
 * The cursor never stops inside a card the filter hides: it goes past it as if it weren't there.
 * (Not "atomic" ranges: those would make a Backspace next to a hidden card delete all of it.)
 */
const skipHiddenCards = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection || !tr.isUserEvent('select')) return tr;
  const { shown } = tr.startState.field(cardsField);
  if (!shown.some((s) => s.as === 'hidden')) return tr;
  const before = tr.startState.selection.main.head;
  const end = tr.startState.doc.length;
  let moved = false;
  const ranges = tr.selection.ranges.map((range) => {
    const head = pastHidden(shown, range.head, range.head >= before, end);
    if (head === range.head) return range;
    moved = true;
    return EditorSelection.range(range.empty ? head : range.anchor, head);
  });
  return moved ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr;
});

/**
 * Up and down arrows into a card: CodeMirror would jump over it (it is one block), so a card just
 * below opens at its heading and a card just above opens at its end. Hidden cards are passed over.
 */
function arrowIntoCard(forward: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const range = state.selection.main;
    const { shown } = state.field(cardsField);
    if (!range.empty || state.selection.ranges.length > 1 || shown.length === 0 || completionStatus(state) === 'active') return false;
    const line = state.doc.lineAt(range.head);
    // A long line wrapped over several rows: move within it first.
    const plain = view.moveVertically(range, forward).head;
    if (forward ? plain <= line.to : plain >= line.from) return false;
    const end = state.doc.length;
    let target: number | null = null;
    if (forward) {
      if (line.to >= end) return false;
      const next = pastHidden(shown, line.to + 1, true, end);
      const card = shown.find((s) => s.as === 'card' && s.from === next);
      if (card) target = card.from;
      else if (next !== line.to + 1) target = next;
    } else {
      if (line.from === 0) return false;
      const previous = pastHidden(shown, line.from - 1, false, end);
      const card = shown.find((s) => s.as === 'card' && s.to === previous);
      if (card) target = card.to;
      else if (previous !== line.from - 1) target = previous;
    }
    if (target === null) return false;
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

/** Escape in a card's markdown: done editing, the card shows again. */
function leaveCard(view: EditorView): boolean {
  const { shown, focused } = view.state.field(cardsField);
  if (!focused) return false;
  const head = view.state.selection.main.head;
  if (!shown.some((s) => s.as === 'text' && head >= s.from && head <= s.to)) return false;
  view.contentDOM.blur();
  return true;
}

export const cardEditing: Extension = [
  cardsField,
  skipHiddenCards,
  EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing)),
  keymap.of([
    { key: 'ArrowDown', run: arrowIntoCard(true) },
    { key: 'ArrowUp', run: arrowIntoCard(false) },
  ]),
  Prec.low(keymap.of([{ key: 'Escape', run: leaveCard }])),
];

import {
  type Card,
  type CardFilter,
  type CardSet,
  cardFacets,
  cardMatches,
  cardValueIds,
  type Facet,
  findCards,
  isFiltering,
  NO_FILTER,
  propertyValues,
  statusFacet,
  type Tone,
  toneOf,
  valueKind,
} from '../../shared/cards.ts';
import { blocksHtml, documentHtml, type HtmlOptions, inlineHtml } from './markdownHtml.ts';
import { foldedQuoteElement } from './quotes.ts';

/**
 * Cards drawn as HTML: a card (title, values as pills, links as chips, its text) and the bar above
 * a set (counts, status colours, filters, search). The editor shows them as widgets you can edit
 * (`cards.ts`); the reading view shows them read-only, with filters that still work.
 */

/** The property cards keep their attachments in. */
export const ATTACH_KEY = 'attached';

/** A card's colour: that of its status value, when the set has a status. */
export function cardTone(card: Card, status: Facet | null): Tone | null {
  if (!status) return null;
  const value = propertyValues(card.properties.find((p) => p.key.toLowerCase() === status.id)?.value ?? '')[0];
  return value ? toneOf(value) : null;
}

// ---------------------------------------------------------------------------
// The bar above a set
// ---------------------------------------------------------------------------

interface BarValue {
  id: string;
  value: string;
  count: number;
  tone: Tone | null;
  /** For values of other properties: the status colours of the cards that have it. */
  mix: { tone: Tone; count: number }[];
}

export interface BarData {
  key: string;
  total: number;
  shown: number;
  filter: CardFilter;
  facets: { id: string; key: string; status: boolean; values: BarValue[] }[];
  /** The status of all the set's cards, value by value. */
  status: { value: string; tone: Tone; count: number }[];
}

export function barData(key: string, cards: readonly Card[], facets: Facet[], status: Facet | null, filter: CardFilter, shown: number): BarData {
  const statusOf = (card: Card) => (status ? cardValueIds(card, status.id)[0] : undefined);
  const toneById = new Map(status?.values.map((v) => [v.id, toneOf(v.value)]) ?? []);
  return {
    key,
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

export interface BarActions {
  /** The filter changed: a chip, the search box or Show all. */
  filter(key: string, filter: CardFilter): void;
  /** "+ Card". Without it the button isn't there. */
  add?(key: string): void;
  /** Escape in the search box. */
  leave?(): void;
}

const barHosts = new WeakMap<HTMLElement, BarHost>();

/** The bar's DOM, kept across updates (so the search box keeps the focus while you type). */
export class BarHost {
  readonly dom: HTMLElement;
  readonly #actions: BarActions;
  readonly #count: HTMLElement;
  readonly #clear: HTMLButtonElement;
  readonly #mix: HTMLElement;
  readonly #search: HTMLInputElement;
  readonly #facets: HTMLElement;
  #data: BarData | null = null;

  static of(dom: HTMLElement): BarHost | undefined {
    return barHosts.get(dom);
  }

  constructor(actions: BarActions) {
    this.#actions = actions;
    // No margins on the outer box (the editor can't measure them): spacing is its padding.
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
    top.append(this.#count, this.#clear, this.#mix, this.#search);
    if (actions.add) top.append(this.#button('+ Card', 'cm-card-add', 'Add a card at the end of this set'));
    this.#facets = document.createElement('div');
    this.#facets.className = 'cm-card-facets';
    bar.append(top, this.#facets);

    // Using the bar leaves the focus where it was (the search box takes it, though).
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
      this.#actions.leave?.();
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
    if (this.#data) this.#actions.filter(this.#data.key, filter);
  }

  #onClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const data = this.#data;
    if (!data) return;
    if (target.closest('.cm-card-add')) return this.#actions.add?.(data.key);
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
    this.#mix.replaceChildren(...data.status.map((s) => toneBar(s.tone, s.count, `${s.value}: ${s.count}`)));
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
            mix.append(...v.mix.map((m) => toneBar(m.tone, m.count)));
            chip.append(mix);
          }
          row.append(chip);
        }
        return row;
      }),
    );
  }
}

/** One coloured part of a bar, as wide as its count. */
function toneBar(tone: Tone, count: number, title?: string): HTMLElement {
  const part = document.createElement('span');
  part.className = `tone-${tone}`;
  part.style.flexGrow = String(count);
  if (title) part.title = title;
  return part;
}

// ---------------------------------------------------------------------------
// A card
// ---------------------------------------------------------------------------

/** A word value. In the editor a button that opens a menu of values; read-only, a label. */
function pill(key: string, property: number, part: number, value: string | null, editable: boolean): HTMLElement {
  const pill = document.createElement(editable ? 'button' : 'span');
  pill.className = `cm-card-pill ${value === null ? 'empty' : `tone-${toneOf(value)}`}`;
  pill.textContent = value ?? 'set…';
  if (!editable) return pill;
  const button = pill as HTMLButtonElement;
  button.type = 'button';
  button.dataset.property = String(property);
  button.dataset.part = String(part);
  button.setAttribute('aria-haspopup', 'menu');
  button.title = value === null ? `Choose a ${key}` : `${key}: ${value}. Click to change it`;
  return button;
}

/** A link value (a note, a paper, a file, a web page) as a chip; in the editor with a button to remove it. */
function linkChip(value: string, property: number, part: number, options: HtmlOptions, editable: boolean): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'cm-card-link';
  chip.innerHTML = inlineHtml(value, options);
  if (!editable) return chip;
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

/**
 * A card: `text` is its markdown. `editable` (the editor) adds what edits it: value menus, + Attach,
 * × on links and tickable tasks; the editor handles those clicks. Quotes fold and open either way.
 */
export function cardElement(text: string, card: Card, tone: Tone | null, options: HtmlOptions, editable: boolean): HTMLElement {
  const dom = document.createElement('div');
  dom.className = `cm-card${tone ? ` tone-${tone}` : ''}${editable ? '' : ' read-only'}`;

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
    const values = propertyValues(property.value);
    if (values.length === 0 && (property.key.toLowerCase() === ATTACH_KEY || !editable)) return;
    const group = document.createElement('span');
    group.className = 'cm-card-prop';
    const key = document.createElement('span');
    key.className = 'cm-card-key';
    key.textContent = property.key;
    group.append(key);
    if (values.length === 0) group.append(pill(property.key, index, 0, null, editable));
    values.forEach((value, part) => {
      const kind = valueKind(value);
      if (kind === 'word') {
        group.append(pill(property.key, index, part, value, editable));
      } else if (kind === 'link') {
        group.append(linkChip(value, index, part, options, editable));
      } else {
        const span = document.createElement('span');
        span.className = 'cm-card-text';
        span.innerHTML = inlineHtml(value, options);
        group.append(span);
      }
    });
    props.append(group);
  });
  if (editable && !options.privateMode) {
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
  const lines = text.split('\n');
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
      const summary = foldedQuoteElement((full.querySelector('blockquote')?.textContent ?? '').replace(/\s+/g, ' ').trim());
      summary.classList.add('cm-card-quote-summary');
      el.append(summary, full);
    } else {
      el.innerHTML = block.html;
      if (editable) {
        for (const box of el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
          if (box.closest('blockquote')) continue;
          box.disabled = false;
          box.classList.add('cm-card-task');
          box.setAttribute('aria-label', box.checked ? 'Done. Mark as not done' : 'Not done. Mark as done');
        }
      }
    }
    body.append(el);
  }
  if (body.childElementCount) dom.append(body);

  // A folded quote opens on a click on it; ▴ folds it again.
  dom.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (!target.closest('.cm-card-quote-summary, .cm-card-quote-fold')) return;
    target.closest('.cm-card-quote')?.classList.toggle('folded');
  });
  return dom;
}

// ---------------------------------------------------------------------------
// The reading view
// ---------------------------------------------------------------------------

/** A set of cards, read-only, under a bar whose filters and search work (nothing is saved). */
function readOnlySet(set: CardSet, lines: readonly string[], options: HtmlOptions): HTMLElement {
  const { cards } = set;
  const texts = cards.map((card) => lines.slice(card.start, card.end + 1).join('\n'));
  const facets = cardFacets(cards);
  const status = statusFacet(facets);
  const boxes = cards.map((card, i) => {
    const box = document.createElement('div');
    box.className = 'cm-card-outer';
    box.append(cardElement(texts[i] ?? '', card, cardTone(card, status), options, false));
    return box;
  });
  let filter = NO_FILTER;
  const bar = new BarHost({
    filter: (_key, next) => {
      filter = next;
      show();
    },
  });
  function show(): void {
    let shown = 0;
    cards.forEach((card, i) => {
      const match = cardMatches(card, texts[i] ?? '', filter);
      const box = boxes[i];
      if (box) box.hidden = !match;
      if (match) shown++;
    });
    bar.update(barData('', cards, facets, status, filter, shown));
  }
  show();
  const element = document.createElement('div');
  element.className = 'cm-card-set';
  element.append(bar.dom, ...boxes);
  return element;
}

/** Fills `container` with a note's body as HTML, with its cards drawn as cards. */
export function renderWithCards(container: HTMLElement, source: string, options: HtmlOptions): void {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const nodes: Node[] = [];
  const markdown = (from: number, to: number) => {
    if (to <= from) return;
    const template = document.createElement('template');
    template.innerHTML = documentHtml(lines.slice(from, to).join('\n'), options);
    nodes.push(...template.content.childNodes);
  };
  let next = 0;
  for (const set of findCards(lines)) {
    const first = set.cards[0];
    const last = set.cards.at(-1);
    if (!first || !last) continue;
    markdown(next, first.start);
    nodes.push(readOnlySet(set, lines, options));
    next = last.last + 1;
  }
  markdown(next, lines.length);
  container.replaceChildren(...nodes);
}

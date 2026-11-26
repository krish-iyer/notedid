import { type EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { isFrontmatterClose, isFrontmatterOpen } from '../../shared/frontmatter.ts';

/**
 * The front matter block (`---` … `---` at the top of a note) folds into one "Properties" line.
 * Clicking it, or moving the cursor into it, shows the YAML for editing. The file is unchanged.
 * A block with nothing but the note's `id:` isn't shown at all.
 */

const focusChanged = StateEffect.define<boolean>();

/** Tags listed in the front matter (`tags: [a, b]`, `tags: a, b` or a `- a` list), for the folded line. */
function tagsOf(lines: string[]): string[] {
  const at = lines.findIndex((l) => /^tags?[ \t]*:/.test(l));
  if (at < 0) return [];
  const inline = (lines[at] ?? '').replace(/^tags?[ \t]*:/, '').trim();
  const items = inline
    ? inline.replace(/^\[|\]$/g, '').split(',')
    : lines
        .slice(at + 1)
        .filter((_, i, rest) => rest.slice(0, i + 1).every((l) => /^[ \t]*-[ \t]/.test(l)))
        .map((l) => l.replace(/^[ \t]*-[ \t]*/, ''));
  return items.map((t) => t.trim().replace(/^["']|["']$/g, '').replace(/^#/, '')).filter(Boolean);
}

class PropertiesWidget extends WidgetType {
  readonly tags: string[];

  constructor(tags: string[]) {
    super();
    this.tags = tags;
  }

  override eq(other: PropertiesWidget): boolean {
    return other.tags.join('\n') === this.tags.join('\n');
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('div');
    box.className = 'cm-properties';
    box.title = 'Show the properties (the YAML front matter) to edit them';
    const label = document.createElement('span');
    label.className = 'cm-properties-label';
    label.textContent = '▸ Properties';
    box.append(label);
    for (const tag of this.tags) {
      const chip = document.createElement('span');
      chip.className = 'cm-tag';
      chip.textContent = `#${tag}`;
      box.append(' ', chip);
    }
    box.addEventListener('mousedown', (event) => {
      event.preventDefault();
      // The end of the first property line: inside the block, so it opens.
      view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
      view.focus();
    });
    return box;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Lines of the front matter block (1-based, inclusive), or null. Long blocks aren't folded. */
function blockOf(state: EditorState): { first: number; last: number } | null {
  const doc = state.doc;
  if (doc.lines < 2 || !isFrontmatterOpen(doc.line(1).text)) return null;
  const limit = Math.min(doc.lines, 300);
  for (let n = 2; n <= limit; n++) if (isFrontmatterClose(doc.line(n).text)) return { first: 1, last: n };
  return null;
}

function build(state: EditorState, focused: boolean): DecorationSet {
  const block = blockOf(state);
  if (!block) return Decoration.none;
  const from = state.doc.line(block.first).from;
  const to = state.doc.line(block.last).to;
  if (focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from)) return Decoration.none;
  const lines: string[] = [];
  for (let n = block.first + 1; n < block.last; n++) lines.push(state.doc.line(n).text);
  // Front matter that only holds the note's id is for the app, not for reading: it isn't shown.
  if (lines.every((line) => !line.trim() || /^id[ \t]*:/.test(line))) return Decoration.set([Decoration.replace({ block: true }).range(from, to)]);
  return Decoration.set([Decoration.replace({ widget: new PropertiesWidget(tagsOf(lines)), block: true }).range(from, to)]);
}

/* Folding changes line heights, so it is a state field: decorations from view plugins can't. */
const fold = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
  create: (state) => ({ focused: false, decorations: build(state, false) }),
  update(value, tr) {
    let focused = value.focused;
    for (const effect of tr.effects) if (effect.is(focusChanged)) focused = effect.value;
    if (!tr.docChanged && !tr.selection && focused === value.focused) return value;
    return { focused, decorations: build(tr.state, focused) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export const frontmatterFold = [fold, EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing))];

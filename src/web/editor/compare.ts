import { type EditorState, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, type Panel, showPanel, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { diffStats, diffText } from '../../shared/diff.ts';

/**
 * Tracked changes in the note itself: compared with an older version, text added since then is
 * highlighted and removed text is shown struck through where it was. The removed text is only
 * drawn; it isn't in the document. You can keep editing while comparing; the marks follow.
 */

export interface CompareBase {
  /** The older version's text. */
  text: string;
  /** When it was, for the bar at the top ("25 Nov, 10:39"). */
  label: string;
}

interface CompareState extends CompareBase {
  decorations: DecorationSet;
  added: number;
  removed: number;
}

/** Starts comparing with a version (or stops, with null). */
export const setCompare = StateEffect.define<CompareBase | null>();
const recompute = StateEffect.define<null>();

const addedText = Decoration.mark({ class: 'cm-diff-add', attributes: { title: 'Added since then' } });
const addedLine = Decoration.line({ class: 'cm-diff-added-line' });

class RemovedText extends WidgetType {
  readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  override eq(other: RemovedText): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const del = document.createElement('del');
    del.className = 'cm-diff-del';
    del.title = 'Removed since then';
    // Removed spaces or line breaks alone would be invisible.
    del.textContent = /^\s+$/.test(this.text) ? (this.text.includes('\n') ? '↵' : '␣') : this.text;
    return del;
  }
}

function compute(base: CompareBase, state: EditorState): CompareState {
  const doc = state.doc;
  const parts = diffText(base.text.replace(/\r\n?/g, '\n'), doc.toString());
  const ranges: Range<Decoration>[] = [];
  let pos = 0;
  for (const part of parts) {
    if (part.kind === 'del') {
      ranges.push(Decoration.widget({ widget: new RemovedText(part.text), side: -1 }).range(pos));
      continue;
    }
    const end = Math.min(pos + part.text.length, doc.length);
    if (part.kind === 'add' && end > pos) {
      if (part.text.trim()) ranges.push(addedText.range(pos, end));
      // Lines that are new from start to end get a bar in the margin.
      for (let line = doc.lineAt(pos); ; line = doc.line(line.number + 1)) {
        if (line.from >= pos && line.to <= end && line.length > 0) ranges.push(addedLine.range(line.from));
        if (line.to >= end || line.number >= doc.lines) break;
      }
    }
    pos = end;
  }
  const { added, removed } = diffStats(parts);
  return { ...base, decorations: Decoration.set(ranges, true), added, removed };
}

const compareField = StateField.define<CompareState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCompare)) return effect.value ? compute(effect.value, tr.state) : null;
      if (effect.is(recompute) && value) return compute(value, tr.state);
    }
    // While typing, the marks move with the text; they are worked out again once typing pauses.
    if (value && tr.docChanged) return { ...value, decorations: value.decorations.map(tr.changes) };
    return value;
  },
  provide: (field) => [EditorView.decorations.from(field, (value) => value?.decorations ?? Decoration.none), showPanel.from(field, (value) => (value ? compareBar : null))],
});

function compareBar(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-compare-bar';
  const render = () => {
    const value = view.state.field(compareField, false);
    if (!value) return;
    const text = document.createElement('span');
    text.className = 'cm-compare-text';
    if (value.added === 0 && value.removed === 0) {
      text.textContent = `No changes since ${value.label}`;
    } else {
      const ins = document.createElement('ins');
      ins.textContent = `+${value.added}`;
      const del = document.createElement('del');
      del.textContent = `−${value.removed}`;
      text.append(`Changes since ${value.label}: `, ins, ' ', del, ` word${value.added + value.removed === 1 ? '' : 's'}`);
    }
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'small';
    done.textContent = 'Done';
    done.title = 'Stop showing the changes';
    done.addEventListener('click', () => view.dispatch({ effects: setCompare.of(null) }));
    dom.replaceChildren(text, done);
  };
  render();
  return {
    top: true,
    dom,
    update(update: ViewUpdate) {
      if (update.state.field(compareField, false) !== update.startState.field(compareField, false)) render();
    },
  };
}

const recomputeAfterTyping = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | undefined;
    readonly view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
    }

    update(update: ViewUpdate): void {
      if (!update.docChanged || !update.state.field(compareField, false)) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.view.dispatch({ effects: recompute.of(null) }), 300);
    }

    destroy(): void {
      clearTimeout(this.timer);
    }
  },
);

/** Whether the editor is showing changes, and since what. */
export function comparingWith(state: EditorState): string | null {
  return state.field(compareField, false)?.label ?? null;
}

export const compareChanges = [compareField, recomputeAfterTyping];

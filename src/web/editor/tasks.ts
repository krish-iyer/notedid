import { syntaxTree } from '@codemirror/language';
import type { ChangeSpec, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { localISODate } from '../../shared/dates.ts';
import { toggleTaskLine } from '../../shared/tasks.ts';

const CHECKED_MARKER = /^\[[xX]\]$/;
/** A ticked task's text: struck through and greyed. */
const doneText = Decoration.mark({ class: 'cm-task-done' });
const LIST_ITEM_PREFIX = /^(\s*(?:[-*+]|\d+[.)])\s+)/;

/** A real checkbox drawn over a task marker ("[ ]" or "[x]"). The text stays plain markdown. */
class CheckboxWidget extends WidgetType {
  readonly checked: boolean;

  constructor(checked: boolean) {
    super();
    this.checked = checked;
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.className = 'cm-task-checkbox';
    box.setAttribute('aria-label', this.checked ? 'Done. Mark as not done' : 'Not done. Mark as done');
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function checkboxDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'TaskMarker') return;
        const checked = CHECKED_MARKER.test(view.state.doc.sliceString(node.from, node.to));
        ranges.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to));
        // The task's text runs to the end of its paragraph (the Task node holds the marker and the text).
        const textEnd = node.node.parent?.name === 'Task' ? node.node.parent.to : view.state.doc.lineAt(node.to).to;
        const textStart = node.to + (view.state.doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0);
        if (checked && textEnd > textStart) ranges.push(doneText.range(textStart, textEnd));
      },
    });
  }
  return Decoration.set(ranges, true);
}

/** Ticks or unticks the task on the line at `pos` (adding or removing done:<date>). */
function toggleLineAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos);
  const next = toggleTaskLine(line.text, localISODate());
  if (next === null) return false;
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next }, userEvent: 'input.toggle-task' });
  return true;
}

/** Shows task markers as checkboxes. Clicking one ticks the task and records the day. */
export const taskCheckboxes = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = checkboxDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = checkboxDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.classList.contains('cm-task-checkbox')) return false;
        event.preventDefault();
        return toggleLineAt(view, view.posAtDOM(target));
      },
    },
  },
);

/**
 * Mod-Enter: tick or untick the task on each selected line. A list item becomes a task,
 * and any other line becomes "- [ ] line".
 */
export function toggleTask(view: EditorView): boolean {
  const changes: ChangeSpec[] = [];
  const seenLines = new Set<number>();
  const today = localISODate();
  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.head);
    if (seenLines.has(line.number)) continue;
    seenLines.add(line.number);

    const toggled = toggleTaskLine(line.text, today);
    if (toggled !== null) {
      changes.push({ from: line.from, to: line.to, insert: toggled });
      continue;
    }
    const item = LIST_ITEM_PREFIX.exec(line.text);
    if (item) {
      changes.push({ from: line.from + (item[1] ?? '').length, insert: '[ ] ' });
    } else {
      const indent = line.text.length - line.text.trimStart().length;
      changes.push({ from: line.from + indent, insert: '- [ ] ' });
    }
  }
  view.dispatch({ changes, userEvent: 'input.toggle-task' });
  return true;
}

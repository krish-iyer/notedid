import { useState } from 'react';
import type { TaskItem } from '../../shared/api.ts';
import { journalDateOf, relativeDayLabel } from '../../shared/dates.ts';
import { dueState } from '../../shared/tasks.ts';
import { api } from '../api.ts';
import { Link, noteHref } from '../router.ts';
import { showToast } from '../toast.ts';
import { messageOf } from '../util.ts';

/** A task's text without its due:/done: markers (shown as badges instead) and with [[links]] unwrapped. */
export function taskLabel(text: string): string {
  return text
    .replace(/(?:^|\s)(?:due|done):\d{4}-\d{2}-\d{2}(?=\s|$)/g, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .trim();
}

/** One task, with a checkbox that ticks it in its note, and a link to where it lives. */
export function TaskRow({ task, today, showSource = true }: { task: TaskItem; today: string; showSource?: boolean }) {
  const [done, setDone] = useState(task.done);
  const [busy, setBusy] = useState(false);
  const state = dueState(task.due, today);
  const sourceDate = journalDateOf(task.path);

  const toggle = async () => {
    setBusy(true);
    setDone(!done);
    try {
      await api.toggleTask(task, today);
    } catch (err) {
      setDone(done);
      showToast(`Could not update the task: ${messageOf(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={done ? 'task-row done' : 'task-row'}>
      <input type="checkbox" checked={done} disabled={busy} onChange={() => void toggle()} aria-label={done ? `Mark “${taskLabel(task.text)}” as not done` : `Mark “${taskLabel(task.text)}” as done`} />
      <span className="task-text">{taskLabel(task.text) || task.text}</span>
      {task.due && !done && <span className={`due due-${state}`}>{relativeDayLabel(task.due, today)}</span>}
      {done && task.doneDate && <span className="due">done {relativeDayLabel(task.doneDate, today)}</span>}
      {showSource && (
        <Link to={noteHref(task.path, undefined, `L${task.line}`)} className="task-source">
          {sourceDate ?? task.title}
        </Link>
      )}
    </li>
  );
}

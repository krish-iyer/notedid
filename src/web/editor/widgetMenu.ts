/** A small menu of buttons, used by widgets in the editor (a table cell's menu, a card value's menu). */

export interface MenuEntry {
  label: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** For a choice between values: whether this one is the current value. */
  checked?: boolean;
  /** Extra classes on the button, e.g. a colour. */
  className?: string;
}

export function menuElement(entries: readonly (MenuEntry | 'line')[]): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'cm-md-menu';
  menu.setAttribute('role', 'menu');
  for (const entry of entries) {
    if (entry === 'line') {
      menu.append(document.createElement('hr'));
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.label;
    button.disabled = entry.disabled ?? false;
    button.className = [entry.danger ? 'danger' : '', entry.className ?? ''].filter(Boolean).join(' ');
    if (entry.checked === undefined) {
      button.setAttribute('role', 'menuitem');
    } else {
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(entry.checked));
    }
    // Keep the focus where it is (a table cell, the editor) while using the menu.
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', entry.run);
    menu.append(button);
  }
  // Up and down arrows move between the items.
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  return menu;
}

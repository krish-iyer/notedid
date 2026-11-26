import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.tsx';

export interface MenuItem {
  label: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A small menu behind an icon button (rename, move, delete…). */
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="popover-wrap" ref={root}>
      <button type="button" className={open ? 'icon-button pressed' : 'icon-button'} aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="menu" size={15} />
      </button>
      {open && (
        <div className="popover menu" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'popover-item danger' : 'popover-item'}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

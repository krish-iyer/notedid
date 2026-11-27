import { useEffect, useRef, useState } from 'react';
import { localISODate } from '../shared/dates.ts';
import { onServerEvent } from './live.ts';

/** Today's date, kept right when the app stays open past midnight. */
export function useToday(): string {
  const [today, setToday] = useState(localISODate);
  useEffect(() => {
    const id = setInterval(() => setToday(localISODate()), 60_000);
    return () => clearInterval(id);
  }, []);
  return today;
}

/**
 * Loads data with `load`, and loads it again (debounced) whenever notes change on the server.
 * Returns the data (null until loaded), any error, and a reload function.
 */
export function useLiveData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(load);
  latest.current = load;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    latest
      .current()
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onServerEvent((event) => {
      if (event.type === 'changed' || event.type === 'deleted') {
        clearTimeout(timer);
        timer = setTimeout(() => setTick((t) => t + 1), 400);
      }
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);

  return { data, error, reload: () => setTick((t) => t + 1) };
}

/** A value that follows `value` after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/** Whether a CSS media query matches, kept up to date. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** Phone width: the menu for selected text and the comment box become sheets along the screen's edges. */
export const PHONE = '(max-width: 600px)';
/** Too narrow for a note's side panel beside it: the panel opens from a button instead. */
export const NO_SIDE_PANEL = '(max-width: 1180px)';

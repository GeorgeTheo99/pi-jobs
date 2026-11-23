import { useCallback, useEffect, useRef, useState } from "react";
import { CHANGED_EVENT } from "./api";

type Interval<T> = number | null | ((latest: T | null) => number | null);

/**
 * Loads data now, then again after each interval while the page is visible.
 * `interval` may be null (load once) or a function of the latest data, so polling can stop
 * once there is nothing left to watch.
 */
export function usePoll<T>(load: () => Promise<T>, interval: Interval<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  const intervalRef = useRef(interval);
  useEffect(() => {
    loadRef.current = load;
    intervalRef.current = interval;
  });

  const fetchOnce = useCallback(async (): Promise<T | null> => {
    try {
      const latest = await loadRef.current();
      setData(latest);
      setError(null);
      return latest;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const loop = async (fetch: boolean, previous: T | null) => {
      const latest = fetch ? await fetchOnce() : previous;
      if (stopped) return;
      const current = intervalRef.current;
      const ms = typeof current === "function" ? current(latest) : current;
      if (ms === null) return;
      timer = window.setTimeout(() => void loop(document.visibilityState === "visible", latest), ms);
    };
    void loop(true, null);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchOnce, ...deps]);

  return { data, error, refresh: fetchOnce, setData };
}

/** Calls `refresh` whenever the app changes something on the server. */
export function useRefreshOnChange(refresh: () => unknown) {
  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener(CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CHANGED_EVENT, onChange);
  }, [refresh]);
}

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

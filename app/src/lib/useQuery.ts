import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { realtime } from './realtime';

/**
 * Loads a GET endpoint and reloads it when one of `refreshOn` realtime
 * events arrives (and after a reconnect), so screens stay current without
 * polling.
 */
export function useQuery<T>(path: string | null, refreshOn: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!path);
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const res = await api<T>('GET', p);
      if (pathRef.current === p) {
        setData(res);
        setError(null);
      }
    } catch (err) {
      if (pathRef.current === p) setError(err);
    } finally {
      if (pathRef.current === p) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(!!path);
    setData(null);
    void reload();
  }, [path, reload]);

  const events = refreshOn.join(',');
  useEffect(() => {
    if (!events) return;
    const set = new Set([...events.split(','), 'reconnected']);
    return realtime.subscribe((e) => {
      if (set.has(e.type)) void reload();
    });
  }, [events, reload]);

  return { data, error, loading, reload, setData };
}

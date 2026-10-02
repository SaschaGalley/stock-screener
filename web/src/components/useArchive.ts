import { useEffect, useState } from 'react';

/**
 * One archive view, loaded when its section mounts — a closed section costs
 * nothing — and reloaded when the stock or the arguments change.
 * `undefined` while loading, `null` when there is nothing archived.
 */
export function useArchive<T>(load: () => Promise<{ data: T | null }>, deps: unknown[]): { data: T | null | undefined; error: string | null } {
  const [data, setData] = useState<T | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
    load()
      .then((r) => { if (live) setData(r.data); })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

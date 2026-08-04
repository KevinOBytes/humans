"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * Reads the current query string after hydration without putting action
 * credentials into server-component props or a server-rendered cache.
 */
export function useLocationSearch(): string | null {
  return useSyncExternalStore<string | null>(
    subscribe,
    () => window.location.search,
    () => null,
  );
}

export function useLocationHash(): string | null {
  return useSyncExternalStore<string | null>(
    subscribe,
    () => window.location.hash,
    () => null,
  );
}

export function useEphemeralHashParam(name: string): {
  ready: boolean;
  value: string | null;
} {
  const [captured, setCaptured] = useState<{
    ready: boolean;
    value: string | null;
  }>({ ready: false, value: null });

  useEffect(() => {
    let active = true;
    const parameters = new URLSearchParams(
      window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "",
    );
    const value = parameters.get(name)?.trim() || null;
    const scrub = () =>
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    scrub();
    queueMicrotask(() => {
      if (active) setCaptured({ ready: true, value });
    });
    return () => {
      active = false;
      scrub();
    };
  }, [name]);

  return captured;
}

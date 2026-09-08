"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

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
  const capturedValue = useRef<{ name: string; value: string | null } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    let value: string | null;
    if (capturedValue.current?.name === name) {
      value = capturedValue.current.value;
    } else {
      const hashParameters = new URLSearchParams(
        window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : "",
      );
      const parameters = hashParameters.has(name)
        ? hashParameters
        : new URLSearchParams(window.location.search);
      value = parameters.get(name)?.trim() || null;
      capturedValue.current = { name, value };
    }
    const scrub = () => {
      const searchParameters = new URLSearchParams(window.location.search);
      searchParameters.delete(name);
      const search = searchParameters.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search ? `?${search}` : ""}`,
      );
    };
    scrub();
    queueMicrotask(() => {
      if (active) setCaptured({ ready: true, value });
    });
    return () => {
      active = false;
    };
  }, [name]);

  return captured;
}

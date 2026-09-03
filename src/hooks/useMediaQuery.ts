"use client";

/**
 * Read a CSS media query from React.
 *
 * Uses useSyncExternalStore rather than an effect writing to state. The server
 * snapshot is the second callback, so the markup rendered on the server is
 * well defined and React reconciles to the real value on hydration -- no
 * mismatch warning, and no flash of the wrong layout that an effect would
 * produce a frame later.
 */
import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string, serverFallback = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverFallback,
  );
}

/** True on phone-width viewports. Matches Tailwind's `sm` breakpoint. */
export function useIsNarrowViewport(): boolean {
  return useMediaQuery("(max-width: 639px)");
}

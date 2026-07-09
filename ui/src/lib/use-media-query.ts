import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and re-render on match changes. SPA-only
 * (window always exists) but guards SSR defensively. Used for the desktop
 * responsive breakpoints of the shell (sidebar auto-collapse, session-rail
 * auto-hide) — distinct from the vendored `useIsMobile` (a fixed 768px hook the
 * shadcn sidebar block owns for its mobile sheet).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

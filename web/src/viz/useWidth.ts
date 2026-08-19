import { useEffect, useRef, useState } from "react";

/**
 * Measure a container so charts can be drawn at TRUE pixel scale.
 *
 * Why this exists: an SVG with a fixed viewBox scales its text along with its
 * box. Charts drawn at a 520-unit viewBox and rendered into a 415px card had
 * their 10.5px axis labels come out at 8.4px, while the same chart in an 886px
 * card rendered them at 17.9px — two different type scales on one page, which is
 * exactly what read as "janky".
 *
 * Setting the viewBox to the measured width makes the scale factor 1, so a font
 * size means what it says everywhere.
 */
export function useWidth<T extends HTMLElement>(fallback = 520): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

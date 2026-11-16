"use client";

import { useEffect, useRef } from "react";

/** The count's length and curve (docs/design-system.md, behaviour rule 13). */
const DURATION_MS = 1200;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/**
 * The one count-up the product allows: a headline figure counts from zero on first paint, 1200 ms,
 * cubic ease-out (docs/design-system.md, behaviour rule 13).
 *
 * The figure's own text is the final value from the first byte, so a reader, a screen reader, a
 * test, a copy and a print all get the real number. While it counts, that text is painted
 * transparent and the moving figure is drawn over it from `data-display` by CSS (`.count-up` in
 * app/globals.css): the moving digits never enter the text or the accessibility tree. That CSS
 * applies only with scripting on and no reduced-motion preference, so otherwise nothing moves; and
 * it lets go after three seconds by itself, so a script that never runs cannot leave a wrong figure
 * on screen.
 */
export function CountUp({
  value,
  text,
  decimals = 0,
  prefix = "",
  className = "",
  testId,
}: {
  /** The final value in display units (dollars, not cents). */
  value: number;
  /** The final value as the server formats it: the element's text. */
  text: string;
  /** Fraction digits of the moving figure, to match `text`. */
  decimals?: number;
  /** Written before the moving figure, e.g. "$". */
  prefix?: string;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    // Counted once per mount: a new value arriving later (another period) is shown as it is.
    if (!el || el.hasAttribute("data-counted")) return;
    // `data-counted` ends the count: the CSS stops painting over the real figure.
    const settle = () => el.setAttribute("data-counted", "");
    if (!(value > 0) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      settle();
      return;
    }
    const format = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / DURATION_MS, 1);
      el.setAttribute("data-display", `${prefix}${format.format(value * easeOutCubic(t))}`);
      if (t < 1) frame = requestAnimationFrame(tick);
      else settle();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, decimals, prefix]);

  return (
    // data-display starts at zero in the server's HTML, so the first paint already counts from 0.
    <span ref={ref} className={`count-up ${className}`} data-display={`${prefix}${(0).toFixed(decimals)}`} data-testid={testId}>
      <span className="count-up-value">{text}</span>
    </span>
  );
}

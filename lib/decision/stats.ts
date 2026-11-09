/**
 * Small, dependency-free statistics for the Decision Lab. Everything random is driven by a
 * seeded generator, so the same inputs always produce the same interval: a number on screen
 * can be reproduced in a test or a review months later.
 */

/** 32-bit FNV-1a. Used only to turn a parameter set into a seed, not for security. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, well-mixed 32-bit PRNG. Returns uniforms in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw (Box–Muller). `1 - u` keeps the log argument in (0, 1]. */
export function normal(next: () => number): number {
  const u = 1 - next();
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma(shape, 1) draw, Marsaglia & Tsang (2000). For shape < 1 the standard boost is used:
 * Gamma(a) = Gamma(a + 1) · U^(1/a).
 */
export function gamma(next: () => number, shape: number): number {
  if (!(shape > 0)) throw new RangeError(`gamma shape must be > 0, got ${shape}`);
  if (shape < 1) return gamma(next, shape + 1) * Math.pow(1 - next(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(next);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - next();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Complementary error function, Numerical Recipes `erfcc` (Chebyshev fit, |error| < 1.2e-7
 * everywhere). Precise enough for p-values reported to three significant figures.
 */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 +
        t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Two-sided normal tail: P(|Z| ≥ |z|). */
export function twoSidedP(z: number): number {
  return Math.min(1, erfc(Math.abs(z) / Math.SQRT2));
}

/** z for a two-sided 95% interval. */
export const Z95 = 1.959963984540054;

export interface SampleRatioTest {
  expectedShareA: number;
  observedShareA: number | null;
  chiSquare: number;
  /** One degree of freedom: P(χ²₁ ≥ x) = erfc(√(x/2)). */
  pValue: number;
}

/**
 * Sample-ratio-mismatch check: does the observed split match the designed one? A χ² goodness
 * of fit on two cells. A tiny p-value means assignment or logging is broken and every outcome
 * comparison built on top of it is untrustworthy.
 */
export function sampleRatioTest(nA: number, nB: number, expectedShareA = 0.5): SampleRatioTest {
  const n = nA + nB;
  if (n === 0) return { expectedShareA, observedShareA: null, chiSquare: 0, pValue: 1 };
  const eA = n * expectedShareA;
  const eB = n * (1 - expectedShareA);
  const chiSquare = (nA - eA) ** 2 / eA + (nB - eB) ** 2 / eB;
  return { expectedShareA, observedShareA: nA / n, chiSquare, pValue: Math.min(1, erfc(Math.sqrt(chiSquare / 2))) };
}

export interface ProportionDiff {
  rateA: number | null;
  rateB: number | null;
  /** rateB − rateA */
  difference: number | null;
  standardError: number | null;
  ci95: [number, number] | null;
  pValue: number | null;
  /** Smallest true difference this sample would detect with 80% power at α = 0.05 (2.8 · SE). */
  minimumDetectableEffect: number | null;
}

/**
 * Difference of two independent proportions with an unpooled Wald 95% interval. Adequate for the
 * arm sizes here (hundreds of units, rates far from 0 and 1); the result says so when it is not.
 */
export function proportionDiff(xA: number, nA: number, xB: number, nB: number): ProportionDiff {
  if (nA === 0 || nB === 0) {
    return { rateA: nA ? xA / nA : null, rateB: nB ? xB / nB : null, difference: null, standardError: null, ci95: null, pValue: null, minimumDetectableEffect: null };
  }
  const pA = xA / nA;
  const pB = xB / nB;
  const se = Math.sqrt((pA * (1 - pA)) / nA + (pB * (1 - pB)) / nB);
  const difference = pB - pA;
  return {
    rateA: pA,
    rateB: pB,
    difference,
    standardError: se,
    ci95: [difference - Z95 * se, difference + Z95 * se],
    pValue: se > 0 ? twoSidedP(difference / se) : difference === 0 ? 1 : 0,
    minimumDetectableEffect: 2.8 * se,
  };
}

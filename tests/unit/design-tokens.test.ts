import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.2 AA contrast for the design tokens in app/globals.css: every text colour on every
 * surface it is used on, 4.5:1 for normal text (the app's small labels make that the floor
 * everywhere), and 3:1 for non-text UI (borders that mark a control, the focus ring).
 */

const css = readFileSync(path.join(__dirname, "../../app/globals.css"), "utf8");
const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
const token = (name: string): string => {
  const m = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found (or not a 6-digit hex)`);
  return m[1];
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_ON: Array<[string, string[]]> = [
  ["text", ["surface", "bg", "surface-2", "surface-sunken"]],
  ["muted", ["surface", "bg", "surface-2", "surface-sunken"]],
  ["faint", ["surface", "bg", "surface-2"]],
  ["accent", ["surface", "bg", "surface-2", "accent-soft"]],
  ["bad", ["surface", "bad-soft"]],
  ["warn", ["surface", "warn-soft"]],
  ["good", ["surface", "good-soft"]],
  ["shell-text", ["shell", "shell-raised"]],
  ["shell-muted", ["shell", "shell-raised"]],
];

describe("design tokens · contrast", () => {
  for (const [fg, backgrounds] of TEXT_ON) {
    for (const bg of backgrounds) {
      it(`--${fg} on --${bg} is at least 4.5:1`, () => {
        expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("white on the accent (primary buttons) is at least 4.5:1", () => {
    expect(contrast("#ffffff", token("accent"))).toBeGreaterThanOrEqual(4.5);
  });

  it("white on the shell is at least 4.5:1", () => {
    expect(contrast("#ffffff", token("shell"))).toBeGreaterThanOrEqual(4.5);
  });

  it("the focus ring (accent) and control borders reach 3:1 against the surface", () => {
    expect(contrast(token("accent"), token("surface"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("accent"), token("bg"))).toBeGreaterThanOrEqual(3);
  });

  it("chart colours that carry meaning reach 3:1 against the surface (non-text graphics)", () => {
    for (const c of ["chart-paid", "chart-unknown", "chart-good"]) expect(contrast(token(c), token("surface")), c).toBeGreaterThanOrEqual(3);
  });
});

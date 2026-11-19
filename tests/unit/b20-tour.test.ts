import { describe, expect, it } from "vitest";
import { B09_STEPS, GUIDE_ID } from "@/lib/demo/b09-path";
import { B20_TOUR, TOUR_ID, TOUR_QUESTION, tourHref, tourPlace, tourQuery, tourStepAt } from "@/lib/demo/b20-tour";
import { NAV } from "@/lib/nav";

/**
 * The visitor tour (lib/demo/b20-tour.ts): seven read-only steps through B20's finished repair,
 * the hosted demo's guided path (sharing review, 2026-11-19).
 */
describe("the visitor tour", () => {
  it("has seven steps, numbered in order, each with words to show", () => {
    expect(B20_TOUR.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(B20_TOUR.map((s) => s.key)).toEqual(["result", "why", "evidence", "records", "approval", "investigator", "decision"]);
    for (const s of B20_TOUR) {
      expect(s.title.length, s.key).toBeGreaterThan(3);
      expect(s.look.length, s.key).toBeGreaterThan(10);
      expect(s.says.length, s.key).toBeGreaterThan(40);
    }
  });

  it("says no figure: every figure is on the page a step opens, read from the stored receipt", () => {
    // B20 is the branch's name and 24 hours the workspace's rule; neither is a figure from the data.
    for (const s of B20_TOUR) {
      const words = [s.title, s.look, s.says, s.answered?.look ?? "", s.answered?.says ?? ""].join(" ");
      expect(words.replace(/B20/g, "").replace(/24 hours/g, ""), s.key).not.toMatch(/[0-9$%]/);
    }
  });

  it("is its own guide, apart from the B09 presenter path", () => {
    expect(TOUR_ID).not.toBe(GUIDE_ID);
    expect(B09_STEPS).toHaveLength(8);
  });

  it("builds each step's link with the tour's place, before the section to open", () => {
    expect(tourHref(B20_TOUR[0], 1063)).toBe("/exceptions/1063?guide=b20&step=1&incident=1063#fix-result");
    expect(tourHref(B20_TOUR[1], 1063)).toBe("/exceptions/1063?guide=b20&step=2&incident=1063#fix-result");
    expect(tourHref(B20_TOUR[2], 1063)).toBe("/exceptions/1063?guide=b20&step=3&incident=1063#evidence");
    expect(tourHref(B20_TOUR[3], 1063)).toBe("/exceptions/1063?guide=b20&step=4&incident=1063#records");
    expect(tourHref(B20_TOUR[4], 1063)).toBe("/exceptions/1063?guide=b20&step=5&incident=1063#case-audit");
    expect(tourHref(B20_TOUR[6], 7)).toBe("/decisions?branch=B20&period=oct&guide=b20&step=7&incident=7");
  });

  it("pre-fills the investigator with the walkthrough's question, encoded", () => {
    const href = tourHref(B20_TOUR[5], 1063);
    expect(href).toBe(`/investigator?q=${encodeURIComponent(TOUR_QUESTION)}&guide=b20&step=6&incident=1063`);
    expect(new URL(href, "http://x").searchParams.get("q")).toBe("Why did B20's CAC jump in October?");
  });

  it("reads its place back from a page's search params", () => {
    expect(tourQuery(6, 1063)).toBe("?guide=b20&step=6&incident=1063");
    const place = tourPlace(Object.fromEntries(new URLSearchParams(tourQuery(6, 1063))));
    expect(place?.step.key).toBe("investigator");
    expect(place?.incidentId).toBe(1063);
  });

  it("is off for any other guide, a step it does not have, or an incident that is not an id", () => {
    expect(tourPlace({ guide: "b09", step: "1", incident: "1063" })).toBeNull();
    expect(tourPlace({ step: "1", incident: "1063" })).toBeNull();
    for (const step of ["0", "8", "-1", "1.5", "x", undefined]) expect(tourPlace({ guide: "b20", step, incident: "1063" }), String(step)).toBeNull();
    for (const incident of ["0", "-3", "abc", "1e3", "12345678901234", "", undefined]) expect(tourPlace({ guide: "b20", step: "1", incident }), String(incident)).toBeNull();
    expect(tourStepAt(0)).toBeNull();
    expect(tourStepAt(8)).toBeNull();
  });

  it("is reached from the top of the navigation, before any group", () => {
    expect(NAV[0]).toMatchObject({ href: "/start", label: "Start here", group: "Start" });
    expect(NAV.filter((n) => n.group === "Start")).toHaveLength(1);
  });
});

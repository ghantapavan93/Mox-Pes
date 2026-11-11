import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { setRole } from "./action-center";

/**
 * Stages one of the synthetic exports in public/samples through POST /api/onboarding/uploads
 * (the same request the page makes) and, with `dryRun`, proposes the assistant's suggestions
 * plus the standard answers and dry-runs them. Returns the workspace URL.
 */
export async function stageSample(page: Page, file: string, opts: { dryRun?: boolean; answers?: Record<string, unknown> } = {}): Promise<string> {
  await setRole(page, "marketing");
  const bytes = readFileSync(path.join(process.cwd(), "public", "samples", file));
  const res = await page.request.post("/api/onboarding/uploads", { headers: { "x-filename": encodeURIComponent(file), "content-type": "application/octet-stream" }, data: bytes });
  expect(res.status(), await res.text()).toBe(201);
  const { upload } = (await res.json()) as { upload: { id: number } };
  if (opts.dryRun) {
    const detail = (await (await page.request.get(`/api/onboarding/uploads/${upload.id}`)).json()) as {
      assistant: { dataset: { chosen: string }; fields: Array<{ field: string; status: string; column: string | null }> };
      values: Record<string, Array<{ value: string; proposed: string | null }>>;
    };
    const spec = {
      dataset: detail.assistant.dataset.chosen,
      columns: Object.fromEntries(detail.assistant.fields.map((f) => [f.field, f.status === "suggested" ? f.column : null])),
      constants: {},
      valueMaps: Object.fromEntries(Object.entries(detail.values).map(([k, v]) => [k, Object.fromEntries(v.filter((x) => x.proposed).map((x) => [x.value, x.proposed]))])),
      dateOrder: "MDY",
      localTime: "branch_local",
      moneyMeaning: {},
      exportedAt: null,
      ...opts.answers,
    };
    const m = await page.request.post(`/api/onboarding/uploads/${upload.id}/mappings`, { data: { spec } });
    const mapping = (await m.json()) as { mappingId: number; problems: unknown[] };
    expect(mapping.problems, JSON.stringify(mapping.problems)).toEqual([]);
    const d = await page.request.post(`/api/onboarding/uploads/${upload.id}/dry-run`, { data: { mappingId: mapping.mappingId } });
    expect(d.status(), await d.text()).toBe(200);
  }
  return `/onboarding/${upload.id}`;
}

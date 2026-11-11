import { describe, expect, it } from "vitest";
import { redactValue } from "@/lib/adapters/redact";
import { compileRows, validateSpec, type MappingSpec } from "@/lib/onboarding/compile";
import { isRefusal, parseUpload, type ParsedTable, type ParseRefusal } from "@/lib/onboarding/parse";
import { classify, profileColumn } from "@/lib/onboarding/profile";
import { parseDateValue, parseMoneyText } from "@/lib/onboarding/values";
import { excelSerialToWallTime } from "@/lib/onboarding/xlsx";
import { workbook } from "../xlsx-builder";

/**
 * Regressions for the two independent reviews of the onboarding pipeline
 * (docs/agent-work/REVIEW-FINDINGS.md). Each test uses the reviewer's own counterexample;
 * "D" is the data-correctness review, "S" the security review.
 */
const ok = (r: ParsedTable | ParseRefusal): ParsedTable => {
  if (isRefusal(r)) throw new Error(`refused ${r.code}: ${r.message}`);
  return r;
};
const csv = (text: string) => parseUpload({ filename: "x.csv", bytes: Buffer.from(text, "utf8") });
const sheet = (rowsXml: string) => `<?xml version="1.0"?><worksheet><sheetData>${rowsXml}</sheetData></worksheet>`;
const xlsx = (opts: Parameters<typeof workbook>[2]) => parseUpload({ filename: "x.xlsx", bytes: workbook([{ name: "S", rows: [["a"]] }], [], opts) });
const NOW = new Date("2026-11-10T00:00:00Z");

describe("data review", () => {
  it("D1: an unterminated quote is refused instead of swallowing the rest of the file", () => {
    expect(csv('id,note,amt\n1,"abc,3\n2,def,4\n3,ghi,5\n')).toMatchObject({ refused: true, code: "UNTERMINATED_QUOTE" });
  });

  it("D2: a date-only Excel cell reads as a date, not a date at an invented midnight", () => {
    expect(excelSerialToWallTime(46082, "date")).toBe("2026-03-01");
    expect(excelSerialToWallTime(46082.75, "datetime")).toBe("2026-03-01 18:00:00");
    expect(excelSerialToWallTime(0.5, "time")).toBe("12:00:00");
    const t = ok(xlsx({ sheetXml: sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>Start</t></is></c><c r="B1" t="inlineStr"><is><t>Id</t></is></c></row><row r="2"><c r="A2" s="1"><v>46082</v></c><c r="B2" t="inlineStr"><is><t>C1</t></is></c></row>`) }));
    expect(t.rows[0][0]).toBe("2026-03-01");
  });

  it("D3: a header with blank names is still the header; the first data row is kept", () => {
    const t = ok(csv("call_id,started,,\nC1,Dallas,Google Ads,note one\nC2,Austin,Bing,note two\n"));
    expect(t.columns.slice(0, 2)).toEqual(["call_id", "started"]);
    expect(t.rows).toHaveLength(2);
  });

  it("D4: empty trailing cells (a trailing comma, a formatted empty Excel cell) do not make a row ragged", () => {
    expect(ok(csv("a,b\n1,2,\n3,4\n")).raggedRows).toEqual([]);
    const t = ok(xlsx({ sheetXml: sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>P</t></is></c><c r="B1" t="inlineStr"><is><t>Amt</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>P1</t></is></c><c r="B2"><v>12.5</v></c><c r="C2" s="1"/></row>`) }));
    expect(t.raggedRows).toEqual([]);
    expect(t.rows[0]).toEqual(["P1", "12.5"]);
  });

  const callsTable = (rows: string[][]): ParsedTable => ({
    format: "csv", filename: "x.csv", columns: ["Call ID", "Start", "Branch", "Phone", "Source"], sourceHeaders: ["Call ID", "Start", "Branch", "Phone", "Source"],
    rows, rowRefs: rows.map((_, i) => i + 2), raggedRows: [], sheet: null, encoding: "utf-8", delimiter: ",", warnings: [],
  });
  const callsSpec = (extra: Partial<MappingSpec> = {}): MappingSpec => ({
    dataset: "calls", columns: { call_id: "Call ID", started_at: "Start", branch: "Branch", caller_phone: "Phone", call_source: "Source" },
    constants: {}, valueMaps: {}, dateOrder: null, localTime: "branch_local", moneyMeaning: {}, exportedAt: null, ...extra,
  });

  it("D8: a translation to a branch that does not exist is a spec problem, and an impossible offset a row issue, never a crash", () => {
    const table = callsTable([["C1", "2026-11-02T10:00:00+25:00", "Dallas North", "+13125550101", "Direct"]]);
    expect(validateSpec(callsSpec({ valueMaps: { branch: { "Dallas North": "B99" } } }), table).map((p) => p.code)).toEqual(["INVALID_TRANSLATION"]);
    const out = compileRows(table, callsSpec({ valueMaps: { branch: { "Dallas North": "B17" } } }), NOW);
    expect(out[0]).toMatchObject({ disposition: "invalid", issues: [expect.objectContaining({ code: "IMPOSSIBLE_DATE" })] });
    expect(parseDateValue("2026-03-02T10:00:00+15:00", null)).toMatchObject({ ok: false, code: "IMPOSSIBLE_DATE" });
  });

  it("D8: money cannot come from a fixed value, which would skip the meaning check", () => {
    const table: ParsedTable = { ...callsTable([]), columns: ["P"], sourceHeaders: ["P"], rows: [["1"]], rowRefs: [2] };
    const spec = { dataset: "crm_payments", columns: {}, constants: { amount: "100.00" }, valueMaps: {}, dateOrder: null, localTime: null, moneyMeaning: {}, exportedAt: null } as MappingSpec;
    expect(validateSpec(spec, table).map((p) => p.code)).toContain("CONSTANT_NOT_ALLOWED");
  });

  it("D9: a campaign whose name starts with \"Total\" is data, not a report total", () => {
    const table: ParsedTable = {
      format: "csv", filename: "x.csv", columns: ["Campaign", "Campaign ID", "Day", "Cost", "Clicks", "Conversions"], sourceHeaders: ["Campaign", "Campaign ID", "Day", "Cost", "Clicks", "Conversions"],
      rows: [["Total Home Protection - Dallas", "9001", "2026-11-01", "$120.00", "10", "1"], ["Total: Account", "", "", "$120.00", "10", "1"]],
      rowRefs: [2, 3], raggedRows: [], sheet: null, encoding: "utf-8", delimiter: ",", warnings: [],
    };
    const spec: MappingSpec = {
      dataset: "ad_spend", columns: { campaign_name: "Campaign", campaign_id: "Campaign ID", date: "Day", cost: "Cost", clicks: "Clicks", conversions: "Conversions" },
      constants: { platform: "google_ads", account_id: "111" }, valueMaps: {}, dateOrder: null, localTime: null, moneyMeaning: { cost: "ad_cost" }, exportedAt: "2026-11-05T00:00:00Z",
    };
    expect(compileRows(table, spec, NOW).map((o) => (o.disposition === "invalid" ? o.issues[0].code : o.disposition))).toEqual(["eligible", "SUMMARY_ROW"]);
  });

  it("D10: 1904-dated workbooks and cells without a reference are read correctly", () => {
    const t = ok(xlsx({ workbookPr: `<workbookPr date1904="1"/>`, sheetXml: sheet(`<row r="1"><c t="inlineStr"><is><t>id</t></is></c><c t="inlineStr"><is><t>day</t></is></c></row><row r="2"><c t="inlineStr"><is><t>A1</t></is></c><c s="1"><v>44620</v></c></row>`) }));
    expect(t.columns).toEqual(["id", "day"]);
    expect(t.rows[0]).toEqual(["A1", "2026-03-01"]);
  });

  it("D11: renamed duplicate headers never collide with a real header", () => {
    expect(ok(csv("Name,Name,Name (2)\n1,2,3\n")).columns).toEqual(["Name", "Name (3)", "Name (2)"]);
  });

  it("D12: more than one negative marker is refused; colliding JSON keys are refused; dashed dates ask for the order", () => {
    for (const v of ["--12.00", "-$-12.00", "(-12.00)"]) expect(parseMoneyText(v)).toMatchObject({ ok: false });
    expect(parseUpload({ filename: "a.json", bytes: Buffer.from('[{"a.b":"flat","a":{"b":"nested"}}]') })).toMatchObject({ refused: true, code: "JSON_KEY_COLLISION" });
    expect(classify("03-04-2026")).toBe("date_ambiguous");
  });
});

describe("security review", () => {
  it("S1: a small workbook that expands to huge text through shared strings is refused", () => {
    const big = "x".repeat(10_000);
    const cells = Array.from({ length: 200 }, (_, c) => `<c r="${String.fromCharCode(65 + (c % 26))}${c}" t="s"><v>0</v></c>`).join("");
    const rows = Array.from({ length: 300 }, (_, r) => `<row r="${r + 1}">${cells}</row>`).join("");
    const r = xlsx({ store: true, sharedXml: `<sst><si><t>${big}</t></si></sst>`, sheetXml: sheet(rows) });
    expect(r).toMatchObject({ refused: true });
    expect((r as ParseRefusal).code).toMatch(/TOO_MUCH_TEXT|CELL_TOO_LARGE/);
  });

  it("S2: unclosed XML elements are refused in linear time", () => {
    const t = Date.now();
    const r = xlsx({ store: true, sharedXml: `<sst>${"<si>".repeat(200_000)}</sst>` });
    expect(r).toMatchObject({ refused: true, code: "CORRUPT_WORKBOOK" });
    expect(Date.now() - t).toBeLessThan(3_000);
  });

  it("S3: whole-value email checks are bounded on hostile values", () => {
    const hostile = `a@${".".repeat(40_000)}@`;
    const t = Date.now();
    redactValue({ caller: hostile });
    classify(hostile);
    expect(Date.now() - t).toBeLessThan(500);
    expect(redactValue({ email: "jo.smith@mail.example.com" })).toMatchObject({ email: expect.stringMatching(/^h:email:/) });
  });

  it("S6: thousands of ragged rows produce a capped warning list", () => {
    const t = ok(csv(`a,b\n${"1,2,3\n".repeat(5_000)}`));
    expect(t.raggedRows).toHaveLength(5_000);
    expect(t.warnings.length).toBeLessThanOrEqual(21);
    expect(t.warnings.at(-1)?.message).toMatch(/4,980 more RAGGED_ROW/);
  });

  it("S7: a CSV past the row limit is refused while parsing, not after", () => {
    expect(csv(`a\n${"1\n".repeat(50_100)}`)).toMatchObject({ refused: true, code: "TOO_MANY_ROWS" });
  });

  it("S8: a column of distinct short values (names, addresses) never stores its values", () => {
    const p = profileColumn("Customer", 0, ["DOE, JANE", "ROE, RICHARD", "POE, EDGAR", "LOE, ANN"]);
    expect(p.topValues).toBeNull();
    expect(profileColumn("Status", 0, ["paid", "paid", "void", "paid"]).topValues).toEqual([{ value: "paid", count: 3 }, { value: "void", count: 1 }]);
  });
});

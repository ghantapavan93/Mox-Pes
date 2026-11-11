import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileRows, type MappingSpec } from "@/lib/onboarding/compile";
import { LIMITS } from "@/lib/onboarding/limits";
import { isRefusal, parseUpload, sanitizeFilename, type ParsedTable, type ParseRefusal } from "@/lib/onboarding/parse";
import { classify, profileTable, slashDateOrder } from "@/lib/onboarding/profile";
import { dollarsToMicros, parseCount, parseDateValue, parseIdentifier, parseMoneyText } from "@/lib/onboarding/values";
import { excelSerialToWallTime } from "@/lib/onboarding/xlsx";
import { workbook, zip } from "../xlsx-builder";

const ok = (r: ParsedTable | ParseRefusal): ParsedTable => {
  if (isRefusal(r)) throw new Error(`refused ${r.code}: ${r.message}`);
  return r;
};
const csv = (text: string, filename = "x.csv") => parseUpload({ filename, bytes: Buffer.from(text, "utf8") });
const holdout = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", "onboarding", "holdout", name));

describe("onboarding parse · CSV", () => {
  it("reads quotes, doubled quotes, delimiters and newlines inside quotes, CRLF", () => {
    const t = ok(csv('a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"line1\nline2",z\r\n'));
    expect(t.columns).toEqual(["a", "b", "c"]);
    expect(t.rows).toEqual([["1", "x, y", 'he said "hi"'], ["2", "line1\nline2", "z"]]);
    expect(t.rowRefs).toEqual([2, 3]);
  });

  it("sniffs a semicolon delimiter and strips a UTF-8 BOM (held-out Meta export)", () => {
    const t = ok(parseUpload({ filename: "meta-spend-semicolon.csv", bytes: holdout("meta-spend-semicolon.csv") }));
    expect(t.delimiter).toBe(";");
    expect(t.columns[0].charCodeAt(0)).not.toBe(0xfeff);
    // The formula-injection cell is kept as text and flagged by the profiler, never evaluated.
    const profile = profileTable(t);
    expect(profile.columns.some((c) => c.formulaLike > 0)).toBe(true);
  });

  it("renames duplicate and blank headers and warns about each", () => {
    const t = ok(csv("Total,,Total\n1,2,3\n"));
    expect(t.columns).toEqual(["Total", "Column 2", "Total (2)"]);
    expect(t.warnings.map((w) => w.code).sort()).toEqual(["BLANK_HEADER", "DUPLICATE_HEADER"]);
  });

  it("keeps ragged rows and reports them by source line", () => {
    const t = ok(csv("a,b\n1,2\n3\n4,5,6\n"));
    expect(t.raggedRows).toEqual([3, 4]);
    expect(t.rows).toHaveLength(3);
  });

  it("skips a report title and date-range line above the header (held-out Google Ads export)", () => {
    const t = ok(parseUpload({ filename: "google-ads-daily.csv", bytes: holdout("google-ads-daily.csv") }));
    expect(t.columns.slice(0, 3)).toEqual(["Day", "Campaign", "Campaign ID"]);
    expect(t.warnings.map((w) => w.code)).toContain("PREAMBLE_SKIPPED");
  });

  it("decodes UTF-16 and reports a guessed Windows-1252 encoding", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("name,city\nJosé,Ñu\n", "utf16le")]);
    expect(ok(parseUpload({ filename: "a.csv", bytes: utf16 })).rows[0]).toEqual(["José", "Ñu"]);
    const cp1252 = Buffer.from([0x6e, 0x2c, 0x63, 0x0a, 0x4a, 0x6f, 0x73, 0xe9, 0x2c, 0x78, 0x0a]); // "n,c\nJos\xe9,x\n"
    const t = ok(parseUpload({ filename: "a.csv", bytes: cp1252 }));
    expect(t.encoding).toBe("windows-1252");
    expect(t.rows[0][0]).toBe("José");
    expect(t.warnings.map((w) => w.code)).toContain("ENCODING_ASSUMED");
  });

  it("refuses binary content, empty files, oversized files and too many columns", () => {
    expect(csv("a,b\n1,\u00002\n")).toMatchObject({ refused: true, code: "BINARY_CONTENT" });
    expect(parseUpload({ filename: "a.csv", bytes: Buffer.alloc(0) })).toMatchObject({ refused: true, code: "EMPTY_FILE" });
    expect(parseUpload({ filename: "a.csv", bytes: Buffer.alloc(LIMITS.maxUploadBytes + 1, 0x61) })).toMatchObject({ refused: true, code: "TOO_LARGE" });
    expect(csv(`${Array.from({ length: LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(",")}\n${"1,".repeat(LIMITS.maxColumns)}1\n`)).toMatchObject({ refused: true, code: "TOO_MANY_COLUMNS" });
    expect(csv("a,b\n")).toMatchObject({ refused: true, code: "NO_ROWS" });
  });
});

describe("onboarding parse · names, formats and content checks", () => {
  it("sanitizes path traversal, control characters and leading dots out of file names", () => {
    expect(sanitizeFilename("../../etc/passwd.csv")).toBe("passwd.csv");
    expect(sanitizeFilename("C:\\Users\\x\\..\\report.csv")).toBe("report.csv");
    expect(sanitizeFilename("..\u0000evil<>.csv")).toBe("evil.csv");
    expect(sanitizeFilename("")).toBe("upload");
    expect(sanitizeFilename("a".repeat(300) + ".csv").length).toBe(120);
  });

  it("refuses macro-enabled, legacy and archive formats by extension, and mismatched content", () => {
    for (const [name, code] of [["a.xlsm", "UNSUPPORTED_FORMAT"], ["a.xls", "UNSUPPORTED_FORMAT"], ["a.zip", "UNSUPPORTED_FORMAT"], ["a.exe", "UNSUPPORTED_FORMAT"]]) {
      expect(parseUpload({ filename: name, bytes: Buffer.from("x") })).toMatchObject({ refused: true, code });
    }
    expect(parseUpload({ filename: "a.xlsx", bytes: Buffer.from("a,b\n1,2\n") })).toMatchObject({ refused: true, code: "CONTENT_MISMATCH" });
    expect(parseUpload({ filename: "a.csv", bytes: workbook([{ name: "S", rows: [["a"], ["1"]] }]) })).toMatchObject({ refused: true, code: "CONTENT_MISMATCH" });
  });
});

describe("onboarding parse · JSON", () => {
  it("reads an envelope, flattens nesting to dotted columns and keeps arrays as flagged text", () => {
    const t = ok(parseUpload({ filename: "a.json", bytes: Buffer.from(JSON.stringify({ data: [{ id: "1", contact: { phone: "x", email: null }, tags: ["a"] }, { id: "2", extra: 5 }] })) }));
    expect(t.columns).toEqual(["id", "contact.phone", "contact.email", "tags", "extra"]);
    expect(t.rows[1]).toEqual(["2", null, null, null, "5"]);
    expect(t.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["JSON_ENVELOPE", "NESTED_ARRAY"]));
  });

  it("refuses invalid and non-tabular JSON", () => {
    expect(parseUpload({ filename: "a.json", bytes: Buffer.from("{nope") })).toMatchObject({ refused: true, code: "INVALID_JSON" });
    expect(parseUpload({ filename: "a.json", bytes: Buffer.from('{"a":1}') })).toMatchObject({ refused: true, code: "JSON_NOT_TABULAR" });
  });

  it("reads the held-out nested web-leads export", () => {
    const t = ok(parseUpload({ filename: "web-leads-nested.json", bytes: holdout("web-leads-nested.json") }));
    expect(t.columns.some((c) => c.includes("."))).toBe(true);
  });
});

describe("onboarding parse · XLSX", () => {
  it("reads shared strings, numbers, date-styled serials and cached formula values", () => {
    const t = ok(parseUpload({ filename: "a.xlsx", bytes: workbook([{ name: "Calls", rows: [["Call ID", "Start", "Cost"], ["C1", { date: 46329.5 }, { formula: "SUM(1,2)", cached: 3 }]] }]) }));
    expect(t.columns).toEqual(["Call ID", "Start", "Cost"]);
    // Style 1 is a date-only format (numFmtId 14): the cell shows a day, so a day is read.
    expect(t.rows[0]).toEqual(["C1", "2026-11-03", "3"]);
    expect(t.warnings.map((w) => w.code)).toContain("FORMULA_CELL");
  });

  it("lists every sheet, reads the chosen one and says which", () => {
    const wb = workbook([{ name: "Summary", rows: [["x", "y"], ["1", "2"]] }, { name: "Payments", rows: [["Payment ID", "Amount"], ["7", "1.00"]] }]);
    const first = ok(parseUpload({ filename: "a.xlsx", bytes: wb }));
    expect(first.sheet).toEqual({ name: "Summary", index: 0, available: ["Summary", "Payments"] });
    expect(first.warnings.map((w) => w.code)).toContain("MULTIPLE_SHEETS");
    expect(ok(parseUpload({ filename: "a.xlsx", bytes: wb, sheetIndex: 1 })).columns).toEqual(["Payment ID", "Amount"]);
    expect(parseUpload({ filename: "a.xlsx", bytes: wb, sheetIndex: 5 })).toMatchObject({ refused: true, code: "NO_SUCH_SHEET" });
  });

  it("refuses macros, ActiveX, external links, encryption and escaping relationship targets", () => {
    const base = [{ name: "S", rows: [["a"], ["1"]] }];
    expect(parseUpload({ filename: "a.xlsx", bytes: workbook(base, [{ name: "xl/vbaProject.bin", data: "x" }]) })).toMatchObject({ refused: true, code: "ACTIVE_CONTENT" });
    expect(parseUpload({ filename: "a.xlsx", bytes: workbook(base, [{ name: "xl/activeX/activeX1.xml", data: "x" }]) })).toMatchObject({ refused: true, code: "ACTIVE_CONTENT" });
    expect(parseUpload({ filename: "a.xlsx", bytes: workbook(base, [{ name: "xl/externalLinks/externalLink1.xml", data: "x" }]) })).toMatchObject({ refused: true, code: "EXTERNAL_LINKS" });
    expect(parseUpload({ filename: "a.xlsx", bytes: zip([{ name: "xl/workbook.xml", data: "x", encrypted: true }]) })).toMatchObject({ refused: true, code: "ENCRYPTED" });
    expect(parseUpload({ filename: "a.xlsx", bytes: workbook(base, [], { sheetTarget: "../../../etc/passwd" }) })).toMatchObject({ refused: true, code: "CORRUPT_WORKBOOK" });
  });

  it("refuses a decompression bomb by its declared ratio, and a lying size by bounded inflation", () => {
    const bomb = Buffer.alloc(20 * 1024 * 1024, 0x41); // 20 MB of "A" deflates to about 20 KB
    expect(parseUpload({ filename: "a.xlsx", bytes: zip([{ name: "xl/worksheets/sheet1.xml", data: bomb }]) })).toMatchObject({ refused: true, code: "DECOMPRESSION_BOMB" });
    // Declares 100 bytes but inflates to 20 MB: the inflater stops at the declared size.
    const lying = zip([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "xl/workbook.xml", data: bomb, declaredSize: 100 }]);
    expect(parseUpload({ filename: "a.xlsx", bytes: lying })).toMatchObject({ refused: true, code: "CORRUPT_ZIP" });
    expect(parseUpload({ filename: "a.xlsx", bytes: Buffer.from("PK\u0003\u0004 not really a zip") })).toMatchObject({ refused: true, code: "NOT_A_ZIP" });
  });

  it("converts Excel serial dates without assuming a time zone", () => {
    expect(excelSerialToWallTime(46327)).toBe("2026-11-01 00:00:00");
    expect(excelSerialToWallTime(1, "date")).toBe("1900-01-01");
    expect(excelSerialToWallTime(60, "date")).toBeNull(); // the 29 February 1900 that never was
    expect(excelSerialToWallTime(0)).toBeNull();
  });
});

describe("onboarding values", () => {
  it("money: US formats, accounting negatives, refusals instead of guesses", () => {
    expect(parseMoneyText("$1,234.00")).toEqual({ ok: true, value: "1234.00" });
    expect(parseMoneyText("(50.00)")).toEqual({ ok: true, value: "-50.00" });
    expect(parseMoneyText("-$12.5")).toEqual({ ok: true, value: "-12.50" });
    expect(parseMoneyText("$-0.00")).toEqual({ ok: true, value: "0.00" });
    expect(parseMoneyText("1.234,56")).toMatchObject({ ok: false, code: "AMBIGUOUS_NUMBER_FORMAT" });
    expect(parseMoneyText("€12.00")).toMatchObject({ ok: false, code: "CURRENCY_NOT_USD" });
    expect(parseMoneyText("12.345")).toMatchObject({ ok: false, code: "FRACTIONAL_CENTS" });
    expect(parseMoneyText("99999999999999.00")).toMatchObject({ ok: false, code: "AMOUNT_OUT_OF_RANGE" });
    expect(dollarsToMicros("1234.56")).toBe("1234560000");
  });

  it("dates: AM/PM midnight, impossible dates, unknown order, two-digit years, spreadsheet serials", () => {
    expect(parseDateValue("11/04/2026 12:05 AM", "MDY")).toMatchObject({ ok: true, value: { month: 11, day: 4, hour: 0, minute: 5 } });
    expect(parseDateValue("11/04/2026 12:05 PM", "MDY")).toMatchObject({ ok: true, value: { hour: 12 } });
    expect(parseDateValue("02/30/2026", "MDY")).toMatchObject({ ok: false, code: "IMPOSSIBLE_DATE" });
    expect(parseDateValue("03/04/2026", null)).toMatchObject({ ok: false, code: "DATE_ORDER_UNKNOWN" });
    expect(parseDateValue("03/04/26", "MDY")).toMatchObject({ ok: false, code: "TWO_DIGIT_YEAR" });
    expect(parseDateValue("46327", "MDY")).toMatchObject({ ok: false, code: "SPREADSHEET_SERIAL" });
    expect(parseDateValue("2026-11-03T09:14:00-0800", null)).toMatchObject({ ok: true, value: { offset: "-08:00" } });
    expect(slashDateOrder(["13/04/2026", "03/04/2026"])).toBe("DMY");
    expect(slashDateOrder(["04/13/2026", "13/04/2026"])).toBe("conflict");
    expect(classify("03/04/2026")).toBe("date_ambiguous");
  });

  it("identifiers and counts: scientific notation and padding are refused, never repaired", () => {
    expect(parseIdentifier("1.23457E+17", true)).toMatchObject({ ok: false, code: "MANGLED_ID" });
    expect(parseIdentifier("00417", true)).toMatchObject({ ok: false, code: "PADDED_ID" });
    expect(parseIdentifier("00417", false)).toEqual({ ok: true, value: "00417" });
    expect(parseCount("1,204")).toEqual({ ok: true, value: 1204 });
    expect(parseCount("1.50")).toMatchObject({ ok: false, code: "FRACTIONAL_COUNT" });
    expect(parseCount("3.00")).toEqual({ ok: true, value: 3 });
  });
});

describe("onboarding compile · local times at daylight-saving boundaries", () => {
  const table = (times: string[]): ParsedTable => ({
    format: "csv", filename: "x.csv", columns: ["Call ID", "Start", "Branch", "Phone", "Source"], sourceHeaders: ["Call ID", "Start", "Branch", "Phone", "Source"],
    rows: times.map((t, i) => [`C${i}`, t, "B17", `+1312555014${i}`, "Direct"]), rowRefs: times.map((_, i) => i + 2), raggedRows: [], sheet: null, encoding: "utf-8", delimiter: ",", warnings: [],
  });
  const spec: MappingSpec = {
    dataset: "calls", columns: { call_id: "Call ID", started_at: "Start", branch: "Branch", caller_phone: "Phone", call_source: "Source" },
    constants: {}, valueMaps: {}, dateOrder: null, localTime: "branch_local", moneyMeaning: {}, exportedAt: null,
  };
  it("refuses a local time in the spring-forward gap and one that happened twice; accepts a normal one", () => {
    // B17 is in America/Chicago. 2026-03-08 02:30 never happened; 2026-11-01 01:30 happened twice.
    const out = compileRows(table(["2026-03-08 02:30:00", "2026-11-01 01:30:00", "2026-11-01 03:30:00"]), spec, new Date("2026-11-10T00:00:00Z"));
    expect(out.map((o) => (o.disposition === "invalid" ? o.issues[0].code : o.disposition))).toEqual(["NONEXISTENT_LOCAL_TIME", "AMBIGUOUS_LOCAL_TIME", "eligible"]);
  });
});

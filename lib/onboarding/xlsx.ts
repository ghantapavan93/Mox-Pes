import { inflateRawSync } from "node:zlib";
import { LIMITS } from "./limits";

/**
 * A deliberately small XLSX reader: enough of the Office Open XML spreadsheet format to read
 * cell VALUES, with every resource bound checked before work is done.
 *
 * Why not a library: the reader's job here is to refuse things (macros, external links,
 * decompression bombs, encrypted workbooks) as much as to read cells, and a few hundred lines
 * we can bound and test beat a large dependency whose limits we would have to trust. It never
 * evaluates a formula: a formula cell yields its cached value and is reported as a formula.
 *
 * Supported: shared strings, inline strings, numbers, booleans, cached formula results,
 * error cells, date-formatted numbers (built-in and custom date formats), multiple sheets.
 * Not supported (refused or reported): .xls (BIFF), .xlsb, macro-enabled workbooks,
 * encrypted workbooks, ZIP64 archives, rich-text runs beyond their plain text.
 */

export class XlsxRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxRefusal("NOT_A_ZIP", "The file is not a valid XLSX archive");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new XlsxRefusal("ZIP64_UNSUPPORTED", "ZIP64 workbooks are not supported");
  if (count > LIMITS.xlsx.maxEntries) throw new XlsxRefusal("TOO_MANY_ENTRIES", `The workbook has ${count} parts (limit ${LIMITS.xlsx.maxEntries})`);
  if (cdOffset + cdSize > buf.length) throw new XlsxRefusal("CORRUPT_ZIP", "The workbook's directory points outside the file");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  let declared = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxRefusal("CORRUPT_ZIP", "The workbook's directory is damaged");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (flags & 0x1) throw new XlsxRefusal("ENCRYPTED", "Encrypted workbooks are not accepted");
    declared += uncompressedSize;
    if (declared > LIMITS.xlsx.maxUncompressedBytes) throw new XlsxRefusal("TOO_LARGE_UNCOMPRESSED", "The workbook expands beyond the size limit");
    if (compressedSize > 0 && uncompressedSize / compressedSize > LIMITS.xlsx.maxCompressionRatio) {
      throw new XlsxRefusal("DECOMPRESSION_BOMB", `"${name}" expands ${Math.round(uncompressedSize / compressedSize)}x: refused as a decompression bomb`);
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(buf: Buffer, e: ZipEntry): Buffer {
  const lh = e.localHeaderOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw new XlsxRefusal("CORRUPT_ZIP", `"${e.name}" is damaged`);
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) throw new XlsxRefusal("CORRUPT_ZIP", `"${e.name}" is truncated`);
  if (e.method === 0) return Buffer.from(data);
  if (e.method !== 8) throw new XlsxRefusal("UNSUPPORTED_COMPRESSION", `"${e.name}" uses an unsupported compression method`);
  try {
    // The declared size can lie; the inflater is bounded by it as well (a bomb cannot grow past it).
    return inflateRawSync(data, { maxOutputLength: Math.min(e.uncompressedSize, LIMITS.xlsx.maxUncompressedBytes) || 1 });
  } catch {
    throw new XlsxRefusal("CORRUPT_ZIP", `"${e.name}" could not be decompressed within its declared size`);
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return XML_ENTITIES[e.toLowerCase()] ?? "";
  });
}
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
};

/**
 * Elements named `tag`, found by linear scanning (indexOf), never by a lazy regex: a regex like
 * /<si>([\s\S]*?)<\/si>/ rescans to the end of the input from every unclosed opening tag, and a
 * workbook of unclosed tags took minutes (security review #2). An element that never closes is
 * refused. Self-closing elements yield an empty inner text. Elements of this schema do not nest.
 */
export function* elements(xml: string, tag: string): Generator<{ head: string; inner: string }> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0) return;
    const after = xml.charCodeAt(i + open.length);
    // "<c" must not match "<col" or "<cfRule": the name ends at a space, "/" or ">".
    if (!(after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13)) {
      pos = i + open.length;
      continue;
    }
    const headEnd = xml.indexOf(">", i);
    if (headEnd < 0) throw new XlsxRefusal("CORRUPT_WORKBOOK", `An unclosed <${tag}> tag`);
    const head = xml.slice(i, headEnd + 1);
    if (xml.charCodeAt(headEnd - 1) === 47) {
      yield { head, inner: "" };
      pos = headEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, headEnd + 1);
    if (end < 0) throw new XlsxRefusal("CORRUPT_WORKBOOK", `A <${tag}> element never closes`);
    yield { head, inner: xml.slice(headEnd + 1, end) };
    pos = end + close.length;
  }
}

/** Plain text of a <si> or <is> element: every <t> run, concatenated. */
const runsText = (xml: string): string => {
  let out = "";
  for (const t of elements(xml, "t")) out += decodeXml(t.inner);
  return out;
};

/** Built-in number formats (ECMA-376 §18.8.30): date only, time only, both. */
const BUILTIN_DATE_ONLY = new Set([14, 15, 16, 17, 27, 30, 36, 50, 57]);
const BUILTIN_TIME_ONLY = new Set([18, 19, 20, 21, 45, 46, 47]);
const BUILTIN_DATETIME = new Set([22]);

/** Cell style index -> what kind of date the style displays. */
function dateStyleIndexes(stylesXml: string | null): Map<number, SerialKind> {
  const out = new Map<number, SerialKind>();
  if (!stylesXml) return out;
  const custom = new Map<number, string>();
  for (const f of elements(stylesXml, "numFmt")) {
    const id = Number(attr(f.head, "numFmtId"));
    const code = attr(f.head, "formatCode") ?? "";
    custom.set(id, code);
  }
  const xfs = elements(stylesXml, "cellXfs").next().value?.inner ?? "";
  let index = 0;
  for (const xf of elements(xfs, "xf")) {
    const id = Number(attr(xf.head, "numFmtId") ?? "0");
    // A custom code's date and time tokens, outside quoted text and brackets. "m" alone is
    // ambiguous (month or minute), so the kind is decided by d/y (a date) and h/s (a time).
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "");
    const hasDate = BUILTIN_DATE_ONLY.has(id) || BUILTIN_DATETIME.has(id) || /[dy]/i.test(code);
    const hasTime = BUILTIN_TIME_ONLY.has(id) || BUILTIN_DATETIME.has(id) || /[hs]/i.test(code);
    if (hasDate || hasTime) out.set(index, hasDate && hasTime ? "datetime" : hasDate ? "date" : "time");
    index++;
  }
  return out;
}

export type SerialKind = "date" | "datetime" | "time";

/**
 * An Excel serial to the text the cell DISPLAYS: a date-only format gives "YYYY-MM-DD" (no
 * invented midnight: data review #2), a time-only format "HH:MM:SS", a date-time format a
 * zone-less wall time. The time zone is never assumed. `date1904` workbooks count from 1904.
 */
export function excelSerialToWallTime(serial: number, kind: SerialKind = "datetime", date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (kind === "time") {
    const secs = Math.round((serial % 1) * 86_400) % 86_400;
    return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  }
  // Serial 0 in the 1900 system displays as "1900-01-00": not a date.
  if (!date1904 && serial < 1) return null;
  let days = serial + (date1904 ? 1_462 : 0);
  if (!date1904) {
    // The 1900 system counts a 29 February 1900 that never existed (serial 60).
    if (days >= 60 && days < 61) return null;
    if (days < 60) days += 1;
  }
  if (days < 1) return null;
  const d = new Date(Math.round((days - 25_569) * 86_400_000));
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return kind === "date" ? date : `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Column letters ("AB") to a 0-based index. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export interface XlsxCellNote {
  row: number;
  column: number;
  kind: "formula" | "error" | "date_serial";
}

export interface XlsxSheet {
  name: string;
  rows: Array<Array<string | null>>;
  /** 1-based source row number of each entry in rows (blank rows are skipped, so they differ). */
  rowNumbers: number[];
  /** A sample (the first few of each kind); noteCounts has the totals. */
  notes: XlsxCellNote[];
  noteCounts: Record<XlsxCellNote["kind"], number>;
}

export interface XlsxWorkbook {
  sheetNames: string[];
  sheet: XlsxSheet;
}

/**
 * Reads one worksheet (by index, default the first) of an XLSX file.
 * Throws XlsxRefusal for anything it will not read.
 */
export function readXlsx(buf: Buffer, sheetIndex = 0): XlsxWorkbook {
  const entries = readCentralDirectory(buf);
  const byName = new Map(entries.map((e) => [e.name.replace(/^\//, ""), e]));
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (lower.endsWith("vbaproject.bin") || lower.includes("/activex/") || lower.startsWith("xl/macrosheets/")) {
      throw new XlsxRefusal("ACTIVE_CONTENT", "The workbook contains macros or ActiveX controls; save it as a plain .xlsx or CSV");
    }
    if (lower.startsWith("xl/externallinks/")) throw new XlsxRefusal("EXTERNAL_LINKS", "The workbook links to other files; paste values and save again");
  }
  let inflated = 0;
  const text = (name: string): string | null => {
    const e = byName.get(name);
    if (!e) return null;
    const out = inflateEntry(buf, e);
    inflated += out.length;
    if (inflated > LIMITS.xlsx.maxUncompressedBytes) throw new XlsxRefusal("TOO_LARGE_UNCOMPRESSED", "The workbook expands beyond the size limit");
    return out.toString("utf8");
  };

  const contentTypes = text("[Content_Types].xml") ?? "";
  if (/macroEnabled/i.test(contentTypes)) throw new XlsxRefusal("ACTIVE_CONTENT", "Macro-enabled workbooks are not accepted");
  const workbook = text("xl/workbook.xml");
  if (!workbook) throw new XlsxRefusal("NOT_A_WORKBOOK", "The archive is not an Excel workbook");

  const rels = text("xl/_rels/workbook.xml.rels") ?? "";
  const target = new Map<string, string>();
  for (const r of elements(rels, "Relationship")) {
    const id = attr(r.head, "Id");
    const t = attr(r.head, "Target");
    if (id && t) target.set(id, t.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const sheets = [...elements(workbook, "sheet")].map((s) => ({ name: attr(s.head, "name") ?? "Sheet", rid: attr(s.head, "r:id") ?? "" }));
  if (sheets.length === 0) throw new XlsxRefusal("NO_SHEETS", "The workbook has no worksheets");
  if (sheets.length > LIMITS.xlsx.maxSheets) throw new XlsxRefusal("TOO_MANY_SHEETS", `The workbook has ${sheets.length} sheets`);
  const chosen = sheets[sheetIndex];
  if (!chosen) throw new XlsxRefusal("NO_SUCH_SHEET", `Sheet ${sheetIndex + 1} does not exist`);
  const path = target.get(chosen.rid);
  // A relationship target is a path inside the archive; it must stay there.
  if (!path || path.includes("..") || /^[a-z]+:/i.test(path)) throw new XlsxRefusal("CORRUPT_WORKBOOK", `Sheet "${chosen.name}" has no valid location`);
  const sheetXml = text(`xl/${path}`);
  if (sheetXml === null) throw new XlsxRefusal("CORRUPT_WORKBOOK", `Sheet "${chosen.name}" is missing`);

  const sharedXml = text("xl/sharedStrings.xml");
  const shared: string[] = [];
  if (sharedXml) for (const si of elements(sharedXml, "si")) shared.push(runsText(si.inner));
  const dateStyles = dateStyleIndexes(text("xl/styles.xml"));
  // Workbooks created on old Macs count dates from 1904; ignoring it shifts every date by 1,462 days.
  const workbookPr = elements(workbook, "workbookPr").next().value?.head ?? "";
  const date1904 = /\bdate1904="(1|true)"/i.test(workbookPr);

  const rows: Array<Array<string | null>> = [];
  const rowNumbers: number[] = [];
  const notes: XlsxCellNote[] = [];
  const noteCounts: Record<XlsxCellNote["kind"], number> = { formula: 0, error: 0, date_serial: 0 };
  const note = (n: XlsxCellNote) => {
    // Counted in full, kept as a sample: notes are reported, never allowed to grow unbounded.
    if (noteCounts[n.kind]++ < MAX_NOTES_PER_KIND) notes.push(n);
  };
  // Shared strings let a small file reference one long string from every cell. The text the
  // workbook DECODES TO is budgeted, not just its bytes (security review #1).
  let decodedChars = 0;
  for (const r of elements(sheetXml, "row")) {
    const rowNumber = Number(attr(r.head, "r") ?? rows.length + 1);
    const cells: Array<string | null> = [];
    let nextCol = 0;
    for (const c of elements(r.inner, "c")) {
      const head = c.head;
      // The cell reference is optional; without one, a cell follows the previous cell.
      const ref = attr(head, "r");
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      if (col >= LIMITS.maxColumns) continue;
      const t = attr(head, "t");
      const s = Number(attr(head, "s") ?? "-1");
      const inner = c.inner;
      const v = elements(inner, "v").next().value?.inner;
      let value: string | null = null;
      if (t === "s") value = v !== undefined ? (shared[Number(v)] ?? null) : null;
      else if (t === "inlineStr") value = runsText(inner);
      else if (t === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : null;
      else if (t === "e") {
        value = v !== undefined ? decodeXml(v) : null;
        note({ row: rowNumber, column: col, kind: "error" });
      } else if (t === "str") value = v !== undefined ? decodeXml(v) : null;
      else if (v !== undefined) {
        const raw = decodeXml(v);
        const kind = dateStyles.get(s);
        if (kind && Number.isFinite(Number(raw))) {
          value = excelSerialToWallTime(Number(raw), kind, date1904) ?? raw;
          note({ row: rowNumber, column: col, kind: "date_serial" });
        } else value = raw;
      }
      if (inner.includes("<f>") || inner.includes("<f ")) note({ row: rowNumber, column: col, kind: "formula" });
      if (value !== null) {
        if (value.length > LIMITS.maxCellChars) throw new XlsxRefusal("CELL_TOO_LARGE", `Row ${rowNumber} has a cell over ${LIMITS.maxCellChars.toLocaleString("en-US")} characters`);
        decodedChars += value.length;
        if (decodedChars > LIMITS.xlsx.maxDecodedChars) throw new XlsxRefusal("TOO_MUCH_TEXT", "The workbook's cells expand to more text than an export of this size can hold");
      }
      while (cells.length < col) cells.push(null);
      cells[col] = value === "" ? null : value;
    }
    // A formatted but empty cell past the last value is not data (data review #4).
    while (cells.length > 0 && cells[cells.length - 1] === null) cells.pop();
    if (cells.some((c) => c !== null)) {
      rows.push(cells);
      rowNumbers.push(rowNumber);
    }
    if (rows.length > LIMITS.maxRows + 1) throw new XlsxRefusal("TOO_MANY_ROWS", `More than ${LIMITS.maxRows.toLocaleString("en-US")} rows`);
  }
  return { sheetNames: sheets.map((x) => x.name), sheet: { name: chosen.name, rows, rowNumbers, notes, noteCounts } };
}

const MAX_NOTES_PER_KIND = 20;

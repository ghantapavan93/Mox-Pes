import { LIMITS } from "./limits";
import { XlsxRefusal, readXlsx } from "./xlsx";

/**
 * Upload -> a rectangular table of TEXT cells, or a refusal with a reason.
 *
 * Cells stay strings exactly as the file said them (no number or date coercion here): the
 * profiler decides what a column looks like, and the mapping decides what it means. Every
 * structural surprise (duplicate or blank headers, ragged rows, a guessed encoding, a nested
 * array, a formula cell) is reported as a warning tied to a location, never smoothed over.
 */

export type UploadFormat = "csv" | "xlsx" | "json";

export interface ParseWarning {
  code: string;
  message: string;
  /** 1-based source row (header row = 1 for CSV/XLSX), when the warning is about one row. */
  row?: number;
  column?: string;
}

export interface ParsedTable {
  format: UploadFormat;
  filename: string;
  /** Column names, unique (a repeated header becomes "Name (2)"). */
  columns: string[];
  /** The header cells as they were in the file, same order as columns. */
  sourceHeaders: string[];
  rows: Array<Array<string | null>>;
  /** Source row reference of each data row (CSV/XLSX: line/row number; JSON: 1-based record index). */
  rowRefs: number[];
  /** Rows whose cell count differed from the header: kept, and reported per row. */
  raggedRows: number[];
  sheet: { name: string; index: number; available: string[] } | null;
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
  delimiter: string | null;
  warnings: ParseWarning[];
}

export interface ParseRefusal {
  refused: true;
  code: string;
  message: string;
}

export const isRefusal = (x: ParsedTable | ParseRefusal): x is ParseRefusal => "refused" in x;
const refuse = (code: string, message: string): ParseRefusal => ({ refused: true, code, message });

/**
 * A display-safe file name: no directories, no control or path characters, bounded length.
 * The name is only ever shown; files are stored by id, never by name.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || "upload";
}

const EXTENSIONS: Record<string, UploadFormat> = { csv: "csv", txt: "csv", tsv: "csv", xlsx: "xlsx", json: "json" };
const REFUSED_EXTENSIONS: Record<string, string> = {
  xlsm: "Macro-enabled workbooks are not accepted; save as .xlsx or CSV",
  xlsb: "Binary workbooks (.xlsb) are not supported; save as .xlsx or CSV",
  xls: "Legacy Excel (.xls) is not supported; save as .xlsx or CSV",
  zip: "Archives are not accepted; upload the file itself",
  gz: "Compressed files are not accepted; upload the file itself",
};

function decodeText(bytes: Buffer): { text: string; encoding: ParsedTable["encoding"]; warnings: ParseWarning[] } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8", warnings: [] };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le", warnings: [] };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be", warnings: [] };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", warnings: [] };
  } catch {
    // Not UTF-8. Windows-1252 is what spreadsheet exports most often are; it is an assumption,
    // so it is reported, and every non-ASCII value should be checked by a person.
    return {
      text: new TextDecoder("windows-1252").decode(bytes),
      encoding: "windows-1252",
      warnings: [{ code: "ENCODING_ASSUMED", message: "The file is not UTF-8; it was read as Windows-1252. Check accented and special characters." }],
    };
  }
}

/**
 * Picks the delimiter whose most common column count (above 1) appears on the most lines. The
 * mode, not the first line, so a report title above the header does not decide (data review #12).
 */
function sniffDelimiter(text: string, extension: string): string {
  if (extension === "tsv") return "\t";
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 30);
  const cellsIn = (l: string, d: string) => {
    try {
      return splitCsv(l, d)[0]?.cells.length ?? 1;
    } catch {
      return 1; // a quoted value continues on the next line: this line alone says nothing
    }
  };
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const freq = new Map<number, number>();
    for (const l of lines) {
      const n = cellsIn(l, d);
      if (n > 1) freq.set(n, (freq.get(n) ?? 0) + 1);
    }
    const [mode, lines_] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0];
    const score = lines_ * 100 + mode;
    if (mode > 1 && score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** A quote that never closes would swallow every following row into one cell. */
class UnterminatedQuote extends Error {
  constructor(readonly line: number) {
    super(`A quoted value opened on line ${line} never closes`);
  }
}

class TooManyRows extends Error {}

function splitCsv(text: string, delimiter: string, maxRows = Number.POSITIVE_INFINITY): Array<{ cells: string[]; line: number }> {
  const out: Array<{ cells: string[]; line: number }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let quoteLine = 0;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
      quoteLine = line;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      out.push({ cells, line: rowLine });
      // Stop as soon as the row limit is passed, not after building every row (security review #7).
      if (out.length > maxRows) throw new TooManyRows();
      cells = [];
      cell = "";
      line++;
      rowLine = line;
    } else cell += ch;
  }
  // Refused, not repaired: where the quote should have closed cannot be known (data review #1).
  if (quoted) throw new UnterminatedQuote(quoteLine);
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    out.push({ cells, line: rowLine });
  }
  return out;
}

/**
 * Reports often open with a title or date-range line above the real header. The header is
 * the first of the leading rows that is as wide as the table's typical row and reads as names
 * (mostly non-blank, mostly non-numeric). Bounded to the first 10 rows.
 */
export function headerRowIndex(rows: Array<Array<string | null>>): number {
  // Width = the number of cells as written, so a header with blank names keeps its width
  // (a header "id,started,," is 4 wide, not 2: data review #3).
  const width = (r: Array<string | null>) => r.length;
  const widths = new Map<number, number>();
  for (const r of rows.slice(0, 30)) widths.set(width(r), (widths.get(width(r)) ?? 0) + 1);
  const typical = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  // Only single-value lines narrower than the table (a report title, a date range) are skipped.
  // Any line naming two or more columns is the header, even if data rows are wider (a ragged
  // file must not lose its header: a regression the S6 test caught in the first version of this).
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const filled = rows[i].filter((c) => c !== null && c.trim() !== "").length;
    if (filled > 1 || width(rows[i]) >= Math.max(2, typical * 0.8)) return i;
  }
  return 0;
}

function uniqueColumns(headers: string[], warnings: ParseWarning[]): string[] {
  // Every name the file uses is reserved first, so a rename can never collide with a real
  // header ("Name, Name, Name (2)" -> "Name", "Name (3)", "Name (2)": data review #11).
  const used = new Set(headers.map((h) => h.trim().slice(0, LIMITS.maxHeaderChars).toLowerCase()).filter(Boolean));
  const taken = new Set<string>();
  return headers.map((h, i) => {
    let name = h.trim().slice(0, LIMITS.maxHeaderChars);
    if (!name) {
      let k = i + 1;
      while (used.has(`column ${k}`) || taken.has(`column ${k}`)) k++;
      name = `Column ${k}`;
      warnings.push({ code: "BLANK_HEADER", message: `Column ${i + 1} has no header; it is shown as "${name}"`, column: name });
    }
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (used.has(`${name} (${n})`.toLowerCase()) || taken.has(`${name} (${n})`.toLowerCase())) n++;
      const renamed = `${name} (${n})`;
      warnings.push({ code: "DUPLICATE_HEADER", message: `"${name}" appears more than once; this one is shown as "${renamed}". Which one is meant must be decided in mapping.`, column: renamed });
      name = renamed;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

function boundCells(rows: Array<Array<string | null>>, rowRefs: number[]): ParseRefusal | null {
  for (const [r, row] of rows.entries()) {
    for (const c of row) {
      if (c !== null && c.length > LIMITS.maxCellChars) return refuse("CELL_TOO_LARGE", `Row ${rowRefs[r]} has a cell over ${LIMITS.maxCellChars.toLocaleString("en-US")} characters`);
      if (c !== null && c.includes("\u0000")) return refuse("BINARY_CONTENT", `Row ${rowRefs[r]} contains a NUL byte: this is not a text export`);
    }
  }
  return null;
}

function tabulate(
  format: UploadFormat,
  filename: string,
  headerCells: Array<string | null>,
  dataRows: Array<Array<string | null>>,
  rowRefs: number[],
  extra: Pick<ParsedTable, "sheet" | "encoding" | "delimiter">,
  warnings: ParseWarning[],
): ParsedTable | ParseRefusal {
  if (headerCells.length === 0 || headerCells.every((h) => h === null || h.trim() === "")) return refuse("NO_HEADER", "The first row has no column names");
  if (headerCells.length > LIMITS.maxColumns) return refuse("TOO_MANY_COLUMNS", `${headerCells.length} columns (limit ${LIMITS.maxColumns})`);
  if (dataRows.length === 0) return refuse("NO_ROWS", "The file has a header but no data rows");
  if (dataRows.length > LIMITS.maxRows) return refuse("TOO_MANY_ROWS", `${dataRows.length.toLocaleString("en-US")} rows (limit ${LIMITS.maxRows.toLocaleString("en-US")})`);
  const sourceHeaders = headerCells.map((h) => h ?? "");
  const columns = uniqueColumns(sourceHeaders, warnings);
  const raggedRows: number[] = [];
  const rows = dataRows.map((row, i) => {
    // Ragged = a value beyond the header (a shifted row), or a short CSV row. Empty trailing
    // cells (a trailing comma, a formatted empty Excel cell) are not data (data review #4).
    const extraValue = row.slice(columns.length).some((c) => c !== null && c.trim() !== "");
    const shortCsv = format !== "xlsx" && format !== "json" && row.length < columns.length;
    if (extraValue || shortCsv) {
      raggedRows.push(rowRefs[i]);
      warnings.push({ code: "RAGGED_ROW", message: `Row ${rowRefs[i]} has ${row.length} cells; the header has ${columns.length}`, row: rowRefs[i] });
    }
    const cells = row.slice(0, columns.length).map((c) => (c === null || c === "" ? null : c));
    while (cells.length < columns.length) cells.push(null);
    return cells;
  });
  const bad = boundCells(rows, rowRefs);
  if (bad) return bad;
  return { format, filename, columns, sourceHeaders, rows, rowRefs, raggedRows, ...extra, warnings: capWarnings(warnings) };
}

const WARNINGS_PER_CODE = 20;

/**
 * The first few warnings of each kind, then one line with how many more: a file of 50,000
 * ragged rows yields a readable report, not 50,000 entries stored and sent to every page view
 * (security review #6). Row-level detail is never lost: every row still gets its disposition.
 */
export function capWarnings(warnings: ParseWarning[]): ParseWarning[] {
  const seen = new Map<string, number>();
  const out: ParseWarning[] = [];
  for (const w of warnings) {
    const n = (seen.get(w.code) ?? 0) + 1;
    seen.set(w.code, n);
    if (n <= WARNINGS_PER_CODE) out.push(w);
  }
  for (const [code, n] of seen) if (n > WARNINGS_PER_CODE) out.push({ code, message: `…and ${(n - WARNINGS_PER_CODE).toLocaleString("en-US")} more ${code} warnings` });
  return out;
}

class JsonKeyCollision extends Error {
  constructor(
    readonly key: string,
    readonly ref: number,
  ) {
    super(`Record ${ref}: "${key}" is both a dotted key and a nested path`);
  }
}

function flatten(value: unknown, prefix: string, out: Record<string, string | null>, depth: number, warnings: ParseWarning[], ref: number): void {
  if (value === null || value === undefined) {
    out[prefix] = null;
  } else if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    warnings.push({ code: "NESTED_ARRAY", message: `Record ${ref}: "${prefix}" is a list; it is kept as JSON text and cannot be mapped directly`, row: ref, column: prefix });
  } else if (typeof value === "object") {
    if (depth >= LIMITS.maxJsonDepth) {
      out[prefix] = JSON.stringify(value);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1, warnings, ref);
  } else if (Object.hasOwn(out, prefix)) {
    // {"a.b": 1, "a": {"b": 2}} flattens two values onto one column: refuse rather than pick one.
    throw new JsonKeyCollision(prefix, ref);
  } else out[prefix] = String(value);
}

function parseJson(text: string, filename: string, encoding: ParsedTable["encoding"], warnings: ParseWarning[]): ParsedTable | ParseRefusal {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return refuse("INVALID_JSON", "The file is not valid JSON");
  }
  let records: unknown = doc;
  if (!Array.isArray(doc) && doc && typeof doc === "object") {
    const key = ["records", "data", "rows", "items", "results"].find((k) => Array.isArray((doc as Record<string, unknown>)[k]));
    if (!key) return refuse("JSON_NOT_TABULAR", "Expected an array of records, or an object with a records/data/rows/items/results array");
    records = (doc as Record<string, unknown>)[key];
    warnings.push({ code: "JSON_ENVELOPE", message: `Records were read from the "${key}" array` });
  }
  if (!Array.isArray(records)) return refuse("JSON_NOT_TABULAR", "Expected an array of records");
  if (records.length > LIMITS.maxRows) return refuse("TOO_MANY_ROWS", `${records.length.toLocaleString("en-US")} records (limit ${LIMITS.maxRows.toLocaleString("en-US")})`);
  const flat: Array<Record<string, string | null>> = [];
  const columnOrder: string[] = [];
  const known = new Set<string>();
  for (const [i, r] of records.entries()) {
    const row: Record<string, string | null> = {};
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      warnings.push({ code: "NOT_A_RECORD", message: `Record ${i + 1} is not an object; it is kept as an empty row`, row: i + 1 });
    } else {
      try {
        flatten(r, "", row, 0, warnings, i + 1);
      } catch (error) {
        if (error instanceof JsonKeyCollision) return refuse("JSON_KEY_COLLISION", `${error.message}; which value is meant cannot be decided here`);
        throw error;
      }
    }
    for (const k of Object.keys(row)) {
      if (!known.has(k)) {
        known.add(k);
        columnOrder.push(k);
      }
    }
    flat.push(row);
    if (columnOrder.length > LIMITS.maxColumns) return refuse("TOO_MANY_COLUMNS", `More than ${LIMITS.maxColumns} distinct fields`);
  }
  const rows = flat.map((r) => columnOrder.map((k) => (Object.hasOwn(r, k) ? r[k] : null)));
  return tabulate("json", filename, columnOrder, rows, rows.map((_, i) => i + 1), { sheet: null, encoding, delimiter: null }, warnings);
}

/** Parses one upload. `sheetIndex` picks an XLSX worksheet (default: the first). */
export function parseUpload(input: { filename: string; bytes: Buffer; sheetIndex?: number }): ParsedTable | ParseRefusal {
  const filename = sanitizeFilename(input.filename);
  const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (REFUSED_EXTENSIONS[extension]) return refuse("UNSUPPORTED_FORMAT", REFUSED_EXTENSIONS[extension]);
  const format = EXTENSIONS[extension];
  if (!format) return refuse("UNSUPPORTED_FORMAT", `".${extension || "?"}" files are not supported. Upload CSV, XLSX or JSON.`);
  if (input.bytes.length === 0) return refuse("EMPTY_FILE", "The file is empty");
  if (input.bytes.length > LIMITS.maxUploadBytes) return refuse("TOO_LARGE", `The file is over ${LIMITS.maxUploadBytes / 1024 / 1024} MB`);

  const isZip = input.bytes.readUInt32LE(0) === 0x04034b50;
  const warnings: ParseWarning[] = [];

  if (format === "xlsx") {
    // The extension is a claim; the content must agree.
    if (!isZip) return refuse("CONTENT_MISMATCH", "The file is named .xlsx but is not an Excel workbook");
    try {
      const wb = readXlsx(input.bytes, input.sheetIndex ?? 0);
      const start = headerRowIndex(wb.sheet.rows);
      if (start > 0) warnings.push({ code: "PREAMBLE_SKIPPED", message: `${start} row(s) above the header were skipped`, row: wb.sheet.rowNumbers[start] });
      const [header = [], ...data] = wb.sheet.rows.slice(start);
      const refs = wb.sheet.rowNumbers.slice(start + 1);
      // One warning per kind, with the total and the first rows: notes never grow without bound.
      const firstRows = (kind: string) => wb.sheet.notes.filter((n) => n.kind === kind).slice(0, 5).map((n) => n.row).join(", ");
      if (wb.sheet.noteCounts.formula) {
        warnings.push({ code: "FORMULA_CELL", message: `${wb.sheet.noteCounts.formula} formula cell(s) (rows ${firstRows("formula")}…): their last calculated values were used; no formula was run` });
      }
      if (wb.sheet.noteCounts.error) warnings.push({ code: "ERROR_CELL", message: `${wb.sheet.noteCounts.error} cell(s) show a spreadsheet error value (rows ${firstRows("error")}…)` });
      if (wb.sheetNames.length > 1) warnings.push({ code: "MULTIPLE_SHEETS", message: `The workbook has ${wb.sheetNames.length} sheets; "${wb.sheet.name}" was read. Choose another sheet to read it instead.` });
      return tabulate("xlsx", filename, header, data, refs, { sheet: { name: wb.sheet.name, index: input.sheetIndex ?? 0, available: wb.sheetNames }, encoding: "utf-8", delimiter: null }, warnings);
    } catch (error) {
      if (error instanceof XlsxRefusal) return refuse(error.code, error.message);
      throw error;
    }
  }

  if (isZip) return refuse("CONTENT_MISMATCH", `The file is named .${extension} but is a ZIP archive (perhaps a workbook): rename it or export CSV`);
  const decoded = decodeText(input.bytes);
  warnings.push(...decoded.warnings);
  const text = decoded.text;
  if (text.trim() === "") return refuse("EMPTY_FILE", "The file has no content");
  if (format === "json") return parseJson(text, filename, decoded.encoding, warnings);

  const delimiter = sniffDelimiter(text, extension);
  let parsed: Array<{ cells: string[]; line: number }>;
  try {
    // Header and up to 10 title lines on top of the row limit.
    parsed = splitCsv(text, delimiter, LIMITS.maxRows + 11).filter((r) => r.cells.some((c) => c.trim() !== ""));
  } catch (error) {
    if (error instanceof TooManyRows) return refuse("TOO_MANY_ROWS", `More than ${LIMITS.maxRows.toLocaleString("en-US")} rows`);
    if (error instanceof UnterminatedQuote) return refuse("UNTERMINATED_QUOTE", `${error.message}; every row after it would be merged into one value. Fix the quote and export again.`);
    throw error;
  }
  const start = headerRowIndex(parsed.map((r) => r.cells));
  if (start > 0) warnings.push({ code: "PREAMBLE_SKIPPED", message: `${start} line(s) above the header (a report title or date range) were skipped`, row: parsed[start].line });
  const [header, ...data] = parsed.slice(start);
  if (!header) return refuse("NO_HEADER", "The file has no rows");
  return tabulate(
    "csv",
    filename,
    header.cells,
    data.map((r) => r.cells),
    data.map((r) => r.line),
    { sheet: null, encoding: decoded.encoding, delimiter },
    warnings,
  );
}

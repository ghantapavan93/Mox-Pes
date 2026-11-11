import { crc32, deflateRawSync } from "node:zlib";

/**
 * Builds minimal XLSX (zip) files for tests, including deliberately hostile ones: a declared
 * size that lies (decompression bomb), an encrypted-entry flag, a macro part, a relationship
 * target that escapes the archive. Not a general writer.
 */

export interface ZipEntryInput {
  name: string;
  data: string | Buffer;
  /** Override the uncompressed size written in the directory (to forge a bomb). */
  declaredSize?: number;
  encrypted?: boolean;
  store?: boolean;
}

export function zip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const body = e.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const flags = e.encrypted ? 0x1 : 0;
    const method = e.store ? 0 : 8;
    const crc = crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (i: number) => String.fromCharCode(65 + i);

export type Cell = string | number | { formula: string; cached: string | number } | { date: number } | null;

/** One worksheet of cells. Strings go to the shared string table; { date } uses a date style. */
export function workbook(
  sheets: Array<{ name: string; rows: Cell[][] }>,
  extra: ZipEntryInput[] = [],
  /** store: write entries uncompressed, so a test reaches the checks behind the compression-ratio guard. */
  opts: { sheetTarget?: string; sheetXml?: string; sharedXml?: string; workbookPr?: string; store?: boolean } = {},
): Buffer {
  const shared: string[] = [];
  const sheetXml = sheets.map((s) => {
    const rows = s.rows
      .map((r, ri) => {
        const cells = r
          .map((c, ci) => {
            const ref = `${col(ci)}${ri + 1}`;
            if (c === null) return "";
            if (typeof c === "string") {
              shared.push(c);
              return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
            }
            if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
            if ("date" in c) return `<c r="${ref}" s="1"><v>${c.date}</v></c>`;
            return typeof c.cached === "number" ? `<c r="${ref}"><f>${esc(c.formula)}</f><v>${c.cached}</v></c>` : `<c r="${ref}" t="str"><f>${esc(c.formula)}</f><v>${esc(c.cached)}</v></c>`;
          })
          .join("");
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join("");
    return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const entries: ZipEntryInput[] = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>` },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${opts.workbookPr ?? ""}<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0"?><Relationships>${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="${opts.sheetTarget ?? `worksheets/sheet${i + 1}.xml`}"/>`).join("")}</Relationships>`,
    },
    { name: "xl/styles.xml", data: `<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>` },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: i === 0 && opts.sheetXml !== undefined ? opts.sheetXml : x })),
    { name: "xl/sharedStrings.xml", data: opts.sharedXml ?? `<?xml version="1.0"?><sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>` },
    ...extra,
  ];
  return zip(opts.store ? entries.map((e) => ({ ...e, store: true })) : entries);
}

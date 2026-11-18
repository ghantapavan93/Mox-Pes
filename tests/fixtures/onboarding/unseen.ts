/**
 * Synthetic call-tracking exports in a layout none of public/samples uses: other headers, other
 * column order, 24-hour slash dates without a zone. The assistant has to recognise it from header
 * vocabulary and values alone, and the visitor has to answer the two questions the file cannot
 * (month or day first; branch-local times). Every name, number and id is fictional.
 */

export interface LedgerCall {
  /** The call-tracking id the ledger holds (leads.source_lead_id). */
  id: string;
  /** The branch's name, as an export names it ("Alder"). */
  branch: string;
  /** The call's start in the branch's local time, "MM/DD/YYYY HH:mm". */
  startedLocal: string;
  /** The call source exactly as the platform labels it ("Google Ads"). */
  source: string;
  /** The caller's number, any punctuation. */
  phone: string;
}

const HEADER = "Call SID,Call Time,Office,Caller Number,Marketing Source,Talk Seconds";
const BRANCHES = ["Alder", "Aspen", "Birch", "Briar", "Canyon", "Cedar", "Clover", "Granite", "Moss", "Northgate"];
const SOURCES = ["Google Ads", "Google LSA", "Google My Business", "Facebook", "Bing", "Direct"];

const pad = (n: number) => String(n).padStart(2, "0");
const quote = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const line = (cells: string[]) => cells.map(quote).join(",");

/** One fictional call that is not in any ledger: an id no seed uses, a 555 number. */
function newCall(i: number, salt = 0): string[] {
  const day = 1 + ((i + salt) % 28);
  const minutes = (i * 37 + salt) % (10 * 60);
  const at = `10/${pad(day)}/2026 ${pad(8 + Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const phone = `(206) 555-${String(1000 + ((i * 7 + salt) % 9000)).padStart(4, "0")}`;
  return [`UNSEEN-${salt}-${i}`, at, BRANCHES[i % BRANCHES.length], phone, SOURCES[i % SOURCES.length], String(30 + ((i * 13) % 400))];
}

/**
 * The J2 export: the calls the ledger already holds (`known`, so their rows are compared and link
 * to their records), then `fresh` calls it does not. CRLF line ends, as spreadsheet exports write.
 */
export function unseenCallsCsv(known: LedgerCall[], fresh = 6): string {
  const rows = [
    ...known.map((c, i) => [c.id, c.startedLocal, c.branch, c.phone, c.source, String(60 + i * 17)]),
    ...Array.from({ length: fresh }, (_, i) => newCall(i)),
  ];
  return [HEADER, ...rows.map(line)].join("\r\n") + "\r\n";
}

/** `rows` fictional calls in the same layout; `salt` makes every file of a flood different. */
export function manyCallsCsv(rows: number, salt = 0): string {
  const out = [HEADER];
  for (let i = 0; i < rows; i++) out.push(line(newCall(i, salt)));
  return out.join("\n") + "\n";
}

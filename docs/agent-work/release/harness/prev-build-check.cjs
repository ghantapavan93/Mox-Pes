/**
 * The previous production build against the release database (RELEASE-DESIGN.md §9, WP-J step 4):
 *
 *   DATABASE_URL=<the release database> node prev-build-check.cjs <baseUrl> [nodeModulesDir]
 *
 * A rollback points that build at its own database, but the check that it could read this one
 * proves migrations 0037 and 0038 are additive: its pages answer with their verdicts, and none of
 * the release's workspace items (a visitor's uploads and questions, in columns and tables the old
 * build does not know) reaches it. Read-only: GET requests and one SELECT per table.
 */
const path = require("node:path");

const [, , baseUrl, modulesDir] = process.argv;
if (!baseUrl || !process.env.DATABASE_URL) {
  console.error("usage: DATABASE_URL=… node prev-build-check.cjs <baseUrl> [nodeModulesDir]");
  process.exit(2);
}
const { Client } = require(path.join(modulesDir ?? path.resolve("node_modules"), "pg"));

/** Each page and the words its answer starts from on that build. */
const PAGES = [
  ["/", "Where did the conversions go?"],
  ["/decisions?branch=B20", "Decision Lab"],
  ["/exceptions", "Incidents"],
  ["/onboarding", "Data onboarding"],
  ["/investigator", "Investigator"],
];
const BROKEN = /Something went wrong|Application error|Internal Server Error/i;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const uploads = (await db.query("select id from onboarding_uploads where workspace_owner is not null")).rows.map((r) => String(r.id));
  const questions = (await db.query("select id from workspace_investigations")).rows.map((r) => String(r.id));
  await db.end();
  console.log(`workspace items in the database: ${uploads.length} upload(s), ${questions.length} question(s)`);
  if (uploads.length + questions.length === 0) console.log("note: no workspace items to look for; run the rehearsal's journeys first");

  let failed = 0;
  const line = (ok, text) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "pass" : "FAIL"} ${text}`);
  };
  const linked = (html, prefix, ids) => ids.filter((id) => html.includes(`href="${prefix}${id}"`) || html.includes(`href="${prefix}${id}?`));

  for (const [route, words] of PAGES) {
    const res = await fetch(baseUrl + route, { redirect: "manual" });
    const html = await res.text();
    line(res.status === 200 && html.includes(words) && !BROKEN.test(html), `${route}: ${res.status}, ${html.includes(words) ? `shows "${words}"` : `"${words}" missing`}${BROKEN.test(html) ? ", shows an error page" : ""}`);
    const leaked = [...linked(html, "/onboarding/", uploads).map((id) => `upload ${id}`), ...linked(html, "/investigator/", questions).map((id) => `question ${id}`)];
    line(leaked.length === 0, `${route}: ${leaked.length ? `links ${leaked.join(", ")}` : "links no workspace item"}`);
  }

  const api = await fetch(baseUrl + "/api/investigations");
  const body = await api.text();
  let ids = [];
  try {
    const json = JSON.parse(body);
    const list = Array.isArray(json) ? json : (json.investigations ?? json.items ?? []);
    ids = list.map((i) => String(i.id));
  } catch {
    // Not JSON: an older build may refuse the guest; the ids are then looked for in the text.
  }
  const seen = questions.filter((id) => ids.includes(id) || new RegExp(`"id":\\s*${id}\\b`).test(body));
  line(api.status < 500 && seen.length === 0, `/api/investigations: ${api.status}, ${seen.length ? `lists question(s) ${seen.join(", ")}` : "lists no workspace question"}`);

  for (const id of questions.slice(0, 3)) {
    const res = await fetch(`${baseUrl}/investigator/${id}`, { redirect: "manual" });
    const html = await res.text();
    const shown = res.status === 200 && /Why did B20|Answered by|findings/i.test(html) && !/not found|404/i.test(html);
    line(!shown, `/investigator/${id}: ${res.status}, ${shown ? "shows the visitor's question" : "does not show it"}`);
  }
  console.log(failed ? `${failed} check(s) failed` : "every check passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

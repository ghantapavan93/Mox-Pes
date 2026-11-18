/**
 * Diagnostic preload: prints the call stack of every query whose SQL contains TRACE_SQL, to find
 * which render runs it (docs/agent-work/release/measurements/steps.md, step 0). Usage, from a
 * built worktree:
 *
 *   TRACE_SQL="refused_revision, company_level" PG_MODULE=<worktree>/node_modules/pg \
 *     NODE_OPTIONS="--require <this file>" npx next start -p 3996
 *
 * Next loads `pg` as an external package, so patching the same module instance is enough.
 * Never used in tests or in the product.
 */
const pg = require(process.env.PG_MODULE || "pg");
const needle = process.env.TRACE_SQL || "";
const query = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (text) {
  const sql = typeof text === "string" ? text : text && text.text;
  if (needle && sql && sql.includes(needle)) {
    const frames = new Error().stack.split("\n").slice(2, 40).map((l) => l.trim()).filter((l) => !l.includes("node:internal"));
    // Date.now() on purpose: inside a prerender Next reports it, which names the render.
    console.log("[trace-query]", Date.now(), "\n  " + frames.join("\n  "));
  }
  return query.apply(this, arguments);
};

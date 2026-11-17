# Deploying the demo: Vercel and Render

The app is one Next.js project. Vercel runs its pages and its API routes. Render holds the
Postgres database. Once Vercel is connected, every push to `main` redeploys the app. All data
is synthetic.

## 1. The database, on Render

1. In the Render dashboard, choose **New**, then **Postgres**.
2. **Region: Virginia (US East).** Vercel runs functions in Washington, D.C. (`iad1`) by default,
   so each query stays a short hop. A page runs many queries; a distant region adds a long round
   trip to each one.
3. **PostgreSQL version 17**, the version the app is tested on.
4. **Plan.** A free database expires 30 days after creation, and Render deletes it after a
   further 14-day grace period; an account holds one free database at a time. Choose a paid plan
   if the link must outlive that.
5. When the database is available, copy its **External Database URL**. It holds the password:
   paste it only into the prompt in step 2 and into Vercel, never into a chat or a file.

## 2. The data

```bash
npm run db:load-hosted
```

Paste the External Database URL at the hidden prompt. The script seeds a fresh local copy
(`revenue_signal_deploy`; it never touches `revenue_signal` or `revenue_signal_rc`), restores it
into Render in one transaction, compares every table's row count, and prints the `sslmode` the
app needs. Rerun it to reset the hosted demo. It needs the local Postgres on port 54333 and the
PostgreSQL 17 client tools (`pg_dump`, `pg_restore`).

## 3. The app, on Vercel

1. In Vercel, choose **Add New**, then **Project**, and import `ghantapavan93/Mox-Pes`. The
   framework is detected as Next.js; leave the build settings as they are.
2. Before the first deploy, add one environment variable: `DATABASE_URL`, set to the External
   Database URL followed by `?sslmode=` and the mode step 2 printed.
3. Deploy. The link is `https://<project>.vercel.app`.

Leave every other variable unset:

- `DEMO_MODE`: every visitor is a read-only guest who sees everything and can approve or run
  nothing (`lib/demo-mode.ts`).
- `INGEST_API_KEY`: the push API then refuses every request (`app/api/ingest/[source]/route.ts`
  fails closed in production).
- `ANTHROPIC_API_KEY`: the investigator takes its deterministic path, at no cost per visitor.

## Not deployed

- **The worker** (`npm run worker`). It runs connector syncs and scheduled jobs, which a
  read-only copy does not need. To add it, run it as a Render Background Worker with the same
  `DATABASE_URL`.
- **The interactive demo**: the role picker, approvals and fixes. It needs `DEMO_MODE=1`, which
  lets anyone with the link change the data for everyone after them. Show it from a laptop.

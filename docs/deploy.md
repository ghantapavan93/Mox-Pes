# Deploying the demo: Vercel and Neon

The app is one Next.js project. Vercel runs its pages and API routes; a Neon Postgres database
holds the synthetic world. Every visitor is a guest who reads every page and, with
`PUBLIC_WORKSPACE=1`, gets a private comparison workspace: their own uploads and questions, kept
24 hours, never counted (docs/agent-work/release/RELEASE-DESIGN.md §5.1–§5.2). All data is
synthetic.

## 1. The database, on Neon

1. One Neon project in **AWS US East (N. Virginia)**, beside Vercel's default function region
   (`iad1`): a page runs many queries, and a distant region adds a round trip to each.
2. **PostgreSQL 17**, the version the app is tested on.
3. One Neon branch per release (`release-YYYY-MM-DD`, from `main`), so a release never changes the
   database the running deployment reads. A rollback points the deployment back at the previous
   release's branch, unchanged.
4. Copy the branch's connection string with Neon's copy button. It holds the password: it goes
   only to the loader in step 2 and into Vercel, never into a chat or a file.

## 2. The data

```bash
npm run db:load-hosted:clipboard
```

The script reads the URL from the clipboard (Windows), seeds a fresh local copy
(`revenue_signal_deploy`; it never touches `revenue_signal` or `revenue_signal_rc`), restores it
into the target in one transaction, and compares every table's row count. When it finishes, the
clipboard holds the exact `DATABASE_URL` value for Vercel: the URL with the `sslmode` it verified.
`npm run db:load-hosted` asks for the URL at a hidden prompt instead. It needs the local Postgres
on port 54333 and the PostgreSQL 17 client tools (`pg_dump`, `pg_restore`).

Never use the loader to reset a database a deployment is serving: load a new release branch
instead. A rehearsal loads a local database (`ALLOW_LOCAL_TARGET=1`, see the release design §9).

## 3. The app, on Vercel

1. Import `ghantapavan93/Mox-Pes` as a Next.js project; leave the build settings as they are.
2. Environment variables, per environment (Production, and Preview for the release branch):
   - `DATABASE_URL`: the value step 2 left on the clipboard, piped from it so it never appears in
     a terminal: `npx tsx scripts/clipboard-to-stdout.ts | npx vercel env add DATABASE_URL preview <git branch>`
     (or `production`); then clear the clipboard (`Set-Clipboard -Value $null`).
     The app turns on TLS with certificate checks for any database that is not on this machine
     (`lib/db.ts`).
   - `PUBLIC_WORKSPACE=1`: the visitor workspace. Without it the guest is read-only.
3. `vercel.json` schedules `GET /api/workspace/cleanup` once a day; every onboarding and
   investigator request also deletes expired workspace items, so the cron only bounds a quiet demo.
4. Each deployment answers `GET /api/health` with the commit it was built from (`commit`) and the
   migrations its database has: the release check and the rollback check read it.

Leave every other variable unset:

- `DEMO_MODE`: with it, the role picker would let anyone with the link approve and change the data
  for everyone after them. Without it, nobody can switch roles (`POST /api/role` answers 404) and
  the header names the visitor instead.
- `INGEST_API_KEY`: the push API then refuses every request (`app/api/ingest/[source]/route.ts`
  fails closed in production).
- `ANTHROPIC_API_KEY`, `AI_INVESTIGATOR_PROVIDER`: a visitor's questions always take the
  deterministic evidence path (§5.9); no model runs on the hosted demo.

## 4. Release and rollback

1. Load the release branch (step 2) from the release commit's worktree.
2. Set the Preview variables for the release git branch, push it, and open a pull request: CI on
   Linux must be green, and the Preview deployment must pass the smoke (upload, result, evidence
   and Back, the investigator, `/api/health`).
3. Promote: Production's `DATABASE_URL` to the release branch, then fast-forward `main` to the
   release commit and push.
4. Rollback: promote the previous deployment in Vercel (instant, no rebuild); it still reads its
   own Neon branch. `GET /api/health` must then name the previous commit.

## Not deployed

- **The worker** (`npm run worker`). It runs connector syncs and scheduled jobs, which a demo
  copy does not need.
- **The interactive staff demo**: the role picker, approvals, publication and fixes. It needs
  `DEMO_MODE=1`, so it runs from a laptop (README, "Run the demo locally").

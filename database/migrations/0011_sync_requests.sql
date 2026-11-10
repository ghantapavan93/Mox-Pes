-- Audit 2026-11-09 (B-5): a sync request is idempotent by its key even when it created no job.
-- A request whose streams all had a queued job reused them and wrote no sync_jobs row, so the
-- key was never recorded: a retry re-planned it (creating jobs once those had started) and the
-- same key with a different request was accepted. The request itself is now recorded.
create table sync_requests (
  request_key  text primary key,
  fingerprint  text not null,
  -- every job the first response named, created or reused, in response order
  job_ids      bigint[] not null,
  requested_by text not null,
  created_at   timestamptz not null
);

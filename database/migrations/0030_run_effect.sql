-- What a delivery run changed in the accepted records (2026-11-14, docs/agent-work/DELIVERY-OUTCOMES.md).
--
-- ingestion_runs.inserted counts the record versions a run stored for the first time, accepted or
-- not. A revision older than the accepted one, delivered late, is stored and changes nothing, yet it
-- is counted: the Integrations pipeline showed it as "New 1" (run #679 in the B09 world). What a run
-- changed was recorded only on its intake event (domain_events 'intake.records_stored', rowsChanged),
-- in the run's own transaction, and only when the run stored, conflicted or changed something. A run
-- that only re-delivered stored versions left no record of its effect at all.
--
-- rows_changed: the accepted records the run's delivery wrote or removed (spend days, leads, CRM
-- records), 0 included, written in the run's own data transaction (lib/ingest/ingest.ts, runStream):
-- it commits with the change or not at all, and it is set, never added to, so writing it again
-- cannot double it. NULL means not recorded (a run before this column, or one whose transaction did
-- not commit); it never means "no change".
alter table ingestion_runs add column if not exists rows_changed integer check (rows_changed >= 0);

-- Runs recorded before this column: the count their intake event recorded, in the same transaction
-- as the change. Not where that count may be short: when the currency gate excluded an ads run's
-- records, it could also remove accepted spend, which that count left out (fixed with this column).
-- Runs without such an event stay NULL: whether they changed anything was not recorded.
update ingestion_runs r
set rows_changed = (e.payload ->> 'rowsChanged')::int
from domain_events e
where r.rows_changed is null
  and e.type = 'intake.records_stored'
  and e.payload ->> 'runId' ~ '^[0-9]{1,18}$'
  and (e.payload ->> 'runId')::bigint = r.id
  and e.payload ->> 'rowsChanged' ~ '^[0-9]{1,9}$'
  and not (r.source = 'ads' and coalesce(e.payload ->> 'excluded', '0') <> '0');

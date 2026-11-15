-- The campaign record follows the newest fetch, as each spend day does (2026-11-15,
-- docs/agent-work/RELEASE-CANDIDATE.md §1).
--
-- Spend reaches us as spend_day versions keyed by the source's fetch time, and the newest
-- fetchedAt wins (VENDOR-CONTRACTS G-5). Each version also carries its campaign's own fields:
-- name, type, Local Services flag, and so the campaign's latest classification. The spend
-- projection guards every upsert by that clock (lib/ingest/project.ts), but the campaign record
-- had no clock: any delivery that carried the campaign rewrote it. In the B09 world a revision of
-- Oct 20 fetched at 13:07, delivered after the 13:10 one, left the accepted spend alone and
-- renamed the campaign "B09 Coral | Search", filed google_search, type SEARCH.
--
-- source_updated_at: the fetch time of the version whose fields the record holds. Only a version
-- at least as new may set them (the projection's rule); an older one still files its own day.
alter table ad_campaigns add column if not exists source_updated_at timestamptz;

-- History: the newest fetch the campaign's accepted spend rests on, the clock the record's fields
-- were meant to follow. A record an older version already rewrote is not repaired here: it keeps
-- those fields until its next newer fetch or a re-projection. A campaign with no accepted spend
-- (only held versions) stays null: the first version that projects sets it.
update ad_campaigns c
set source_updated_at = s.newest
from (select campaign_id, max(source_updated_at) as newest from ad_spend_daily group by campaign_id) s
where s.campaign_id = c.id and c.source_updated_at is null;

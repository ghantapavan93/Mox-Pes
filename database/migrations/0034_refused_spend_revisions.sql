-- A newer spend revision the active mapper refuses holds the decision that reads it (2026-11-16,
-- docs/agent-work/HOLD-TO-DECISION.md; REMAINING-RISKS.md R-54, case 2).
--
-- Before: the source sent a newer revision of a campaign-day, intake refused it (fractional
-- conversions, another currency), and the older amount stayed counted. The quarantine incident took
-- its branch from the payload, and a spend payload names a campaign, not a branch, so the incident
-- had no branch and held no decision: Decision Lab read "Ready for review" on an amount the source
-- had since revised.
--
-- v_refused_spend_revisions sets each refused ad spend record against the revision the ledger
-- counts for the same campaign-day. Identity is the record's own: platform, campaign id and date
-- (the mapper's entity_id, matched on both records). Order is the source's clock: occurred_at, the
-- parsed fetch time. Never the campaign's name, its ad account or the order of arrival.
--   newer         the refused revision is newer than the counted one: the counted amount stands,
--                 and the decision reading this campaign-day is held for the campaign's branch
--   superseded    a counted revision is newer: it replaced the refused one, which holds nothing
--   same_instant  the counted revision has the same source instant: neither is newer (R-54 case 3)
-- A refused record the ledger counts no revision for (a held day) or cannot identify is not here:
-- held spend keeps its own rule (book §9.6.6, N1; verified readiness's `complete` check).
create view v_refused_spend_revisions as
select re.id as raw_event_id,
       re.entity_id,
       re.error_code,
       re.error_detail,
       re.occurred_at as refused_fetched_at,
       re.ingestion_run_id as refused_run_id,
       case when re.payload ->> 'costMicros' ~ '^[0-9]{1,18}$'
            then div((re.payload ->> 'costMicros')::numeric + 5000, 10000)::bigint end as refused_cents,
       s.campaign_id,
       c.platform,
       c.external_campaign_id,
       s.spend_date,
       s.channel_code,
       s.cost_cents as accepted_cents,
       acc.id as accepted_raw_event_id,
       acc.occurred_at as accepted_fetched_at,
       acc.ingestion_run_id as accepted_run_id,
       m.branch_id,
       case when re.occurred_at > acc.occurred_at then 'newer'
            when re.occurred_at < acc.occurred_at then 'superseded'
            else 'same_instant' end as standing
from raw_events re
join ad_campaigns c on c.platform = re.payload ->> 'platform' and c.external_campaign_id = re.payload ->> 'campaignId'
join ad_spend_daily s on s.campaign_id = c.id and s.spend_date = try_date(re.payload ->> 'date')
join raw_events acc on acc.id = s.raw_event_id and acc.source = re.source and acc.entity = re.entity and acc.entity_id = re.entity_id
left join campaign_branch_map m on m.campaign_id = s.campaign_id
where re.source = 'ads' and re.entity = 'spend_day' and re.status = 'quarantined';

-- The quarantined records that still hold something back, each with the branch whose decision it
-- holds: the branch its payload names, else (a refused spend revision newer than the counted one)
-- the branch its campaign is mapped to. A refused revision a counted one superseded is left out.
-- Reconciliation groups these into incidents (lib/reconcile/reconcile.ts, rule 1) and the incident
-- lists the same group (lib/ingest/replay.ts, quarantineGroupIds): one definition for both.
create view v_quarantine_holds as
select re.id,
       re.source,
       re.error_code,
       re.error_detail,
       re.occurred_at,
       re.payload,
       coalesce(payload_branch(re.payload), case when v.standing = 'newer' then v.branch_id end) as branch_id,
       v.standing
from raw_events re
left join v_refused_spend_revisions v on v.raw_event_id = re.id
where re.status = 'quarantined' and v.standing is distinct from 'superseded';

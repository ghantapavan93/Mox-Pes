-- A refused ad spend record holds the branch its campaign is mapped to, never a branch its payload
-- names (2026-11-18; EGM review of docs/agent-work/HOLD-TO-DECISION.md, K5).
--
-- Before: v_quarantine_holds took coalesce(payload_branch(payload), the campaign's branch). A spend
-- payload names a campaign, not a branch, but nothing rejects extra keys, so a refused revision of
-- a B09 campaign carrying branchId "B10" held B10's decision and left B09's free: the failure the
-- record's §1.7 names ("the wrong branch is held"). The investigator's tools, the metric trace and
-- the shadow snapshot used the same payload-first rule for the branch of a raw event.
--
-- raw_event_branch is that rule once: ad spend belongs to the branch its campaign is mapped to (null
-- when the campaign is unknown or unmapped), and every other record to the branch its payload names.

create function raw_event_branch(src text, ent text, p jsonb) returns text
language sql stable as $$
  select case
    when src = 'ads' and ent = 'spend_day' then (
      select m.branch_id from ad_campaigns c join campaign_branch_map m on m.campaign_id = c.id
      where c.platform = p ->> 'platform' and c.external_campaign_id = p ->> 'campaignId')
    else payload_branch(p)
  end
$$;

-- The same columns as migration 0034. Ad spend holds its campaign's branch only while the refused
-- revision is newer than the counted one; any other refused spend record (a held day, an unknown or
-- unmapped campaign, the same instant) is company level, as before.
create or replace view v_quarantine_holds as
select re.id,
       re.source,
       re.error_code,
       re.error_detail,
       re.occurred_at,
       re.payload,
       case when re.source = 'ads' and re.entity = 'spend_day'
            then case when v.standing = 'newer' then v.branch_id end
            else payload_branch(re.payload) end as branch_id,
       v.standing
from raw_events re
left join v_refused_spend_revisions v on v.raw_event_id = re.id
where re.status = 'quarantined' and v.standing is distinct from 'superseded';

-- R-46 (2026-11-13): a lead's campaign is the campaign with its id ON THE AD PLATFORM THE LEAD'S
-- OWN RECORD NAMES. A bare id is not enough: Google and Meta campaign ids are unique only within
-- their own platform, so two platforms can use one id, and "the only campaign with this id today"
-- says nothing about the record. Until now the scorecard, the paid-CAC trace, the decision gate,
-- the CAC inquiry and the customer journey matched leads to campaigns by id alone: a mapped
-- Google campaign lost its paid customer to an unmapped Meta campaign with the same id, and a
-- journey showed the lowest-numbered campaign with the id, whoever's it was.
--
-- The platforms a record names, read only from its own explicit fields, by source contract
-- (lib/adapters/marketing.ts reads the same fields for the channel):
--   calls  the call-tracking source label: "Google Ads" -> google_ads, "Google LSA" -> google_lsa,
--          "Facebook" -> meta, "Bing" -> microsoft_ads ("Google My Business" and "Direct" name no
--          ad platform); a gclid -> google_ads (Google's click id).
--   web    a gclid -> google_ads; a paid utm_medium (cpc, paid, ppc, paid_social) with utm_source
--          google -> google_ads, facebook / meta / instagram -> meta, bing -> microsoft_ads.
--   d2d    none.
-- Exactly one platform: matched on (platform, id), the campaigns' own unique key, so the platform
-- also fixes the ad account; leads name no account and none is guessed. No platform, or two:
-- unresolved, and nothing is chosen between campaigns. The lead, its customer and every amount
-- stay as they are; only the campaign link is withheld, and the evidence says why.
--
-- Plain expressions, so the planner inlines them: written as one union-and-aggregate query the
-- same rule took 169 ms over the demo world's 13,366 leads with a campaign id; this takes 70 ms.

-- The platform the record's own label names: a call's source label, a web form's paid utm_source.
create function lead_label_platform(source text, payload jsonb) returns text
language sql immutable as $$
  select case source
    when 'calls' then case payload ->> 'source'
      when 'Google Ads' then 'google_ads' when 'Google LSA' then 'google_lsa'
      when 'Facebook' then 'meta' when 'Bing' then 'microsoft_ads' end
    when 'web' then case when lower(payload -> 'properties' ->> 'utm_medium') in ('cpc', 'paid', 'ppc', 'paid_social') then
      case lower(payload -> 'properties' ->> 'utm_source')
        when 'google' then 'google_ads' when 'facebook' then 'meta' when 'meta' then 'meta'
        when 'instagram' then 'meta' when 'bing' then 'microsoft_ads' end end
  end
$$;

-- google_ads when the record carries a Google click id (gclid).
create function lead_click_platform(source text, payload jsonb) returns text
language sql immutable as $$
  select case when coalesce(case source when 'calls' then payload ->> 'gclid' when 'web' then payload -> 'properties' ->> 'gclid' end, '') <> ''
              then 'google_ads' end
$$;

-- Two named platforms as a sorted set: {}, {one}, or {two} when they disagree.
create function campaign_platform_set(a text, b text) returns text[]
language sql immutable as $$
  select case when a is null and b is null then '{}'::text[]
              when a is null then array[b]
              when b is null or a = b then array[a]
              else array[least(a, b), greatest(a, b)] end
$$;

create function lead_campaign_platforms(source text, payload jsonb) returns text[]
language sql immutable as $$
  select campaign_platform_set(lead_label_platform(source, payload), lead_click_platform(source, payload))
$$;

-- One row per lead that carries a campaign id. `status`:
--   matched                  one platform named, and a campaign with the id on it (campaign_id)
--   no_campaign_on_platform  one platform named, and no campaign on it has the id (`platform` is
--                            still set: a campaign whose spend was all held may have no record)
--   no_platform              the record names no ad platform
--   conflicting_platforms    the record names more than one (`platforms`)
create view v_lead_campaigns as
select l.id as lead_id, l.campaign_external_id, named.platforms,
       case when cardinality(named.platforms) = 1 then named.platforms[1] end as platform,
       c.id as campaign_id,
       case when cardinality(named.platforms) = 0 then 'no_platform'
            when cardinality(named.platforms) > 1 then 'conflicting_platforms'
            when c.id is null then 'no_campaign_on_platform'
            else 'matched' end as status
from leads l
join raw_events re on re.id = l.raw_event_id
-- offset 0: computed once per lead. Flattened, the planner evaluated it once for every reference
-- to its result below, five or six times a row (730 ms over the demo world).
cross join lateral (select lead_campaign_platforms(l.source, re.payload) as platforms offset 0) named
left join ad_campaigns c
  on cardinality(named.platforms) = 1 and c.platform = named.platforms[1] and c.external_campaign_id = l.campaign_external_id
where l.campaign_external_id is not null;

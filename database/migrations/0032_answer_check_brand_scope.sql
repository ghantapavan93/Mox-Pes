-- An answer check that read a brand is readable only by viewers who may see the whole brand
-- (2026-11-15, docs/agent-work/BIVE-ACCEPTANCE.md, F-1).
--
-- A check's stored branch_ids decide who may read it (lib/shadow/store.ts, VISIBLE: every branch
-- it read must be in the viewer's scope). An answer check stored only the branches it named. One
-- that read a brand's metrics ("Moxie Pest Control paid CAC was ...") was stored with no branches,
-- and an empty scope is inside every scope: the B20 partner and the Joshua's brand lead could read
-- a company-wide analyst's Moxie figures. New checks store every branch of each brand they read.
-- This repairs checks recorded before: their result names the brands they read.
update shadow_checks s
set branch_ids = (
  select array(
    select distinct x from unnest(
      s.branch_ids || coalesce((
        select array_agg(b.id) from branches b
        where b.brand_id in (select jsonb_array_elements_text(s.result -> 'entities' -> 'brands'))
      ), '{}'::text[])
    ) as x order by x
  )
)
where s.kind = 'answer'
  and jsonb_typeof(s.result -> 'entities' -> 'brands') = 'array'
  and jsonb_array_length(s.result -> 'entities' -> 'brands') > 0;

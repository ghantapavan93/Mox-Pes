import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { ACTIVE_VERSION, mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withTransaction, type Queryable } from "@/lib/db";
import { projectAll, type ProjectionItem } from "@/lib/ingest/project";
import { ForbiddenError, requirePermission, type Viewer } from "@/lib/viewer";
import { activeCurrencyRules, covered, CURRENCY_UNSTATED, lockCurrencyExclusive } from "./coverage";

export { activeCurrencyRules, covered, CURRENCY_UNSTATED };

/**
 * Account currency rules: spend whose feed did not state a currency is NOT dollars until two
 * people say the account reports in USD.
 *
 * Without an authorized rule, an unstated-currency spend record is excluded at intake (raw event
 * status 'excluded', code CURRENCY_UNSTATED; the currency gate in lib/ingest/project.ts) and shown
 * wherever held records are: the metric trace and the ingestion failures. An integration engineer
 * proposes a rule with a reason; a DIFFERENT person with approval rights authorizes it (the same
 * maker-checker as every data change), and the account's held records are re-projected as
 * currency_basis 'account_rule_usd', so every figure built from them can say why they count as
 * USD. Revoking a rule excludes them again. Every step is audited. Spend in another currency is
 * never converted (CURRENCY_UNSUPPORTED, quarantined by the mapper), rule or not.
 *
 * A rule names one platform and one ad account. "*" as the account means every account of the
 * platform; "*" as both means company-wide (used by test fixtures, stated as such).
 */

export interface CurrencyRule {
  id: number;
  platform: string;
  adAccountId: string;
  currency: "USD";
  proposedBy: string;
  proposedAt: string;
  reason: string;
  /** Null while the proposal waits for a second person. */
  authorizedBy: string | null;
  authorizedAt: string | null;
  /** Spend records of this account held for lacking a stated currency, now. */
  heldRecords: number;
}

const PLATFORM = /^(?:\*|google_ads|google_lsa|microsoft_ads|meta)$/;
const ACCOUNT = /^[\w*.-]{1,80}$/;

export async function listCurrencyRules(db: Queryable): Promise<CurrencyRule[]> {
  const { rows } = await db.query(
    `select r.id, r.platform, r.ad_account_id, r.proposed_by, r.proposed_at, r.reason, r.authorized_by, r.authorized_at,
            (select count(*) from raw_events re where re.source = 'ads' and re.status = 'excluded' and re.exclusion_code = $1
               and (r.platform = '*' or re.payload ->> 'platform' = r.platform) and (r.ad_account_id = '*' or re.payload ->> 'accountId' = r.ad_account_id)) as held
     from currency_rules r where r.revoked_at is null order by r.authorized_at nulls first, r.platform, r.ad_account_id`,
    [CURRENCY_UNSTATED],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    platform: r.platform,
    adAccountId: r.ad_account_id,
    currency: "USD",
    proposedBy: r.proposed_by,
    proposedAt: new Date(r.proposed_at).toISOString(),
    reason: r.reason,
    authorizedBy: r.authorized_by ?? null,
    authorizedAt: r.authorized_at ? new Date(r.authorized_at).toISOString() : null,
    heldRecords: Number(r.held),
  }));
}

/**
 * The ad accounts whose spend is held for lacking a stated currency, with no authorized rule: what
 * a person must decide (a pending proposal is shown with it). Counted per campaign-day at its newest held version, and only where no
 * version of that day is counted: platforms restate a day on every fetch, so summing every held
 * record overstated the money several times over (review 2026-11-12, financial finding 6).
 */
export async function accountsAwaitingCurrency(db: Queryable): Promise<Array<{ platform: string; adAccountId: string; campaignDays: number; amountCents: number }>> {
  const { rows } = await db.query(
    `with held as (
       select distinct on (re.payload ->> 'platform', re.payload ->> 'campaignId', re.payload ->> 'date')
              re.payload ->> 'platform' as platform, re.payload ->> 'accountId' as account, re.payload ->> 'campaignId' as ext,
              (re.payload ->> 'date')::date as day, round(((re.payload ->> 'costMicros')::numeric) / 10000) as cents
       from raw_events re
       where re.source = 'ads' and re.status = 'excluded' and re.exclusion_code = $1
       order by re.payload ->> 'platform', re.payload ->> 'campaignId', re.payload ->> 'date', (re.payload ->> 'fetchedAt')::timestamptz desc, re.id desc
     )
     select h.platform, h.account, count(*) as n, coalesce(sum(h.cents), 0) as cents
     from held h
     where not exists (select 1 from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id
                       where c.platform = h.platform and c.external_campaign_id = h.ext and s.spend_date = h.day)
       -- Only an AUTHORIZED rule settles it: while a rule is merely proposed the money is still
       -- held and still awaits a decision (VP acceptance, first contact: a proposal hid it).
       and not exists (select 1 from currency_rules r where r.revoked_at is null and r.authorized_at is not null
                         and (r.platform = '*' or r.platform = h.platform)
                         and (r.ad_account_id = '*' or r.ad_account_id = h.account))
     group by 1, 2 order by 4 desc`,
    [CURRENCY_UNSTATED],
  );
  return rows.map((r) => ({ platform: r.platform, adAccountId: r.account, campaignDays: Number(r.n), amountCents: Number(r.cents) }));
}

/** An integration engineer proposes "this account reports in USD", with a reason. Nothing counts until another person authorizes it. */
export async function proposeCurrencyRule(pool: Pool, viewer: Viewer, args: { platform: string; adAccountId: string; reason: string; now: Date }): Promise<{ ruleId: number }> {
  requirePermission(viewer, "sync", "propose a currency rule");
  const reason = args.reason.trim();
  if (reason.length < 10) throw new ActionError("Say why this account reports in USD (at least 10 characters)", 400);
  // A person vouches for one account they have looked at. A wildcard would make every account of
  // a platform, including ones nobody has seen yet, count as dollars (review 2026-11-12, A-10);
  // the company-wide rule exists only in test fixtures, inserted directly and stated as such.
  if (!PLATFORM.test(args.platform) || args.platform === "*") throw new ActionError(`Unknown ad platform ${args.platform}`, 400);
  if (!ACCOUNT.test(args.adAccountId) || args.adAccountId.includes("*")) throw new ActionError("An ad account id is letters, digits, '.', '-' or '_', and names one account", 400);
  return withTransaction(pool, async (tx) => {
    const live = await tx.query("select id from currency_rules where platform = $1 and ad_account_id = $2 and revoked_at is null for update", [args.platform, args.adAccountId]);
    if (live.rows.length > 0) throw new ActionError(`A rule for ${args.platform} account ${args.adAccountId} is already proposed or authorized`, 409);
    const { rows } = await tx.query<{ id: string }>(
      `insert into currency_rules (platform, ad_account_id, currency, proposed_by, proposed_at, reason) values ($1, $2, 'USD', $3, $4, $5) returning id`,
      [args.platform, args.adAccountId, viewer.subject, args.now, reason],
    );
    const ruleId = Number(rows[0].id);
    await audit(tx, args.now, viewer.subject, "currency_rule_proposed", ruleId, { platform: args.platform, adAccountId: args.adAccountId, currency: "USD", reason });
    return { ruleId };
  });
}

/**
 * A second person with approval rights authorizes a proposed rule; the account's held spend
 * records are re-projected in the same transaction.
 */
export async function authorizeCurrencyRule(pool: Pool, viewer: Viewer, args: { ruleId: number; now: Date }): Promise<{ reprojected: number }> {
  requirePermission(viewer, "approve", "authorize a currency rule");
  return withTransaction(pool, async (tx) => {
    // Exclusive, first: no intake batch can hold a record between the re-projection's read and
    // this commit, so none is left excluded under a live rule (review 2026-11-12, A-2).
    await lockCurrencyExclusive(tx);
    const { rows } = await tx.query<{ platform: string; ad_account_id: string; proposed_by: string; authorized_at: Date | null }>(
      "select platform, ad_account_id, proposed_by, authorized_at from currency_rules where id = $1 and revoked_at is null for update",
      [args.ruleId],
    );
    const rule = rows[0];
    if (!rule) throw new ActionError(`No live currency rule ${args.ruleId}`, 404);
    if (rule.authorized_at) throw new ActionError(`Currency rule ${args.ruleId} is already authorized`, 409);
    if (rule.proposed_by === viewer.subject) throw new ForbiddenError("The person who proposed a currency rule cannot also authorize it");
    await tx.query("update currency_rules set authorized_by = $2, authorized_at = $3 where id = $1", [args.ruleId, viewer.subject, args.now]);
    const reprojected = await reprojectHeld(tx, rule.platform, rule.ad_account_id, args.now);
    await audit(tx, args.now, viewer.subject, "currency_rule_authorized", args.ruleId, { platform: rule.platform, adAccountId: rule.ad_account_id, proposedBy: rule.proposed_by, reprojected });
    return { reprojected };
  });
}

/** Revokes a rule (a proposal or an authorized one): the spend it made countable is excluded again, unless another rule still covers it. */
export async function revokeCurrencyRule(pool: Pool, viewer: Viewer, args: { ruleId: number; reason: string; now: Date }): Promise<{ excluded: number }> {
  if (!viewer.can.sync && !viewer.can.approve) throw new ForbiddenError(`${viewer.label} cannot revoke a currency rule`);
  const reason = args.reason.trim();
  if (reason.length < 10) throw new ActionError("Say why the rule no longer holds (at least 10 characters)", 400);
  return withTransaction(pool, async (tx) => {
    // Exclusive, first: an intake batch that read the rule as live cannot commit spend under it
    // after this revocation (review 2026-11-12, A-1).
    await lockCurrencyExclusive(tx);
    const { rows } = await tx.query<{ platform: string; ad_account_id: string }>(
      "update currency_rules set revoked_at = $2, revoked_by = $3, revoked_reason = $4 where id = $1 and revoked_at is null returning platform, ad_account_id",
      [args.ruleId, args.now, viewer.subject, reason],
    );
    if (rows.length === 0) throw new ActionError(`No live currency rule ${args.ruleId}`, 404);
    const rules = await activeCurrencyRules(tx);
    // The account a rule covers is the one the record's own payload names, as at intake, not
    // the campaign's stored account, which a later record may have changed (review F-11).
    const spend = await tx.query<{ campaign_id: string; spend_date: string; raw_event_id: string; platform: string; ad_account_id: string }>(
      `select s.campaign_id, s.spend_date::text, s.raw_event_id, re.payload ->> 'platform' as platform, re.payload ->> 'accountId' as ad_account_id
       from ad_spend_daily s join raw_events re on re.id = s.raw_event_id
       where s.currency_basis = 'account_rule_usd'
         and ($1 = '*' or re.payload ->> 'platform' = $1) and ($2 = '*' or re.payload ->> 'accountId' = $2)`,
      [rows[0].platform, rows[0].ad_account_id],
    );
    const uncovered = spend.rows.filter((s) => !covered(rules, s.platform, s.ad_account_id));
    for (const s of uncovered) {
      await tx.query("delete from ad_spend_daily where campaign_id = $1 and spend_date = $2", [s.campaign_id, s.spend_date]);
    }
    if (uncovered.length > 0) {
      await tx.query(
        `update raw_events set status = 'excluded', exclusion_code = $2, exclusion_detail = 'the currency rule that made this spend countable was revoked', projected_at = null where id = any($1::bigint[])`,
        [uncovered.map((s) => Number(s.raw_event_id)), CURRENCY_UNSTATED],
      );
    }
    await audit(tx, args.now, viewer.subject, "currency_rule_revoked", args.ruleId, { reason, excluded: uncovered.length });
    return { excluded: uncovered.length };
  });
}

/**
 * Re-projects the spend records of an account that were excluded for lacking a stated currency,
 * now that a rule covers it. Oldest receipt first, so the newest version of a campaign-day wins.
 */
export async function reprojectHeld(tx: Queryable, platform: string, adAccountId: string, now: Date): Promise<number> {
  const { rows } = await tx.query<{ id: string; entity: string; payload: Record<string, unknown>; received_at: Date }>(
    `select id, entity, payload, received_at from raw_events
     where source = 'ads' and status = 'excluded' and exclusion_code = $1
       and ($2 = '*' or payload ->> 'platform' = $2) and ($3 = '*' or payload ->> 'accountId' = $3)
     order by received_at, id for update`,
    [CURRENCY_UNSTATED, platform, adAccountId],
  );
  if (rows.length === 0) return 0;
  const mapper = mapperFor("ads", ACTIVE_VERSION.ads);
  const items: ProjectionItem[] = [];
  const ids: number[] = [];
  for (const r of rows) {
    const result = mapper.map({ entity: r.entity, payload: r.payload }, { ...referenceContext, receivedAt: r.received_at });
    if (!result.ok || result.projection.table !== "ad_spend_daily") continue;
    items.push({ projection: result.projection, rawEventId: Number(r.id) });
    ids.push(Number(r.id));
  }
  // The currency gate in projectAll sees the authorized rule and stores account_rule_usd. A
  // record it still holds (a rule scoped to another account, a newer held version) stays excluded.
  const gate = { held: [] as number[] };
  await projectAll(tx, items, gate);
  const heldIds = new Set(gate.held);
  const projected = ids.filter((id) => !heldIds.has(id));
  if (projected.length > 0) {
    await tx.query(
      `update raw_events set status = 'projected', exclusion_code = null, exclusion_detail = null, projected_at = $2, adapter_version = $3 where id = any($1::bigint[])`,
      [projected, now, `ads@${ACTIVE_VERSION.ads}`],
    );
  }
  return projected.length;
}

async function audit(tx: Queryable, now: Date, actor: string, action: string, ruleId: number, detail: Record<string, unknown>) {
  await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, $3, $4, $5)", [now, actor, action, `currency_rule:${ruleId}`, detail]);
}

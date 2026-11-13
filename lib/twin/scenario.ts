import type { RawRecord } from "@/lib/adapters/contract";
import type { FaultInput } from "@/lib/connectors/faults";
import type { CrmEntity } from "@/lib/connectors/types";
import type { Queryable } from "@/lib/db";
import { PERIODS } from "@/lib/period";
import { canonicalJson, instantToWallTime, sha256 } from "@/lib/primitives";
import { BRANCHES, BRANCH_BY_ID } from "@/lib/reference";
import type { SourceRecordVersion } from "@/lib/sim/world";

/**
 * Scenario TW-1: the calls@1.1 → calls@1.2 source-contract upgrade, rolled out over
 * 1 → 5 → 44 branches in the twin.
 *
 * What the upgrade changes (lib/adapters/marketing.ts, verified in code): calls@1.2 reads three
 * CallRail fields calls@1.1 strips, and gives each its own exclusion: an outbound call
 * (NOT_INBOUND), a call marked spam (SPAM_CALL), a call marked "not a lead" (NOT_A_LEAD). A later
 * revision that marks a counted call this way takes it out of every lead metric; a later
 * qualifying revision restores it. Both versions read both caller shapes, so nothing else moves.
 * The consequence for customers: a lead that leaves stops being anyone's first touch, so the
 * customer's credit moves to their next touch, or to "no lead" (unknown).
 *
 * The synthetic world carries none of these fields, so the scenario supplies them: revisions and
 * calls CallRail would have sent all along (calls@1.1 counted them), and more during each stage,
 * picked deterministically from the world. Every input is stored with the evaluation's twin and
 * hashed.
 */

export const TWIN_SCENARIO_ID = "TW-1";
export const TWIN_SCENARIO_VERSION = "1";
export const FROM_VERSIONS = ["1.0", "1.1"] as const;
export const BASELINE_VERSION = "1.1";
export const TO_VERSION = "1.2";

export type StageKey = "A" | "B" | "C";
export type StepName = "reproject" | "deliver" | "backfill" | "reconcile" | "gates";
export const STEPS: readonly StepName[] = ["reproject", "deliver", "backfill", "reconcile", "gates"];

export const VARIANTS = {
  standard: {
    label: "Standard rollout",
    description: "Every stage meets rate limits, an outage, a timeout and an interrupted worker; nothing in the inputs should stop the rollout.",
  },
  scope_leak: {
    label: "Cross-brand credit (expected to stop)",
    description: "A call tagged to a stage-B branch is the first touch of a customer of another brand outside the stage; excluding it moves that brand's numbers.",
  },
  source_outage: {
    label: "CRM outage (expected to stop)",
    description: "The CRM refuses one stage-B office's subscriptions for the whole stage; the backfill cannot complete.",
  },
} as const;
export type Variant = keyof typeof VARIANTS;
export const isVariant = (v: unknown): v is Variant => typeof v === "string" && Object.hasOwn(VARIANTS, v);

export interface StagePlan {
  key: StageKey;
  label: string;
  branchIds: string[];
  newBranchIds: string[];
}

const STAGE_A = ["B12"];
// Three brands, four time zones, distinct offices and call accounts.
const STAGE_B = ["B12", "B05", "B23", "B28", "B41"];
export const STAGES: StagePlan[] = [
  { key: "A", label: "1 branch", branchIds: STAGE_A, newBranchIds: STAGE_A },
  { key: "B", label: "5 branches", branchIds: STAGE_B, newBranchIds: STAGE_B.filter((b) => !STAGE_A.includes(b)) },
  { key: "C", label: "44 branches", branchIds: BRANCHES.map((b) => b.id), newBranchIds: BRANCHES.map((b) => b.id).filter((b) => !STAGE_B.includes(b)) },
];

const office = (branchId: string) => BRANCH_BY_ID.get(branchId)!.crmOfficeId;

export interface BackfillPlan {
  entities: CrmEntity[];
  /** Mock FieldRoutes faults, created in the twin before the backfill runs. */
  faults: FaultInput[];
  /** A worker that stops responding after committing `afterBatches` batches of this job. */
  workerDeath?: { officeId: number; entity: CrmEntity; afterBatches: number };
  /** The runbook: retry a job that used up its attempts, once, after the outage. */
  runbookRetry: boolean;
}

export interface StageFaults {
  backfill: BackfillPlan;
  /** The rollout runner itself stops after this step's work commits, before it is acknowledged. */
  interruptAfter?: StepName;
}

/** Two fault families at every stage: source errors during the backfill, and a process lost after a commit. */
export function faultPlan(variant: Variant): Record<StageKey, StageFaults> {
  const entities: CrmEntity[] = ["customer", "subscription", "appointment"];
  return {
    A: {
      // 429 on the first customer search; the mock sends Retry-After (FieldRoutes documents none).
      backfill: { entities, faults: [{ kind: "rate_limit", officeId: office("B12"), entity: "customer", action: "search", remaining: 1, retryAfterSeconds: 90 }], runbookRetry: true },
      interruptAfter: "reproject",
    },
    B: {
      backfill: {
        entities,
        faults:
          variant === "source_outage"
            ? [{ kind: "unavailable", officeId: office("B28"), entity: "subscription", action: null, remaining: null }]
            : [
                // 503 on the second get: one batch committed, then the job resumes after it.
                { kind: "unavailable", officeId: office("B05"), entity: "subscription", action: "get", remaining: 1, skip: 1 },
                { kind: "rate_limit", officeId: office("B41"), entity: "customer", action: "get", remaining: 2 },
              ],
        workerDeath: { officeId: office("B23"), entity: "appointment", afterBatches: 1 },
        runbookRetry: true,
      },
    },
    C: {
      backfill: {
        entities,
        faults: [
          // A delayed response: the mock answers after 6 s, past the client's 5 s timeout.
          { kind: "timeout", officeId: office("B33"), entity: "customer", action: "search", remaining: 1, delayMs: 6_000 },
          // Down for exactly the job's five attempts: the job fails, and the runbook retry succeeds.
          { kind: "unavailable", officeId: office("B37"), entity: "customer", action: null, remaining: 5 },
        ],
        runbookRetry: true,
      },
      interruptAfter: "deliver",
    },
  };
}

// ── Generated inputs ────────────────────────────────────────────────────────

export type InputRole =
  | "spam_before" | "not_a_lead_before" | "outbound_before" | "no_op_before"
  | "spam_A" | "correction_B" | "not_a_lead_B" | "unreadable_B" | "spam_C"
  | "new_customer_paid" | "new_customer_spam" | "cross_brand_touch";

export interface InputNote {
  role: InputRole;
  branchId: string;
  customerId: number;
  callId: string;
}

export interface Overlay {
  preRollout: RawRecord[];
  inflight: Record<StageKey, RawRecord[]>;
  /** CRM records the mock serves besides the world's: new customers the backfill must bring in. */
  crm: SourceRecordVersion[];
  notes: InputNote[];
}

interface Candidate {
  customer: number;
  branchId: string;
  callId: string;
  payload: Record<string, unknown>;
  phone: string;
  callAt: Date;
  soldAt: Date;
}

const asCall = (payload: Record<string, unknown>): RawRecord => ({ entity: "call", payload });
const MIN = 60_000;

/**
 * Picks the inputs from the twin world as cloned (identical to the base). Deterministic: the
 * same world gives the same inputs, in the same order.
 */
export async function buildOverlay(db: Queryable, variant: Variant): Promise<Overlay> {
  const { rows } = await db.query<{ customer: string; branch_id: string; call_id: string; payload: Record<string, unknown>; phone: string; call_at: Date; sold_at: Date }>(
    `select a.crm_customer_id::text as customer, a.branch_id, l.source_lead_id as call_id, re.payload, c.phone_hash as phone,
            l.occurred_at as call_at, a.sold_at
     from v_acquisitions a
     join leads l on l.id = a.lead_id and l.source = 'calls' and l.branch_id = a.branch_id
     join raw_events re on re.id = l.raw_event_id
     join channels ch on ch.code = a.channel_code and ch.is_paid and ch.cost_basis = 'media'
     join crm_customers c on c.crm_customer_id = a.crm_customer_id
     where a.initial_status = 'completed' and a.initial_completed_at >= $1 and a.initial_completed_at < $2
       and c.phone_hash is not null
       and not exists (select 1 from crm_customers o where o.phone_hash = c.phone_hash and o.crm_customer_id <> c.crm_customer_id)
       and (select count(*) from raw_events v where v.source = 'calls' and v.entity_id = l.source_lead_id) = 1
     order by md5(a.crm_customer_id::text || 'TW-1'), a.crm_customer_id`,
    [PERIODS.all.from, PERIODS.all.to],
  );
  const byBranch = new Map<string, Candidate[]>();
  for (const r of rows) {
    const list = byBranch.get(r.branch_id) ?? [];
    list.push({ customer: Number(r.customer), branchId: r.branch_id, callId: r.call_id, payload: r.payload, phone: r.phone, callAt: r.call_at, soldAt: r.sold_at });
    byBranch.set(r.branch_id, list);
  }

  const preRollout: RawRecord[] = [];
  const inflight: Record<StageKey, RawRecord[]> = { A: [], B: [], C: [] };
  const crm: SourceRecordVersion[] = [];
  const notes: InputNote[] = [];
  const note = (role: InputRole, c: Pick<Candidate, "branchId" | "customer" | "callId">) => notes.push({ role, branchId: c.branchId, customerId: c.customer, callId: c.callId });
  const revise = (c: Candidate, fields: Record<string, unknown>) => asCall({ ...c.payload, ...fields });

  BRANCHES.forEach((branch, i) => {
    const pool = [...(byBranch.get(branch.id) ?? [])];
    const take = () => pool.shift();
    // Classification patterns differ by branch: more spam here, more outbound there.
    const spamCount = 1 + (i % 3);
    const outboundCount = 1 + ((i + 1) % 3);
    for (let k = 0; k < spamCount; k++) {
      const c = take();
      if (!c) break;
      preRollout.push(revise(c, { spam: true }));
      note("spam_before", c);
      if (branch.id === "B05" && k === 0) {
        // Missing evidence: a later revision of this call arrives without its caller.
        const unreadable: Record<string, unknown> = { ...c.payload, spam: true, agent_note: "revision without caller" };
        delete unreadable.customer_phone_number;
        inflight.B.push(asCall(unreadable));
        note("unreadable_B", c);
      }
    }
    const notALead = take();
    if (notALead) {
      preRollout.push(revise(notALead, { lead_status: "not_a_lead" }));
      note("not_a_lead_before", notALead);
      // A person reverses it in CallRail during stage B.
      inflight.B.push(revise(notALead, { lead_status: "good_lead" }));
      note("correction_B", notALead);
    }
    for (let k = 0; k < outboundCount; k++) {
      const c = take();
      if (!c) break;
      // An outbound call from the branch's Google Business Profile line, an hour before the
      // customer's own call: calls@1.1 counts it as their (organic) first touch.
      preRollout.push(asCall({
        id: `TW1-OUT-${c.callId}`, branch_tag: branch.id, start_time: new Date(c.callAt.getTime() - 60 * MIN).toISOString(),
        tracking_phone_number: "+18885550100", source: "Google My Business", gclid: null, campaign: null, agent_note: null,
        customer_phone_number: `h:phone:${c.phone}`, direction: "outbound",
      }));
      note("outbound_before", { ...c, callId: `TW1-OUT-${c.callId}` });
    }
    const noOp = take();
    if (noOp) {
      preRollout.push(revise(noOp, { lead_status: "good_lead", direction: "inbound", spam: false }));
      note("no_op_before", noOp);
    }
    for (const [stage, fields, role] of [["A", { spam: true }, "spam_A"], ["B", { lead_status: "not_a_lead" }, "not_a_lead_B"], ["C", { spam: true }, "spam_C"]] as const) {
      const c = take();
      if (!c) continue;
      inflight[stage].push(revise(c, fields));
      note(role, c);
    }

    // Two customers the CRM has not sent yet: each called first; one call was marked spam.
    for (const [k, spam] of [[0, false], [1, true]] as const) {
      const seq = i * 2 + k;
      const customerId = 9_100_000 + seq;
      const callId = `TW1-NEW-${branch.id}-${k}`;
      const phone = `+1480559${String(7000 + seq).padStart(4, "0")}`;
      const callAt = new Date(Date.UTC(2026, 9, 26, 15, seq % 60));
      const call = { id: callId, branch_tag: branch.id, start_time: callAt.toISOString(), tracking_phone_number: "+18885550101", source: spam ? "Facebook" : "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: phone };
      preRollout.push(asCall(call));
      if (spam) preRollout.push(asCall({ ...call, spam: true }));
      crm.push(...newCustomer(branch.id, customerId, 9_200_000 + seq, 9_300_000 + seq, phone, seq));
      notes.push({ role: spam ? "new_customer_spam" : "new_customer_paid", branchId: branch.id, customerId, callId });
    }
  });

  if (variant === "scope_leak") {
    // A customer of brand "joshuas" (B43, outside stage B) with no lead at all, reached by a call
    // tagged to B28 (brand "mission", in stage B), later marked spam during stage B.
    const y = await db.query<{ customer: string; phone: string; sold_at: Date }>(
      `select a.crm_customer_id::text as customer, c.phone_hash as phone, a.sold_at
       from v_acquisitions a join crm_customers c on c.crm_customer_id = a.crm_customer_id
       where a.branch_id = 'B43' and a.lead_id is null and a.initial_status = 'completed'
         and a.initial_completed_at >= $1 and a.initial_completed_at < $2 and c.phone_hash is not null
         and not exists (select 1 from crm_customers o where o.phone_hash = c.phone_hash and o.crm_customer_id <> c.crm_customer_id)
         and not exists (select 1 from leads x where x.phone_hash = c.phone_hash)
       order by md5(a.crm_customer_id::text || 'TW-1'), a.crm_customer_id limit 1`,
      [PERIODS.all.from, PERIODS.all.to],
    );
    const target = y.rows[0];
    if (!target) throw new Error("scope_leak: the world has no B43 customer without a lead to reach across brands");
    const call = {
      id: "TW1-XBRAND-1", branch_tag: "B28", start_time: new Date(target.sold_at.getTime() - 2 * 24 * 60 * MIN).toISOString(), tracking_phone_number: "+18885550102",
      source: "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: `h:phone:${target.phone}`,
    };
    preRollout.push(asCall(call));
    inflight.B.push(asCall({ ...call, spam: true }));
    notes.push({ role: "cross_brand_touch", branchId: "B28", customerId: Number(target.customer), callId: call.id });
  }
  return { preRollout, inflight, crm, notes };
}

/** A new customer's CRM records, in the FieldRoutes wire shape the mock serves. */
function newCustomer(branchId: string, customerId: number, subscriptionId: number, appointmentId: number, phone: string, seq: number): SourceRecordVersion[] {
  const tz = BRANCH_BY_ID.get(branchId)!.timezone;
  const officeID = String(office(branchId));
  const wall = (at: Date) => instantToWallTime(at, tz);
  const added = new Date(Date.UTC(2026, 9, 27, 15, 30 + (seq % 20)));
  const sold = new Date(added.getTime() + 30 * MIN);
  const done = new Date(Date.UTC(2026, 9, 29, 17, seq % 50));
  const [date, start] = wall(done).split(" ");
  const v = (entity: string, at: Date, payload: Record<string, unknown>): SourceRecordVersion => ({ stream: `crm.${entity}`, entity, visibleAt: at.getTime(), payload });
  return [
    v("customer", added, { customerID: String(customerId), officeID, phone1: phone, email: null, zip: "85001", source: "Google Ads", dateAdded: wall(added), dateUpdated: wall(added) }),
    v("subscription", sold, {
      subscriptionID: String(subscriptionId), customerID: String(customerId), officeID, serviceType: "General Pest", soldBy: "0", source: "Google Ads",
      contractValue: "540.00", active: "1", dateAdded: wall(sold), dateCancelled: "0000-00-00 00:00:00", dateUpdated: wall(sold),
    }),
    v("appointment", done, {
      appointmentID: String(appointmentId), subscriptionID: String(subscriptionId), customerID: String(customerId), officeID, salesAnchor: "1", status: "1", date, start,
      dateCompleted: wall(done), dateUpdated: wall(done),
    }),
  ];
}

/** The scenario's identity: its definition and every generated input. */
export function scenarioHash(variant: Variant, overlay: Overlay): string {
  return sha256(canonicalJson({ id: TWIN_SCENARIO_ID, version: TWIN_SCENARIO_VERSION, variant, stages: STAGES, faults: faultPlan(variant), from: FROM_VERSIONS, to: TO_VERSION, overlay }));
}

/** The business clock of each phase: the stages run in the hours after the world's last poll. */
export const PHASE_NOW = {
  world: new Date("2026-10-31T13:10:00Z"),
  A: new Date("2026-10-31T14:00:00Z"),
  B: new Date("2026-10-31T15:00:00Z"),
  C: new Date("2026-10-31T16:00:00Z"),
} as const;

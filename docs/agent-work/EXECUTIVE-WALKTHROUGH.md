# Five-minute executive walkthrough

**The question:** *Can we trust the numbers we're using to decide where our next marketing dollar
should go?*

Everything shown is synthetic and labelled as such. Prepare: `npm run db:seed`,
`npm run demo:exports`, `npm run dev`, role switcher top right.

## 1. Data you have never seen (about 90 seconds)

Role: **Marketing analyst**. Open **Data onboarding** and click **CRM payments export**.

- "We gave the system an export it was never designed for: a payments file from the CRM."
- Point at **What is in the file**: every row profiled; the phone column shows only a masked shape.
- Point at **Map each field**: *Net Paid* is suggested as cash collected, with the reason.
  *Total* and *Contract Value* are refused as cash, and the screen says why: an invoice total
  and a contract are not money received.
- Answer the two questions it cannot answer itself (date order; times are branch-local), save,
  and the dry run follows.
- **The punchline:** "Every row is accounted for. The file and our ledger disagree on two payments,
  and here they are to the cent: one is $20 higher in the file, one is voided in the file but paid
  in our ledger. One payment we hold is missing from the file. Three rows were damaged by a
  spreadsheet, and the system refused to guess what they meant."
- "A correct refusal is the impressive result. Payments belong to the CRM, so this file can never
  overwrite them. It can only show us where to look."

## 2. The B09 incident (about 90 seconds)

**Guided demo** → B09 (the four-minute path, `/demo`). Google migrated B09's Local Services campaign
into Performance Max. The old ad mapper filed that spend as Google Search: nothing crashed, but the
meaning of the data changed. The Overview puts B09's channel cost comparison **on hold** instead of
showing a confidently wrong number. Walk through the evidence (stored spend rows, leads and CRM
customers), the proposed correction, the dry run (run in a transaction that rolls back), approval by
a **different** role, the verified recalculation, and the audit trail.

## 3. A decision, not a forecast (about 45 seconds)

**Decision Lab**: per paid channel, a verdict on whether the numbers are safe to use for a budget
decision, with its reasons and evidence. The scenario builder shifts budget using the branch's
verified cost per customer from SQL, not the platform's claim. The A/A self-check proves the
experiment statistics before anyone trusts an experiment. No revenue uplift is claimed; a pilot
would be measured, not predicted.

## 4. Resilience (about 45 seconds)

**Integrations** → fault panel: trigger a 429 or a stale worker and watch the job back off,
recover or fail loudly. Or, in onboarding, switch to the analyst and try to approve their own
mapping: the button says why not, the server refuses, and the database itself refuses.

## Close (15 seconds)

"This does not replace the CRM or Power BI. It checks what flows between them, says exactly where
the numbers disagree, and lets a person fix it with an audit trail. What I don't know yet is
whether you already have this lineage in your warehouse. That's my first question."

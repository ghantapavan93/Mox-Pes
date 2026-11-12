# Investigator tool contract (public interface, generated from the registry)

Each tool is read-only, scoped to the viewer, and returns data plus evidence ids. This is the interface the investigator (deterministic or model) calls. It says nothing about how answers are composed or checked.

## getBranchMetrics

Scorecard metrics for one branch and period (oct, sep or all): paid spend, new customers serviced (all / paid / unknown channel), paid-media CAC, unknown share, collected revenue, refunds, open exceptions, and per-channel spend, customers and cost per customer. Money is integer cents.

```json
{
 "type": "object",
 "properties": {
  "branchId": {
   "type": "string",
   "pattern": "^B\\d{2}$"
  },
  "period": {
   "default": "oct",
   "type": "string",
   "enum": [
    "oct",
    "sep",
    "all"
   ]
  }
 },
 "required": [
  "branchId"
 ],
 "additionalProperties": false
}
```

## getCustomerJourney

The Customer 360 journey of one CRM customer: lifecycle, first touch, attribution (credited channel, basis, campaign), identity-linked leads with their raw event ids, payments and refunds, money totals, open exceptions that touch the customer, and fields the source did not provide. Free-text fields (heardAboutText) are third-party data.

```json
{
 "type": "object",
 "properties": {
  "customerId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  }
 },
 "required": [
  "customerId"
 ],
 "additionalProperties": false
}
```

## getSourceLineage

Where a record came from. Give exactly one of: rawEventId (the stored, redacted source payload, its mapper version, status, every stored version of the same source record and the projection row it produced), campaignId (the ad campaign, its branch mapping, predecessor/successor lineage and its spend grouped by the mapper version and channel that classified it), or leadId (the lead row and its raw event).

```json
{
 "type": "object",
 "properties": {
  "rawEventId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  },
  "campaignId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  },
  "leadId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  }
 },
 "additionalProperties": false
}
```

## getIngestionFailures

Ingestion health in the viewer's scope (optionally one source and/or branch): quarantined record groups (source, error code, branch, count, sample raw event ids, the mapper versions that refused them, the exception that tracks the group), duplicate deliveries absorbed by exactly-once ingest, open payload conflicts, per-stream freshness against the business clock, and failed ingestion runs with the run that recovered them.

```json
{
 "type": "object",
 "properties": {
  "source": {
   "type": "string",
   "enum": [
    "crm",
    "calls",
    "web",
    "d2d",
    "ads"
   ]
  },
  "branchId": {
   "type": "string",
   "pattern": "^B\\d{2}$"
  }
 },
 "additionalProperties": false
}
```

## getReconciliationExceptions

Reconciliation exceptions in the viewer's scope: either one exception by exceptionId (with its full stored evidence and its Action Center case state), or a filtered list (branchId, kind, status, limit ≤ 25) plus open/resolved counts by kind. Kinds: quarantined_source_records, payment_without_ticket, branch_mismatch, unmapped_spend, channel_conflict, payload_conflict, channel_coverage_gap.

```json
{
 "type": "object",
 "properties": {
  "exceptionId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  },
  "branchId": {
   "type": "string",
   "pattern": "^B\\d{2}$"
  },
  "kind": {
   "type": "string",
   "enum": [
    "quarantined_source_records",
    "payment_without_ticket",
    "branch_mismatch",
    "unmapped_spend",
    "channel_conflict",
    "payload_conflict",
    "channel_coverage_gap"
   ]
  },
  "status": {
   "type": "string",
   "enum": [
    "open",
    "resolved",
    "acknowledged"
   ]
  },
  "limit": {
   "default": 10,
   "type": "integer",
   "minimum": 1,
   "maximum": 25
  }
 },
 "additionalProperties": false
}
```

## compareMappingVersions

Runs two mapper versions of one source over STORED raw records, read-only (pure mappers, nothing is written), and diffs the projections: how many records change, which fields change from what to what (with the spend affected for ad records), which held records would now project, and which still fail. Give exactly one record set: exceptionId (a quarantine group or a channel coverage gap's successor campaigns), campaignId, or rawEventIds (≤ 50).

```json
{
 "type": "object",
 "properties": {
  "source": {
   "type": "string",
   "enum": [
    "crm",
    "calls",
    "web",
    "d2d",
    "ads"
   ]
  },
  "fromVersion": {
   "type": "string",
   "pattern": "^\\d+\\.\\d+$"
  },
  "toVersion": {
   "type": "string",
   "pattern": "^\\d+\\.\\d+$"
  },
  "exceptionId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  },
  "campaignId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  },
  "rawEventIds": {
   "minItems": 1,
   "maxItems": 50,
   "type": "array",
   "items": {
    "type": "integer",
    "exclusiveMinimum": 0,
    "maximum": 9007199254740991
   }
  }
 },
 "required": [
  "source",
  "fromVersion",
  "toVersion"
 ],
 "additionalProperties": false
}
```

## inspectCampaignClassification

How ad campaigns are classified into channels: for one campaignId, or every campaign mapped to a branchId. Shows the stored channel, the campaign type and local-services flag in the latest stored raw payload, the channel the deployed ads mapper assigns to that payload, whether they disagree, and spend grouped by the mapper version and channel that classified it.

```json
{
 "type": "object",
 "properties": {
  "campaignId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  },
  "branchId": {
   "type": "string",
   "pattern": "^B\\d{2}$"
  }
 },
 "additionalProperties": false
}
```

## getMetricDefinition

The registered definition of a metric: formula, sources and caveat. Keys: paidSpend, prospects, acquired, paidCac, unknownShare, collected, newCollected, atRisk.

```json
{
 "type": "object",
 "properties": {
  "key": {
   "type": "string",
   "enum": [
    "paidSpend",
    "prospects",
    "acquired",
    "paidCac",
    "unknownShare",
    "collected",
    "newCollected",
    "atRisk"
   ]
  }
 },
 "required": [
  "key"
 ],
 "additionalProperties": false
}
```

## getMetricTrace

Where a branch's paid-media CAC or paid spend comes from: the number reproduced from records, the campaigns (with mapping and mapper versions) behind the spend, the customers counted, what the definition excludes, records excluded or held at intake, and what evidence is missing. Read-only, scoped.

```json
{
 "type": "object",
 "properties": {
  "branchId": {
   "type": "string",
   "pattern": "^B\\d{2}$"
  },
  "period": {
   "default": "oct",
   "type": "string",
   "enum": [
    "oct",
    "sep",
    "all"
   ]
  },
  "metric": {
   "default": "paid_cac",
   "type": "string",
   "enum": [
    "paid_cac",
    "paid_spend"
   ]
  }
 },
 "required": [
  "branchId"
 ],
 "additionalProperties": false
}
```

## getAuditHistory

Audit log rows: for one exceptionId (its case's events, decisions and the writes its executions made), or — for viewers with company-wide scope only — by subject: an exact subject ('campaign:12', 'case:40') or every subject of one type ('case:', 'investigation:'). Newest first, limit ≤ 50.

```json
{
 "type": "object",
 "properties": {
  "exceptionId": {
   "type": "integer",
   "exclusiveMinimum": 0,
   "maximum": 9007199254740991
  },
  "subject": {
   "type": "string",
   "minLength": 2,
   "maxLength": 60,
   "pattern": "^[a-z_]+:[A-Za-z0-9_:-]*$"
  },
  "limit": {
   "default": 20,
   "type": "integer",
   "minimum": 1,
   "maximum": 50
  }
 },
 "additionalProperties": false
}
```

## getDecisionReadiness

Decision Lab verdicts for every paid-media channel at a branch and period: data integrity (are the records classified and reconciled), decision readiness (enough reliable evidence to move budget, with blockers) and business effectiveness (only a randomized experiment can say; attribution never does), plus the budget signal and whether it is trustworthy.

```json
{
 "type": "object",
 "properties": {
  "branchId": {
   "type": "string",
   "pattern": "^B\\d{2}$"
  },
  "period": {
   "default": "oct",
   "type": "string",
   "enum": [
    "oct",
    "sep",
    "all"
   ]
  }
 },
 "required": [
  "branchId"
 ],
 "additionalProperties": false
}
```

## submit_findings

Submit your findings. Call exactly once, last. Every observation and the suspected cause must cite evidence ids exactly as tools returned them in this conversation; claims citing anything else are discarded. proposals: only fixes for exceptions a tool returned.

```json
{
 "type": "object",
 "properties": {
  "summary": {
   "type": "string",
   "minLength": 1,
   "maxLength": 1200
  },
  "observations": {
   "maxItems": 20,
   "type": "array",
   "items": {
    "type": "object",
    "properties": {
     "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 600
     },
     "evidenceIds": {
      "maxItems": 25,
      "type": "array",
      "items": {
       "type": "string",
       "maxLength": 120,
       "pattern": "^([a-z_]+):([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)$"
      }
     },
     "status": {
      "type": "string",
      "enum": [
       "verified",
       "hypothesis"
      ]
     },
     "strength": {
      "type": "string",
      "enum": [
       "strong",
       "weak"
      ]
     }
    },
    "required": [
     "text",
     "evidenceIds",
     "status"
    ],
    "additionalProperties": false
   }
  },
  "suspectedCause": {
   "anyOf": [
    {
     "type": "object",
     "properties": {
      "text": {
       "type": "string",
       "minLength": 1,
       "maxLength": 600
      },
      "evidenceIds": {
       "maxItems": 25,
       "type": "array",
       "items": {
        "type": "string",
        "maxLength": 120,
        "pattern": "^([a-z_]+):([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)$"
       }
      }
     },
     "required": [
      "text",
      "evidenceIds"
     ],
     "additionalProperties": false
    },
    {
     "type": "null"
    }
   ]
  },
  "confidence": {
   "type": "object",
   "properties": {
    "level": {
     "type": "string",
     "enum": [
      "high",
      "medium",
      "low"
     ]
    },
    "why": {
     "type": "string",
     "minLength": 1,
     "maxLength": 600
    }
   },
   "required": [
    "level",
    "why"
   ],
   "additionalProperties": false
  },
  "recommendedNextAction": {
   "type": "string",
   "minLength": 1,
   "maxLength": 600
  },
  "expectedEffect": {
   "type": "string",
   "minLength": 1,
   "maxLength": 600
  },
  "risks": {
   "maxItems": 10,
   "type": "array",
   "items": {
    "type": "string",
    "minLength": 1,
    "maxLength": 400
   }
  },
  "missingInformation": {
   "maxItems": 10,
   "type": "array",
   "items": {
    "type": "string",
    "minLength": 1,
    "maxLength": 400
   }
  },
  "proposals": {
   "maxItems": 5,
   "type": "array",
   "items": {
    "type": "object",
    "properties": {
     "exceptionId": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
     },
     "kind": {
      "type": "string",
      "enum": [
       "remap_channel",
       "replay_quarantine",
       "map_campaign",
       "override_lead_branch",
       "acknowledge_exception",
       "resolve_identity_conflict",
       "trigger_sync"
      ]
     },
     "params": {
      "type": "object",
      "propertyNames": {
       "type": "string"
      },
      "additionalProperties": {}
     },
     "rationale": {
      "type": "string",
      "minLength": 10,
      "maxLength": 800
     }
    },
    "required": [
     "exceptionId",
     "kind",
     "params",
     "rationale"
    ],
    "additionalProperties": false
   }
  }
 },
 "required": [
  "summary",
  "observations",
  "suspectedCause",
  "confidence",
  "recommendedNextAction",
  "expectedEffect",
  "risks",
  "missingInformation",
  "proposals"
 ],
 "additionalProperties": false
}
```

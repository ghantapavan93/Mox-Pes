# Revenue Signal OS

Reconciles what marketing claims with what the company's ledger shows, explains every difference, and refuses to let a budget decision rest on unreconciled data. Context boundaries and how they relate: [docs/domain-model.md](docs/domain-model.md).

## Organization

**Company**:
The business as a whole; the widest scope a number can have.

**Brand**:
A name the company trades under; a group of branches. A brand's numbers are its branches' numbers, never more.
_Avoid_: business unit, banner, sister company

**Branch**:
A service location with its own territory, staff and budget; the unit every number is first cut by.
_Avoid_: location, market, store

**CRM office**:
The CRM's record of a branch; one per branch, and the unit CRM access is granted by.
_Avoid_: account, tenant

**Territory**:
The set of zip codes a branch services.

**Scope**:
The set of branches a person may see and act on. Brand access is a way of granting scope, not a different kind of scope.

## Intake

**Source**:
A system that tells us something happened: ad platforms, call tracking, website leads, door-to-door sales, the CRM.
_Avoid_: feed, integration (when the system itself is meant)

**Source record**:
One version of one thing a source reported, kept exactly as received (contact details hashed).
_Avoid_: raw row, event (in this sense)

**Mapper version**:
A named, fixed way of reading a source's records into our model. Every stored record remembers which mapper version read it.
_Avoid_: parser, adapter version

**Quarantine**:
Holding a source record that could not be read safely, with the reason, until a person or a corrected mapper version deals with it.

**Replay**:
Reading held or stored source records again through a chosen mapper version, so a fix applies to history.
_Avoid_: reprocess, backfill

**Re-projection**:
A replay of records that were already read, through a newer mapper version, to correct their meaning (for example, their channel).

## CRM Sync

**Connector**:
Our read-only link to one CRM, holding no secrets of its own.

**Sync job**:
One request to read one kind of CRM record for one CRM office over one time window.

**Window**:
The span of CRM change times a sync job reads; fixed on its first attempt so a retry reads the same span.

**Checkpoint**:
How far a CRM office's records of one kind have been read completely; it only ever moves forward, and only when a window is complete.
_Avoid_: cursor, bookmark

## Measurement

**Lead**:
A record that a person contacted the company or was contacted.

**Prospect**:
A distinct person across all of their leads.
_Avoid_: lead (when the person is meant)

**Acquired customer**:
A CRM customer whose first service was completed in the period.
_Avoid_: conversion, sale, booking

**Channel**:
The route a customer came by: a paid platform, organic search, door-to-door, sponsorship, or unknown.
_Avoid_: source (which is the system that reported it)

**Measurement class**:
What evidence can ever show a channel's effect: a recorded touch, a recorded rep, an inferred landing, or only an experiment.

**Attribution**:
The first channel with evidence for a customer. It is derived, never stored, and no evidence means unknown.

**Platform-claimed conversion**:
A conversion as an ad platform reports it; a claim to be checked, not a result.

**Unallocated spend**:
Spend on a campaign that no branch has been mapped to; it belongs to no branch and no brand.

**Revenue at risk**:
Collected revenue from customers named by an open exception: money the ledger has but cannot yet tie to a lead, branch or channel.

## Reconciliation

**Detector**:
A rule that two systems must agree on, checked against all stored records.

**Exception**:
One detected disagreement, with its evidence and the money involved; it closes itself when the disagreement is gone.
_Avoid_: alert, issue, error

**Decision-blocking exception**:
An exception that changes what a channel cost or which customers it produced at a branch, and so puts that branch's budget signal on hold.

**Budget signal**:
A comparison of channels' cost per acquired customer at a branch, offered only together with the exceptions that make it untrustworthy.

## Identity

**Identity**:
One real person or household as far as our evidence goes: a CRM customer, or a prospect not yet one.

**Identity link**:
The evidence that a lead belongs to an identity, with the rule that made it.

**Identity conflict**:
A link the rules could not make alone because the evidence fits more than one customer; a person decides.

**Customer journey**:
Everything known about one customer, in time order, each fact traceable to its source record.

## Action Center

**Case**:
The work on one exception, from detection to resolution or a reasoned closure.
_Avoid_: ticket, task

**Proposal**:
A specific change offered to resolve a case, by a person or by the investigator.
_Avoid_: suggestion, recommendation

**Dry run**:
Carrying out a proposal and checking its result without keeping it.

**Approval**:
A person, in a different role from the proposer's, accepting one specific dry run.

**Execution**:
The application carrying out an approved proposal once, verified, or not at all.

**Verification**:
The check that an execution resolved its exception and left the ledger's money unchanged.

## Investigation

**Investigation**:
A reasoned reading of the evidence about a question or an exception, citing every record it relies on.

**Evidence**:
A stored record or derived fact an investigation may cite by id.

## Decision Lab

**Data integrity**:
Whether a scope's records are complete, classified and reconciled.

**Decision readiness**:
Whether there is enough reliable evidence to compare options for a budget decision.

**Business effectiveness**:
Whether a channel or change caused an outcome; known only from a randomized experiment.
_Avoid_: performance, ROI (when causation is meant)

**Experiment**:
A randomized comparison between arms assigned without regard to outcome.

**Scenario**:
A labelled forecast of what a change might do under stated assumptions; never evidence of effect.

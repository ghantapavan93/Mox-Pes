/**
 * Identity resolution + Customer 360 — the module's public surface (roadmap §4 Identity).
 * Every query takes a Queryable first and a branch scope (resolveScope output) last.
 */
export { resolveIdentities, resolveInTransaction, SYSTEM_ACTOR, type ResolveOptions, type ResolveStats } from "./resolve";
export {
  decideIdentityConflict,
  getIdentityConflict,
  listIdentityConflicts,
  type ConflictFilters,
  type DecisionArgs,
  type DecisionResult,
  type IdentityConflict,
} from "./conflicts";
export { identityOverview, searchCustomers, type CustomerFilters, type CustomerPage, type CustomerRow, type IdentityOverview } from "./search";
export {
  getCustomerJourney,
  getJourneyRawEvent,
  getProspectJourney,
  type CustomerJourney,
  type RawEventView,
  type TimelineItem,
} from "./journey";
export * from "./types";

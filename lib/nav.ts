/**
 * The product's primary navigation. One list feeds the sidebar and the command menu, so a
 * route cannot exist in one and be missing from the other.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Extra words the command menu matches on. */
  keywords: string;
  group: "Operate" | "Understand" | "Systems";
}

export const NAV: NavItem[] = [
  { href: "/", label: "Overview", keywords: "command center scorecard branches cac revenue", group: "Operate" },
  { href: "/exceptions", label: "Incidents", keywords: "action center cases exceptions approvals replay", group: "Operate" },
  { href: "/investigator", label: "AI Investigator", keywords: "ai investigate why evidence tools", group: "Operate" },
  { href: "/customers", label: "Customer Journeys", keywords: "customer 360 identity timeline crm", group: "Understand" },
  { href: "/decisions", label: "Decision Lab", keywords: "budget scenario readiness experiment forecast", group: "Understand" },
  { href: "/feedback", label: "Google feedback", keywords: "conversions upload gclid", group: "Understand" },
  { href: "/definitions", label: "Definitions", keywords: "metrics glossary formulas lineage", group: "Understand" },
  { href: "/onboarding", label: "Data onboarding", keywords: "upload import csv xlsx json file export mapping profile quarantine dry run byod", group: "Systems" },
  { href: "/integrations", label: "Integrations", keywords: "crm fieldroutes connectors sync studio mapping", group: "Systems" },
  { href: "/changes", label: "ChangeGuard", keywords: "change preflight release campaign mapping approve verify configuration", group: "Systems" },
  { href: "/audit", label: "Audit & Health", keywords: "audit log system health jobs freshness", group: "Systems" },
  { href: "/demo", label: "Guided demo", keywords: "tour walkthrough golden path four minutes presenter", group: "Systems" },
];

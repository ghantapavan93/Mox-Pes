"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import {
  BookOpen,
  Bot,
  Compass,
  FlaskConical,
  LayoutDashboard,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  FileUp,
  GitPullRequestArrow,
  Plug,
  ScrollText,
  Send,
  ShieldCheck,
  Siren,
  Users,
} from "lucide-react";
import { NAV, type NavItem } from "@/lib/nav";

const GROUPS: NavItem["group"][] = ["Start", "Operate", "Understand", "Systems"];

const ICON: Record<string, LucideIcon> = {
  "/start": Compass,
  "/": LayoutDashboard,
  "/exceptions": Siren,
  "/investigator": Bot,
  "/assurance": ShieldCheck,
  "/customers": Users,
  "/decisions": FlaskConical,
  "/feedback": Send,
  "/definitions": BookOpen,
  "/onboarding": FileUp,
  "/integrations": Plug,
  "/changes": GitPullRequestArrow,
  "/audit": ScrollText,
  "/demo": PlayCircle,
};

function isActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  if (href === "/") return pathname === "/" || pathname.startsWith("/branches");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The links themselves. `pathname` null = not known yet (prerender fallback): nothing is marked active. */
function NavLinks({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Main" className="space-y-5">
      {GROUPS.map((group) => (
        <div key={group}>
          {/* "Start here" stands alone above the groups: a heading would only repeat it. */}
          {group !== "Start" && <p data-sidebar-label className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-shell-muted">{group}</p>}
          <ul className="space-y-0.5">
            {NAV.filter((n) => n.group === group).map((n) => {
              const active = isActive(pathname, n.href);
              const Icon = ICON[n.href] ?? LayoutDashboard;
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    title={n.label}
                    className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] ${
                      active ? "bg-shell-raised font-medium text-white before:absolute before:inset-y-1 before:-left-3 before:w-0.5 before:rounded before:bg-accent" : "text-shell-text hover:bg-shell-raised/60 hover:text-white"
                    }`}
                  >
                    <Icon aria-hidden className="size-4 shrink-0" />
                    <span data-sidebar-label>{n.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * Primary navigation, grouped by what the person is doing. usePathname() can suspend under
 * cacheComponents on routes with request-time params, so the layout renders this inside a
 * Suspense boundary whose fallback is `SidebarNavFallback` (the same links, none active).
 */
export function SidebarNav() {
  return <NavLinks pathname={usePathname()} />;
}

export function SidebarNavFallback() {
  return <NavLinks pathname={null} />;
}

const STORAGE_KEY = "rs-sidebar";

/**
 * Collapses the desktop sidebar to an icon rail. The state lives on <html data-sidebar>, set
 * before first paint by the inline script in app/layout.tsx so there is no flash, and is kept in
 * localStorage (a per-browser convenience; nothing depends on it).
 */
const CHANGE_EVENT = "rs-sidebar-change";
const subscribe = (onChange: () => void) => {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
};
const isCollapsed = () => document.documentElement.dataset.sidebar === "collapsed";

export function SidebarCollapseButton() {
  // The DOM attribute is the source of truth (set before paint); the server renders "expanded".
  const collapsed = useSyncExternalStore(subscribe, isCollapsed, () => false);
  const toggle = () => {
    const next = !collapsed;
    document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
    try {
      localStorage.setItem(STORAGE_KEY, next ? "collapsed" : "expanded");
    } catch {
      // storage blocked: the toggle still works for this page view
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      onClick={toggle}
      // A disclosure: one constant name, its state in aria-expanded (the name never flips with the
      // state, so a screen reader hears "Navigation sidebar, expanded" or "…, collapsed").
      aria-expanded={!collapsed}
      aria-label="Navigation sidebar"
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="hidden items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-shell-muted hover:bg-shell-raised/60 hover:text-white lg:flex"
      data-testid="sidebar-collapse"
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      {/* Its visible words are the start of its name (WCAG 2.5.3, label in name); the icon and the
          tooltip say which way it goes. */}
      <span data-sidebar-label>Navigation</span>
    </button>
  );
}

/** Runs before paint: restores the collapsed state without a flash of the wide sidebar. */
export const SIDEBAR_BOOT_SCRIPT = `try{var s=localStorage.getItem("${STORAGE_KEY}");if(s)document.documentElement.dataset.sidebar=s}catch(e){}`;

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, type NavItem } from "@/lib/nav";

const GROUPS: NavItem["group"][] = ["Operate", "Understand", "Systems"];

function isActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  if (href === "/") return pathname === "/" || pathname.startsWith("/branches");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The links themselves. `pathname` null = not known yet (prerender fallback): nothing is marked active. */
function NavLinks({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Main" className="space-y-4">
      {GROUPS.map((group) => (
        <div key={group}>
          <p className="px-2 pb-1 font-mono text-[10px] uppercase tracking-wider text-white/60">{group}</p>
          <ul className="space-y-0.5">
            {NAV.filter((n) => n.group === group).map((n) => {
              const active = isActive(pathname, n.href);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    className={`block rounded px-2 py-1.5 text-sm ${active ? "bg-white/12 font-medium text-white" : "text-white/70 hover:bg-white/6 hover:text-white"}`}
                  >
                    {n.label}
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

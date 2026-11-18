import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { CommandMenu } from "@/components/CommandMenu";
import { GuideBar } from "@/components/GuideBar";
import { RoleSwitcher } from "@/components/RoleSwitcher";
import { FreshnessIndicator, ScopeIndicator } from "@/components/ShellStatus";
import { SidebarDisclosure } from "@/components/SidebarDisclosure";
import { SIDEBAR_BOOT_SCRIPT, SidebarCollapseButton, SidebarNav, SidebarNavFallback } from "@/components/SidebarNav";
import { demoModeEnabled } from "@/lib/demo-mode";
import { getViewer, workspaceEnabled } from "@/lib/server";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  // Each page names itself, so tabs, history and screen readers can tell pages apart.
  title: { default: "Revenue Signal OS", template: "%s · Revenue Signal OS" },
  description:
    "Independent concept: an operational layer that traces customers from marketing touch to collected revenue, investigates disagreements and repairs them safely. Synthetic data.",
};

async function ViewerControls() {
  const viewer = await getViewer();
  // Outside demo mode nobody can switch roles (POST /api/role answers 404): no picker that would
  // do nothing, just who the visitor is ("Guest · your workspace" on the hosted demo).
  if (!demoModeEnabled()) {
    return (
      <span className="text-xs text-muted" data-testid="viewer-label">
        {viewer.label}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 2xl only: below it the role select already names the viewer, and the top bar must stay one row. */}
      <span className="hidden text-xs text-faint 2xl:inline" data-testid="viewer-label">{viewer.label}</span>
      <RoleSwitcher current={viewer.role} guestLabel={workspaceEnabled() ? "Guest (own workspace)" : "Guest (read-only)"} />
    </div>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Restores the collapsed sidebar before paint (localStorage only; see SidebarNav). */}
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <a
          href="#main"
          className="sr-only rounded bg-surface px-3 py-2 text-sm font-medium text-accent shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60]"
          data-testid="skip-link"
        >
          Skip to content
        </a>
        <div className="flex min-h-screen flex-col lg:flex-row">
          <aside
            data-sidebar-root
            className="bg-shell text-shell-text transition-[width] duration-150 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-60 lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden"
          >
            <div className="flex flex-col gap-3 px-3 py-3 lg:flex-1 lg:gap-4 lg:py-4">
              <Link href="/" className="flex items-center gap-2.5 px-1.5" title="Revenue Signal OS">
                <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-bold text-white">RS</span>
                <span data-sidebar-label className="min-w-0">
                  <span className="block truncate text-[14px] font-semibold leading-5 tracking-tight text-white">Revenue Signal OS</span>
                  <span className="block truncate text-[11px] leading-4 text-shell-muted">marketing → verified revenue</span>
                </span>
              </Link>
              {/* Search stays outside the collapsible panel: its dialog must open on phones too. */}
              <CommandMenu />
              <SidebarDisclosure>
                <Suspense fallback={<SidebarNavFallback />}>
                  <SidebarNav />
                </Suspense>
                <p className="px-2.5 text-[10px] leading-relaxed text-shell-muted lg:hidden">
                  Independent interview concept by Pavankalyan Ghanta. All data synthetic. Not affiliated with or built from any company&apos;s systems.
                </p>
              </SidebarDisclosure>
            </div>
            <div className="hidden space-y-2 border-t border-shell-border px-3 py-3 lg:block">
              <SidebarCollapseButton />
              <p data-sidebar-label className="px-2.5 text-[10px] leading-relaxed text-shell-muted">
                Independent interview concept by Pavankalyan Ghanta. All data synthetic. Not affiliated with or built from any company&apos;s systems.
              </p>
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            {/* One row from lg up, whatever streams in: the freshness text truncates instead of wrapping, and
                each streamed part has a fallback of its own size. A late wrap here pushed every page down
                (CLS 0.25-0.39 at 1440 px, measured with a layout-shift observer). */}
            <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-surface/95 px-4 py-2 backdrop-blur lg:flex-nowrap lg:px-6">
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <Suspense fallback={<span aria-hidden className="inline-block h-[26px] w-40 rounded-md bg-sunken" />}>
                  <ScopeIndicator />
                </Suspense>
                <p className="inline-flex items-center gap-1.5 rounded-md bg-warn-soft px-2 py-1 text-[11px] text-warn" role="note">
                  <strong>Synthetic data</strong>
                  <span className="hidden 2xl:inline">· demo roles have no passwords; permissions are enforced on the server</span>
                  <span className="hidden sm:inline 2xl:hidden">· demo roles, server-enforced</span>
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 lg:flex-nowrap">
                <Suspense fallback={null}>
                  <FreshnessIndicator />
                </Suspense>
                <Suspense fallback={<span aria-hidden className="inline-block h-[26px] w-56 rounded-md bg-sunken" />}>
                  <ViewerControls />
                </Suspense>
              </div>
            </header>
            <Suspense fallback={null}>
              <GuideBar />
            </Suspense>
            <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 focus-visible:outline-none lg:px-6">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}

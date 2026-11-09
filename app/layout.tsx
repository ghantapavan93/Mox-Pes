import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { CommandMenu } from "@/components/CommandMenu";
import { RoleSwitcher } from "@/components/RoleSwitcher";
import { SidebarDisclosure } from "@/components/SidebarDisclosure";
import { SidebarNav, SidebarNavFallback } from "@/components/SidebarNav";
import { getViewer } from "@/lib/server";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Revenue Signal OS",
  description:
    "Independent concept: an operational layer that traces customers from marketing touch to collected revenue, investigates disagreements and repairs them safely. Synthetic data.",
};

async function ViewerControls() {
  const viewer = await getViewer();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="hidden text-xs text-faint md:inline" data-testid="viewer-label">{viewer.label}</span>
      <RoleSwitcher current={viewer.role} />
    </div>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <a
          href="#main"
          className="sr-only rounded bg-surface px-3 py-2 text-sm font-medium text-accent shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60]"
          data-testid="skip-link"
        >
          Skip to content
        </a>
        <div className="flex min-h-screen flex-col lg:flex-row">
          <aside className="bg-shell text-white lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:overflow-y-auto">
            <div className="flex flex-col gap-3 px-3 py-3 lg:gap-4 lg:py-4">
              <Link href="/" className="px-2">
                <span className="block text-[15px] font-semibold tracking-tight">Revenue Signal OS</span>
                <span className="block text-[11px] text-white/60">marketing → verified revenue</span>
              </Link>
              {/* Search stays outside the collapsible panel: its dialog must open on phones too. */}
              <CommandMenu />
              <SidebarDisclosure>
                <Suspense fallback={<SidebarNavFallback />}>
                  <SidebarNav />
                </Suspense>
                <p className="px-2 text-[10px] leading-relaxed text-white/60">
                  Independent interview concept by Pavankalyan Ghanta. All data synthetic. Not affiliated with or built from any company&apos;s systems.
                </p>
              </SidebarDisclosure>
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5 lg:px-6">
              <p className="text-[11px] text-warn" role="note">
                <strong>Synthetic data</strong> · demo roles have no passwords; permissions are enforced on the server
              </p>
              <Suspense fallback={<span className="text-xs text-faint">…</span>}>
                <ViewerControls />
              </Suspense>
            </header>
            <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus-visible:outline-none lg:px-6">
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}

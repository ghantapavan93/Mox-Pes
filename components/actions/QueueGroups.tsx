"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { TableWrap } from "@/components/ui";

/** One incident type of the grouped queue, its cells rendered on the server (components/actions/CaseQueue.tsx). */
export interface QueueGroupView {
  /** The incident type: the group's key. */
  id: string;
  /** Icon, name and case count: the disclosure button's label. */
  title: ReactNode;
  /** The header row's cells after the first: one `<td>` per remaining column of `head`. */
  cells: ReactNode;
  /** The same facts for the phone layout, under the button. */
  summary: ReactNode;
  /** Its most urgent cases: a table row's cells, and a phone card. */
  rows: Array<{ key: string; cells: ReactNode; card: ReactNode }>;
}

function Chevron({ open }: { open: boolean }) {
  return <ChevronRight aria-hidden className={`size-4 shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`} />;
}

/**
 * The incident queue grouped by type (docs/design-system.md, behaviour rule 14). Each type is a row group
 * whose header is a disclosure button; its most urgent cases sit one level in, under the same
 * columns. The first group, the one that needs someone first, starts open (behaviour rule 11); the
 * others start closed, and each header links to its type's full list, so nothing depends on this
 * script. Below md the groups are cards and the table is not rendered (display: none), so
 * assistive tech meets each case once at any width.
 */
export function QueueGroups({ groups, head, label }: { groups: QueueGroupView[]; head: ReactNode; label: string }) {
  const base = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(groups.slice(0, 1).map((g) => g.id)));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <ul className="divide-y divide-border md:hidden" data-testid="case-queue-cards">
        {groups.map((g) => {
          const isOpen = open.has(g.id);
          const panel = `${base}-cards-${g.id}`;
          return (
            <li key={g.id} data-group={g.id}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panel}
                onClick={() => toggle(g.id)}
                className="flex min-h-11 w-full items-center gap-2.5 px-4 pb-1.5 pt-3 text-left transition-colors duration-100 hover:bg-surface-2"
              >
                <Chevron open={isOpen} />
                {g.title}
              </button>
              <div className="pb-3 pl-11 pr-4">{g.summary}</div>
              <ul id={panel} hidden={!isOpen} className="divide-y divide-border border-t border-border bg-surface-2/40">
                {g.rows.map((r) => (
                  <li key={r.key} className="py-3 pl-11 pr-4">
                    {r.card}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block">
        <TableWrap label={label} flush minWidth={880} testId="case-queue">
          {head}
          {groups.map((g) => {
            const isOpen = open.has(g.id);
            const rowId = (key: string) => `${base}-row-${g.id}-${key}`;
            return (
              <tbody key={g.id} data-group={g.id}>
                <tr>
                  <th scope="rowgroup" className="border-b border-border px-2 py-1.5 text-left align-middle font-normal">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={g.rows.map((r) => rowId(r.key)).join(" ")}
                      onClick={() => toggle(g.id)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-100 hover:bg-surface-2"
                    >
                      <Chevron open={isOpen} />
                      {g.title}
                    </button>
                  </th>
                  {g.cells}
                </tr>
                {g.rows.map((r) => (
                  <tr key={r.key} id={rowId(r.key)} hidden={!isOpen} data-case-row>
                    {r.cells}
                  </tr>
                ))}
              </tbody>
            );
          })}
        </TableWrap>
      </div>
    </>
  );
}

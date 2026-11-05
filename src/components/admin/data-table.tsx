import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";

/*
 * Responsive data table. Wide screens: a normal table with a caption and
 * column headers. Narrow screens (<768px): each row becomes a stacked card
 * and every cell shows its column label (via data-label), so nothing needs
 * horizontal scrolling at 375px.
 */
export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  /** hide the label on mobile cards (e.g. for action buttons) */
  hideLabelOnMobile?: boolean;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  empty = "Nothing to show.",
  captionHidden,
}: {
  caption: ReactNode;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  empty?: ReactNode;
  captionHidden?: boolean;
}) {
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-dashed border-sand-300 bg-surface p-6 text-center text-muted">
        <p className={clsx("font-semibold text-ink", captionHidden && "sr-only")}>{caption}</p>
        <p className="mt-1">{empty}</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-sand-200 bg-surface md:overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm max-md:block">
        <caption className={clsx("px-4 pt-3 pb-2 text-left font-semibold text-ink max-md:block", captionHidden && "sr-only")}>{caption}</caption>
        <thead className="max-md:sr-only">
          <tr className="border-b border-sand-200 bg-sand-100/60">
            {columns.map((c) => (
              <th key={c.header} scope="col" className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-md:block">
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-b border-sand-200 align-top last:border-0 max-md:block max-md:px-4 max-md:py-3">
              {columns.map((c) => (
                <td
                  key={c.header}
                  data-label={c.hideLabelOnMobile ? undefined : c.header}
                  className={clsx(
                    "px-4 py-2.5 max-md:flex max-md:gap-3 max-md:px-0 max-md:py-1",
                    !c.hideLabelOnMobile &&
                      "max-md:before:w-32 max-md:before:shrink-0 max-md:before:text-xs max-md:before:font-semibold max-md:before:uppercase max-md:before:tracking-wide max-md:before:text-muted max-md:before:content-[attr(data-label)]",
                    c.className,
                  )}
                >
                  <div className="min-w-0 break-words">{c.cell(r)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Previous/next pagination that preserves the current GET filters. */
export function Pagination({
  basePath,
  params,
  total,
  limit,
  offset,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  total: number;
  limit: number;
  offset: number;
}) {
  if (total <= limit && offset === 0) return total ? <p className="mt-3 text-sm text-muted">{total} result(s)</p> : null;
  const href = (o: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    if (o > 0) q.set("offset", String(o));
    if (limit !== 25) q.set("limit", String(limit));
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + limit, total);
  const link = "inline-flex min-h-11 items-center rounded-xl border border-forest-200 bg-surface px-4 font-semibold text-forest-800 hover:bg-forest-50";
  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex gap-2">
        {offset > 0 ? (
          <Link className={link} href={href(Math.max(0, offset - limit))} rel="prev">
            Previous
          </Link>
        ) : (
          <span className={clsx(link, "pointer-events-none opacity-50")} aria-disabled="true">
            Previous
          </span>
        )}
        {offset + limit < total ? (
          <Link className={link} href={href(offset + limit)} rel="next">
            Next
          </Link>
        ) : (
          <span className={clsx(link, "pointer-events-none opacity-50")} aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

/** GET filter form: values live in the URL so filtered views can be shared and paginated. */
export function FilterBar({ action, children, resetHref }: { action: string; children: ReactNode; resetHref?: string }) {
  return (
    <form method="get" action={action} role="search" aria-label="Filters" className="mb-4 flex flex-col gap-3 rounded-xl border border-sand-200 bg-surface p-4 sm:flex-row sm:flex-wrap sm:items-end">
      {children}
      <div className="flex gap-2">
        <button type="submit" className="inline-flex min-h-11 items-center rounded-xl bg-forest-700 px-4 font-semibold text-white hover:bg-forest-800">
          Apply filters
        </button>
        {resetHref ? (
          <Link href={resetHref} className="inline-flex min-h-11 items-center rounded-xl px-3 font-semibold text-forest-800 hover:bg-forest-50">
            Reset
          </Link>
        ) : null}
      </div>
    </form>
  );
}

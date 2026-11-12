import type { PoiDto } from "@/domain/catalog";
import { groupPoisByCategory } from "./poi";

/**
 * Text alternative and legend for the map's points: each category with its
 * map colour and the mapped names (unnamed ones counted, not invented).
 */
export function PoiList({ pois }: { pois: PoiDto[] }) {
  const groups = groupPoisByCategory(pois);
  if (!groups.length) {
    return <p className="text-sm text-muted">No points of interest are mapped along this trail.</p>;
  }
  return (
    <ul className="grid gap-x-10 gap-y-1.5 md:grid-cols-2">
      {groups.map((g) => {
        const named = [...new Set(g.items.map((p) => p.name?.trim()).filter((n): n is string => !!n))];
        const unnamed = g.items.filter((p) => !p.name?.trim()).length;
        return (
          <li key={g.category} className="flex gap-2.5 text-sm leading-6">
            <span
              aria-hidden
              className="mt-1.5 size-3 shrink-0 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.15)]"
              style={{ background: g.color }}
            />
            <p className="min-w-0 text-muted">
              <span className="font-semibold text-ink">{g.label}</span> ({g.items.length})
              {named.length || unnamed ? <span aria-hidden> — </span> : null}
              {named.length || unnamed ? <span className="sr-only">: </span> : null}
              {named.join(" · ")}
              {unnamed ? `${named.length ? " · " : ""}${unnamed} unnamed` : ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui";
import { DemoBadge, StatusBadge } from "@/components/admin/admin-ui";
import { SubTabs } from "@/components/admin/sub-tabs";
import { requirePermission } from "@/server/auth";
import { getAdminTrail } from "@/server/admin/trails";

export default async function TrailAdminLayout({ children, params }: LayoutProps<"/admin/trails/[id]">) {
  const { id } = await params;
  const user = await requirePermission("trails.manage", `/admin/trails/${id}`);
  const trail = await getAdminTrail(user, id);
  if (!trail) notFound();
  const base = `/admin/trails/${trail.id}`;
  return (
    <>
      <p className="mb-3">
        <Link href="/admin/trails" className="inline-flex min-h-11 items-center font-semibold text-forest-800 hover:underline">
          ← All trails
        </Link>
      </p>
      <header className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-ink sm:text-3xl">{trail.name}</h1>
          <StatusBadge status={trail.status} />
          {trail.isDemo ? <DemoBadge /> : null}
        </div>
        <p className="mt-1 text-sm text-muted">
          {trail.regionName} · slug <code>{trail.slug}</code>
          {trail.status === "published" ? (
            <>
              {" "}
              ·{" "}
              <Link className="underline" href={`/trails/${trail.slug}`}>
                View public page
              </Link>
            </>
          ) : null}
        </p>
        {trail.isDemo ? (
          <Alert tone="amber" className="mt-3">
            Demonstration trail: fictional place and route. It stays labeled as demo content to customers, also when published.
          </Alert>
        ) : null}
      </header>
      <SubTabs
        label="Trail sections"
        tabs={[
          { href: base, label: "Facts & publishing", exact: true },
          { href: `${base}/geometry`, label: "Route geometry" },
          { href: `${base}/sources`, label: "Sources" },
          { href: `${base}/closures`, label: "Closures" },
          { href: `${base}/pois`, label: "POIs" },
          { href: `${base}/permits`, label: "Permits" },
          { href: `/admin/content?trailId=${trail.id}`, label: "Narration" },
        ]}
      />
      {children}
    </>
  );
}

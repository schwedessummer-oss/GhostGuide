import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card, SimulatedBadge } from "@/components/ui";
import { AdminHeader, DemoBadge, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, TextAreaField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { getMarketingDraft, marketingEnabled } from "@/server/admin/marketing";
import { formatDate } from "@/lib/format";
import { sp } from "@/server/admin/common";
import { approveDraftAction, publishDraftAction, rejectDraftAction, submitDraftAction, updateDraftAction } from "../actions";

export const metadata: Metadata = { title: "Marketing draft" };

export default async function MarketingDraftPage({ params, searchParams }: PageProps<"/admin/marketing/[id]">) {
  const { id } = await params;
  const q = await searchParams;
  const user = await requirePermission("marketing.draft", `/admin/marketing/${id}`);
  const view = await getMarketingDraft(user, id);
  if (!view) notFound();
  const { draft: d, weather, warnings } = view;
  const enabled = await marketingEnabled();
  const canApprove = can(user.roles, "marketing.approve");

  return (
    <>
      <p className="mb-3">
        <Link href="/admin/marketing" className="inline-flex min-h-11 items-center font-semibold text-forest-800 hover:underline">
          ← Marketing drafts
        </Link>
      </p>
      <AdminHeader
        title={d.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} /> <span>{d.channel}</span> · <span>{d.trailName}</span>
            {d.trailIsDemo ? <DemoBadge /> : null}
          </span>
        }
      />
      {sp(q.generated) ? <Alert tone="forest" live="polite" className="mb-4" title="Draft generated from sourced facts. Review the warnings below." /> : null}
      {!enabled ? <Alert tone="amber" className="mb-4">The marketing-draft workflow is turned off (feature flag); this draft is read-only.</Alert> : null}
      {warnings.length ? (
        <Alert tone="amber" title="Freshness and honesty warnings" className="mb-4">
          <ul className="list-disc space-y-1 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {d.reviewNote ? (
        <Alert tone="red" className="mb-4" title="Reviewer note">
          <p className="whitespace-pre-wrap">{d.reviewNote}</p>
        </Alert>
      ) : null}

      <Section id="text" title="Draft text">
        <Card>
          <p className="whitespace-pre-wrap break-words">{d.body}</p>
        </Card>
      </Section>

      <Section id="provenance" title="Sources and weather snapshot">
        <Card>
          <h3 className="font-semibold">Sources used</h3>
          {d.sources.length ? (
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {d.sources.map((s, i) => (
                <li key={i}>
                  {s.label}
                  {s.url ? (
                    <>
                      {" "}
                      (
                      <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">
                        link
                      </a>
                      )
                    </>
                  ) : null}
                  {s.retrievedAt ? ` · retrieved ${formatDate(s.retrievedAt)}` : ""}
                  {s.verifiedAt ? ` · ${s.verifiedKind ? "verified" : "reviewed"} ${formatDate(s.verifiedAt)}` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None.</p>
          )}
          <p className="mt-3 text-sm">
            Facts as of: {d.factsAsOf ? formatDate(d.factsAsOf) : "unknown"}
          </p>
          <h3 className="mt-4 flex flex-wrap items-center gap-2 font-semibold">
            Weather snapshot {weather?.isSimulated ? <SimulatedBadge label="Simulated weather" /> : null}
          </h3>
          {weather ? (
            <div className="text-sm">
              <p>
                {weather.provider} · fetched <When at={weather.fetchedAt} age />
                {weather.sourceUrl ? (
                  <>
                    {" "}
                    ·{" "}
                    <a className="underline" href={weather.sourceUrl} target="_blank" rel="noopener noreferrer">
                      source
                    </a>
                  </>
                ) : null}
              </p>
              <ul className="mt-1 list-disc pl-5">
                {(weather.data.periods ?? []).slice(0, 4).map((p, i) => (
                  <li key={i}>
                    {p.name}: {p.shortForecast}, {p.temperature}°{p.temperatureUnit}
                    {p.precipitationChancePct !== null ? `, ${p.precipitationChancePct}% precipitation` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted">No weather snapshot (the provider was unavailable).</p>
          )}
        </Card>
      </Section>

      {enabled && d.status !== "published" ? (
        <Section id="edit" title="Edit" description={d.status === "approved" ? "Editing an approved draft sends it back to review." : undefined}>
          <Card>
            <ActionForm action={updateDraftAction.bind(null, d.id)} submitLabel="Save draft">
              <TextField id="md-title" name="title" label="Title" required minLength={3} maxLength={200} defaultValue={d.title} />
              <TextAreaField id="md-body" name="body" label="Body" required minLength={10} maxLength={20000} defaultValue={d.body} rows={14} hint="Keep the source and freshness lines. Do not add facts, closures, access or safety claims that are not sourced." />
            </ActionForm>
            {d.status === "draft" ? <ActionForm action={submitDraftAction.bind(null, d.id)} submitLabel="Submit for review" variant="secondary" className="mt-4" /> : null}
          </Card>
        </Section>
      ) : null}

      {enabled && canApprove && (d.status === "in_review" || d.status === "approved" || d.status === "draft") ? (
        <Section id="review" title="Review">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {d.status === "in_review" ? (
              <Card>
                <h3 className="mb-2 font-semibold">Approve</h3>
                <ActionForm action={approveDraftAction.bind(null, d.id)} submitLabel="Approve draft">
                  {warnings.length ? <CheckField id="md-ack" name="acknowledge" required label={`I reviewed the ${warnings.length} warning(s) above and the text is accurate.`} /> : null}
                </ActionForm>
              </Card>
            ) : null}
            {d.status === "approved" ? (
              <Card>
                <h3 className="mb-2 font-semibold">Mark as published</h3>
                <p className="mb-3 text-sm text-muted">Ghost Guide does not post to any channel. Publish the approved text yourself, then record it here.</p>
                <ActionForm action={publishDraftAction.bind(null, d.id)} submitLabel="Mark as published">
                  <CheckField id="md-pub" name="confirm" required label="This approved text has been published." />
                </ActionForm>
              </Card>
            ) : null}
            <Card>
              <h3 className="mb-2 font-semibold">Reject</h3>
              <ActionForm action={rejectDraftAction.bind(null, d.id)} submitLabel="Reject draft" variant="secondary">
                <TextAreaField id="md-reason" name="reason" label="Reason (shown to the author)" required minLength={3} maxLength={1000} />
              </ActionForm>
            </Card>
          </div>
        </Section>
      ) : null}
      {d.approvedAt || d.publishedAt ? (
        <p className="mt-6 text-sm text-muted">
          {d.approvedAt ? (
            <>
              Approved <When at={d.approvedAt} />.{" "}
            </>
          ) : null}
          {d.publishedAt ? (
            <>
              Marked published <When at={d.publishedAt} />.
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

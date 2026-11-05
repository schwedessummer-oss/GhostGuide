import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui";
import { AdminHeader, DemoBadge, KeyValue, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField, TextAreaField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { canEditNarration, getNarration, narrationFormOptions } from "@/server/admin/content";
import { sp } from "@/server/admin/common";
import { approveNarrationAction, editNarrationAction, rejectNarrationAction, retireNarrationAction, submitNarrationAction } from "../actions";

export const metadata: Metadata = { title: "Narration" };

export default async function NarrationDetailPage({ params, searchParams }: PageProps<"/admin/content/[id]">) {
  const { id } = await params;
  const q = await searchParams;
  const user = await requirePermission("trails.manage", `/admin/content/${id}`);
  const view = await getNarration(user, id);
  if (!view) notFound();
  const n = view.narration;
  const options = await narrationFormOptions(user);
  const canApprove = can(user.roles, "content.approve");
  const editable = canEditNarration(user);
  const sources = options.sources.map((s) => ({ value: s.id, label: s.label }));
  const pois = options.pois.filter((p) => p.trailId === n.trailId).map((p) => ({ value: p.id, label: `${p.seq}. ${p.name}` }));
  const reviewable = n.status === "in_review" || n.status === "draft";
  const superseded = n.supersedesId ? view.versions.find((v) => v.id === n.supersedesId) : null;

  return (
    <>
      <p className="mb-3">
        <Link href="/admin/content" className="inline-flex min-h-11 items-center font-semibold text-forest-800 hover:underline">
          ← Narration queue
        </Link>
      </p>
      <AdminHeader
        title={n.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={n.status} /> <span>version {n.version}</span> · <span>{n.trailName}</span>
            {n.trailIsDemo ? <DemoBadge /> : null}
            {n.poiName ? <span>· POI: {n.poiName}</span> : null}
          </span>
        }
      />
      {sp(q.revision) ? (
        <Alert tone="forest" live="polite" className="mb-4" title="New version created for review">
          The approved version stays live until this one is approved.
        </Alert>
      ) : null}
      {superseded ? (
        <Alert tone="blue" className="mb-4">
          This version replaces{" "}
          <Link className="font-semibold underline" href={`/admin/content/${superseded.id}`}>
            version {superseded.version}
          </Link>{" "}
          ({superseded.status.replace("_", " ")}). Approving it retires the old version.
        </Alert>
      ) : null}
      {n.reviewNote ? (
        <Alert tone="amber" className="mb-4" title="Reviewer note">
          <p className="whitespace-pre-wrap">{n.reviewNote}</p>
        </Alert>
      ) : null}

      <Section id="transcript" title="Transcript" description="Rendered as plain text exactly as stored.">
        <Card>
          <p className="whitespace-pre-wrap break-words">{n.transcript}</p>
          <div className="mt-4">
            <KeyValue
              items={[
                ["Source", n.sourceLabel ?? "None — required for approval"],
                ["Citation", n.sourceCitation ?? "None — required for approval"],
                ["Audio", n.audioPath ? "Recorded audio attached" : "Device text-to-speech"],
                ["Approved", n.approvedAt ? <When at={n.approvedAt} /> : "Not approved"],
              ]}
            />
          </div>
        </Card>
      </Section>

      {canApprove && reviewable ? (
        <Section id="review" title="Review">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card>
              <h3 className="mb-2 font-semibold">Approve</h3>
              <ActionForm action={approveNarrationAction.bind(null, n.id)} submitLabel="Approve narration" pendingLabel="Approving…">
                <SelectField id="ap-source" name="sourceId" label="Source" required options={sources} placeholder="Choose the source" defaultValue={n.sourceId ?? ""} />
                <TextField id="ap-cite" name="sourceCitation" label="Citation" required minLength={3} maxLength={500} defaultValue={n.sourceCitation ?? ""} />
                <p className="text-sm text-muted">Confirm the transcript is accurate, matches the source, and contains no safety or medical claims beyond general guidance.</p>
              </ActionForm>
            </Card>
            <Card>
              <h3 className="mb-2 font-semibold">Reject</h3>
              <ActionForm action={rejectNarrationAction.bind(null, n.id)} submitLabel="Reject" variant="secondary">
                <TextAreaField id="rj-reason" name="reason" label="Reason (shown to the editor)" required minLength={3} maxLength={1000} />
              </ActionForm>
            </Card>
          </div>
        </Section>
      ) : null}

      {editable && n.status !== "retired" ? (
        <Section
          id="edit"
          title={n.status === "approved" ? "Edit (creates a new version)" : "Edit"}
          description={n.status === "approved" ? "Saving creates version " + (n.version + 1) + " for review. Customers keep hearing this approved version until the new one is approved." : undefined}
        >
          <Card>
            <ActionForm action={editNarrationAction.bind(null, n.id)} submitLabel={n.status === "approved" ? "Create new version" : "Save"}>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField id="ed-title" name="title" label="Title" required minLength={3} maxLength={200} defaultValue={n.title} className="sm:col-span-2" />
                <TextAreaField id="ed-transcript" name="transcript" label="Transcript" required minLength={10} maxLength={20000} defaultValue={n.transcript} className="sm:col-span-2" rows={8} />
                <SelectField id="ed-poi" name="poiId" label="POI" options={pois} placeholder="Not tied to a POI" defaultValue={n.poiId ?? ""} />
                <SelectField id="ed-source" name="sourceId" label="Source" options={sources} placeholder="No source yet" defaultValue={n.sourceId ?? ""} />
                <TextField id="ed-cite" name="sourceCitation" label="Citation" maxLength={500} defaultValue={n.sourceCitation ?? ""} className="sm:col-span-2" />
              </div>
            </ActionForm>
            {n.status === "draft" ? <ActionForm action={submitNarrationAction.bind(null, n.id)} submitLabel="Submit for review" variant="secondary" className="mt-4" /> : null}
          </Card>
        </Section>
      ) : null}

      {canApprove && n.status === "approved" ? (
        <Section id="retire" title="Retire" description="Customers stop hearing this narration. Use this when the content is outdated and no replacement is ready.">
          <Card>
            <ActionForm action={retireNarrationAction.bind(null, n.id)} submitLabel="Retire narration" variant="danger">
              <CheckField id="rt-confirm" name="confirm" required label="I understand customers will no longer hear this narration." />
            </ActionForm>
          </Card>
        </Section>
      ) : null}

      {view.versions.length > 1 ? (
        <Section id="versions" title="Versions">
          <ul className="space-y-2">
            {view.versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/content/${v.id}`} aria-current={v.id === n.id ? "page" : undefined} className="font-semibold text-forest-800 underline">
                  Version {v.version}
                </Link>
                <StatusBadge status={v.status} />
                <span className="text-sm text-muted">
                  updated <When at={v.updatedAt} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

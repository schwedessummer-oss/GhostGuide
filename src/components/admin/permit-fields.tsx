import type { PermitRequirementRow } from "@/server/admin/permits";
import { SelectField, TextAreaField, TextField } from "./fields";

/** Permit requirement form fields (create + edit). */
export function PermitRequirementFields({ idPrefix, r, sources }: { idPrefix: string; r?: PermitRequirementRow; sources: { value: string; label: string }[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <TextField id={`${idPrefix}-name`} name="name" label="Permit name" required minLength={3} maxLength={200} defaultValue={r?.name ?? ""} />
      <TextField id={`${idPrefix}-auth`} name="authority" label="Issuing authority" required maxLength={200} defaultValue={r?.authority ?? ""} />
      <TextField
        id={`${idPrefix}-url`}
        name="officialUrl"
        label="Official link (https)"
        type="url"
        pattern="https://.*"
        required
        defaultValue={r?.officialUrl ?? ""}
        hint="The land manager's own page. Customers apply there themselves."
        className="sm:col-span-2"
      />
      <TextAreaField id={`${idPrefix}-sum`} name="requirementSummary" label="Requirement summary" required minLength={5} maxLength={2000} defaultValue={r?.requirementSummary ?? ""} className="sm:col-span-2" />
      <TextAreaField id={`${idPrefix}-how`} name="howToObtain" label="How to obtain" maxLength={4000} defaultValue={r?.howToObtain ?? ""} className="sm:col-span-2" />
      <TextField id={`${idPrefix}-lead`} name="leadTimeDays" label="Lead time (days)" type="number" min="0" max="365" defaultValue={r?.leadTimeDays ?? ""} hint="Reminders start at least this many days before the hike." />
      <TextField id={`${idPrefix}-ver`} name="verifiedAt" label="Verified on" type="date" defaultValue={r?.verifiedAt ? new Date(r.verifiedAt).toISOString().slice(0, 10) : ""} />
      <SelectField id={`${idPrefix}-src`} name="sourceId" label="Source" options={sources} placeholder="No source" defaultValue={r?.sourceId ?? ""} className="sm:col-span-2" />
    </div>
  );
}

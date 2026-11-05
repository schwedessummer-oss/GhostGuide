import type { Source } from "@/domain/types";
import { SOURCE_TYPES } from "@/server/admin/sources";
import { SelectField, TextAreaField, TextField } from "./fields";

/** Shared source form fields (create + edit). */
export function SourceFields({ idPrefix, source }: { idPrefix: string; source?: Source }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <TextField id={`${idPrefix}-label`} name="label" label="Label" required minLength={3} maxLength={200} defaultValue={source?.label ?? ""} className="sm:col-span-2" />
      <TextField id={`${idPrefix}-url`} name="url" label="URL" type="url" maxLength={2000} defaultValue={source?.url ?? ""} hint="Official page where possible." />
      <TextField id={`${idPrefix}-publisher`} name="publisher" label="Publisher" maxLength={200} defaultValue={source?.publisher ?? ""} />
      <SelectField id={`${idPrefix}-type`} name="sourceType" label="Type" options={SOURCE_TYPES} defaultValue={source?.sourceType ?? "official"} />
      <TextField
        id={`${idPrefix}-retrieved`}
        name="retrievedAt"
        label="Retrieved on"
        type="date"
        defaultValue={source?.retrievedAt ? new Date(source.retrievedAt).toISOString().slice(0, 10) : ""}
      />
      <TextAreaField id={`${idPrefix}-notes`} name="notes" label="Notes" maxLength={2000} defaultValue={source?.notes ?? ""} className="sm:col-span-2" />
    </div>
  );
}

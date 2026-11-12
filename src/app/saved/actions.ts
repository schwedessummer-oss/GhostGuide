"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentUser, requireUser } from "@/server/auth";
import { log } from "@/server/log";
import { checkRateLimit } from "@/server/rate-limit";
import { isTrailSaved, saveTrail, unsaveTrail } from "@/server/trails/saved";

/**
 * Saved-trail server actions.
 *
 *   getTrailSaveState    called by the trail page's Save button after it
 *                        loads (the trail page HTML is the same for everyone,
 *                        so it can be cached; this answers per visitor)
 *   setTrailSaved        the Save toggle (optimistic on the client)
 *   removeSavedTrail     the /saved page's remove form (works without JS)
 *
 * Ids are validated with zod; every database call runs as the signed-in user
 * (RLS). Signed-out callers get { signedIn: false } rather than an error, so
 * the button can offer "Sign in to save".
 */

const trailIdSchema = z.uuid();

/** Toggles per user per minute (generous for people, a ceiling for scripts). */
const SAVE_RATE_LIMIT_PER_MIN = 60;

export type SaveState = { signedIn: false } | { signedIn: true; saved: boolean };

export type SetSavedResult = { ok: true; saved: boolean } | { ok: false; signedIn: false } | { ok: false; signedIn: true; error: string };

export async function getTrailSaveState(trailId: string): Promise<SaveState> {
  const user = await getCurrentUser();
  if (!user) return { signedIn: false };
  const id = trailIdSchema.safeParse(trailId);
  if (!id.success) return { signedIn: true, saved: false };
  return { signedIn: true, saved: await isTrailSaved(user, id.data) };
}

export async function setTrailSaved(trailId: string, saved: boolean): Promise<SetSavedResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, signedIn: false };
  const id = trailIdSchema.safeParse(trailId);
  if (!id.success || typeof saved !== "boolean") return { ok: false, signedIn: true, error: "This trail can't be saved." };

  const rl = await checkRateLimit(`trails:save:user:${user.id}`, SAVE_RATE_LIMIT_PER_MIN, 60);
  if (!rl.allowed) return { ok: false, signedIn: true, error: "Too many changes in a row. Wait a moment and try again." };

  try {
    if (saved) {
      const result = await saveTrail(user, id.data);
      if (!result.ok) {
        return {
          ok: false,
          signedIn: true,
          error:
            result.reason === "limit_reached"
              ? "You've reached the limit of saved trails. Remove some on your Saved page first."
              : "This trail is no longer available.",
        };
      }
    } else {
      await unsaveTrail(user, id.data);
    }
  } catch (err) {
    log.error("trails.save_failed", { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, signedIn: true, error: "Couldn't update your saved trails. Please try again." };
  }
  revalidatePath("/saved");
  return { ok: true, saved };
}

/** Form action for the /saved page (field: trailId). */
export async function removeSavedTrail(formData: FormData): Promise<void> {
  const user = await requireUser("/saved");
  const id = trailIdSchema.safeParse(formData.get("trailId"));
  if (id.success) await unsaveTrail(user, id.data);
  revalidatePath("/saved");
}

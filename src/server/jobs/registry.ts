import "server-only";
import type { JobHandlers } from "./queue";
import { commerceHandlers } from "./handlers/commerce";
import { safetyHandlers } from "./handlers/safety";
import { hikeHandlers } from "./handlers/hike";
import { opsHandlers } from "./handlers/ops";
import { catalogHandlers } from "./handlers/catalog";

/** All job handlers, keyed by job kind. Each slice owns its handlers file. */
export function allJobHandlers(): JobHandlers {
  const merged: JobHandlers = {};
  for (const group of [commerceHandlers, safetyHandlers, hikeHandlers, opsHandlers, catalogHandlers]) {
    for (const [kind, handler] of Object.entries(group)) {
      if (merged[kind]) throw new Error(`Duplicate job handler for ${kind}`);
      merged[kind] = handler;
    }
  }
  return merged;
}

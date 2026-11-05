"use server";

import type { FormState } from "@/server/admin/common";
import { deletePricingRule, savePricingRule, updateAddonPricing, updateTrailBasePrice } from "@/server/admin/pricing";
import { checked, runAction, str } from "../_lib/action";

const P = "/admin/pricing";

function ruleInput(fd: FormData) {
  return {
    name: str(fd, "name"),
    kind: str(fd, "kind") as never,
    value: str(fd, "value"),
    threshold: str(fd, "threshold"),
    minParty: str(fd, "minParty"),
    dates: str(fd, "dates"),
    scope: str(fd, "scope") as never,
    regionId: str(fd, "regionId"),
    trailId: str(fd, "trailId"),
    priority: str(fd, "priority"),
    effectiveFrom: str(fd, "effectiveFrom"),
    effectiveTo: str(fd, "effectiveTo"),
    active: checked(fd, "active"),
  };
}

export async function saveRuleAction(ruleId: string | null, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("pricing.manage", P, (user) => savePricingRule(user, ruleId, ruleInput(fd)));
}

export async function deleteRuleAction(ruleId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (!checked(fd, "confirm")) return { ok: false, error: "Tick the confirmation box to delete this rule." };
  return runAction("pricing.manage", P, (user) => deletePricingRule(user, ruleId));
}

export async function trailPriceAction(trailId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("pricing.manage", P, (user) => updateTrailBasePrice(user, trailId, str(fd, "price")));
}

export async function addonPriceAction(addonId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("pricing.manage", P, (user) => updateAddonPricing(user, addonId, { dollars: str(fd, "price"), active: checked(fd, "active") }));
}

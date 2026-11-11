"use server";

import type { FormState } from "@/server/admin/common";
import { createAddon, deletePricingRule, savePricingRule, updateAddon, updateTrailBasePrice } from "@/server/admin/pricing";
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

function addonInput(fd: FormData) {
  return {
    name: str(fd, "name"),
    description: str(fd, "description"),
    price: str(fd, "price"),
    pricingUnit: str(fd, "pricingUnit") as never,
    dailyCapacity: str(fd, "dailyCapacity"),
    requiresCustomerConfirmation: checked(fd, "requiresCustomerConfirmation"),
    regionId: str(fd, "regionId"),
    active: checked(fd, "active"),
  };
}

/** Edit an add-on (name, description, price, unit, daily capacity, confirmation, region, active). Admin only. */
export async function saveAddonAction(addonId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("pricing.manage", P, (user) => updateAddon(user, addonId, addonInput(fd)));
}

export async function createAddonAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("pricing.manage", P, (user) => createAddon(user, { ...addonInput(fd), code: str(fd, "code"), kind: str(fd, "kind") as never }));
}

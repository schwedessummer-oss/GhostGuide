import "server-only";
import { maskRecipient, normalizePhone, type NotifyChannel } from "@/domain/notification-messages";

/**
 * Resolving where a notice goes. Addresses are computed from the source
 * tables (emergency_contacts / profiles) at creation time only to build the
 * masked label, and again at send time to deliver; they are never stored.
 */
export interface Address {
  channel: NotifyChannel;
  to: string;
  masked: string;
}

function emailOk(email: string | null | undefined): email is string {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Every channel we can reach a contact on (SMS and/or email). */
export function contactAddresses(contact: { phone: string | null; email: string | null }): Address[] {
  const out: Address[] = [];
  const phone = normalizePhone(contact.phone);
  if (phone) out.push({ channel: "sms", to: phone, masked: maskRecipient("sms", phone) });
  if (emailOk(contact.email)) out.push({ channel: "email", to: contact.email, masked: maskRecipient("email", contact.email) });
  return out;
}

/** The hiker's own channel: SMS when a phone is on file, else email. */
export function userAddress(profile: { phone: string | null; email: string | null }): Address | null {
  const phone = normalizePhone(profile.phone);
  if (phone) return { channel: "sms", to: phone, masked: maskRecipient("sms", phone) };
  if (emailOk(profile.email)) return { channel: "email", to: profile.email, masked: maskRecipient("email", profile.email) };
  return null;
}

/** Address on a specific channel (send time). */
export function addressOn(channel: NotifyChannel, source: { phone: string | null; email: string | null }): Address | null {
  if (channel === "sms") {
    const phone = normalizePhone(source.phone);
    return phone ? { channel, to: phone, masked: maskRecipient("sms", phone) } : null;
  }
  return emailOk(source.email) ? { channel, to: source.email, masked: maskRecipient("email", source.email) } : null;
}

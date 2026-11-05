import "server-only";
import { NotificationSendError, type NotificationMessage, type NotificationProvider, type NotificationSendResult } from "./types";

/**
 * Twilio Programmable Messaging (SMS).
 *
 * Implemented against Twilio's documented public REST API
 * (POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json,
 * form-encoded To/From/Body, HTTP basic auth AccountSid:AuthToken).
 * NOT verified with live credentials in this repository.
 */
export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

const TIMEOUT_MS = 10_000;

export class TwilioSmsProvider implements NotificationProvider {
  readonly name = "twilio";

  constructor(
    private readonly config: TwilioConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    if (message.channel !== "sms") throw new NotificationSendError("Twilio provider only sends SMS", false, "config");
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`;
    const form = new URLSearchParams({ To: message.to, From: this.config.fromNumber, Body: message.body });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new NotificationSendError(`Twilio request failed: ${err instanceof Error ? err.name : "network error"}`, true, "network");
    }
    const json = (await res.json().catch(() => ({}))) as { sid?: string; code?: number; message?: string };
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      // Twilio error messages can echo the phone number; callers redact before storing.
      throw new NotificationSendError(`Twilio HTTP ${res.status}${json.code ? ` (code ${json.code})` : ""}`, retryable);
    }
    if (!json.sid) throw new NotificationSendError("Twilio response did not include a message SID", true);
    return { status: "sent", providerMessageId: json.sid };
  }
}

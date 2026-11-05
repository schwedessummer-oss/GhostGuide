import "server-only";
import { NotificationSendError, type NotificationMessage, type NotificationProvider, type NotificationSendResult } from "./types";

/**
 * Resend transactional email.
 *
 * Implemented against Resend's documented public REST API
 * (POST https://api.resend.com/emails, Bearer API key, JSON from/to/subject/text,
 * optional Idempotency-Key header). NOT verified with live credentials in
 * this repository.
 */
export interface ResendConfig {
  apiKey: string;
  from: string;
}

const TIMEOUT_MS = 10_000;

export class ResendEmailProvider implements NotificationProvider {
  readonly name = "resend";

  constructor(
    private readonly config: ResendConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    if (message.channel !== "email") throw new NotificationSendError("Resend provider only sends email", false, "config");
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject ?? "Ghost Guide notice",
          text: message.body,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new NotificationSendError(`Resend request failed: ${err instanceof Error ? err.name : "network error"}`, true, "network");
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string; name?: string };
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new NotificationSendError(`Resend HTTP ${res.status}${json.name ? ` (${json.name})` : ""}`, retryable);
    }
    if (!json.id) throw new NotificationSendError("Resend response did not include an email id", true);
    return { status: "sent", providerMessageId: json.id };
  }
}

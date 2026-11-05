import "server-only";
import { env } from "@/config/env";
import { DemoNotificationProvider } from "./demo";
import { ResendEmailProvider } from "./resend";
import { TwilioSmsProvider } from "./twilio";
import { NotificationSendError, type NotificationChannel, type NotificationMessage, type NotificationProvider } from "./types";

export type * from "./types";
export { NotificationSendError } from "./types";

/**
 * Live mode with no provider configured for a channel: every send FAILS
 * loudly (retryable, so it lands in the dead-letter queue if not fixed). It
 * never silently drops a message and never pretends success.
 */
class UnconfiguredProvider implements NotificationProvider {
  readonly name = "unconfigured";
  constructor(private readonly channel: NotificationChannel) {}
  async send(message: NotificationMessage): Promise<never> {
    void message;
    const vars = this.channel === "sms" ? "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER" : "RESEND_API_KEY, NOTIFY_FROM_EMAIL";
    throw new NotificationSendError(`No live ${this.channel.toUpperCase()} provider is configured (NOTIFY_PROVIDER=live; set ${vars}).`, true, "config");
  }
}

/** Provider for a channel, per NOTIFY_PROVIDER (demo = simulated, live = Twilio SMS / Resend email). */
export function getNotificationProvider(channel: NotificationChannel): NotificationProvider {
  const e = env();
  if (e.NOTIFY_PROVIDER !== "live") return new DemoNotificationProvider();
  if (channel === "sms") {
    if (e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM_NUMBER) {
      return new TwilioSmsProvider({ accountSid: e.TWILIO_ACCOUNT_SID, authToken: e.TWILIO_AUTH_TOKEN, fromNumber: e.TWILIO_FROM_NUMBER });
    }
    return new UnconfiguredProvider("sms");
  }
  if (e.RESEND_API_KEY && e.NOTIFY_FROM_EMAIL) {
    return new ResendEmailProvider({ apiKey: e.RESEND_API_KEY, from: e.NOTIFY_FROM_EMAIL });
  }
  return new UnconfiguredProvider("email");
}

/** Provider key recorded on a notification before it is sent. */
export function expectedProviderName(channel: NotificationChannel): string {
  const e = env();
  if (e.NOTIFY_PROVIDER !== "live") return "demo";
  if (channel === "sms") return e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_FROM_NUMBER ? "twilio" : "unconfigured";
  return e.RESEND_API_KEY && e.NOTIFY_FROM_EMAIL ? "resend" : "unconfigured";
}

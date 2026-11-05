/**
 * Notification provider interface. Providers deliver an already-built
 * message to an already-resolved address; they never decide whether a
 * message should be sent.
 */
export type NotificationChannel = "sms" | "email";

export interface NotificationMessage {
  channel: NotificationChannel;
  /** E.164 phone number (sms) or email address (email). Never logged. */
  to: string;
  subject?: string;
  body: string;
  /** Stable per notification (e.g. "notify:<notificationId>"); passed to providers that support it. */
  idempotencyKey: string;
}

export interface NotificationSendResult {
  /** "simulated" = demo provider: nothing was delivered. */
  status: "sent" | "simulated";
  providerMessageId?: string;
}

export interface NotificationProvider {
  /** "demo" | "twilio" | "resend" | "unconfigured" */
  readonly name: string;
  send(message: NotificationMessage): Promise<NotificationSendResult>;
}

/**
 * A provider failure. `retryable` = transient (network, 429, 5xx,
 * misconfiguration an operator can fix): the job throws and retries with
 * backoff. Non-retryable = the provider rejected this message permanently
 * (e.g. invalid number): the notification is marked failed without retrying.
 * Messages never contain the recipient address.
 */
export class NotificationSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly kind: "config" | "provider" | "network" = "provider",
  ) {
    super(message);
    this.name = "NotificationSendError";
  }
}

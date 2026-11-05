import "server-only";
import { randomUUID } from "node:crypto";
import { assertSimulationAllowed } from "@/config/env";
import type { NotificationMessage, NotificationProvider, NotificationSendResult } from "./types";

/**
 * SIMULATED notification provider (demo mode). It NEVER delivers anything:
 * no SMS or email leaves the system. The caller records the attempt as an
 * integration event with outcome "simulated" and the notification row gets
 * status "simulated", which the UI labels clearly. Refuses to run when
 * APP_MODE=live, so a misconfigured production deploy fails loudly instead
 * of pretending a safety notice went out.
 */
export class DemoNotificationProvider implements NotificationProvider {
  readonly name = "demo";

  async send(message: NotificationMessage): Promise<NotificationSendResult> {
    assertSimulationAllowed("notifications");
    void message;
    return { status: "simulated", providerMessageId: `sim_${randomUUID()}` };
  }
}

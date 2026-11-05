import { afterEach, describe, expect, it } from "vitest";
import { TwilioSmsProvider } from "@/integrations/notifications/twilio";
import { ResendEmailProvider } from "@/integrations/notifications/resend";
import { DemoNotificationProvider } from "@/integrations/notifications/demo";
import { getNotificationProvider, NotificationSendError } from "@/integrations/notifications";
import { resetEnvCache } from "@/config/env";

type Call = { url: string; init: RequestInit };
function fakeFetch(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const msg = { channel: "sms" as const, to: "+15555550123", body: "Hello", idempotencyKey: "notify:abc" };

afterEach(() => {
  delete process.env.NOTIFY_PROVIDER;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
  process.env.APP_MODE = "demo";
  resetEnvCache();
});

describe("notification providers", () => {
  it("Twilio: form-encoded POST with basic auth to the Messages endpoint", async () => {
    const calls: Call[] = [];
    const p = new TwilioSmsProvider({ accountSid: "AC123", authToken: "tok", fromNumber: "+15555550000" }, fakeFetch(201, { sid: "SM1" }, calls));
    expect(await p.send(msg)).toEqual({ status: "sent", providerMessageId: "SM1" });
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("AC123:tok").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({ To: "+15555550123", From: "+15555550000", Body: "Hello" });
  });

  it("classifies provider errors: 4xx permanent, 429/5xx retryable, never echoing the number", async () => {
    const bad = new TwilioSmsProvider({ accountSid: "AC", authToken: "t", fromNumber: "+1" }, fakeFetch(400, { code: 21211, message: "Invalid 'To' +15555550123" }, []));
    const e1 = await bad.send(msg).catch((e) => e);
    expect(e1).toBeInstanceOf(NotificationSendError);
    expect(e1.retryable).toBe(false);
    expect(e1.message).not.toContain("5555550123");
    const busy = new ResendEmailProvider({ apiKey: "re_x", from: "Ghost Guide <a@b.test>" }, fakeFetch(503, {}, []));
    expect((await busy.send({ ...msg, channel: "email", to: "c@d.test" }).catch((e) => e)).retryable).toBe(true);
  });

  it("Resend: bearer auth, JSON body and idempotency key", async () => {
    const calls: Call[] = [];
    const p = new ResendEmailProvider({ apiKey: "re_key", from: "Ghost Guide <notices@example.test>" }, fakeFetch(200, { id: "em_1" }, calls));
    expect(await p.send({ ...msg, channel: "email", to: "casey@example.com", subject: "Hi" })).toEqual({ status: "sent", providerMessageId: "em_1" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_key");
    expect(headers["Idempotency-Key"]).toBe("notify:abc");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ from: "Ghost Guide <notices@example.test>", to: ["casey@example.com"], subject: "Hi", text: "Hello" });
  });

  it("demo provider simulates in demo mode and refuses in live mode; live mode without config fails loudly", async () => {
    expect((await new DemoNotificationProvider().send(msg)).status).toBe("simulated");
    process.env.APP_MODE = "live";
    resetEnvCache();
    await expect(new DemoNotificationProvider().send(msg)).rejects.toThrow(/APP_MODE=live/);
    process.env.NOTIFY_PROVIDER = "live";
    resetEnvCache();
    const sms = getNotificationProvider("sms");
    expect(sms.name).toBe("unconfigured");
    await expect(sms.send(msg)).rejects.toThrow(/No live SMS provider is configured/);
    process.env.TWILIO_ACCOUNT_SID = "AC";
    process.env.TWILIO_AUTH_TOKEN = "t";
    process.env.TWILIO_FROM_NUMBER = "+15555550000";
    resetEnvCache();
    expect(getNotificationProvider("sms").name).toBe("twilio");
    expect(getNotificationProvider("email").name).toBe("unconfigured");
  });
});

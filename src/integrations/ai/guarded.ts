/**
 * Run a live AI call with a timeout, sanitize + guard the output, and fall
 * back to the deterministic template on ANY failure. Pure apart from the
 * injected call, so it is unit-testable without a network or database.
 */
import { guardAiText, sanitizeAiText } from "./guard";
import type { AiText } from "./types";

export const AI_TIMEOUT_MS = 8000;

export interface GuardedResult {
  text: AiText;
  outcome: "success" | "fallback";
  /** reason for falling back (no secrets; safe to log) */
  error?: string;
  durationMs: number;
}

export async function runGuarded(opts: {
  call: (signal: AbortSignal) => Promise<AiText>;
  template: AiText;
  facts: string;
  timeoutMs?: number;
}): Promise<GuardedResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? AI_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const fallback = (error: string): GuardedResult => ({ text: opts.template, outcome: "fallback", error, durationMs: Date.now() - started });
  try {
    const raw = await Promise.race([opts.call(controller.signal), timeout]);
    const text = sanitizeAiText(raw.text);
    const verdict = guardAiText(text, opts.facts);
    if (!verdict.ok) return fallback(`guard rejected output: ${verdict.reason}`);
    return { text: { ...raw, text }, outcome: "success", durationMs: Date.now() - started };
  } catch (err) {
    return fallback(err instanceof Error ? err.message : "unknown error");
  } finally {
    clearTimeout(timer);
  }
}

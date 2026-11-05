/**
 * AI provider contract. AI text is UNTRUSTED, display-only: it may explain or
 * summarize deterministic results that were already computed, but it never
 * decides routes, bookings, closures, permits, safety or emergency actions.
 */
export interface AiText {
  text: string;
  /** "demo-template" or e.g. "anthropic" */
  provider: string;
  model?: string;
  /** true for deterministic template text (no AI model involved) */
  simulated: boolean;
}

export interface ExplainInput {
  trailId?: string;
  trailName: string;
  isDemo: boolean;
  rank: number;
  score: number;
  breakdown: { factor: string; points: number; max: number; detail: string; neutral?: boolean }[];
  reasons: string[];
  warnings: string[];
  estimatedDurationMin: number;
  estimatedFinishTime: string;
  paceFactor: number;
}

export interface SummarizeInput {
  trailId?: string;
  trailName: string;
  isDemo: boolean;
  plannedDate: string;
  startTime: string;
  estimatedFinishTime: string;
  estimatedDurationMin: number;
  turnaroundBy?: string;
  stops: { name: string; etaOffsetMin: number }[];
  reminders: { hydrationEveryMin: number; paceCheckEveryMin: number };
}

export interface AiCallOptions {
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly key: string;
  readonly model?: string;
  explainRecommendation(input: ExplainInput, opts?: AiCallOptions): Promise<AiText>;
  summarizeItinerary(input: SummarizeInput, opts?: AiCallOptions): Promise<AiText>;
}

export type AiOperation = "explainRecommendation" | "summarizeItinerary";

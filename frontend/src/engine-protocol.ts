import type { Diagnostic, Limits, Timings } from "redline-engine";
export const HOST_LIMITS: Limits = {
  maxInputUnits: 2_000_000,
  maxOutputUnits: 2_000_000,
  maxNodes: 200_000,
  maxDepth: 256,
  maxWork: 50_000_000,
  timeoutMs: 15_000,
};
export interface EngineRequest {
  before: string;
  after: string;
}
export type EngineResponse =
  | {
      outcome: "success";
      html: string;
      modelVersion: 1;
      diagnostics: readonly Diagnostic[];
      timings: Timings;
    }
  | {
      outcome: "limit";
      limit: keyof Limits;
      diagnostics: readonly Diagnostic[];
    }
  | { outcome: "unsupported"; diagnostics: readonly Diagnostic[] }
  | { outcome: "failure"; message: string };

export type EngineSuccess = Extract<EngineResponse, { outcome: "success" }>;

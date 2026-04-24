import type { A11ySeverity } from "./types.js";

export const SEVERITY_WEIGHTS: Record<A11ySeverity, number> = {
  critical: 15,
  serious: 8,
  moderate: 3,
  minor: 1,
};

export const SEVERITY_ORDER: Record<A11ySeverity, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

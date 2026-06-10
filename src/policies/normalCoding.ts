import type { Policy } from "./types";

export const normalCodingPolicy: Policy = {
  riskType: "normal_coding",
  severity: "low",
  decision: "allow",
  requiredChecks: [],
};

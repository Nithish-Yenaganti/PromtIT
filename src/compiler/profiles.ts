export type Profile = "SWE" | "SECURITY" | "BUGFIX";

export const PROFILES: { key: Profile; label: string }[] = [
  { key: "SWE", label: "SWE (General coding)" },
  { key: "BUGFIX", label: "Bugfix (Debug & patch)" },
  { key: "SECURITY", label: "Security (Review & hardening)" },
];

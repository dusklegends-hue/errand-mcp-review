/**
 * The two axes every call names explicitly, with no default (playbook 3.2).
 * `instance` says whose mailbox/roster/sender this acts against; `mode` says
 * whether writes land on sandboxes (Meta test number, scratch calendar) or on
 * things real people read. An operation is not risky in itself -- it is risky
 * against a particular target -- so the risk table is keyed on the pair.
 */
export type Mode = "test" | "live";

export type RiskTier = "READ" | "AUTO_WRITE" | "CONFIRM" | "DENY_UNLESS_UNLOCKED";

export type DenyReason =
  | "not_allowlisted"
  | "mode_not_allowed_for_instance"
  | "unknown_action"
  | "requires_destructive_unlock";

export type GateDecision =
  | { type: "auto" }
  | { type: "denied"; reason: DenyReason }
  | { type: "confirm_required"; token: string; expiresAt: string };

export interface GateContext {
  /** The instance the action targets. Named explicitly on every call -- no default. */
  instance: string;
  /** The mode the caller is acting in. Named explicitly on every call -- no default. */
  mode: Mode;
  destructiveUnlocked: boolean;
  /** Present when the caller is resubmitting a previously-issued confirmation. */
  confirmToken?: string;
  /**
   * Per-instance mode wall: instance -> modes that instance may be addressed
   * in. An instance absent from this map is not allowlisted at all. "live"
   * absent means live dispatch simply does not exist for that instance yet.
   */
  instanceModes: Map<string, Set<Mode>>;
}

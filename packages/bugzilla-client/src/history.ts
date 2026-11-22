import { createHash } from "node:crypto";

export interface ConfirmedFieldChange {
  readonly field: string;
  readonly removed: string;
  readonly added: string;
}

/** Identifies a confirmed delta, not an individual history row. */
export function confirmedHistoryKey(
  timestamp: string,
  changes: readonly ConfirmedFieldChange[],
): string | undefined {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || !changes.length) return undefined;
  const fields = changes.map(({ field, removed, added }) =>
    JSON.stringify([field, removed, added]),
  );
  return `history:${createHash("sha256")
    .update(JSON.stringify([time, fields.sort()]))
    .digest("hex")}`;
}

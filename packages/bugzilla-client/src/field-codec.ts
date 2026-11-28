/**
 * Defensive Bugzilla field-name codec (#13 Blocker #2).
 *
 * Stock Bugzilla 5.0/5.2 already reverses `Bugzilla::Bug::FIELD_MAP` on both
 * `PUT /rest/bug/{id}` and `GET /rest/bug/{id}/history`, except `flagtypes.name`.
 * Some customized instances or legacy fixtures still emit DB column names
 * (`bug_status`, `bug_severity`, `short_desc`, `rep_platform`).
 *
 * Critically, `"assigned_to"` MUST remain snake_case to match
 * `watchedFields: ["assigned_to"]` in contracts and specs.
 */
const DEFENSIVE_FIELD_NORMALIZATION: Readonly<Record<string, string>> = {
  "flagtypes.name": "flags",
  bug_status: "status",
  bug_severity: "severity",
  short_desc: "summary",
  rep_platform: "platform",
  assigned_to: "assigned_to",
  assignedTo: "assigned_to",
};

export function normalizeBugzillaFieldName(fieldName: string): string {
  return DEFENSIVE_FIELD_NORMALIZATION[fieldName] ?? fieldName;
}

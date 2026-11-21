export interface TenantIdentifiablePayload {
  readonly tenantKey?: string;
  readonly issuer?: string;
  readonly principalId?: string;
  readonly instanceUrl?: string;
}

/**
 * Returns a reusable tenant key ONLY when the payload carries an explicit server-derived
 * `tenantKey` or a complete `(issuer, principalId, instanceUrl)` triple.
 * Legacy/incomplete payloads (e.g. `a04c54f` boards carrying only `principalId` + `instanceUrl`
 * without `issuer`) return `null` so the caller assigns a fresh isolated view key (ISO-04-B).
 */
export function resolveVerifiedTenantKey(payload: TenantIdentifiablePayload | null): string | null {
  if (!payload) return null;
  if (typeof payload.tenantKey === "string" && payload.tenantKey.length > 0) {
    return payload.tenantKey;
  }
  if (
    typeof payload.issuer === "string" &&
    payload.issuer.length > 0 &&
    typeof payload.principalId === "string" &&
    payload.principalId.length > 0 &&
    typeof payload.instanceUrl === "string" &&
    payload.instanceUrl.length > 0
  ) {
    return JSON.stringify([payload.issuer, payload.principalId, payload.instanceUrl]);
  }
  return null;
}

/**
 * Normalizes a board or inline dossier payload to guarantee a non-empty `tenantKey`.
 * Any payload lacking verified ownership receives a fresh key from `nextFreshKey()`
 * so consecutive legacy/unowned payloads never share private draft caches (ISO-04-B).
 */
export function normalizeBoardTenantKey<T extends TenantIdentifiablePayload>(
  payload: T,
  nextFreshKey: () => string,
): T & { readonly tenantKey: string } {
  const verified = resolveVerifiedTenantKey(payload);
  return {
    ...payload,
    tenantKey: verified ?? nextFreshKey(),
  };
}

export function resolveBoardTenantKey(payload: TenantIdentifiablePayload | null): string {
  return resolveVerifiedTenantKey(payload) ?? "anon";
}

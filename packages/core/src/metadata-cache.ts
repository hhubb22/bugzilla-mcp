import type {
  BugzillaClient,
  BugzillaClientEffect,
  BugzillaClientError,
  BugzillaCredentialRevokedError,
  EnterableProductSummary,
} from "@bugzilla-mcp/bugzilla-client";
import type {
  BugzillaCreateBugInput,
  FieldMetadata,
  PrincipalContext,
  ProductMetadata,
} from "@bugzilla-mcp/contracts";
import { Context, Effect, Layer } from "effect";
import { asEffectBugzillaClient, runCoreEffect } from "./canonical.js";

export const DEFAULT_PRODUCT_METADATA_TTL_MS = 300_000;
export const DEFAULT_FIELD_METADATA_TTL_MS = 600_000;
export const DEFAULT_METADATA_MAX_ENTRIES = 256;
export const DEFAULT_MAX_FIELD_HINT_ITEMS = 20;

export interface MetadataCacheConfig {
  readonly clock?: () => number;
  readonly productTtlMs?: number;
  readonly fieldTtlMs?: number;
  readonly maxEntries?: number;
  readonly maxHintItems?: number;
}

export type CreateBugPreflightResult =
  | {
      readonly ok: true;
      readonly resolvedOpSys?: string;
      readonly resolvedPlatform?: string;
    }
  | {
      readonly ok: false;
      readonly missingFields: readonly string[];
      readonly fieldHints: Readonly<Record<string, readonly string[]>>;
      readonly reason: string;
      readonly remediationHint: string;
    };

export interface MetadataCacheEffect {
  listEnterableProducts(
    ctx: PrincipalContext,
    client: BugzillaClientEffect,
  ): Effect.Effect<readonly EnterableProductSummary[], BugzillaClientError>;
  getProductMetadata(
    ctx: PrincipalContext,
    client: BugzillaClientEffect,
    productName: string,
  ): Effect.Effect<ProductMetadata | null, BugzillaClientError>;
  getBugFields(
    ctx: PrincipalContext,
    client: BugzillaClientEffect,
  ): Effect.Effect<readonly FieldMetadata[], BugzillaClientError>;
  preflightCreateBug(
    ctx: PrincipalContext,
    client: BugzillaClientEffect,
    input: Omit<BugzillaCreateBugInput, "idempotencyKey">,
  ): Effect.Effect<CreateBugPreflightResult, BugzillaCredentialRevokedError>;
  invalidateTenant(ctx: PrincipalContext): void;
}

export interface MetadataCacheService {
  listEnterableProducts(
    ctx: PrincipalContext,
    client: BugzillaClient | BugzillaClientEffect,
  ): Promise<readonly EnterableProductSummary[]>;
  getProductMetadata(
    ctx: PrincipalContext,
    client: BugzillaClient | BugzillaClientEffect,
    productName: string,
  ): Promise<ProductMetadata | null>;
  getBugFields(
    ctx: PrincipalContext,
    client: BugzillaClient | BugzillaClientEffect,
  ): Promise<readonly FieldMetadata[]>;
  preflightCreateBug(
    ctx: PrincipalContext,
    client: BugzillaClient | BugzillaClientEffect,
    input: Omit<BugzillaCreateBugInput, "idempotencyKey">,
  ): Promise<CreateBugPreflightResult>;
  invalidateTenant(ctx: PrincipalContext): void;
}

export class MetadataCacheTag extends Context.Service<MetadataCacheTag, MetadataCacheEffect>()(
  "@bugzilla-mcp/core/MetadataCacheTag",
) {}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAtMs: number;
}

class BoundedTtlMap<T> {
  private readonly map = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries: number) {}

  get(key: string, nowMs: number): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh insertion order for LRU eviction.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, expiresAtMs: number, nowMs: number): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      for (const [k, v] of this.map) {
        if (v.expiresAtMs <= nowMs) {
          this.map.delete(k);
        }
      }
      while (this.map.size >= this.maxEntries) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.map.delete(oldest);
      }
    }
    this.map.set(key, { value, expiresAtMs });
  }

  deleteByPrefix(prefix: string): void {
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
      }
    }
  }
}

function tenantPartitionKey(ctx: PrincipalContext): string {
  // Strictly partitioned by (issuer, principalId, instanceUrl, credentialGeneration) [R-669595].
  return JSON.stringify([ctx.issuer, ctx.principalId, ctx.instanceUrl, ctx.credentialGeneration]);
}

function ensureEffectClient(client: BugzillaClient | BugzillaClientEffect): BugzillaClientEffect {
  return asEffectBugzillaClient(client);
}

function pickPreferredDefaultValue(values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined;
  const preferred = ["All", "Unspecified", "Other"];
  for (const candidate of preferred) {
    const exact = values.find((v) => v === candidate);
    if (exact !== undefined) return exact;
  }
  for (const candidate of preferred) {
    const ci = values.find((v) => v.toLowerCase() === candidate.toLowerCase());
    if (ci !== undefined) return ci;
  }
  return values[0];
}

function activeFieldValueNames(field: FieldMetadata | undefined): string[] {
  if (!field?.values || field.values.length === 0) return [];
  return field.values
    .filter((v) => v.isActive !== false && v.name.trim().length > 0)
    .map((v) => v.name);
}

function capHints(items: readonly string[], maxHintItems: number): string[] {
  return items.slice(0, maxHintItems);
}

export function createMetadataCacheEffect(config: MetadataCacheConfig = {}): MetadataCacheEffect {
  const clock = config.clock ?? (() => Date.now());
  const productTtlMs = config.productTtlMs ?? DEFAULT_PRODUCT_METADATA_TTL_MS;
  const fieldTtlMs = config.fieldTtlMs ?? DEFAULT_FIELD_METADATA_TTL_MS;
  const maxEntries = Math.max(1, config.maxEntries ?? DEFAULT_METADATA_MAX_ENTRIES);
  const maxHintItems = Math.max(1, config.maxHintItems ?? DEFAULT_MAX_FIELD_HINT_ITEMS);

  const enterableProductsCache = new BoundedTtlMap<readonly EnterableProductSummary[]>(maxEntries);
  const productDetailCache = new BoundedTtlMap<ProductMetadata | null>(maxEntries);
  const bugFieldsCache = new BoundedTtlMap<readonly FieldMetadata[]>(maxEntries);

  const listEnterableProducts: MetadataCacheEffect["listEnterableProducts"] = Effect.fnUntraced(
    function* (ctx: PrincipalContext, client: BugzillaClientEffect) {
      const nowMs = clock();
      const key = tenantPartitionKey(ctx);
      const cached = enterableProductsCache.get(key, nowMs);
      if (cached !== undefined) {
        return cached;
      }
      const products = yield* client.listEnterableProducts();
      enterableProductsCache.set(key, products, nowMs + productTtlMs, nowMs);
      return products;
    },
  );

  const getProductMetadata: MetadataCacheEffect["getProductMetadata"] = Effect.fnUntraced(
    function* (ctx: PrincipalContext, client: BugzillaClientEffect, productName: string) {
      const nowMs = clock();
      const key = `${tenantPartitionKey(ctx)}::product::${productName}`;
      const cached = productDetailCache.get(key, nowMs);
      if (cached !== undefined) {
        return cached;
      }
      const detail = yield* client.getProductMetadata(productName);
      if (detail !== null) {
        productDetailCache.set(key, detail, nowMs + productTtlMs, nowMs);
      }
      return detail;
    },
  );

  const getBugFields: MetadataCacheEffect["getBugFields"] = Effect.fnUntraced(function* (
    ctx: PrincipalContext,
    client: BugzillaClientEffect,
  ) {
    const nowMs = clock();
    const key = tenantPartitionKey(ctx);
    const cached = bugFieldsCache.get(key, nowMs);
    if (cached !== undefined) {
      return cached;
    }
    const fields = yield* client.getBugFields();
    if (fields.length > 0) {
      bugFieldsCache.set(key, fields, nowMs + fieldTtlMs, nowMs);
    }
    return fields;
  });

  /**
   * Non-fatal metadata fetch wrapper: fails closed ONLY on BugzillaCredentialRevokedError,
   * degrading gracefully to `fallback` on BugzillaAccessDeniedError / BugzillaTransientError /
   * BugzillaRateLimitError / BugzillaValidationError so optional preflight never falsely blocks
   * a valid createBug call.
   */
  function degradeNonFatal<A>(
    effect: Effect.Effect<A, BugzillaClientError>,
    fallback: A,
  ): Effect.Effect<A, BugzillaCredentialRevokedError> {
    return effect.pipe(
      Effect.catchTags({
        BugzillaAccessDeniedError: () => Effect.succeed(fallback),
        BugzillaTransientError: () => Effect.succeed(fallback),
        BugzillaRateLimitError: () => Effect.succeed(fallback),
        BugzillaValidationError: () => Effect.succeed(fallback),
        BugzillaUnsupportedAttachmentError: () => Effect.succeed(fallback),
      }),
    );
  }

  const preflightCreateBug: MetadataCacheEffect["preflightCreateBug"] = Effect.fnUntraced(
    function* (
      ctx: PrincipalContext,
      client: BugzillaClientEffect,
      input: Omit<BugzillaCreateBugInput, "idempotencyKey">,
    ): Effect.fn.Return<CreateBugPreflightResult, BugzillaCredentialRevokedError> {
      const missingFields: string[] = [];
      const fieldHints: Record<string, readonly string[]> = {};
      const reasons: string[] = [];

      // 1. Lazy product metadata lookup for the requested product.
      const productMeta = yield* degradeNonFatal(
        getProductMetadata(ctx, client, input.product),
        null,
      );

      if (productMeta === null) {
        // Only reject unknown product if enterable products are introspectable and non-empty.
        const enterable = yield* degradeNonFatal(listEnterableProducts(ctx, client), []);
        const activeProducts = enterable.filter((p) => p.isActive).map((p) => p.name);
        if (activeProducts.length > 0 && !activeProducts.includes(input.product)) {
          missingFields.push("product");
          fieldHints.product = capHints(activeProducts, maxHintItems);
          reasons.push(`Product "${input.product}" is not an active enterable product`);
        }
      } else {
        if (!productMeta.isActive) {
          const enterable = yield* degradeNonFatal(listEnterableProducts(ctx, client), []);
          const activeProducts = enterable.filter((p) => p.isActive).map((p) => p.name);
          missingFields.push("product");
          if (activeProducts.length > 0) {
            fieldHints.product = capHints(activeProducts, maxHintItems);
          }
          reasons.push(`Product "${input.product}" is inactive`);
        }

        const activeComponents = productMeta.components
          .filter((c) => c.isActive)
          .map((c) => c.name);
        if (activeComponents.length > 0 && !activeComponents.includes(input.component)) {
          missingFields.push("component");
          fieldHints.component = capHints(activeComponents, maxHintItems);
          reasons.push(
            `Component "${input.component}" is not an active component of product "${input.product}"`,
          );
        }

        const activeVersions = productMeta.versions.filter((v) => v.isActive).map((v) => v.name);
        if (activeVersions.length > 0 && !activeVersions.includes(input.version)) {
          missingFields.push("version");
          fieldHints.version = capHints(activeVersions, maxHintItems);
          reasons.push(
            `Version "${input.version}" is not an active version of product "${input.product}"`,
          );
        }
      }

      // 2. Lazy bug fields metadata lookup for op_sys / platform resolution & legal values.
      const fields = yield* degradeNonFatal(getBugFields(ctx, client), []);
      let resolvedOpSys: string | undefined = input.opSys;
      let resolvedPlatform: string | undefined = input.platform;

      if (fields.length > 0) {
        const byName = new Map<string, FieldMetadata>(fields.map((f) => [f.name, f]));

        const opSysValues = activeFieldValueNames(byName.get("op_sys"));
        if (!resolvedOpSys) {
          resolvedOpSys = pickPreferredDefaultValue(opSysValues);
        } else if (opSysValues.length > 0 && !opSysValues.includes(resolvedOpSys)) {
          missingFields.push("opSys");
          fieldHints.opSys = capHints(opSysValues, maxHintItems);
          reasons.push(`opSys "${resolvedOpSys}" is not a legal value on this Bugzilla instance`);
        }

        const platformValues = activeFieldValueNames(
          byName.get("rep_platform") ?? byName.get("platform"),
        );
        if (!resolvedPlatform) {
          resolvedPlatform = pickPreferredDefaultValue(platformValues);
        } else if (platformValues.length > 0 && !platformValues.includes(resolvedPlatform)) {
          missingFields.push("platform");
          fieldHints.platform = capHints(platformValues, maxHintItems);
          reasons.push(
            `platform "${resolvedPlatform}" is not a legal value on this Bugzilla instance`,
          );
        }

        if (input.severity) {
          const severityValues = activeFieldValueNames(
            byName.get("bug_severity") ?? byName.get("severity"),
          );
          if (severityValues.length > 0 && !severityValues.includes(input.severity)) {
            missingFields.push("severity");
            fieldHints.severity = capHints(severityValues, maxHintItems);
            reasons.push(`severity "${input.severity}" is not a legal value`);
          }
        }

        if (input.priority) {
          const priorityValues = activeFieldValueNames(byName.get("priority"));
          if (priorityValues.length > 0 && !priorityValues.includes(input.priority)) {
            missingFields.push("priority");
            fieldHints.priority = capHints(priorityValues, maxHintItems);
            reasons.push(`priority "${input.priority}" is not a legal value`);
          }
        }

        // Validate keywords against /rest/field/bug (Bugzilla 5.2 always includes `values: []`
        // for `keywords` when none are configured; skip validation only if `values` is absent).
        if (input.keywords && input.keywords.length > 0) {
          const keywordsField = byName.get("keywords");
          if (keywordsField && keywordsField.values !== undefined) {
            const legalKeywords = activeFieldValueNames(keywordsField);
            const legalKeywordsLower = new Set(legalKeywords.map((k) => k.trim().toLowerCase()));
            const invalidKeywords = input.keywords.filter(
              (kw) => !legalKeywordsLower.has(kw.trim().toLowerCase()),
            );
            if (invalidKeywords.length > 0) {
              missingFields.push("keywords");
              if (legalKeywords.length > 0) {
                fieldHints.keywords = capHints(legalKeywords, maxHintItems);
                reasons.push(
                  `Invalid keyword(s): ${invalidKeywords.join(", ")} (not configured on this Bugzilla instance)`,
                );
              } else {
                reasons.push(
                  `Invalid keyword(s): ${invalidKeywords.join(", ")}. No keywords are configured on this Bugzilla instance.`,
                );
              }
            }
          }
        }

        // Check mandatory custom fields required on bug entry.
        for (const field of fields) {
          if (!field.isCustom || !field.isMandatory || !field.isOnBugEntry) continue;
          const provided = input.customFields?.[field.name];
          const isEmpty =
            provided === undefined ||
            provided === null ||
            (typeof provided === "string" && provided.trim().length === 0) ||
            (Array.isArray(provided) && provided.length === 0);
          if (isEmpty) {
            missingFields.push(field.name);
            const vals = activeFieldValueNames(field);
            if (vals.length > 0) {
              fieldHints[field.name] = capHints(vals, maxHintItems);
            }
            reasons.push(`Mandatory custom field "${field.name}" is required on bug entry`);
          }
        }
      }

      if (missingFields.length > 0) {
        const hasAnyHints = Object.values(fieldHints).some((vals) => vals.length > 0);
        const keywordsRejectedWithoutOptions =
          missingFields.includes("keywords") &&
          (!fieldHints.keywords || fieldHints.keywords.length === 0);
        const remediationHint =
          missingFields.length === 1 && keywordsRejectedWithoutOptions
            ? "Omit keywords (none are configured on this Bugzilla instance) or configure keywords in Bugzilla administration."
            : hasAnyHints
              ? `Provide valid values for: ${missingFields.join(", ")}. See fieldHints for allowed options.${keywordsRejectedWithoutOptions ? " Omit keywords (none are configured on this Bugzilla instance)." : ""}`
              : `Provide valid values for: ${missingFields.join(", ")}.`;
        return {
          ok: false,
          missingFields,
          fieldHints,
          reason: reasons.join("; "),
          remediationHint,
        };
      }

      return {
        ok: true,
        ...(resolvedOpSys !== undefined ? { resolvedOpSys } : {}),
        ...(resolvedPlatform !== undefined ? { resolvedPlatform } : {}),
      };
    },
  );

  function invalidateTenant(ctx: PrincipalContext): void {
    const prefix = tenantPartitionKey(ctx);
    enterableProductsCache.deleteByPrefix(prefix);
    productDetailCache.deleteByPrefix(prefix);
    bugFieldsCache.deleteByPrefix(prefix);
  }

  return MetadataCacheTag.of({
    listEnterableProducts,
    getProductMetadata,
    getBugFields,
    preflightCreateBug,
    invalidateTenant,
  });
}

export function makeMetadataCacheLayer(
  config: MetadataCacheConfig = {},
): Layer.Layer<MetadataCacheTag> {
  return Layer.succeed(MetadataCacheTag, createMetadataCacheEffect(config));
}

export function createMetadataCache(config: MetadataCacheConfig = {}): MetadataCacheService {
  const effectCache = createMetadataCacheEffect(config);
  return {
    listEnterableProducts: (ctx, client) =>
      runCoreEffect(effectCache.listEnterableProducts(ctx, ensureEffectClient(client))),
    getProductMetadata: (ctx, client, productName) =>
      runCoreEffect(effectCache.getProductMetadata(ctx, ensureEffectClient(client), productName)),
    getBugFields: (ctx, client) =>
      runCoreEffect(effectCache.getBugFields(ctx, ensureEffectClient(client))),
    preflightCreateBug: (ctx, client, input) =>
      runCoreEffect(effectCache.preflightCreateBug(ctx, ensureEffectClient(client), input)),
    invalidateTenant: (ctx) => effectCache.invalidateTenant(ctx),
  };
}

import type { EventsProfile, PrincipalContext } from "@bugzilla-mcp/contracts";
import type { CoreDependencies } from "@bugzilla-mcp/core";

export interface HttpServerConfig {
  readonly mode: "cloud-multi-user" | "local-trusted-ide";
  readonly allowedOrigins: readonly string[];
  readonly allowAbsentOrigin?: boolean;
  readonly eventsProfile: EventsProfile;
  /** Explicitly opt-in non-sensitive parameter names annotated with x-mcp-header per tool/event name */
  readonly headerRoutedParams?: Readonly<Record<string, readonly string[]>>;
  readonly core: CoreDependencies;
  readonly publicBaseUrl?: string;
  readonly authenticateBearerToken?: (token: string) => Promise<PrincipalContext | null>;
  readonly verifyBindingOpenerSession?: (
    req: DualEraHttpRequest,
  ) => Promise<{ issuer: string; principalId: string } | null>;
  readonly storeBoundApiKey?: (
    ctx: Pick<PrincipalContext, "issuer" | "principalId" | "instanceUrl">,
    apiKey: string,
  ) => Promise<{ credentialGeneration: number }>;
}

export interface DualEraHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
}

export interface DualEraHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DualEraMcpHandler {
  handleHttp(req: DualEraHttpRequest): Promise<DualEraHttpResponse>;
}

export function createDualEraHttpHandler(_config: HttpServerConfig): DualEraMcpHandler {
  throw new Error("C0_CONTRACT_STUB");
}

import type { EventsProfile } from "@bugzilla-mcp/contracts";
import type { CoreDependencies } from "@bugzilla-mcp/core";

export interface HttpServerConfig {
  readonly mode: "cloud-multi-user" | "local-trusted-ide";
  readonly allowedOrigins: readonly string[];
  readonly eventsProfile: EventsProfile;
  readonly core: CoreDependencies;
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

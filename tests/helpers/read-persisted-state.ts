import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createSqliteStorage } from "../../packages/storage/src/index.js";
import { principal } from "./fakes.js";

export async function readPersistedState(
  kind: "draft" | "webhooks",
  dbPath: string,
): Promise<unknown> {
  const entry = fileURLToPath(import.meta.url);
  const { stdout } = await promisify(execFile)("bun", [entry, kind, dbPath]);
  return JSON.parse(stdout);
}

if (import.meta.main) {
  const [kind, dbPath] = process.argv.slice(2);
  if (!dbPath) throw new Error("Expected a database path");
  const storage = createSqliteStorage(dbPath);
  switch (kind) {
    case "draft":
      console.log(
        JSON.stringify(
          await storage.getDraft({
            principalId: principal.principalId,
            instanceUrl: principal.instanceUrl,
            bugId: 41,
            draftKind: "private_comment",
          }),
        ),
      );
      break;
    case "webhooks":
      console.log(JSON.stringify(await storage.listWebhookSubscriptions(principal.principalId)));
      break;
    default:
      throw new Error("Expected a persistence fixture kind");
  }
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { StoragePorts } from "@bugzilla-mcp/storage";

export interface EncryptedCredentialVault {
  storeApiKey(params: {
    issuer: string;
    principalId: string;
    instanceUrl: string;
    apiKey: string;
  }): Promise<{ credentialGeneration: number }>;
  loadApiKey(params: {
    issuer: string;
    principalId: string;
    instanceUrl: string;
  }): Promise<{ apiKey: string; credentialGeneration: number } | null>;
  revokeApiKey(params: {
    issuer: string;
    principalId: string;
    instanceUrl: string;
  }): Promise<boolean>;
}

/**
 * AES-256-GCM per-principal Bugzilla API Key vault backed by SQLite StoragePorts.
 * Plaintext API keys are never persisted to disk or included in logs.
 */
export function createEncryptedCredentialVault(
  masterSecret: string,
  storage: StoragePorts,
): EncryptedCredentialVault {
  const key = createHash("sha256").update(masterSecret, "utf8").digest();

  function buildAad(issuer: string, principalId: string, instanceUrl: string): Buffer {
    return Buffer.from(`${issuer}\0${principalId}\0${instanceUrl}`, "utf8");
  }

  return {
    async storeApiKey({ issuer, principalId, instanceUrl, apiKey }) {
      if (!storage.saveBoundCredential) {
        throw new Error("Storage implementation does not support bound credentials");
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(buildAad(issuer, principalId, instanceUrl));
      const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return storage.saveBoundCredential({
        issuer,
        principalId,
        instanceUrl,
        ciphertext: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
      });
    },

    async loadApiKey({ issuer, principalId, instanceUrl }) {
      if (!storage.getBoundCredential) return null;
      const stored = await storage.getBoundCredential(issuer, principalId, instanceUrl);
      if (!stored) return null;
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
      decipher.setAAD(buildAad(issuer, principalId, instanceUrl));
      decipher.setAuthTag(Buffer.from(stored.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return { apiKey: plaintext, credentialGeneration: stored.credentialGeneration };
    },

    async revokeApiKey({ issuer, principalId, instanceUrl }) {
      if (!storage.revokeBoundCredential) return false;
      return storage.revokeBoundCredential(issuer, principalId, instanceUrl);
    },
  };
}

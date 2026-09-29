import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBuffer,
  verify as verifyBuffer
} from "node:crypto";

import { stableJsonStringify } from "../../utils/index.js";

export interface IdentityKeyPair {
  algorithm: "Ed25519";
  publicKey: string;
  privateKey: string;
  publicKeyFingerprint: string;
}

export function generateIdentityKeyPair(): IdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const fingerprint = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("base64url");

  return {
    algorithm: "Ed25519",
    publicKey: publicKeyPem,
    privateKey: privateKeyPem,
    publicKeyFingerprint: fingerprint
  };
}

export function sign(payload: unknown, privateKey: string): string {
  const normalizedPayload = normalizePayload(payload);
  const key = createPrivateKey(privateKey);

  return signBuffer(null, normalizedPayload, key).toString("base64url");
}

export function verifySignature(payload: unknown, signature: string, publicKey: string): boolean {
  const normalizedPayload = normalizePayload(payload);
  const key = createPublicKey(publicKey);

  return verifyBuffer(null, normalizedPayload, key, Buffer.from(signature, "base64url"));
}

function normalizePayload(payload: unknown): Buffer {
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }

  if (typeof payload === "string") {
    return Buffer.from(payload, "utf-8");
  }

  return Buffer.from(stableJsonStringify(payload), "utf-8");
}

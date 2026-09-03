import crypto from "node:crypto";
import { env } from "../config/env.js";

const KEY = crypto.createHash("sha256").update(env.encryptionKey).digest();

export function encryptSensitiveValue(value) {
  if (value === null || value === undefined || value === "") return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSensitiveValue(value) {
  if (!value) return null;

  const [ivHex, tagHex, encryptedHex] = String(value).split(":");
  if (!ivHex || !tagHex || !encryptedHex) return value;

  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

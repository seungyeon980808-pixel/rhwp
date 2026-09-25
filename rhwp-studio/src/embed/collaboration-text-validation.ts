import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const MAX_COLLABORATION_TEXT_CHARS = 20_000;

export function isPlainSingleParagraphText(text: string): boolean {
  return text.length <= MAX_COLLABORATION_TEXT_CHARS && !/[\u0000-\u001f\u007f\ufffc]/u.test(text);
}

export function approvedTemplateTextHash(text: string): string {
  const prefix = new TextEncoder().encode('rhwp-approved-template-text-v1\0');
  const value = new TextEncoder().encode(text);
  const input = new Uint8Array(prefix.length + value.length);
  input.set(prefix);
  input.set(value, prefix.length);
  return `sha256:${bytesToHex(sha256(input))}`;
}

export function recordValue(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entry = Reflect.get(value, key);
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : {};
}

export function arrayValue(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  const entry = Reflect.get(value, key);
  return Array.isArray(entry) ? entry : [];
}

export function integerValue(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = Reflect.get(value, key);
  return Number.isSafeInteger(entry) && typeof entry === 'number' && entry >= 0 ? entry : null;
}

export function stringValue(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = Reflect.get(value, key);
  return typeof entry === 'string' ? entry : null;
}

export function booleanValue(value: unknown, key: string): boolean | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = Reflect.get(value, key);
  return typeof entry === 'boolean' ? entry : null;
}

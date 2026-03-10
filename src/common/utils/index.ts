import { v4 as uuidv4 } from 'uuid';

/** Generate a human-friendly job key like AC-2024-A1B2 */
export function generateJobKey(): string {
  const year = new Date().getFullYear();
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `AC-${year}-${suffix}`;
}

/** Generate a cryptographically random public pay token */
export function generatePublicPayToken(): string {
  return `ppt_${uuidv4().replace(/-/g, '')}`;
}

/** Normalize phone to E.164 format (US numbers only for now) */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** Normalize city name for comparison */
export function normalizeCity(city: string): string {
  return city.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Compute idempotency key from source + external ID */
export function computeIdempotencyKey(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

/** Safe JSON parse — returns null on failure */
export function safeJsonParse<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

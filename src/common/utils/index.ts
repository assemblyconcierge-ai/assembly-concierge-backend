import { v4 as uuidv4 } from 'uuid';
import { randomBytes } from 'crypto';

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

/**
 * Generate a cryptographically random operator photo token.
 * Scoped read-only token used exclusively to build the Airtable Operator Photo Link.
 * MUST NOT be logged or returned in general API responses.
 */
export function generateOperatorPhotoToken(): string {
  return `opt_${uuidv4().replace(/-/g, '')}`;
}

/**
 * Generate a cryptographically random contractor packet token.
 * Scoped read-only token stored on contractor_assignments.
 * Token is inert until assignment status = accepted.
 * MUST NOT be logged, included in audit payloads, or returned in general API responses.
 */
export function generateContractorPacketToken(): string {
  return `cpk_${randomBytes(16).toString('hex')}`;
}

/** Normalize phone to E.164 format (US numbers only for now) */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/**
 * Strict variant of normalizePhone for validated contexts (e.g. admin contractor creation).
 * Accepts: 10-digit, 11-digit starting with 1, or already-E.164 (+1xxxxxxxxxx).
 * Throws a TypeError with a descriptive message for short/malformed/non-US input.
 * Do NOT use this for Jotform intake, SMS webhooks, or public booking — those callers
 * rely on the lenient normalizePhone behavior.
 */
export function strictNormalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length < 10) {
    throw new TypeError(
      `Invalid phone number: too short (${digits.length} digit${
        digits.length === 1 ? '' : 's'
      } after stripping non-digits — expected 10 or 11)`,
    );
  }
  if (digits.length > 11) {
    throw new TypeError(
      `Invalid phone number: too long (${digits.length} digits after stripping non-digits — expected 10 or 11)`,
    );
  }
  // 11 digits not starting with 1
  throw new TypeError(
    `Invalid phone number: 11-digit number must start with country code 1`,
  );
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

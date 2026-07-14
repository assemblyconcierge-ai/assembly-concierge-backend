import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../../common/config';
import { logger } from '../../common/logger';

const SIGNATURE_HEADER = 'openphone-signature';
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

type VerificationReason =
  | 'valid'
  | 'missing_signature'
  | 'malformed_signature'
  | 'stale_timestamp'
  | 'invalid_secret'
  | 'signature_mismatch';

export interface VerifyLegacyQuoSignatureInput {
  rawBody: Buffer;
  parsedBody: unknown;
  signatureHeader: string | undefined;
  signingSecret: string;
  nowMs?: number;
}

export interface VerifyLegacyQuoSignatureResult {
  valid: boolean;
  reason: VerificationReason;
}

function decodeBase64Strict(value: string): Buffer | null {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) return null;
  return decoded;
}

function safeDigestMatch(expected: Buffer, provided: Buffer): boolean {
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

/**
 * Verify a legacy Quo/OpenPhone app webhook signature.
 *
 * Quo's legacy documentation is inconsistent about whether the signed payload
 * is the exact request bytes or compact JSON. Both remain secret-key HMACs over
 * the same timestamp and semantic payload, so accepting either does not permit
 * an unsigned or altered event. Remove the compatibility path after a signed
 * production test delivery confirms the representation used by this webhook.
 */
export function verifyLegacyQuoSignature(
  input: VerifyLegacyQuoSignatureInput,
): VerifyLegacyQuoSignatureResult {
  const { rawBody, parsedBody, signatureHeader, signingSecret, nowMs = Date.now() } = input;
  const signingKey = decodeBase64Strict(signingSecret);
  if (!signingKey) return { valid: false, reason: 'invalid_secret' };
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };

  let sawWellFormedCandidate = false;
  let sawFreshCandidate = false;

  for (const candidate of signatureHeader.split(',').map((value) => value.trim())) {
    const fields = candidate.split(';');
    if (fields.length !== 4 || fields[0] !== 'hmac' || fields[1] !== '1') continue;

    const timestampText = fields[2];
    const providedDigest = decodeBase64Strict(fields[3]);
    if (!/^\d{13}$/.test(timestampText) || !providedDigest || providedDigest.length !== 32) continue;
    sawWellFormedCandidate = true;

    const timestampMs = Number(timestampText);
    if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > SIGNATURE_TOLERANCE_MS) {
      continue;
    }
    sawFreshCandidate = true;

    const prefix = Buffer.from(`${timestampText}.`, 'utf8');
    const compactJson = Buffer.from(JSON.stringify(parsedBody), 'utf8');
    const rawDigest = crypto.createHmac('sha256', signingKey)
      .update(Buffer.concat([prefix, rawBody]))
      .digest();
    const compactDigest = crypto.createHmac('sha256', signingKey)
      .update(Buffer.concat([prefix, compactJson]))
      .digest();

    // Always perform both constant-time comparisons for the compatibility window.
    const rawMatches = safeDigestMatch(rawDigest, providedDigest);
    const compactMatches = safeDigestMatch(compactDigest, providedDigest);
    if (rawMatches || compactMatches) return { valid: true, reason: 'valid' };
  }

  if (!sawWellFormedCandidate) return { valid: false, reason: 'malformed_signature' };
  if (!sawFreshCandidate) return { valid: false, reason: 'stale_timestamp' };
  return { valid: false, reason: 'signature_mismatch' };
}

export function verifyQuoWebhookSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const log = logger.child({ correlationId: req.correlationId, handler: 'quo-webhook-auth' });
  const signingSecret = config.QUO_WEBHOOK_SIGNING_SECRET;

  if (!signingSecret) {
    log.error('[SMS] Quo webhook signing secret is not configured');
    res.status(503).json({
      error: 'WEBHOOK_SECURITY_NOT_CONFIGURED',
      message: 'Webhook security is not configured',
    });
    return;
  }

  if (!Buffer.isBuffer(req.body)) {
    log.warn({ reason: 'invalid_body_encoding' }, '[SMS] Quo webhook verification failed');
    res.status(400).json({ error: 'INVALID_WEBHOOK', message: 'Invalid webhook request' });
    return;
  }

  const rawBody = req.body;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    log.warn({ reason: 'invalid_json' }, '[SMS] Quo webhook verification failed');
    res.status(400).json({ error: 'INVALID_WEBHOOK', message: 'Invalid webhook request' });
    return;
  }

  const result = verifyLegacyQuoSignature({
    rawBody,
    parsedBody,
    signatureHeader: req.get(SIGNATURE_HEADER),
    signingSecret,
  });

  if (!result.valid) {
    const status = result.reason === 'invalid_secret' ? 503 : 401;
    log.warn({ reason: result.reason }, '[SMS] Quo webhook verification failed');
    res.status(status).json(
      status === 503
        ? { error: 'WEBHOOK_SECURITY_NOT_CONFIGURED', message: 'Webhook security is not configured' }
        : { error: 'UNAUTHORIZED', message: 'Invalid webhook signature' },
    );
    return;
  }

  req.body = parsedBody;
  next();
}

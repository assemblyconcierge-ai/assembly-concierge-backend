/**
 * jotformBodyParser.ts
 *
 * Handles ALL content-type formats Jotform may use when posting webhooks:
 *   1. application/x-www-form-urlencoded  (most common — handled by express.urlencoded)
 *   2. application/json                   (handled by express.json)
 *   3. multipart/form-data                (requires busboy — NOT handled by Express built-ins)
 *   4. text/plain                         (some Jotform configs send raw JSON as text/plain)
 *
 * This middleware is mounted ONLY on /webhooks/jotform.
 * It runs AFTER the Stripe raw-body handler so it does not interfere with Stripe.
 *
 * After this middleware runs, req.body will always be a populated object
 * (or empty {} if the body could not be parsed).
 *
 * A structured debug log is emitted for every request showing:
 *   - content-type
 *   - content-length
 *   - user-agent
 *   - which parser was used
 *   - resulting body keys
 */

import { Request, Response, NextFunction } from 'express';
import Busboy from 'busboy';
import { logger } from '../logger';

/** Parse multipart/form-data using busboy, resolving to a flat key→value map */
function parseMultipart(req: Request): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    let bb: ReturnType<typeof Busboy>;

    try {
      bb = Busboy({ headers: req.headers });
    } catch (err) {
      return reject(err);
    }

    bb.on('field', (name: string, val: string) => {
      fields[name] = val;
    });

    bb.on('finish', () => resolve(fields));
    bb.on('error', (err: Error) => reject(err));

    req.pipe(bb);
  });
}

/** Parse text/plain body — Jotform sometimes sends JSON wrapped in text/plain */
function parseTextBody(req: Request): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { raw += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : {});
      } catch {
        // Not JSON — try to parse as urlencoded
        try {
          const params = new URLSearchParams(raw);
          const obj: Record<string, string> = {};
          params.forEach((v, k) => { obj[k] = v; });
          resolve(obj);
        } catch {
          resolve({});
        }
      }
    });
    req.on('error', () => resolve({}));
  });
}

export async function jotformBodyParser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const cl = req.headers['content-length'] || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';

  // ── Debug log: always emit on entry ────────────────────────────────────
  logger.info(
    {
      jotformDebug: {
        contentType: ct,
        contentLength: cl,
        userAgent: ua,
        bodyAlreadyParsed: Object.keys(req.body || {}).length > 0,
        existingBodyKeys: Object.keys(req.body || {}),
        queryKeys: Object.keys(req.query || {}),
      },
    },
    '[JotformParser] Incoming request headers',
  );

  // ── If body already parsed by express.json / express.urlencoded ────────
  if (req.body && Object.keys(req.body).length > 0) {
    logger.info(
      { parser: 'already-parsed', bodyKeys: Object.keys(req.body) },
      '[JotformParser] Body already parsed by upstream middleware',
    );
    return next();
  }

  // ── multipart/form-data ─────────────────────────────────────────────────
  if (ct.includes('multipart/form-data')) {
    try {
      const fields = await parseMultipart(req);
      req.body = fields;
      logger.info(
        { parser: 'multipart', bodyKeys: Object.keys(fields) },
        '[JotformParser] Parsed multipart/form-data',
      );
    } catch (err) {
      logger.warn({ err }, '[JotformParser] Failed to parse multipart/form-data');
      req.body = {};
    }
    return next();
  }

  // ── text/plain ──────────────────────────────────────────────────────────
  if (ct.includes('text/plain')) {
    try {
      const parsed = await parseTextBody(req);
      req.body = parsed;
      logger.info(
        { parser: 'text-plain', bodyKeys: Object.keys(parsed) },
        '[JotformParser] Parsed text/plain body',
      );
    } catch (err) {
      logger.warn({ err }, '[JotformParser] Failed to parse text/plain body');
      req.body = {};
    }
    return next();
  }

  // ── No content-type or unrecognised — try to read raw and detect ────────
  if (!ct || (!ct.includes('json') && !ct.includes('urlencoded'))) {
    try {
      const parsed = await parseTextBody(req);
      if (Object.keys(parsed).length > 0) {
        req.body = parsed;
        logger.info(
          { parser: 'raw-fallback', contentType: ct, bodyKeys: Object.keys(parsed) },
          '[JotformParser] Parsed raw body as fallback',
        );
        return next();
      }
    } catch {
      // ignore
    }
  }

  // ── All other cases: body was not populated — log and continue ──────────
  logger.warn(
    {
      contentType: ct,
      bodyKeys: Object.keys(req.body || {}),
      queryKeys: Object.keys(req.query || {}),
    },
    '[JotformParser] Body is empty after all parsers — check Jotform webhook content-type',
  );

  next();
}

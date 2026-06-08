/**
 * Contractor Job Packet Routes
 *
 * GET /public/contractor/jobs/:contractorPacketToken
 *
 * Read-only, token-scoped page. Renders a mobile-first HTML job packet for
 * an accepted contractor. Access is denied (generic 404) for any other state.
 *
 * Security:
 * - Token format validated before any DB query.
 * - Generic 404 for invalid token, unknown token, or access-denied states.
 * - No information leaked about which check failed.
 * - contractor_packet_token value is NEVER rendered in the HTML output.
 * - R2 signed GET URLs generated server-side only, after access validation.
 * - Signed URLs are NEVER logged.
 * - Cache-Control: no-store to prevent proxy/browser caching.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../../db/pool';
import { generatePresignedDownloadUrl } from '../storage/s3.service';
import { logger } from '../../common/logger';
import { config } from '../../common/config';

export const contractorPacketRouter = Router();

// ── Token format guard ────────────────────────────────────────────────────────
const CONTRACTOR_PACKET_TOKEN_RE = /^cpk_[a-f0-9]{32}$/;

// ── HTML helper ───────────────────────────────────────────────────────────────
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Route ─────────────────────────────────────────────────────────────────────
contractorPacketRouter.get(
  '/jobs/:contractorPacketToken',
  async (req: Request, res: Response, next: NextFunction) => {
    const correlationId = (req as Request & { correlationId?: string }).correlationId ?? 'unknown';
    try {
      const { contractorPacketToken } = req.params;

      // 1. Validate token format before touching the DB
      if (!contractorPacketToken || !CONTRACTOR_PACKET_TOKEN_RE.test(contractorPacketToken)) {
        res.status(404).send('Not found');
        return;
      }

      // 2. Single query: validate token + all access rules in WHERE clause.
      //    Returns null (no row) for: unknown token, assignment not accepted,
      //    job not assigned, dispatch not accepted, dispatch/job mismatch.
      //    All failure cases return a generic 404 — no detail leaked.
      type PacketRow = {
        job_id: string;
        job_key: string;
        job_status: string;
        service_type_name: string | null;
        appointment_date: string | null;
        appointment_window: string | null;
        special_instructions: string | null;
        custom_job_details: string | null;
        customer_full_name: string;
        customer_phone: string;
        address_line1: string | null;
        address_line2: string | null;
        address_city: string | null;
        address_state: string | null;
        address_postal_code: string | null;
      };

      const row = await query<PacketRow>(
        `SELECT
           j.id                         AS job_id,
           j.job_key,
           j.status                     AS job_status,
           st.display_name              AS service_type_name,
           j.appointment_date::text     AS appointment_date,
           j.appointment_window,
           j.special_instructions,
           j.custom_job_details,
           cust.full_name               AS customer_full_name,
           cust.phone_e164              AS customer_phone,
           a.line1                      AS address_line1,
           a.line2                      AS address_line2,
           a.city                       AS address_city,
           a.state                      AS address_state,
           a.postal_code                AS address_postal_code
         FROM contractor_assignments ca
         JOIN jobs j          ON j.id  = ca.job_id
         JOIN customers cust  ON cust.id = j.customer_id
         JOIN dispatches d    ON d.id = ca.dispatch_id
                             AND d.job_id = ca.job_id
         LEFT JOIN addresses a       ON a.id = j.address_id
         LEFT JOIN service_types st  ON st.id = j.service_type_id
        WHERE ca.contractor_packet_token = $1
          AND ca.status = 'accepted'
          AND j.status = 'assigned'
          AND d.status = 'accepted'`,
        [contractorPacketToken],
      );

      if (!row || row.length === 0) {
        // Unknown token, wrong status, or access denied — generic 404, no detail
        res.status(404).send('Not found');
        return;
      }

      const packet = row[0];

      // 3. Fetch confirmed photos (only after access validation passes)
      type PhotoRow = {
        id: string;
        storage_key: string;
        mime_type: string | null;
        original_filename: string | null;
        confirmed_at: Date | null;
      };
      const photos = await query<PhotoRow>(
        `SELECT id, storage_key, mime_type, original_filename, confirmed_at
           FROM uploaded_media
          WHERE job_id = $1 AND confirmed_at IS NOT NULL
          ORDER BY confirmed_at ASC`,
        [packet.job_id],
      );

      // 4. Generate presigned GET URLs — skip failures gracefully, never log URLs
      type SignedPhoto = { url: string; filename: string | null };
      const signedPhotos: SignedPhoto[] = [];
      for (const photo of photos) {
        try {
          const url = await generatePresignedDownloadUrl(photo.storage_key);
          signedPhotos.push({ url, filename: photo.original_filename });
        } catch {
          logger.warn(
            { jobId: packet.job_id, handler: 'contractor-packet' },
            '[ContractorPacket] Failed to sign photo — skipping',
          );
        }
      }

      // 5. Build SMS deep links
      const jobKey = packet.job_key;
      const quoPhone = config.QUO_PHONE_NUMBER ?? '';
      const otwBody = encodeURIComponent(`OTW ${jobKey}`);
      const doneBody = encodeURIComponent(`DONE ${jobKey}`);
      const otwSmsHref = quoPhone ? `sms:${quoPhone}?body=${otwBody}` : '#';
      const doneSmsHref = quoPhone ? `sms:${quoPhone}?body=${doneBody}` : '#';

      // 6. Build Google Maps link
      const addressParts = [
        packet.address_line1,
        packet.address_line2,
        packet.address_city,
        packet.address_state,
        packet.address_postal_code,
      ].filter(Boolean);
      const addressStr = addressParts.join(', ');
      const mapsHref = addressStr
        ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressStr)}`
        : null;

      // 7. Build photos HTML
      const photosHtml =
        signedPhotos.length === 0
          ? `<p class="no-photos">No confirmed photos yet.</p>`
          : signedPhotos
              .map(
                (p, i) =>
                  `<div class="photo-item">
                <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">
                  <img src="${escapeHtml(p.url)}" alt="Photo ${i + 1}${p.filename ? ': ' + escapeHtml(p.filename) : ''}" loading="lazy" />
                </a>
                ${p.filename ? `<span class="photo-name">${escapeHtml(p.filename)}</span>` : ''}
              </div>`,
              )
              .join('\n');

      // 8. Build address display
      const addressDisplayLines: string[] = [];
      if (packet.address_line1) addressDisplayLines.push(escapeHtml(packet.address_line1));
      if (packet.address_line2) addressDisplayLines.push(escapeHtml(packet.address_line2));
      const cityStateZip = [packet.address_city, packet.address_state, packet.address_postal_code]
        .filter((v): v is string => Boolean(v))
        .map(escapeHtml)
        .join(', ');
      if (cityStateZip) addressDisplayLines.push(cityStateZip);
      const addressHtml = addressDisplayLines.join('<br>');

      // 9. Appointment display
      const apptDate = packet.appointment_date
        ? escapeHtml(packet.appointment_date)
        : 'TBD';
      const apptWindow = packet.appointment_window
        ? ` &bull; ${escapeHtml(packet.appointment_window)}`
        : '';

      // 10. Render HTML — contractor_packet_token is NOT rendered anywhere
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Job Packet &mdash; ${escapeHtml(jobKey)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f5f5; color: #1a1a1a; margin: 0; padding: 1rem; }
    .card { background: #fff; border-radius: 10px; padding: 1.25rem;
            margin-bottom: 1rem; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    h1 { font-size: 1.2rem; margin: 0 0 0.25rem; }
    h2 { font-size: 1rem; margin: 0 0 0.75rem; color: #444; border-bottom: 1px solid #eee;
         padding-bottom: 0.4rem; }
    .badge { background: #1a1a2e; color: #fff; padding: 0.2rem 0.6rem;
             border-radius: 4px; font-size: 0.85rem; font-family: monospace; }
    .label { font-size: 0.8rem; color: #666; text-transform: uppercase;
             letter-spacing: 0.05em; margin-bottom: 0.15rem; }
    .value { font-size: 1rem; margin-bottom: 0.75rem; }
    .address-block { font-size: 1rem; line-height: 1.5; }
    a.maps-link { display: inline-block; margin-top: 0.5rem; color: #1a73e8;
                  text-decoration: none; font-size: 0.9rem; }
    .sms-buttons { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.5rem; }
    .sms-btn { display: inline-block; padding: 0.75rem 1.5rem; border-radius: 8px;
               font-size: 1rem; font-weight: 600; text-decoration: none; text-align: center;
               flex: 1; min-width: 120px; }
    .sms-btn.otw { background: #1a73e8; color: #fff; }
    .sms-btn.done { background: #188038; color: #fff; }
    .fallback { font-size: 0.82rem; color: #555; margin-top: 0.75rem; line-height: 1.6; }
    .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
                  gap: 0.75rem; }
    .photo-item img { width: 100%; border-radius: 6px; display: block; }
    .photo-name { font-size: 0.75rem; color: #666; margin-top: 0.25rem;
                  word-break: break-all; display: block; }
    .no-photos { color: #888; font-size: 0.9rem; }
    footer { text-align: center; font-size: 0.75rem; color: #aaa; margin-top: 1.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="label">Assembly Concierge Job Packet</div>
    <h1><span class="badge">${escapeHtml(jobKey)}</span></h1>
    <div class="label">Service</div>
    <div class="value">${packet.service_type_name ? escapeHtml(packet.service_type_name) : 'Assembly'}</div>
    <div class="label">Appointment</div>
    <div class="value">${apptDate}${apptWindow}</div>
  </div>

  <div class="card">
    <h2>Customer</h2>
    <div class="label">Name</div>
    <div class="value">${escapeHtml(packet.customer_full_name)}</div>
    <div class="label">Phone</div>
    <div class="value"><a href="tel:${escapeHtml(packet.customer_phone)}">${escapeHtml(packet.customer_phone)}</a></div>
  </div>

  <div class="card">
    <h2>Service Address</h2>
    <div class="address-block">${addressHtml || 'Address not available'}</div>
    ${mapsHref ? `<a class="maps-link" href="${escapeHtml(mapsHref)}" target="_blank" rel="noopener noreferrer">&#x1F4CD; Open in Google Maps</a>` : ''}
  </div>

  ${packet.custom_job_details || packet.special_instructions ? `
  <div class="card">
    <h2>Job Details &amp; Notes</h2>
    ${packet.custom_job_details ? `<div class="label">Details</div><div class="value">${escapeHtml(packet.custom_job_details)}</div>` : ''}
    ${packet.special_instructions ? `<div class="label">Special Instructions</div><div class="value">${escapeHtml(packet.special_instructions)}</div>` : ''}
  </div>` : ''}

  <div class="card">
    <h2>Customer Photos</h2>
    <div class="photo-grid">
      ${photosHtml}
    </div>
  </div>

  <div class="card">
    <h2>Status Updates</h2>
    <p style="font-size:0.9rem;color:#444;margin:0 0 0.75rem;">
      Text your status updates to Assembly Concierge:
    </p>
    <div class="sms-buttons">
      <a class="sms-btn otw" href="${escapeHtml(otwSmsHref)}">&#x1F697; Text OTW</a>
      <a class="sms-btn done" href="${escapeHtml(doneSmsHref)}">&#x2705; Text DONE</a>
    </div>
    ${quoPhone ? `
    <div class="fallback">
      <strong>Manual fallback</strong> (if buttons don&rsquo;t work):<br>
      Text <code>OTW ${escapeHtml(jobKey)}</code> to ${escapeHtml(quoPhone)}<br>
      Text <code>DONE ${escapeHtml(jobKey)}</code> to ${escapeHtml(quoPhone)}
    </div>` : ''}
  </div>

  <footer>Assembly Concierge &mdash; Contractor Use Only &mdash; Do not share this link</footer>
</body>
</html>`;

      // 11. Set security headers — scoped CSP allowing R2 image origins
      const imgSrcOrigins = new Set<string>(["'self'"]);
      try {
        if (config.STORAGE_ENDPOINT) {
          const endpointUrl = new URL(config.STORAGE_ENDPOINT);
          imgSrcOrigins.add(endpointUrl.origin);
          if (
            config.STORAGE_BUCKET &&
            endpointUrl.hostname.endsWith('.r2.cloudflarestorage.com')
          ) {
            imgSrcOrigins.add(
              `${endpointUrl.protocol}//${config.STORAGE_BUCKET}.${endpointUrl.hostname}`,
            );
          }
        }
      } catch {
        // Malformed endpoint — omit external origins rather than throwing
      }
      const imgSrc = [...imgSrcOrigins].join(' ');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; frame-ancestors 'none';`,
      );
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('X-Frame-Options', 'DENY');
      res.status(200).send(html);
    } catch (err) {
      logger.error({ err, correlationId }, '[ContractorPacket] Failed to render job packet');
      next(err);
    }
  },
);

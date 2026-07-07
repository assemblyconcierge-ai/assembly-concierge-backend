/**
 * Unit tests for validateDownloadedBuffer in googleDrive.service.ts
 *
 * Regression tests proving that HTML login pages, JSON error responses,
 * empty bodies, and other non-file responses are rejected before upload.
 *
 * Tests cover:
 *  - HTML doctype response (Jotform login page) → rejected
 *  - <html> tag without doctype → rejected
 *  - text/html content-type → rejected
 *  - application/json content-type → rejected
 *  - text/plain content-type → rejected
 *  - Empty buffer → rejected
 *  - Buffer smaller than MIN_FILE_BYTES → rejected
 *  - Valid PDF buffer (binary, correct size) → accepted
 *  - Valid JPEG buffer (binary, correct size) → accepted
 *  - application/octet-stream with HTML body → rejected (body check wins)
 *  - Content-type with charset suffix (text/html; charset=utf-8) → rejected
 */

import { describe, it, expect } from 'vitest';
import { validateDownloadedBuffer } from '../../src/modules/storage/googleDrive.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a buffer of at least 512 bytes with the given string prefix. */
function bufferOf(prefix: string, totalBytes = 1024): Buffer {
  const base = Buffer.from(prefix, 'utf-8');
  if (base.length >= totalBytes) return base;
  const pad = Buffer.alloc(totalBytes - base.length, 0x20); // space padding
  return Buffer.concat([base, pad]);
}

/** Build a minimal fake PDF buffer (starts with %PDF- magic bytes). */
function fakePdfBuffer(size = 1024): Buffer {
  const header = Buffer.from('%PDF-1.4\n', 'utf-8');
  const body = Buffer.alloc(size - header.length, 0x00);
  return Buffer.concat([header, body]);
}

/** Build a minimal fake JPEG buffer (starts with FF D8 FF magic bytes). */
function fakeJpegBuffer(size = 1024): Buffer {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const body = Buffer.alloc(size - header.length, 0x00);
  return Buffer.concat([header, body]);
}

const HTML_LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>Login · Jotform</title></head>
<body><form action="/login">...</form></body>
</html>`;

const HTML_NO_DOCTYPE = `<html lang="en">
<head><title>Redirect</title></head>
<body>Please log in.</body>
</html>`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validateDownloadedBuffer', () => {
  // ── HTML rejection ──────────────────────────────────────────────────────────

  it('rejects Jotform login page (DOCTYPE html, text/html content-type)', () => {
    const buf = bufferOf(HTML_LOGIN_PAGE);
    expect(() =>
      validateDownloadedBuffer(buf, 'text/html; charset=utf-8', 'W-9.pdf'),
    ).toThrow(/content-type.*indicates a non-file response/i);
  });

  it('rejects HTML body even when content-type is application/octet-stream', () => {
    const buf = bufferOf(HTML_LOGIN_PAGE);
    expect(() =>
      validateDownloadedBuffer(buf, 'application/octet-stream', 'Insurance.pdf'),
    ).toThrow(/response body begins with HTML markup/i);
  });

  it('rejects <html> tag without DOCTYPE', () => {
    const buf = bufferOf(HTML_NO_DOCTYPE);
    expect(() =>
      validateDownloadedBuffer(buf, 'application/octet-stream', 'Photo_ID.jpg'),
    ).toThrow(/response body begins with HTML markup/i);
  });

  it('rejects HTML body with leading whitespace before DOCTYPE', () => {
    const buf = bufferOf('\n\n   <!DOCTYPE html><html><body></body></html>');
    expect(() =>
      validateDownloadedBuffer(buf, 'application/octet-stream', 'doc.pdf'),
    ).toThrow(/response body begins with HTML markup/i);
  });

  // ── Content-type rejection ──────────────────────────────────────────────────

  it('rejects text/html content-type (binary body)', () => {
    // Even if the body were binary, text/html content-type is rejected
    const buf = fakePdfBuffer();
    expect(() =>
      validateDownloadedBuffer(buf, 'text/html', 'W-9.pdf'),
    ).toThrow(/content-type.*indicates a non-file response/i);
  });

  it('rejects application/json content-type', () => {
    const buf = bufferOf('{"error":"Unauthorized","message":"Please log in"}');
    expect(() =>
      validateDownloadedBuffer(buf, 'application/json', 'Insurance.pdf'),
    ).toThrow(/content-type.*indicates a non-file response/i);
  });

  it('rejects text/plain content-type', () => {
    const buf = bufferOf('Error: File not found.');
    expect(() =>
      validateDownloadedBuffer(buf, 'text/plain', 'doc.pdf'),
    ).toThrow(/content-type.*indicates a non-file response/i);
  });

  it('rejects text/html with charset suffix (text/html; charset=utf-8)', () => {
    const buf = bufferOf(HTML_LOGIN_PAGE);
    expect(() =>
      validateDownloadedBuffer(buf, 'text/html; charset=utf-8', 'W-9.pdf'),
    ).toThrow(/content-type.*indicates a non-file response/i);
  });

  // ── Size rejection ──────────────────────────────────────────────────────────

  it('rejects empty buffer', () => {
    const buf = Buffer.alloc(0);
    expect(() =>
      validateDownloadedBuffer(buf, 'application/pdf', 'W-9.pdf'),
    ).toThrow(/too small/i);
  });

  it('rejects buffer smaller than 512 bytes', () => {
    const buf = Buffer.alloc(100, 0x25); // 100 bytes of '%'
    expect(() =>
      validateDownloadedBuffer(buf, 'application/pdf', 'W-9.pdf'),
    ).toThrow(/too small/i);
  });

  it('rejects 511-byte buffer (one byte below threshold)', () => {
    const buf = Buffer.alloc(511, 0x00);
    expect(() =>
      validateDownloadedBuffer(buf, 'application/pdf', 'W-9.pdf'),
    ).toThrow(/too small/i);
  });

  // ── Valid file acceptance ───────────────────────────────────────────────────

  it('accepts a valid PDF buffer (application/pdf)', () => {
    const buf = fakePdfBuffer(2048);
    expect(() =>
      validateDownloadedBuffer(buf, 'application/pdf', 'W-9.pdf'),
    ).not.toThrow();
  });

  it('accepts a valid JPEG buffer (image/jpeg)', () => {
    const buf = fakeJpegBuffer(2048);
    expect(() =>
      validateDownloadedBuffer(buf, 'image/jpeg', 'Photo_ID.jpg'),
    ).not.toThrow();
  });

  it('accepts a valid PNG buffer (image/png)', () => {
    // PNG magic: 89 50 4E 47
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const body = Buffer.alloc(1016, 0x00);
    const buf = Buffer.concat([header, body]);
    expect(() =>
      validateDownloadedBuffer(buf, 'image/png', 'signature.png'),
    ).not.toThrow();
  });

  it('accepts application/octet-stream with binary content', () => {
    const buf = fakePdfBuffer(1024);
    expect(() =>
      validateDownloadedBuffer(buf, 'application/octet-stream', 'W-9.pdf'),
    ).not.toThrow();
  });

  it('accepts exactly 512-byte buffer (at threshold)', () => {
    const buf = fakePdfBuffer(512);
    expect(() =>
      validateDownloadedBuffer(buf, 'application/pdf', 'W-9.pdf'),
    ).not.toThrow();
  });

  // ── Error message quality ───────────────────────────────────────────────────

  it('error message includes the file name', () => {
    const buf = bufferOf(HTML_LOGIN_PAGE);
    expect(() =>
      validateDownloadedBuffer(buf, 'text/html', 'Insurance_recABC123.pdf'),
    ).toThrow(/Insurance_recABC123\.pdf/);
  });

  it('error message includes "File was NOT uploaded"', () => {
    const buf = bufferOf(HTML_LOGIN_PAGE);
    expect(() =>
      validateDownloadedBuffer(buf, 'text/html', 'W-9.pdf'),
    ).toThrow(/File was NOT uploaded/);
  });

  it('error message includes byte size for size rejection', () => {
    const buf = Buffer.alloc(50, 0x00);
    expect(() =>
      validateDownloadedBuffer(buf, 'application/pdf', 'W-9.pdf'),
    ).toThrow(/50 bytes/);
  });
});

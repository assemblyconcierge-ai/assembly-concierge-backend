# Assembly Concierge — Platform Case Study

## Overview

Assembly Concierge is a local service booking platform for furniture and fitness
equipment assembly in Hampton, McDonough, and Stockbridge, GA. The platform covers
the full customer journey: online booking, secure Stripe payment, photo intake, and
operator job tracking — built and validated incrementally with TypeScript, Vitest,
and production smoke tests at each milestone.
The platform is currently in pre-launch testing.

## Problem

The business needed a structured way to accept booking requests online, collect
payments before confirming jobs, gate contractor dispatch on payment and manual
review, and give operators a consolidated view of intake, payment, and photo status
— without exposing internal system details to customers.

## Architecture

**Frontend** — Next.js 16, React 19, Tailwind CSS v4, deployed on Vercel with a custom domain. Netlify DNS retained; A/CNAME records updated to Vercel; MX, TXT, and DKIM records preserved during migration.

**Backend** — Node.js, Express, TypeScript, PostgreSQL on Render. Stripe Checkout for payments. Cloudflare R2 private bucket for photo storage with presigned upload URLs. Airtable for operator job tracking.

**Booking flow** — 4-step stepper: service selection, contact and address, scheduling, and review/submit. Each step validates before advancing, with inline field-level error messages and scroll-to-focus behavior. The service selector covers flat-rate paths (Small, Medium, Large, Treadmill) and manual-review paths (Fitness Equipment, Custom). Phone normalization and fictional placeholder data prevent accidental real-number exposure during development.

**Contractor dispatch** — Outbound SMS via Quo (OpenPhone-compatible). Contractors receive and respond to jobs through SMS commands (CONFIRM, DECLINE, OTW, DONE) with no app required.

## Recent Work

**Operator photo review — CSP fix** — The operator photo review page
(`GET /public/photos/review/:operatorPhotoToken`) was generating valid R2 presigned
URLs but thumbnails rendered blank. Root cause: global `helmet()` sets
`img-src 'self'`, which blocks cross-origin R2 presigned URLs. An initial fix
scoped the override to the base R2 endpoint origin; a follow-up (commit `0ba353f`)
extended the allowlist to include the bucket-prefixed subdomain origin
(`<bucket>.<base-r2-endpoint>`), which is the form AWS SDK-generated presigned URLs
actually use. Both origins are now permitted in the scoped `img-src` override on the
review route, with `default-src 'none'` for everything else. Global Helmet policy is
unchanged. Validated: build and 212 Vitest tests pass; live CSP verified on
production; operator preview visually confirmed working. Future: a contractor-facing
photo link should reuse this same CSP pattern with a separate contractor-scoped
token — not the operator token.

**Frontend final-state polish** — Payment success and photo upload completion screens
were functional but did not clearly signal "done." Added "You're all set." subtitle,
"What happens next" detail block, and explicit "you can close this page" copy to
both screens. Removed a duplicate pair of identical `/book` CTAs on the photo
completion screen, replacing them with a single understated "Start a new booking"
link.

**Quote flow photo copy** — Updated the booking form's submit CTA for quote-type
jobs to "Submit Quote Request & Add Photos" and added a contextual hint below the
button explaining that photos help price custom jobs. Non-quote paths are unchanged.

**Validation** — Backend: 212 automated tests across 16 Vitest test files
(unit + integration), all passing. Frontend: Next.js production build and ESLint
clean at each merge.

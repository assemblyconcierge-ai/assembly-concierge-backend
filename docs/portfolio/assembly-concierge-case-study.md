# Assembly Concierge — Platform Case Study

## Overview

Assembly Concierge is a local service booking platform for furniture and fitness
equipment assembly in Hampton, McDonough, and Stockbridge, GA. The platform covers
the full customer journey: online booking, secure Stripe payment, photo intake, and
operator job tracking — built and validated incrementally with TypeScript, Vitest,
and production smoke tests at each milestone.

## Problem

The business needed a structured way to accept booking requests online, collect
payments before confirming jobs, gate contractor dispatch on payment and manual
review, and give operators a consolidated view of intake, payment, and photo status
— without exposing internal system details to customers.

## Architecture

**Frontend** — Next.js 16, React 19, Tailwind CSS v4, deployed on Vercel with a custom domain. Netlify DNS retained; A/CNAME records updated to Vercel; MX, TXT, and DKIM records preserved during migration.

**Backend** — Node.js, Express, TypeScript, PostgreSQL on Render. Stripe Checkout for payments. Cloudflare R2 private bucket for photo storage with presigned upload URLs. Airtable for operator job tracking.

**Booking flow** — 4-step stepper: service selection, contact and address, scheduling, and review/submit. Each step validates before advancing, with inline field-level error messages and scroll-to-focus behavior. The service selector covers flat-rate paths (Small, Medium, Large, Treadmill) and manual-review paths (Fitness Equipment, Custom). Phone normalization and fictional placeholder data prevent accidental real-number exposure during development.

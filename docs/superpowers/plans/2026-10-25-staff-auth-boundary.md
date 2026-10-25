# Staff Auth Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict POS access to active GadgetBoy staff, add future technician account setup/recovery controls, and preserve working QR updates.

**Architecture:** Centralize active-staff and shop authorization in Edge Function helpers. Keep public token-scoped client pages separate from staff workflows. Provision accounts through an admin-only Edge Function and expose only a status/action UI in the technician window.

**Tech Stack:** React, TypeScript, Supabase Auth, Supabase Edge Functions, Postgres RLS, Node assertion scripts.

**Spec:** `docs/superpowers/specs/2026-10-25-staff-auth-boundary-design.md`

## Global Constraints

- Do not create or invite any technician account during deployment.
- Email is the only password-recovery mechanism in this release.
- Four-digit PINs remain non-login credentials.
- Preserve public token-scoped client repair status and reply flows.

## Review Focus

- A normal authenticated Supabase account without active staff membership receives 403 from every staff Edge Function.
- Disabled and cross-shop staff cannot operate QR/update/email endpoints.
- Public client QR status pages never receive privileged record fields.
- Setup/recovery responses do not disclose whether an identity exists.
- Existing Admin session continues to access current POS workflows.

### Task 1: Edge-function authorization and QR boundary

**Files:**
- Create: `supabase/functions/_shared/staff-auth.ts`
- Modify: `supabase/functions/qr-status/index.ts`
- Modify: `supabase/functions/client-updates/index.ts`
- Modify: `supabase/functions/send-pos-email/index.ts`
- Test: `tools/test-staff-auth-boundary.cjs`

- [ ] Write failing source-level regression tests for active staff, matching shop, and public QR field boundaries.
- [ ] Run `node tools/test-staff-auth-boundary.cjs` and verify it fails.
- [ ] Implement the shared authorization helper and consume it from all three functions.
- [ ] Run the test and verify it passes.

### Task 2: Admin-only technician setup and recovery

**Files:**
- Create: `supabase/functions/staff-account-admin/index.ts`
- Modify: `src/components/TechniciansWindow.tsx`
- Modify: `src/auth/LoginScreen.tsx`
- Modify: `src/global.d.ts`
- Test: `tools/test-staff-account-setup.cjs`

- [ ] Write failing tests for admin-only setup, identity matching, and non-enumerating email recovery.
- [ ] Run `node tools/test-staff-account-setup.cjs` and verify it fails.
- [ ] Implement the Edge Function and UI actions without triggering account creation until a user clicks Set Up Login.
- [ ] Run the test and verify it passes.

### Task 3: Deployment verification

**Files:**
- Modify: `tools/test-supabase-client-updates.cjs`
- Test: existing QR/update test scripts

- [ ] Run focused authorization and existing QR/update regression tests.
- [ ] Typecheck renderer and Edge Function sources.
- [ ] Deploy Edge Functions only after focused tests pass; verify unauthenticated, ordinary-authenticated, disabled, wrong-shop, and valid-staff cases against the live service without reading customer data.

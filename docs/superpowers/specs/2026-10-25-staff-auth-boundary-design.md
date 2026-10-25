# Staff Auth Boundary Design

## Intent

Move from a shared POS login toward individual staff accounts without creating any technician accounts automatically. The current shared account stays active as the Administrator until an admin deliberately sends a technician setup link.

## Goals

- Permit POS access only to a valid Supabase user linked to one active staff profile in the correct shop.
- Add a per-technician **Set Up Login** action in Admin > Technicians.
- Send an expiring email setup link only to the email saved on that active technician profile.
- Let the recipient establish a password and use the profile's already-saved email, phone, or both as permitted sign-in identities.
- Add an email-only **Forgot ya Login?** recovery path that does not reveal account existence.
- Attribute QR/client updates to the signed-in staff user; do not request an additional update PIN.
- Preserve client-facing QR status/reply links and existing Admin access.

## Non-goals

- Do not create technician Auth users, send setup messages, or change staff access as part of deployment.
- Do not use the four-digit technician PIN as an account password.
- Do not expose the service-role key to a renderer or packaged client.
- Do not enable SMS recovery in this release.

## Architecture

Admin-only account provisioning is performed by a JWT-protected Edge Function using the service role only server-side. It validates the caller's active admin profile, target active technician profile, and stored email before issuing an invite/setup link. A shared authorization helper used by all staff-facing Edge Functions validates the bearer user, active staff profile, role where needed, and matching `shop_id` before privileged queries. The QR status function keeps its public, opaque-token client view distinct from staff-only record access.

## Technician procedure

Until a technician is set up, the existing shared Administrator login continues to work and actions are logged as Admin. Once an admin sends setup, the technician opens the email link, sets a password, and signs into the POS with their saved email or verified phone plus that password. QR scanning and update sending remain the same; the current session determines the recorded technician.

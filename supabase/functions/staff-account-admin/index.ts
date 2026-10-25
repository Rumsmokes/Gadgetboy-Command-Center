import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.1";
import { requireActiveStaff, StaffAuthError } from "../_shared/staff-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const genericRecoveryResult = { ok: true, message: "If that active technician email is on file, a login recovery link has been sent." };

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function safe(value: unknown, length = 254) {
  return String(value ?? "").trim().slice(0, length);
}

function appRedirectUrl() {
  return String(Deno.env.get("PUBLIC_APP_URL") || "https://rumsmokes.github.io/Gadgetboy-Command-Center").replace(/\/+$/, "");
}

function adminClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !serviceKey) throw new StaffAuthError(503, "POS account setup is not configured.");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed." });

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = safe(body.action, 40).toLowerCase();
    const admin = adminClient();

    // This intentionally returns the same result for every input. It is public
    // so an employee who forgot their password can start recovery before login.
    if (action === "request-recovery") {
      const email = safe(body.email).toLowerCase();
      if (!email) return json(200, genericRecoveryResult);
      const { data: profile } = await admin
        .from("staff_profiles")
        .select("email,user_id,status")
        .eq("email", email)
        .eq("status", "active")
        .maybeSingle();
      if (profile?.user_id && profile.email) {
        await admin.auth.resetPasswordForEmail(String(profile.email), { redirectTo: appRedirectUrl() });
      }
      return json(200, genericRecoveryResult);
    }

    if (action !== "setup") return json(400, { ok: false, error: "Unsupported staff account action." });
    const caller = await requireActiveStaff(req, { roles: ["admin"] });
    const profileId = safe(body.staffProfileId, 80);
    if (!profileId) return json(400, { ok: false, error: "Select a technician before sending a setup link." });

    const { data: technician, error: technicianError } = await admin
      .from("staff_profiles")
      .select("id,shop_id,user_id,status,email,first_name,last_name,nickname")
      .eq("id", profileId)
      .eq("shop_id", caller.shopId)
      .eq("status", "active")
      .maybeSingle();
    if (technicianError || !technician) return json(404, { ok: false, error: "That active technician profile could not be found." });
    const email = safe(technician.email).toLowerCase();
    if (!email) return json(400, { ok: false, error: "Add the technician's email address before setting up their login." });

    if (technician.user_id) {
      const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo: appRedirectUrl() });
      if (error) throw error;
      return json(200, { ok: true, mode: "recovery", message: `A password-reset link was sent to ${email}.` });
    }

    const displayName = [technician.nickname, technician.first_name, technician.last_name].filter(Boolean).join(" ").trim();
    const { data: invitation, error: invitationError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: appRedirectUrl(),
      data: {
        staff_profile_id: technician.id,
        shop_id: technician.shop_id,
        display_name: displayName,
      },
    });
    if (invitationError || !invitation.user?.id) throw invitationError || new Error("Supabase did not create the invited staff account.");
    const { error: linkError } = await admin
      .from("staff_profiles")
      .update({ user_id: invitation.user.id, status: "active" })
      .eq("id", technician.id)
      .eq("shop_id", caller.shopId);
    if (linkError) throw linkError;
    return json(200, { ok: true, mode: "invite", message: `A login setup link was sent to ${email}.` });
  } catch (error) {
    if (error instanceof StaffAuthError) return json(error.status, { ok: false, error: error.message });
    const message = error instanceof Error ? error.message : String(error || "Staff login setup failed.");
    console.error("staff-account-admin failed", message);
    return json(500, { ok: false, error: message.slice(0, 1000) });
  }
});

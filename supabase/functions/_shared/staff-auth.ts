import { createClient } from "npm:@supabase/supabase-js@2.110.1";

export type ActiveStaff = {
  userId: string;
  profileId: string;
  shopId: string;
  role: string;
  email: string;
};

export class StaffAuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "StaffAuthError";
    this.status = status;
  }
}

type Requirements = {
  shopId?: string;
  roles?: string[];
};

/**
 * Authorizes a real POS staff account against the server-side staff profile.
 * Never trust a browser-supplied shop id or role claim for sensitive actions.
 */
export async function requireActiveStaff(req: Request, requirements: Requirements = {}): Promise<ActiveStaff> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authorization = req.headers.get("Authorization") || "";
  if (!supabaseUrl || !publishableKey || !serviceRoleKey) {
    throw new StaffAuthError(503, "POS staff authorization is not configured.");
  }
  if (!authorization) throw new StaffAuthError(401, "Sign in before using this POS action.");

  const caller = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: authData, error: authError } = await caller.auth.getUser();
  if (authError || !authData.user) throw new StaffAuthError(401, "Your login session is no longer valid.");

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: profile, error: profileError } = await admin
    .from("staff_profiles")
    .select("id,shop_id,status,role,email")
    .eq("user_id", authData.user.id)
    .eq("status", "active")
    .maybeSingle();
  if (profileError || !profile?.id || !profile.shop_id) {
    throw new StaffAuthError(403, "This account is not active for a POS shop.");
  }
  if (requirements.shopId && String(profile.shop_id) !== String(requirements.shopId)) {
    throw new StaffAuthError(403, "This account is not active for the selected shop.");
  }
  const role = String(profile.role || "technician").trim().toLowerCase();
  if (requirements.roles?.length && !requirements.roles.map((value) => value.toLowerCase()).includes(role)) {
    throw new StaffAuthError(403, "This action requires an administrator account.");
  }
  return {
    userId: authData.user.id,
    profileId: String(profile.id),
    shopId: String(profile.shop_id),
    role,
    email: String(authData.user.email || profile.email || ""),
  };
}

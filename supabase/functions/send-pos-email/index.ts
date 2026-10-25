import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.1";
import nodemailer from "npm:nodemailer@7.0.12";
import { requireActiveStaff, StaffAuthError } from "../_shared/staff-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_RECIPIENTS = 5;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AttachmentInput = {
  filename?: unknown;
  content?: unknown;
  contentBase64?: unknown;
  contentType?: unknown;
  encoding?: unknown;
};

type RequestBody = {
  action?: unknown;
  shopId?: unknown;
  to?: unknown;
  bcc?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  attachments?: unknown;
};

// Automatic acknowledgments use client_update_history as the same retry-safe
// outbox as staff-authored QR updates. The queue RPC inserts only pending rows,
// and this worker's conditional pending -> sending claim prevents double sends.

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function safeString(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function parseAddresses(value: unknown, label: string) {
  const addresses = (Array.isArray(value) ? value : String(value ?? "").split(/[;,]/))
    .map((entry) => String(entry ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (addresses.length > MAX_RECIPIENTS) throw new Error(`${label} supports at most ${MAX_RECIPIENTS} recipients.`);
  if (addresses.some((entry) => !EMAIL_PATTERN.test(entry))) throw new Error(`Enter a valid ${label.toLowerCase()} email address.`);
  return [...new Set(addresses)];
}

function decodeBase64(value: string) {
  const normalized = value.replace(/^data:[^;]+;base64,/i, "").replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function normalizeAttachments(value: unknown) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_ATTACHMENTS) throw new Error(`A message may include at most ${MAX_ATTACHMENTS} attachments.`);
  let totalBytes = 0;
  return value.map((raw: AttachmentInput, index) => {
    const filename = safeString(raw?.filename || `attachment-${index + 1}`, 160).replace(/[\\/:*?"<>|]/g, "-");
    const contentType = safeString(raw?.contentType || "application/octet-stream", 120);
    const isBase64 = safeString(raw?.encoding, 20).toLowerCase() === "base64" || typeof raw?.contentBase64 === "string";
    const content = isBase64
      ? decodeBase64(String(raw?.contentBase64 ?? raw?.content ?? ""))
      : String(raw?.content ?? "");
    const byteLength = typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
    if (!byteLength) throw new Error(`${filename} is empty.`);
    if (byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${filename} exceeds the 6 MB attachment limit.`);
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error("Attachments exceed the 10 MB message limit.");
    return { filename, content, contentType };
  });
}

async function authorizeStaff(req: Request, shopId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  const authorization = req.headers.get("Authorization") || "";
  if (!supabaseUrl || !publishableKey || !authorization) return { ok: false as const, status: 401, error: "Sign in before sending email." };

  const bearerToken = authorization.replace(/^Bearer\s+/i, "").trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (serviceRoleKey && bearerToken === serviceRoleKey) {
    return { ok: true as const, userId: null, service: true as const };
  }

  try {
    const staff = await requireActiveStaff(req, { shopId });
    return { ok: true as const, userId: staff.userId, service: false as const };
  } catch (error) {
    if (error instanceof StaffAuthError) return { ok: false as const, status: error.status, error: error.message };
    return { ok: false as const, status: 500, error: "Unable to authorize this POS email action." };
  }
}

function emailConfig() {
  const gmailUser = safeString(Deno.env.get("GBPOS_GMAIL_USER") || "gadgetboysc@gmail.com", 254);
  const gmailAppPassword = String(Deno.env.get("GBPOS_GMAIL_APP_PASSWORD") || "").replace(/\s+/g, "");
  const fromName = safeString(Deno.env.get("GBPOS_EMAIL_FROM_NAME") || "GadgetBoy Repair & Retail", 120);
  return { gmailUser, gmailAppPassword, fromName, configured: Boolean(gmailUser && gmailAppPassword) };
}

async function deliverEmail(payload: {
  to: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string | Uint8Array; contentType: string }>;
}) {
  const config = emailConfig();
  if (!config.configured) throw new Error("Supabase email is not configured. Add the Gmail App Password to Edge Function secrets.");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: config.gmailUser, pass: config.gmailAppPassword },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return transporter.sendMail({
    from: `${config.fromName} <${config.gmailUser}>`,
    to: payload.to,
    bcc: payload.bcc?.length ? payload.bcc : undefined,
    subject: payload.subject,
    text: payload.text || undefined,
    html: payload.html || undefined,
    attachments: payload.attachments?.length ? payload.attachments : undefined,
  });
}

async function sendClientUpdate(historyId: string, shopId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: claimed, error: claimError } = await admin
    .from("client_update_history")
    .update({ delivery_status: "sending", delivery_updated_at: new Date().toISOString() })
    .eq("id", historyId)
    .eq("shop_id", shopId)
    .eq("delivery_status", "pending")
    .select("id,recipient_email,email_subject,email_text,email_html,delivery_attempts")
    .maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return { ok: true, busy: true, messageId: null };

  const attempts = Number(claimed.delivery_attempts || 0) + 1;
  try {
    const to = parseAddresses(claimed.recipient_email, "Recipient");
    const info = await deliverEmail({
      to,
      subject: safeString(claimed.email_subject || "GadgetBoy POS Client Update", 200),
      text: String(claimed.email_text || ""),
      html: String(claimed.email_html || "") || undefined,
    });
    await admin.from("client_update_history").update({
      delivery_status: "sent",
      delivery_error: null,
      provider_message_id: info.messageId || null,
      delivery_attempts: attempts,
      next_attempt_at: null,
      delivery_updated_at: new Date().toISOString(),
    }).eq("id", historyId).eq("shop_id", shopId);
    return { ok: true, busy: false, messageId: info.messageId || null };
  } catch (error) {
    const retryDelaySeconds = Math.min(15 * 60, 30 * Math.pow(2, Math.min(attempts - 1, 5)));
    const message = error instanceof Error ? error.message : String(error);
    await admin.from("client_update_history").update({
      delivery_status: "pending",
      delivery_error: message.slice(0, 1000),
      delivery_attempts: attempts,
      next_attempt_at: new Date(Date.now() + retryDelaySeconds * 1000).toISOString(),
      delivery_updated_at: new Date().toISOString(),
    }).eq("id", historyId).eq("shop_id", shopId);
    throw error;
  }
}

async function retryPendingClientUpdates(shopId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: pending, error } = await admin
    .from("client_update_history")
    .select("id")
    .eq("shop_id", shopId)
    .eq("delivery_status", "pending")
    .not("recipient_email", "is", null)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;

  let sent = 0;
  let failed = 0;
  for (const row of pending || []) {
    try {
      const result = await sendClientUpdate(String(row.id), shopId);
      if (!result.busy) sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok: true, processed: (pending || []).length, sent, failed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed." });

  try {
    const body = await req.json() as RequestBody;
    const shopId = safeString(body.shopId, 80);
    if (!shopId) return json(400, { ok: false, error: "Missing shop id." });
    const authorization = await authorizeStaff(req, shopId);
    if (!authorization.ok) return json(authorization.status, { ok: false, error: authorization.error });

    const config = emailConfig();
    const action = safeString(body.action || "send", 30).toLowerCase();
    if (action === "status") return json(200, { ok: true, configured: config.configured, fromEmail: config.gmailUser, fromName: config.fromName });
    if (action === "send-client-update") {
      const historyId = safeString((body as any).historyId, 80);
      if (!historyId) return json(400, { ok: false, error: "Missing client update history id." });
      const result = await sendClientUpdate(historyId, shopId);
      return json(200, result);
    }
    if (action === "retry-client-updates") {
      if (!config.configured) return json(503, { ok: false, error: "Supabase email is not configured. Add the Gmail App Password to Edge Function secrets." });
      const result = await retryPendingClientUpdates(shopId);
      return json(200, result);
    }
    if (action !== "send") return json(400, { ok: false, error: "Unsupported email action." });
    if (!config.configured) return json(503, { ok: false, error: "Supabase email is not configured. Add the Gmail App Password to Edge Function secrets." });

    const to = parseAddresses(body.to, "Recipient");
    if (!to.length) return json(400, { ok: false, error: "Missing recipient email." });
    const bcc = parseAddresses(body.bcc, "BCC");
    const subject = safeString(body.subject || "GadgetBoy POS Message", 200).replace(/[\r\n]+/g, " ");
    const text = String(body.text ?? "").slice(0, 500_000);
    const html = String(body.html ?? "").slice(0, 1_500_000);
    const attachments = normalizeAttachments(body.attachments);
    if (!text && !html && !attachments.length) return json(400, { ok: false, error: "The email has no message or attachment." });

    const info = await deliverEmail({
      to,
      bcc,
      subject,
      text,
      html,
      attachments,
    });
    return json(200, { ok: true, messageId: info.messageId || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Email delivery failed.");
    console.error("send-pos-email failed", message);
    return json(500, { ok: false, error: message.slice(0, 1000) });
  }
});

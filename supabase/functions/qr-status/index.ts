import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.1";
import { requireActiveStaff, StaffAuthError } from "../_shared/staff-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function safe(value: unknown, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}
function htmlEscape(value:unknown){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}

function icsEscape(value: unknown) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function icsDate(date: unknown, time: unknown) {
  const day = safe(date, 10).replace(/-/g, "");
  const clock = safe(time || "09:00", 5).replace(":", "").padEnd(4, "0");
  return `${day}T${clock}00`;
}

function titleFor(type: string, record: Record<string, unknown>) {
  if (type === "sale") return safe(record.item_description || record.category || "Order", 200);
  if (type === "consult") return safe(record.title || record.category || "Consultation", 200);
  return safe([record.product_description, record.model].filter(Boolean).join(" - ") || record.product_category || "Repair", 200);
}

function statusFor(type: string, record: Record<string, unknown>) {
  if (type === "repair") return safe(record.status_update || record.repair_status || record.status || "In progress", 200);
  return safe(record.status_update || record.status || "In progress", 200);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  try {
    const url = new URL(req.url);
    const token = safe(url.searchParams.get("token"), 220);
    if (!/^[A-Za-z0-9_-]{24,200}$/.test(token)) return json(400, { ok: false, error: "This QR status link is invalid." });

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !anonKey || !serviceRoleKey) return json(503, { ok: false, error: "The QR status service is not configured." });
    const publicClientView = url.searchParams.get("view") === "client";
    const publicCalendarDownload = url.searchParams.get("format") === "ics";
    const staff = !publicClientView && !publicCalendarDownload ? await requireActiveStaff(req) : null;
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: tokenRow, error: tokenError } = await admin
      .from("qr_status_tokens")
      .select("id,shop_id,record_type,legacy_record_id,expires_at")
      .eq("token", token)
      .is("revoked_at", null)
      .maybeSingle();
    if (tokenError || !tokenRow) return json(404, { ok: false, error: "This QR status link is no longer active." });
    if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) return json(410, { ok: false, error: "This QR status link has expired." });
    if (staff && String(staff.shopId) !== String(tokenRow.shop_id)) return json(403, { ok: false, error: "This QR link belongs to a different shop." });

    const type = safe(tokenRow.record_type, 20) || "repair";
    const table = type === "repair" ? "work_orders" : type === "consult" ? "calendar_events" : "sales";
    const recordFields = type === "repair"
      ? "id,shop_id,legacy_id,product_description,product_category,model,status_update,repair_status,status,estimated_date,scheduled_pickup_at"
      : type === "consult"
        ? "id,shop_id,legacy_id,title,category,status,status_update,event_date,event_time,end_time,location,technician"
        : "id,shop_id,legacy_id,item_description,category,status,status_update,estimated_date";
    const { data: record, error: recordError } = await admin
      .from(table)
      .select(recordFields)
      .eq("shop_id", tokenRow.shop_id)
      .eq("legacy_id", tokenRow.legacy_record_id)
      .maybeSingle();
    if (recordError || !record) return json(404, { ok: false, error: "The linked record is no longer available." });

    void admin.from("qr_status_tokens").update({ last_opened_at: new Date().toISOString() }).eq("id", tokenRow.id);
    if (type === "consult" && url.searchParams.get("format") === "ics") {
      const start = icsDate(record.event_date, record.event_time);
      const end = icsDate(record.event_date, record.end_time || record.event_time || "10:00");
      const calendar = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GadgetBoy POS//Consultation Reminder//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        "BEGIN:VEVENT", `UID:consult-${tokenRow.shop_id}-${tokenRow.legacy_record_id}@gadgetboypos`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`,
        `DTSTART:${start}`, `DTEND:${end}`, `SUMMARY:${icsEscape(record.title || "GadgetBoy Consultation")}`,
        `LOCATION:${icsEscape(record.location || "At Shop Location")}`,
        `DESCRIPTION:${icsEscape("Scheduled consultation with GadgetBoy Repair & Retail.")}`,
        "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", "DESCRIPTION:Consultation begins in one hour", "END:VALARM",
        "END:VEVENT", "END:VCALENDAR", "",
      ].join("\r\n");
      return new Response(calendar, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": `attachment; filename="GadgetBoy-Consultation-${tokenRow.legacy_record_id}.ics"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const reference = type === "sale" ? `INV-${tokenRow.legacy_record_id}` : type === "consult" ? `CONS-${tokenRow.legacy_record_id}` : `WO-${tokenRow.legacy_record_id}`;
    if(publicClientView){
      const {data:history}=await admin.from('client_update_history').select('status_label,message,estimated_date,created_at').eq('shop_id',tokenRow.shop_id).eq('record_type',type).eq('legacy_record_id',tokenRow.legacy_record_id).neq('status_key','technician_progress').order('created_at',{ascending:false}).limit(8);
      const updates=(history||[]).map((row:any)=>`<li style="padding:12px 0;border-bottom:1px solid #3f3f46"><strong>${htmlEscape(row.status_label)}</strong><div style="color:#a1a1aa;font-size:13px">${htmlEscape(new Date(row.created_at).toLocaleString())}${row.estimated_date?` · ETA ${htmlEscape(row.estimated_date)}`:''}</div>${row.message?`<p style="white-space:pre-wrap">${htmlEscape(row.message)}</p>`:''}</li>`).join('');
      return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width"><body style="margin:0;background:#09090b;color:#f4f4f5;font-family:Arial"><main style="max-width:620px;margin:28px auto;padding:22px"><header style="border-bottom:4px solid #39ff14"><h1>GADGETBOY</h1><p>Repair Status</p></header><section style="margin-top:18px;padding:18px;background:#18181b;border:1px solid #3f3f46;border-radius:10px"><small>${htmlEscape(reference)}</small><h2>${htmlEscape(titleFor(type,record))}</h2><div style="color:#39ff14;font-size:18px;font-weight:800">${htmlEscape(statusFor(type,record))}</div>${record.scheduled_pickup_at?`<p>Scheduled pickup: ${htmlEscape(new Date(record.scheduled_pickup_at).toLocaleString())}</p>`:''}${record.estimated_date?`<p>Estimated date: ${htmlEscape(record.estimated_date)}</p>`:''}</section><section style="margin-top:18px"><h3>Updates</h3><ul style="list-style:none;padding:0">${updates||'<li>No updates at this time, feel free to check back later.</li>'}</ul></section><p style="color:#a1a1aa">Questions? Call (803) 708-0101 or use the question link in your latest approval email.</p></main></body></html>`,{headers:{...corsHeaders,'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    }
    return json(200, {
      ok: true,
      type,
      reference,
      title: titleFor(type, record),
      status: statusFor(type, record),
      date: type === "consult" ? safe(record.event_date, 20) : safe(record.estimated_date, 40),
      time: type === "consult" ? safe(record.event_time, 20) : "",
      endTime: type === "consult" ? safe(record.end_time, 20) : "",
      location: type === "consult" ? safe(record.location || "At Shop Location", 500) : "",
      technician: type === "consult" ? safe(record.technician, 200) : "",
      icsUrl: type === "consult" ? `${url.origin}${url.pathname}?token=${encodeURIComponent(token)}&format=ics` : null,
    });
  } catch (error) {
    if (error instanceof StaffAuthError) return json(error.status, { ok: false, error: error.message });
    const message = error instanceof Error ? error.message : String(error || "QR status lookup failed.");
    console.error("qr-status failed", message);
    return json(500, { ok: false, error: message.slice(0, 1000) });
  }
});

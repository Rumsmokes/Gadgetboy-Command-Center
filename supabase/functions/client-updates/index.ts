import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type UpdateType = "repair" | "sale" | "consult";
type JsonRecord = Record<string, unknown>;

const STATUS_OPTIONS: Record<UpdateType, Record<string, string>> = {
  repair: {
    pickup_reminder: "Pickup Reminder",
    manual_update: "Send Update",
    diagnosis: "Diagnosis In Process",
    waiting_device: "Waiting on Device",
    part_ordered: "Part Ordered",
    waiting_part: "Waiting on Part Delivery",
    part_delivered: "Part Delivered",
    repair_complete: "Repair Complete",
    not_possible: "Repair Not Possible",
    repair_approval: "Repair Approval Requested",
    approval_received: "Repair Approved",
    repair_declined: "Repair Declined",
    customer_promise: "Customer Promise Scheduled",
    technician_progress: "Technician Progress",
    testing_in_progress: "Testing In Progress",
    schedule_pickup: "Pickup Scheduled",
    picked_up: "Picked Up / Ticket Closed",
    approve_storage_fee: "Storage Fee Approved",
    items_delivered: "Items Delivered",
  },
  sale: {
    pickup_reminder: "Pickup Reminder",
    manual_update: "Send Update",
    product_ordered: "Product Ordered",
    shipping_delayed: "Shipping Delay",
    product_in_shop: "Product Arrived",
    items_delivered: "Items Delivered",
  },
  consult: {
    consultation_reminder: "Consultation Reminder",
    consultation_delayed: "Consultation Schedule Change",
    consultation_confirmed: "Consultation Confirmed",
    consultation_complete: "Consultation Complete",
    manual_update: "Send Update",
  },
};

const REPAIR_STATUS: Record<string, string> = {
  diagnosis: "Diagnosis In Process",
  waiting_device: "Waiting for Device Drop-off",
  part_ordered: "Part Ordered",
  waiting_part: "Waiting on Part Delivery",
  part_delivered: "Part Delivered - Repairs Starting",
  repair_complete: "Repair Complete - Ready for Pickup",
  not_possible: "Repair Not Possible - Awaiting Pickup",
  repair_approval: "Awaiting Repair Approval",
  approval_received: "Repair In Progress",
  repair_declined: "Repair Declined - Awaiting Pickup",
  testing_in_progress: "Testing In Progress",
  schedule_pickup: "Pickup Scheduled",
  picked_up: "Picked Up",
};

const SALE_STATUS: Record<string, string> = {
  product_ordered: "Product Ordered",
  shipping_delayed: "Shipping Delayed",
  product_in_shop: "Product Arrived",
};

function json(status: number, payload: JsonRecord) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function safeString(value: unknown, maxLength = 5000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeType(value: unknown): UpdateType {
  const normalized = safeString(value, 30).toLowerCase();
  if (/^(sale|sales|invoice|inv)$/.test(normalized)) return "sale";
  if (/^(consult|consultation|appointment)$/.test(normalized)) return "consult";
  return "repair";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tableFor(type: UpdateType) {
  if (type === "sale") return "sales";
  if (type === "consult") return "calendar_events";
  return "work_orders";
}

function customerDetails(type: UpdateType, record: JsonRecord, customer: JsonRecord | null, legacyRecordId: number) {
  const source = customer || {};
  const name = [source.first_name, source.last_name].filter(Boolean).join(" ").trim()
    || safeString(record.customer_name, 200)
    || "Client";
  const email = safeString(source.email || record.customer_email, 254);
  const phone = safeString(source.phone || record.customer_phone, 80);
  const item = type === "repair"
    ? ([record.product_description, record.model].filter(Boolean).join(" - ") || safeString(record.product_category, 200) || "device")
    : type === "consult"
      ? (safeString(record.title, 200) || "consultation")
      : (safeString(record.item_description || record.category, 200) || "order");
  const order = type === "sale" ? `INV-${legacyRecordId}` : type === "consult" ? `CONS-${legacyRecordId}` : `WO-${legacyRecordId}`;
  return { name, email, phone, item, order };
}

function buildPatch(type: UpdateType, statusKey: string, statusLabel: string, estimatedDate: string, estimatedTime: string, notes: string, preserveTechNotes = false) {
  const now = new Date().toISOString();
  const manual = statusKey === "manual_update";
  const patch: JsonRecord = {
    status_updated_at: now,
    estimated_date: estimatedDate || null,
  };
  if (type === "repair" && statusKey === "technician_progress") {
    return { tech_notes: notes, last_update_note: notes, last_update_at: now };
  }
  if (!preserveTechNotes) patch.tech_notes = notes || "";
  if (type === "repair" && (statusKey === "part_ordered" || statusKey === "waiting_part")) {
    patch.parts_est_delivery = estimatedDate || null;
    patch.parts_estimated_delivery = estimatedDate || null;
  }
  if(type==='repair' && statusKey==='schedule_pickup') patch.scheduled_pickup_at=estimatedDate ? new Date(`${estimatedDate}T${estimatedTime||'12:00'}:00`).toISOString() : null;
  if(type==='repair' && (statusKey==='repair_complete'||statusKey==='not_possible'||statusKey==='repair_declined')) patch.pickup_ready_at=now;
  if(type==='repair' && statusKey==='picked_up') Object.assign(patch,{status:'closed',picked_up_at:now,client_pickup_date:now});
  if (manual) {
    patch.last_update_note = notes || statusLabel;
    patch.last_update_at = now;
  } else {
    patch.status_update = statusLabel;
  }
  if (type === "repair" && REPAIR_STATUS[statusKey]) patch.repair_status = REPAIR_STATUS[statusKey];
  if (type === "sale" && SALE_STATUS[statusKey]) patch.status = SALE_STATUS[statusKey];
  if (type === "consult" && statusKey === "consultation_delayed") {
    patch.event_date = estimatedDate;
    patch.event_time = estimatedTime;
  }
  return patch;
}

function emailCopy(details: ReturnType<typeof customerDetails>, statusKey: string, statusLabel: string, estimatedDate: string, estimatedTime: string, notes: string, responseUrl = '') {
  const manual = statusKey === "manual_update";
  const subject = manual ? `Update from GadgetBoy - ${details.order}` : `${statusLabel} - ${details.order}`;
  const updateText = manual ? (notes || statusLabel) : statusLabel;
  const dateLabel = statusKey === "consultation_delayed" ? "Proposed date" : statusKey === "customer_promise" ? "Promised date" : "Estimated date";
  const noteLabel = statusKey === "repair_approval" ? "Estimate details" : statusKey === "customer_promise" ? "Our promise" : "Technician note";
  const dateText = estimatedDate ? `\n${dateLabel}: ${estimatedDate}${estimatedTime ? ` at ${estimatedTime}` : ""}` : "";
  const noteText = !manual && notes ? `\n${noteLabel}: ${notes}` : "";
  const text = `Hi ${details.name},\n\nHere is an update for ${details.item} (${details.order}):\n\n${updateText}${dateText}${noteText}\n\nQuestions? Call (803) 708-0101 or reply to this email.\n\nGadgetBoy Repair & Retail\n2822 Devine Street, Columbia, SC 29205`;
  const actions = responseUrl ? `<div style="margin:22px 0"><p style="margin:0 0 10px;font-weight:700">Have questions/concerns? Let us know below</p><a href="${escapeHtml(responseUrl)}" style="display:inline-block;padding:13px 20px;border-radius:6px;background:#7e22ce;color:white;text-decoration:none;font-weight:bold">Click to Respond</a></div>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#18181b"><div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #d4d4d8"><div style="padding:18px 22px;background:#18181b;border-bottom:4px solid #39ff14;color:#fff"><div style="font-size:18px;font-weight:800">GADGETBOY Repair &amp; Retail</div><div style="margin-top:4px;font-size:12px;color:#d4d4d8">2822 Devine Street, Columbia, SC 29205 | (803) 708-0101</div></div><div style="padding:24px"><p style="margin-top:0">Hi <strong>${escapeHtml(details.name)}</strong>,</p><p>Here is an update for <strong>${escapeHtml(details.item)}</strong> (${escapeHtml(details.order)}).</p><div style="margin:20px 0;padding:16px;border:1px solid #a1a1aa;border-left:5px solid #8b5cf6;background:#fafafa"><div style="font-size:12px;font-weight:800;text-transform:uppercase;color:#52525b">Current update</div><div style="margin-top:6px;font-size:18px;font-weight:800">${escapeHtml(updateText)}</div>${estimatedDate ? `<div style="margin-top:10px"><strong>${dateLabel}:</strong> ${escapeHtml(estimatedDate)}${estimatedTime ? ` at ${escapeHtml(estimatedTime)}` : ""}</div>` : ""}${!manual && notes ? `<div style="margin-top:10px"><strong>${noteLabel}:</strong> ${escapeHtml(notes)}</div>` : ""}</div>${actions}<p style="font-size:13px;color:#52525b">Questions? Call (803) 708-0101 or reply to this email.</p></div></div></body></html>`;
  return { subject, text, html };
}

function smsCopy(details: ReturnType<typeof customerDetails>, statusKey: string, statusLabel: string, estimatedDate: string, estimatedTime: string, notes: string) {
  const messages: Record<string, string> = {
    pickup_reminder: `Friendly reminder: Your ${details.item} is ready for pickup whenever it is convenient for you.`,
    diagnosis: "Diagnosis is underway. Our technicians are carefully checking your device and will keep you posted.",
    waiting_device: "We are ready for the next step and are currently waiting for your device to be dropped off.",
    part_ordered: "Your repair part has been ordered. We will let you know as soon as it arrives.",
    waiting_part: "Your repair is waiting on the ordered part to arrive. We are tracking it and will keep you updated.",
    part_delivered: "Your part has arrived, and your repair is moving into the next stage.",
    repair_complete: "Great news! Your repair is complete and your device is ready for pickup.",
    not_possible: "We completed our assessment, but unfortunately the repair could not be completed.",
    repair_approval: "We have completed the estimate for your repair and need your approval before proceeding.",
    approval_received: "Your repair approval has been recorded, and we are moving forward with the next step.",
    repair_declined: "Your decision not to proceed with the repair has been recorded. We will keep the device ready for pickup.",
    customer_promise: "We have scheduled the following update or follow-up commitment for your repair.",
    testing_in_progress: "Your repair is now in testing. We are verifying proper operation before the next step.",
    product_ordered: "Your product has been ordered. We will let you know as soon as it arrives.",
    shipping_delayed: "Shipping has been delayed. We are monitoring the order and will keep you updated.",
    product_in_shop: "Great news! Your product has arrived and is ready for pickup.",
    consultation_reminder: "This is a friendly reminder about your upcoming GadgetBoy consultation.",
    consultation_delayed: "We need to adjust the scheduled time for your consultation. Please review the proposed date and reply to confirm.",
    consultation_confirmed: "Your GadgetBoy consultation is confirmed.",
    consultation_complete: "Your consultation has been completed. Thank you for working with GadgetBoy.",
  };
  const updateText = statusKey === "manual_update" ? (notes || statusLabel) : (messages[statusKey] || statusLabel);
  const dateText = estimatedDate ? `\n${statusKey === "consultation_delayed" ? "Proposed date" : "Estimated date"}: ${estimatedDate}${estimatedTime ? ` at ${estimatedTime}` : ""}` : "";
  const noteText = statusKey !== "manual_update" && notes ? `\nTechnician note: ${notes}` : "";
  return `GADGETBOY UPDATE\n\nHi ${details.name}! Here is the latest on your ${details.item}:\n\n${updateText}${dateText}${noteText}\n\nTicket: ${details.order}\nQuestions? Call us at (803) 708-0101 or email gadgetboysc@gmail.com.\n\nGadgetBoy Repair & Retail`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed." });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authorization = req.headers.get("Authorization") || "";
    if (!supabaseUrl || !publishableKey || !serviceRoleKey) throw httpError(503, "Supabase client updates are not configured.");
    if (!authorization) throw httpError(401, "Sign in before sending a client update.");

    const userClient = createClient(supabaseUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) throw httpError(401, "Your login session is no longer valid.");

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: profile, error: profileError } = await admin
      .from("staff_profiles")
      .select("shop_id,status")
      .eq("user_id", userData.user.id)
      .eq("status", "active")
      .maybeSingle();
    if (profileError || !profile?.shop_id) throw httpError(403, "This account is not active for a POS shop.");

    const body = await req.json() as JsonRecord;
    let type = normalizeType(body.recordType);
    let legacyRecordId = Number(body.recordId || 0) || 0;
    let tokenRow: JsonRecord | null = null;
    const qrToken = safeString(body.token, 220);
    if (qrToken) {
      const { data, error } = await admin
        .from("qr_status_tokens")
        .select("id,shop_id,record_type,legacy_record_id,expires_at")
        .eq("token", qrToken)
        .is("revoked_at", null)
        .maybeSingle();
      if (error || !data) throw httpError(404, "This QR link is no longer active.");
      if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) throw httpError(410, "This QR link has expired.");
      if (String(data.shop_id) !== String(profile.shop_id)) throw httpError(403, "This QR link belongs to a different shop.");
      tokenRow = data;
      type = normalizeType(data.record_type);
      legacyRecordId = Number(data.legacy_record_id || 0) || 0;
    }
    if (!legacyRecordId) throw httpError(400, "Save the ticket before sending a client update.");

    const table = tableFor(type);
    const { data: record, error: recordError } = await admin
      .from(table)
      .select("*")
      .eq("shop_id", profile.shop_id)
      .eq("legacy_id", legacyRecordId)
      .maybeSingle();
    if (recordError || !record) throw httpError(404, "The synced ticket could not be found.");

    let customer: JsonRecord | null = null;
    if (record.customer_id) {
      const response = await admin.from("customers").select("*").eq("shop_id", profile.shop_id).eq("id", record.customer_id).maybeSingle();
      customer = response.data || null;
    } else if (record.legacy_customer_id) {
      const response = await admin.from("customers").select("*").eq("shop_id", profile.shop_id).eq("legacy_id", record.legacy_customer_id).maybeSingle();
      customer = response.data || null;
    }

    const statusKey = safeString(body.statusKey, 80);
    const statusLabel = STATUS_OPTIONS[type][statusKey];
    if (!statusLabel) throw httpError(400, "That status update is not supported for this ticket.");
    const estimatedDate = safeString(body.estimatedDate, 40);
    const estimatedTime = safeString(body.estimatedTime, 40);
    const notes = safeString(body.notes, 5000);
    const preserveTechNotes = body.preserveTechNotes === true;
    if (statusKey === "manual_update" && !notes) throw httpError(400, "Enter the message you want to send to the client.");
    if (statusKey === "technician_progress" && !notes) throw httpError(400, "Enter the technician progress notes.");
    if (statusKey === "customer_promise" && (!estimatedDate || !notes)) throw httpError(400, "Enter the promise date and what was promised.");
    if (statusKey === "schedule_pickup" && (!estimatedDate || !estimatedTime)) throw httpError(400, "Enter the scheduled pickup date and time.");
    if(statusKey==='picked_up') { const remaining=Number((record.totals as JsonRecord)?.remaining || record.balance || 0); if(remaining>0 && body.managerOverride!==true) throw httpError(409,`This ticket still has a $${remaining.toFixed(2)} balance. Complete checkout or use a manager override.`); }
    if(statusKey==='approve_storage_fee'){
      const anchor=new Date(record.scheduled_pickup_at||record.pickup_ready_at||record.repair_completion_date||0).getTime();
      const days=anchor?Math.floor(Math.max(0,Date.now()-anchor)/86400000):0, fee=Math.max(0,record.scheduled_pickup_at?days:days-7)*25;
      if(fee<=0) throw httpError(409,'No storage fee is currently due.');
      const items=Array.isArray(record.items)?record.items:[];
      if(items.some((item:JsonRecord)=>safeString(item.feeType)==='storage')) throw httpError(409,'A storage fee is already on this ticket.');
      const totals=(record.totals as JsonRecord)||{}, nextTotal=Number(totals.total||0)+fee, nextRemaining=Number(totals.remaining||0)+fee;
      const {data:feeRows,error:feeError}=await admin.from(table).update({items:[...items,{id:`storage-${Date.now()}`,repair:'Storage Fee',description:`Storage Fee (${days-7} days × $25)`,labor:fee,parts:0,taxable:false,feeType:'storage'}],totals:{...totals,total:nextTotal,remaining:nextRemaining},storage_fee_reviewed_at:new Date().toISOString()}).eq('shop_id',profile.shop_id).eq('legacy_id',legacyRecordId).select('*');
      if(feeError||!feeRows?.[0]) throw httpError(500,'The storage fee could not be added.');
      return json(200,{ok:true,statusSaved:true,deliveryStatus:'internal',message:`$${fee.toFixed(2)} storage fee approved and added.`,record:feeRows[0]});
    }
    if(statusKey==='items_delivered'){
      const indexes=Array.isArray(body.itemIndexes)?body.itemIndexes.map(Number).filter(Number.isInteger):[];
      if(!indexes.length) throw httpError(400,'Select at least one delivered item.');
      if(type!=='repair'){
        const priorItems=Array.isArray(record.items)?record.items:[]; const deliveredAt=new Date().toISOString();
        const nextItems=priorItems.map((item:JsonRecord,index:number)=>indexes.includes(index)?{...item,orderStatus:'received',partStatus:'delivered',receivedAt:deliveredAt,partDeliveredAt:deliveredAt}:item);
        const ordered=nextItems.filter((item:JsonRecord)=>item.requiresOrder===true || /needed|ordered|received|delivered/i.test(safeString(item.orderStatus||item.partStatus)));
        const allDelivered=ordered.length>0&&ordered.every((item:JsonRecord)=>/received|delivered|in.?stock/i.test(safeString(item.orderStatus||item.partStatus)));
        const {data:itemRows,error:itemError}=await admin.from(table).update({items:nextItems,status:allDelivered?'Product Arrived':record.status,status_update:allDelivered?'All Products Delivered':'Some Items Delivered',status_updated_at:deliveredAt}).eq('shop_id',profile.shop_id).eq('legacy_id',legacyRecordId).select('*');
        if(itemError||!itemRows?.[0]) throw httpError(500,'Delivered items could not be saved.');
        Object.assign(record,itemRows[0]);
      }
    }
    if (statusKey === "consultation_delayed" && (!estimatedDate || !estimatedTime)) throw httpError(400, "Enter the proposed consultation date and time.");

    const details = customerDetails(type, record, customer, legacyRecordId);
    const requestedDelivery = safeString(body.deliveryMode, 20).toLowerCase();
    const deliveryMode = statusKey === "technician_progress" || requestedDelivery === "internal" ? "internal" : requestedDelivery === "text" ? "text" : "email";
    if (deliveryMode === "email" && !details.email) throw httpError(400, "The client does not have an email address on file.");
    if (deliveryMode === "text" && !details.phone) throw httpError(400, "The client does not have a phone number on file.");

    let savedRecord: JsonRecord;
    let workflowEvent: JsonRecord | null = null;
    if (type === 'repair') {
      const promisedAt = statusKey === 'customer_promise' && estimatedDate
        ? new Date(`${estimatedDate}T${estimatedTime || '12:00'}:00`).toISOString()
        : null;
      const scheduledPickupAt = statusKey === 'schedule_pickup' && estimatedDate
        ? new Date(`${estimatedDate}T${estimatedTime || '12:00'}:00`).toISOString()
        : null;
      const idempotencyKey = safeString(body.idempotencyKey, 160) || crypto.randomUUID();
      const { data: workflow, error: workflowError } = await admin.rpc('apply_repair_workflow_event', {
        p_shop_id: profile.shop_id,
        p_work_order_id: record.id,
        p_action: statusKey,
        p_payload: {
          note: notes,
          estimatedDate,
          estimatedTime,
          promisedAt,
          scheduledPickupAt,
          itemIndexes: Array.isArray(body.itemIndexes) ? body.itemIndexes : [],
          actor: safeString(userData.user.user_metadata?.display_name || userData.user.email || 'Technician', 200),
        },
        p_idempotency_key: idempotencyKey,
        p_actor_user_id: userData.user.id,
      });
      if (workflowError || !workflow?.workOrder) throw httpError(500, safeString(workflowError?.message || 'The ticket workflow could not be updated.'));
      savedRecord = workflow.workOrder as JsonRecord;
      workflowEvent = (workflow.event || null) as JsonRecord | null;
      Object.assign(record, savedRecord);
    } else {
      const { data: savedRows, error: saveError } = await admin
        .from(table)
        .update(buildPatch(type, statusKey, statusLabel, estimatedDate, estimatedTime, notes, preserveTechNotes))
        .eq("shop_id", profile.shop_id)
        .eq("legacy_id", legacyRecordId)
        .select("*");
      if (saveError || !savedRows?.[0]) throw httpError(500, "The ticket status could not be updated.");
      savedRecord = savedRows[0] as JsonRecord;
    }

    let responseUrl = '';
    if(type==='repair' && deliveryMode !== 'internal'){
      const raw=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))).map(x=>x.toString(16).padStart(2,'0')).join('');
      const pickupAction=['repair_complete','not_possible','repair_declined','pickup_reminder','schedule_pickup'].includes(statusKey);
      const allowedActions=statusKey==='repair_approval'?['approve','decline','question','add_information']:pickupAction?['confirm_pickup','request_pickup_change','question','add_information']:['question','add_information'];
      const {error:tokenInsertError}=await admin.from('client_response_tokens').insert({shop_id:profile.shop_id,work_order_id:record.id,legacy_record_id:legacyRecordId,token_hash:digest,allowed_actions:allowedActions,expires_at:new Date(Date.now()+30*86400000).toISOString()});
      if(tokenInsertError)throw httpError(500,'The secure client response link could not be created.');
      const publicAppUrl=String(Deno.env.get('PUBLIC_APP_URL')||'https://rumsmokes.github.io/Gadgetboy-Command-Center').replace(/\/+$/,'');
      responseUrl=`${publicAppUrl}/client-response.html?token=${encodeURIComponent(raw)}`;
    }
    const email = emailCopy(details, statusKey, statusLabel, estimatedDate, estimatedTime, notes, responseUrl);
    const textMessage = smsCopy(details, statusKey, statusLabel, estimatedDate, estimatedTime, notes);
    const historyRow: JsonRecord = {
      shop_id: profile.shop_id,
      qr_token_id: tokenRow?.id || null,
      record_type: type,
      legacy_record_id: legacyRecordId,
      status_key: statusKey,
      status_label: statusLabel,
      message: deliveryMode === "text" ? textMessage : (notes || null),
      estimated_date: estimatedDate || null,
      recipient_email: deliveryMode === "email" ? details.email : null,
      email_subject: deliveryMode === "email" ? email.subject : null,
      email_text: deliveryMode === "email" ? email.text : null,
      email_html: deliveryMode === "email" ? email.html : null,
      delivery_status: deliveryMode === "email" ? "pending" : "not_requested",
      delivery_attempts: 0,
      next_attempt_at: deliveryMode === "email" ? new Date().toISOString() : null,
      delivery_updated_at: new Date().toISOString(),
      created_by: userData.user.id,
    };
    const { data: history, error: historyError } = await admin.from("client_update_history").insert(historyRow).select("*").single();
    if (historyError || !history) throw httpError(500, "The update was saved, but its history entry could not be created.");

    if (deliveryMode === "internal") {
      return json(200, {
        ok: true,
        statusSaved: true,
        deliveryStatus: "internal",
        message: "Technician progress saved internally. No client message was sent.",
        record: savedRecord,
        workflowEvent,
        history,
      });
    }

    if (deliveryMode === "text") {
      return json(200, {
        ok: true,
        statusSaved: true,
        deliveryStatus: "text_prepared",
        message: "Status saved. Your messaging app is ready with the client and update filled in.",
        recipientPhone: details.phone,
        textMessage,
        record: savedRecord,
        workflowEvent,
        history,
      });
    }

    const emailResponse = await fetch(`${supabaseUrl}/functions/v1/send-pos-email`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        // Forward the already-validated staff JWT. Supabase's function gateway
        // rejects modern non-JWT service-role secrets before the downstream
        // function can authorize the request.
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "send-client-update", shopId: profile.shop_id, historyId: history.id }),
    });
    const emailResult = await emailResponse.json().catch(() => null);
    if (!emailResponse.ok || !emailResult?.ok) {
      return json(200, {
        ok: true,
        statusSaved: true,
        deliveryStatus: "queued",
        message: `Status saved. Email to ${details.email} is queued for delivery.`,
        record: savedRecord,
        workflowEvent,
        history,
      });
    }
    return json(200, {
      ok: true,
      statusSaved: true,
      deliveryStatus: "sent",
      message: `Status saved and email sent to ${details.email}.`,
      record: savedRecord,
      workflowEvent,
      history,
    });
  } catch (error) {
    const status = Number((error as Error & { status?: number })?.status || 500) || 500;
    const message = error instanceof Error ? error.message : String(error || "Client update failed.");
    console.error("client-updates failed", message);
    return json(status, { ok: false, error: message.slice(0, 1000) });
  }
});

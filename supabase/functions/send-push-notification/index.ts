import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = { 'Content-Type': 'application/json' };
const base64Url = (input: string | Uint8Array) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const pemBytes = (pem: string) => Uint8Array.from(atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, '')), char => char.charCodeAt(0));
async function firebaseAccessToken(service: any) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({ iss: service.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(service.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`))));
  const result = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${signature}` }) });
  const body = await result.json(); if (!result.ok || !body.access_token) throw new Error(body.error_description || 'Firebase authorization failed.');
  return String(body.access_token);
}

function serverSecretKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (typeof keys.default === 'string' && keys.default) return keys.default;
  } catch {
    // The request below returns a safe configuration error.
  }
  throw new Error('Supabase server key is not configured.');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: 'POST required.' }), { status: 405, headers: cors });
  try {
    const auth = req.headers.get('Authorization') || '';
    const accessToken = auth.replace(/^Bearer\s+/i, '');
    if (!accessToken) throw new Error('Authenticated staff session required.');
    const serviceKey = serverSecretKey();
    const authClient = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
    const adminClient = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey);
    const { data: identity, error: identityError } = await authClient.auth.getUser(accessToken);
    if (identityError || !identity.user) throw new Error('Authenticated staff session required.');
    const payload = await req.json(); const shopId = String(payload?.shopId || ''); const eventKey = String(payload?.eventKey || '').trim();
    if (!shopId) throw new Error('Shop scope is required.');
    if (!eventKey) throw new Error('Notification event key is required.');
    const { data: staff } = await adminClient.from('staff_profiles').select('shop_id,status').eq('user_id', identity.user.id).eq('shop_id', shopId).eq('status', 'active').maybeSingle();
    if (!staff) throw new Error('Active shop staff membership required.');
    const { error: eventError } = await adminClient.from('push_notification_events').insert({ shop_id: shopId, event_key: eventKey, created_by: identity.user.id });
    if (eventError?.code === '23505') return new Response(JSON.stringify({ ok: true, duplicate: true, delivered: 0 }), { headers: cors });
    if (eventError) throw new Error(`Could not reserve notification event: ${eventError.message}`);
    const { data: devices } = await adminClient.from('push_notification_devices').select('token').eq('shop_id', shopId).eq('enabled', true);
    const secret = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON'); if (!secret) throw new Error('Firebase push sender is not configured.');
    const service = JSON.parse(secret); const accessToken = await firebaseAccessToken(service);
    const safeData = { destination: String(payload?.destination || ''), workOrderId: payload?.workOrderId ? String(payload.workOrderId) : '', saleId: payload?.saleId ? String(payload.saleId) : '' };
    const results = await Promise.all((devices || []).map(async ({ token }) => fetch(`https://fcm.googleapis.com/v1/projects/${service.project_id}/messages:send`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { token, notification: { title: String(payload?.title || 'GadgetBoy POS'), body: String(payload?.body || 'A shop record changed.') }, data: safeData, android: { priority: 'high' } } }) })));
    return new Response(JSON.stringify({ ok: true, registered: (devices || []).length, delivered: results.filter(row => row.ok).length }), { headers: cors });
  } catch (error) { return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Push delivery failed.' }), { status: 400, headers: cors }); }
});

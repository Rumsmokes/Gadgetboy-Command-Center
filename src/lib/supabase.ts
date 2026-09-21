import { createClient } from '@supabase/supabase-js';

function readRuntimeConfig() {
  return typeof window !== 'undefined' ? window.__GB_POS_CONFIG__ : undefined;
}

export function isTestEnvironment() {
  return typeof window !== 'undefined' && ((window as any).api?.__GB_POS_TEST_ENVIRONMENT__ === true || window.__GB_POS_TEST_ENVIRONMENT__ === true);
}

export function getSupabaseRuntimeConfig() {
  if (isTestEnvironment()) return { supabaseUrl: '', supabasePublishableKey: '' };
  const runtime = readRuntimeConfig();
  const supabaseUrl = runtime?.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL || '';
  const supabasePublishableKey = runtime?.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
  return { supabaseUrl, supabasePublishableKey };
}

const { supabaseUrl, supabasePublishableKey } = getSupabaseRuntimeConfig();

if (!isTestEnvironment() && (!supabaseUrl || !supabasePublishableKey)) {
  throw new Error('Missing Supabase environment values. Check .env.local.');
}

// This client is never used in test mode: App bypasses auth and the main
// process rejects cloud work. A loopback placeholder keeps shared imports safe.
export const supabase = createClient(
  isTestEnvironment() ? 'http://127.0.0.1:54321' : supabaseUrl,
  isTestEnvironment() ? 'test-environment-no-network' : supabasePublishableKey,
);

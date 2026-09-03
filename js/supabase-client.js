// Supabase setup for cross-device run history sync — entirely optional. The app
// works fully offline/local (IndexedDB) without this configured at all; nothing
// here changes that until it's filled in AND actually wired into app.js.
//
// Fill these in after creating your Supabase project (see the setup steps you
// were given). Use the "Publishable key" from Project Settings -> API Keys —
// not the "Secret key" (that one is server-only and must never appear in
// client-side code like this file).
const SUPABASE_URL = 'https://fdcznybsvihxzcgwqaqa.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6UO_AJ26DmgWVmAjPoyhZw_FrnlzrE8';

export const supabase =
  SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
    : null;

export function isSupabaseConfigured() {
  return supabase !== null;
}

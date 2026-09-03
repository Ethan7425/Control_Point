// Thin wrapper around Supabase Auth — email + 6-digit PIN (stored as Supabase's
// "password"; 6 is the platform's hard floor, so that's what we use). Session
// persistence, token refresh, etc. are all handled by the supabase-js client
// itself; this module just gives app.js a small, named surface instead of
// calling supabase.auth.* directly everywhere.

import { supabase } from './supabase-client.js';

export function isAuthAvailable() {
  return supabase !== null;
}

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(callback) {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((event, session) => callback(event, session));
  return () => data.subscription.unsubscribe();
}

export async function signUp(email, pin) {
  const { data, error } = await supabase.auth.signUp({ email, password: pin });
  return { user: data?.user ?? null, session: data?.session ?? null, error };
}

export async function signIn(email, pin) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pin });
  return { user: data?.user ?? null, session: data?.session ?? null, error };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

// Sends a reset-password email with a link back into this app; the app must be
// listening for the PASSWORD_RECOVERY auth event to show a "set new PIN" form
// when the user follows that link (see onAuthStateChange usage in app.js).
export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  return { error };
}

export async function updatePin(newPin) {
  const { error } = await supabase.auth.updateUser({ password: newPin });
  return { error };
}

export async function updateDisplayName(name) {
  const { data, error } = await supabase.auth.updateUser({ data: { display_name: name } });
  return { user: data?.user ?? null, error };
}

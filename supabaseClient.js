import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

// Service role client for privileged operations
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Anon client for regular operations
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Per-request user-scoped client so RLS uses the caller's JWT
export function createUserClient(userJwt) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: { headers: { Authorization: `Bearer ${userJwt}` } },
      auth: { persistSession: false }
    }
  );
}

// JWT verification utility
export async function verifyJWT(token) {
  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) {
      return { valid: false, user: null, error };
    }
    return { valid: true, user, error: null };
  } catch (err) {
    return { valid: false, user: null, error: err.message || null };
  }
}
    
// Which datastore is configured. Read once at module load, exactly as before
// the adapters were split: a later mutation of process.env must not flip the
// market repository from Supabase to the in-memory store mid-process.
import "server-only";

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const isProdDatastore = Boolean(supabaseUrl && supabaseServiceKey);

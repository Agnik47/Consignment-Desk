import { createClient } from "@supabase/supabase-js";

export interface ItemRow {
  id: string;
  captured_at: string;
  image_path: string | null;
  image_url: string | null;
  category: string | null;
  identified_as: string | null;
  condition: unknown;
  grader_confidence: number | null;
  created_at: string;
}

let client: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  // Service-role key, used server-side only — the Jetson writes with its own
  // key, this process only ever reads. Never sent to the browser.
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/** Most recent item the Jetson pipeline captured and graded, or null if Supabase isn't configured or has no rows yet. */
export async function getLatestItem(): Promise<ItemRow | null> {
  const supabase = getClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("items")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Supabase items query failed: ${error.message}`);
  return (data as ItemRow | null) ?? null;
}

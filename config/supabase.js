const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

async function getSetting(key) {
  const { data } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", key)
    .single();
  return data?.value || null;
}

module.exports = { supabase, getSetting };

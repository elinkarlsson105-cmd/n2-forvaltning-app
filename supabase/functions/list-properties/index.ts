// Supabase Edge Function: list-properties
//
// Publik, oskyddad funktion (ingen inloggning krävs) som ENDAST returnerar
// namn och id för bostadsrättsföreningarna — inget annat. Används av det
// publika felanmälningsformuläret för att fylla i rullistan.
//
// Säkerheten sitter i att funktionen medvetet bara plockar ut name/id och
// aldrig skickar med resten av datan (kontakter, priser, ärenden osv.),
// trots att den läser hela raden med hjälp av service role-nyckeln.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Service role-nyckeln injiceras automatiskt av Supabase i alla Edge
    // Functions — behöver aldrig sättas manuellt som secret.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data, error } = await supabase
      .from("fonsterkort_state")
      .select("data")
      .eq("id", "shared")
      .maybeSingle();

    if (error || !data) {
      throw new Error(error?.message || "Kunde inte hämta data");
    }

    const properties = (data.data?.properties || []).map((p: any) => ({
      id: p.id,
      name: p.name,
    }));

    return new Response(JSON.stringify({ properties }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("list-properties error:", err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

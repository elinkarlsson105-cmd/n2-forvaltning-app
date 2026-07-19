// Supabase Edge Function: submit-felanmalan
//
// Publik, oskyddad funktion (ingen inloggning krävs) som tar emot ett
// inskickat formulär och lägger in det i appens delade journal — antingen
// som en felanmälan (Felanmälan-fliken) eller som ett övrigt ärende
// (Ärenden-fliken), beroende på vilken kategori boende valt.
//
// Boende/besökare får ALDRIG läsbehörighet till databasen själva — bara
// den här smala, specifika funktionen (som i sin tur använder service
// role-nyckeln bakom kulisserna) får skriva in en ny post.

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const {
      propertyId,
      category, // "felanmalan" (standard) | "ovrigt"
      title,
      description,
      reporterName,
      reporterContact,
      reporterAddress,
      honeypot,
    } = await req.json();

    // Enkel robotfälla: ett dolt fält som riktiga besökare aldrig fyller i.
    if (honeypot) {
      // Låtsas att allt gick bra så att boten inte lär sig något, men gör inget.
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const missing =
      !propertyId ||
      !category ||
      (category !== "felanmalan" && category !== "ovrigt") ||
      !title ||
      !String(title).trim() ||
      !reporterAddress ||
      !String(reporterAddress).trim() ||
      !reporterName ||
      !String(reporterName).trim() ||
      !reporterContact ||
      !String(reporterContact).trim() ||
      !description ||
      !String(description).trim();

    if (missing) {
      return new Response(
        JSON.stringify({ error: "Kategori, namn, adress, telefonnummer och beskrivning krävs." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isOvrigt = category === "ovrigt";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: row, error: fetchError } = await supabase
      .from("fonsterkort_state")
      .select("data")
      .eq("id", "shared")
      .maybeSingle();

    if (fetchError || !row) {
      throw new Error(fetchError?.message || "Kunde inte läsa nuvarande data");
    }

    const state = row.data;

    // Bekräfta att föreningen faktiskt finns, så man inte kan skicka in
    // ogiltiga property-id:n.
    const propertyExists = (state.properties || []).some((p: any) => p.id === propertyId);
    if (!propertyExists) {
      return new Response(JSON.stringify({ error: "Okänd bostadsrättsförening." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const commonFields = {
      title: String(title).trim().slice(0, 200),
      description: String(description || "").trim().slice(0, 2000),
      reporterName: String(reporterName || "").trim().slice(0, 100),
      reporterContact: String(reporterContact || "").trim().slice(0, 100),
      reporterAddress: String(reporterAddress || "").trim().slice(0, 150),
      propertyId,
    };

    let newState;
    let responseExtra: Record<string, unknown> = {};

    if (isOvrigt) {
      // Övrigt ärende → läggs i "issues", samma sak som Ärenden-fliken
      // använder för manuellt skapade ärenden.
      const newIssue = {
        id: crypto.randomUUID(),
        ...commonFields,
        priority: "Normal",
        status: "Öppen",
        reportedBy: "Boende (webbformulär)",
        reportedAt: todayISO(),
      };
      newState = {
        ...state,
        issues: [...(state.issues || []), newIssue],
      };
    } else {
      // Felanmälan → läggs som en order i "billableOrders", samma modell
      // som Felanmälan-fliken använder.
      const orderNumber = state.nextOrderNumber || 1;
      const newOrder = {
        id: crypto.randomUUID(),
        type: "felanmalan",
        orderNumber,
        ...commonFields,
        priceCategory: "FA",
        reportedDate: todayISO(),
        status: "Pågår",
        createdAt: todayISO(),
        createdBy: "Boende (webbformulär)",
        completedAt: null,
        billCount: 0,
        billInvoicedInBasisId: null,
        cancelled: false,
        cancelledAt: null,
        cancelledReason: null,
        cancelledBy: null,
      };
      newState = {
        ...state,
        billableOrders: [...(state.billableOrders || []), newOrder],
        nextOrderNumber: orderNumber + 1,
      };
      responseExtra = { orderNumber };
    }

    const { error: updateError } = await supabase
      .from("fonsterkort_state")
      .update({ data: newState, updated_at: new Date().toISOString() })
      .eq("id", "shared");

    if (updateError) {
      throw new Error(updateError.message);
    }

    return new Response(JSON.stringify({ success: true, ...responseExtra }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("submit-felanmalan error:", err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

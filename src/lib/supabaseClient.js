import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Detta gör felet tydligt i webbläsarens konsol istället för en kryptisk krasch,
  // om .env-filen eller Vercels miljövariabler saknas.
  console.error(
    "Saknar VITE_SUPABASE_URL eller VITE_SUPABASE_ANON_KEY. Kontrollera .env (lokalt) eller Vercels miljövariabler (i produktion)."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

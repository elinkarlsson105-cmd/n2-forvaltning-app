-- Fönsterkort — Supabase-schema
-- Kör detta i Supabase Dashboard → SQL Editor → "New query" → klistra in → Run

create table if not exists fonsterkort_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Aktivera Row Level Security (rekommenderas alltid av Supabase)
alter table fonsterkort_state enable row level security;

-- Tillåt alla att läsa och skriva raden med id = 'shared'.
-- Det här matchar hur appen fungerar idag: hela teamet delar samma journal
-- utan separat inloggning. Vill ni senare kräva inloggning per användare,
-- byt ut dessa policys mot regler baserade på auth.uid().
create policy "Alla kan läsa delad journal"
  on fonsterkort_state for select
  using (true);

create policy "Alla kan skriva delad journal"
  on fonsterkort_state for insert
  with check (true);

create policy "Alla kan uppdatera delad journal"
  on fonsterkort_state for update
  using (true);

-- Skapa startraden som appen läser/skriver till
insert into fonsterkort_state (id, data)
values ('shared', '{
  "properties": [],
  "tasks": [],
  "checklistTemplates": [],
  "checklistRuns": [],
  "issues": [],
  "billableOrders": [],
  "billableTimeEntries": [],
  "invoiceBasis": []
}'::jsonb)
on conflict (id) do nothing;

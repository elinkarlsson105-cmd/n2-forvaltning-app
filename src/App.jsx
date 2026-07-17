import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "./lib/supabaseClient";

/* ------------------------------------------------------------------ */
/*  Fönsterkort — planeringsverktyg för fastighetsskötare              */
/*  Design: besiktningsprotokoll / stämpelkort som visuell metafor.    */
/*  Varje återkommande uppgift är ett "kort" som stämplas när det är   */
/*  utfört — precis som de fysiska besiktningskorten man ser i         */
/*  hissar och pannrum.                                                */
/*                                                                      */
/*  Data lagras i Supabase (Postgres) i en delad rad (id="shared").    */
/*  Ändringar synkas i realtid mellan alla som har appen öppen.        */
/* ------------------------------------------------------------------ */

const ROW_ID = "shared";
const TABLE = "fonsterkort_state";

const CATEGORIES = ["Snöröjning", "Filterbyte", "Gräsklippning", "Brandskydd", "VVS", "El", "Städ", "Övrigt"];
const PRIORITIES = ["Låg", "Normal", "Akut"];
const STATUSES = ["Öppen", "Pågår", "Klar"];
const CONTACT_ROLES = ["Ansvarig förvaltare", "Styrelseordförande", "Styrelseledamot", "Ekonomi", "Jour", "Övrig"];

const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const fmtDate = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("sv-SE", { day: "numeric", month: "short" });

const seedState = () => ({
  properties: [
    {
      id: uid(),
      name: "Kvarngatan 4",
      address: "Kvarngatan 4, 112 20 Stockholm",
      notes: "",
      contacts: [],
    },
    {
      id: uid(),
      name: "Ekbacken 12",
      address: "Ekbacken 12, 141 41 Huddinge",
      notes: "",
      contacts: [],
    },
  ],
  tasks: [],
  checklistTemplates: [],
  checklistRuns: [],
  issues: [],
  billableOrders: [],
  billableTimeEntries: [],
  invoiceBasis: [],
});

const normalize = (loaded) => ({
  ...seedState(),
  ...loaded,
  billableOrders: loaded.billableOrders || [],
  billableTimeEntries: loaded.billableTimeEntries || [],
  invoiceBasis: loaded.invoiceBasis || [],
});

/* ------------------------------ storage (Supabase) ------------------------------ */

function useAppState() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [pendingRetry, setPendingRetry] = useState(null);
  const [lastSavedAt, setLastSavedAt] = useState(null);

  // Håller koll på det senaste vi själva sparade, så vi inte skriver över
  // vår egen input när realtidsuppdateringen studsar tillbaka.
  const lastWrittenJson = useRef(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data, error: fetchError } = await supabase
          .from(TABLE)
          .select("data")
          .eq("id", ROW_ID)
          .maybeSingle();

        if (fetchError) throw fetchError;

        if (!data) {
          // Ingen rad ännu — skapa startdata (bör normalt redan finnas via SQL-schemat).
          const seed = seedState();
          const { error: insertError } = await supabase
            .from(TABLE)
            .insert({ id: ROW_ID, data: seed });
          if (insertError) throw insertError;
          if (!cancelled) setState(seed);
        } else {
          if (!cancelled) setState(normalize(data.data));
        }
      } catch (err) {
        console.error("Kunde inte hämta data från Supabase:", err);
        if (!cancelled) {
          setError(
            "Kunde inte hämta data från databasen. Kontrollera internetanslutningen, eller att .env/miljövariablerna är korrekt ifyllda."
          );
          setState(seedState());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // Realtidsprenumeration: när någon annan i teamet sparar en ändring,
    // uppdateras vyn automatiskt utan att man behöver ladda om sidan.
    const channel = supabase
      .channel("fonsterkort-state-changes")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: TABLE, filter: `id=eq.${ROW_ID}` },
        (payload) => {
          const incomingJson = JSON.stringify(payload.new.data);
          if (incomingJson === lastWrittenJson.current) return; // det var vår egen skrivning
          setState(normalize(payload.new.data));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  const attemptSave = useCallback(async (next, isRetry) => {
    setSaving(true);
    try {
      const json = JSON.stringify(next);
      lastWrittenJson.current = JSON.stringify(next); // matchar formatet Supabase skickar tillbaka
      const { error: saveError } = await supabase
        .from(TABLE)
        .update({ data: next, updated_at: new Date().toISOString() })
        .eq("id", ROW_ID);
      if (saveError) throw saveError;
      setError(null);
      setPendingRetry(null);
      setLastSavedAt(new Date());
    } catch (err) {
      console.error("Kunde inte spara till Supabase:", err);
      if (!isRetry) {
        await new Promise((r) => setTimeout(r, 800));
        return attemptSave(next, true);
      }
      setError(
        "Kunde inte spara just nu (kontrollera internetanslutning). Ändringen finns kvar i vyn — tryck på \"Försök spara igen\"."
      );
      setPendingRetry(() => () => attemptSave(next, false));
    } finally {
      setSaving(false);
    }
  }, []);

  const persist = useCallback(
    (next) => {
      setState(next);
      attemptSave(next, false);
    },
    [attemptSave]
  );

  const retry = useCallback(() => {
    if (pendingRetry) pendingRetry();
  }, [pendingRetry]);

  return { state, setState: persist, loading, saving, error, retry, lastSavedAt };
}

/* ------------------------------ shell ------------------------------ */

const FONT_IMPORT = `
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap');
`;

export default function App() {
  const { state, setState, loading, saving, error, retry, lastSavedAt } = useAppState();
  const [propertyId, setPropertyId] = useState("all");
  const [name, setName] = useState("");
  const [tab, setTab] = useState("oversikt");
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 2600);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const notify = (msg) => setToast(msg);

  if (loading || !state) {
    return (
      <div style={S.loadingScreen}>
        <style>{FONT_IMPORT}</style>
        <div style={S.stampSpin} />
        <div style={{ fontFamily: "Inter, sans-serif", color: "#8a8578", marginTop: 14 }}>
          Laddar journalen…
        </div>
      </div>
    );
  }

  const properties = state.properties;
  const scopedProps =
    propertyId === "all" ? properties : properties.filter((p) => p.id === propertyId);

  const tabs = [
    { id: "oversikt", label: "Översikt" },
    { id: "fastigheter", label: "Fastigheter" },
    { id: "uppgifter", label: "Uppgifter" },
    { id: "checklistor", label: "Checklistor" },
    { id: "arenden", label: "Ärenden" },
    { id: "debitering", label: "Debitering" },
    { id: "kalender", label: "Kalender" },
    { id: "backup", label: "Backup" },
  ];

  return (
    <div style={S.app}>
      <style>{`${FONT_IMPORT}
        * { box-sizing: border-box; }
        ::selection { background: #EA5B0C; color: #fff; }
        button { font-family: inherit; cursor: pointer; }
        input, select, textarea { font-family: inherit; }
        .fk-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .fk-scroll::-webkit-scrollbar-thumb { background: #C9C4B7; border-radius: 4px; }
        @keyframes fk-spin { to { transform: rotate(360deg); } }
        @keyframes fk-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .fk-tab-btn:focus-visible, .fk-btn:focus-visible, .fk-input:focus-visible { outline: 2px solid #EA5B0C; outline-offset: 2px; }
        @media print {
          body * { visibility: hidden; }
          .fk-print-area, .fk-print-area * { visibility: visible; }
          .fk-print-area { position: fixed; top: 0; left: 0; width: 100%; padding: 24px; background: #fff; }
          .fk-no-print { display: none !important; }
        }
      `}</style>

      <Header
        properties={properties}
        propertyId={propertyId}
        setPropertyId={setPropertyId}
        name={name}
        setName={setName}
        saving={saving}
        lastSavedAt={lastSavedAt}
      />

      <nav style={S.tabRow} className="fk-scroll">
        {tabs.map((t) => (
          <button
            key={t.id}
            className="fk-tab-btn"
            onClick={() => setTab(t.id)}
            style={{ ...S.tabBtn, ...(tab === t.id ? S.tabBtnActive : {}) }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main style={S.main} className="fk-scroll">
        {tab === "oversikt" && (
          <Oversikt state={state} scopedProps={scopedProps} setTab={setTab} />
        )}
        {tab === "fastigheter" && (
          <Fastigheter
            state={state}
            setState={setState}
            notify={notify}
            onSelectProperty={setPropertyId}
          />
        )}
        {tab === "uppgifter" && (
          <Uppgifter
            state={state}
            setState={setState}
            scopedProps={scopedProps}
            allProperties={properties}
            actor={name}
            notify={notify}
          />
        )}
        {tab === "checklistor" && (
          <Checklistor
            state={state}
            setState={setState}
            scopedProps={scopedProps}
            allProperties={properties}
            actor={name}
            notify={notify}
          />
        )}
        {tab === "arenden" && (
          <Arenden
            state={state}
            setState={setState}
            scopedProps={scopedProps}
            allProperties={properties}
            actor={name}
            notify={notify}
          />
        )}
        {tab === "debitering" && (
          <Debitering
            state={state}
            setState={setState}
            scopedProps={scopedProps}
            allProperties={properties}
            actor={name}
            notify={notify}
          />
        )}
        {tab === "kalender" && <Kalender state={state} scopedProps={scopedProps} />}
        {tab === "backup" && (
          <Backup state={state} setState={setState} notify={notify} lastSavedAt={lastSavedAt} />
        )}
      </main>

      {error && (
        <div style={S.errorBar}>
          {error}
          <button onClick={retry} style={S.retryBtn}>Försök spara igen</button>
        </div>
      )}
      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  );
}

/* ------------------------------ header ------------------------------ */

function Header({ properties, propertyId, setPropertyId, name, setName, saving, lastSavedAt }) {
  const savedLabel = saving
    ? "sparar…"
    : lastSavedAt
    ? `sparat ${lastSavedAt.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`
    : "fastighetsjournal";
  return (
    <header style={S.header}>
      <div style={S.headerLeft}>
        <div style={S.stampMark}>N2</div>
        <div>
          <div style={S.title}>N2 Förvaltning</div>
          <div style={S.subtitle}>{savedLabel}</div>
        </div>
      </div>
      <div style={S.headerRight}>
        <select
          className="fk-input"
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          style={S.selectHeader}
        >
          <option value="all">Alla fastigheter</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="fk-input"
          placeholder="Ditt namn"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={S.nameInput}
        />
      </div>
    </header>
  );
}

/* ------------------------------ fastigheter ------------------------------ */

function Fastigheter({ state, setState, notify, onSelectProperty }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const startAdd = () => {
    setEditingId(null);
    setShowForm(true);
  };

  const startEdit = (p) => {
    setEditingId(p.id);
    setShowForm(true);
  };

  const saveProperty = (payload) => {
    if (editingId) {
      setState({
        ...state,
        properties: state.properties.map((p) => (p.id === editingId ? { ...p, ...payload } : p)),
      });
      notify("Fastighet uppdaterad");
    } else {
      const newProp = { id: uid(), ...payload };
      setState({ ...state, properties: [...state.properties, newProp] });
      onSelectProperty(newProp.id);
      notify("Fastighet tillagd");
    }
    setShowForm(false);
    setEditingId(null);
  };

  const removeProperty = (id) => {
    const orphanOrderIds = new Set(
      (state.billableOrders || []).filter((o) => o.propertyId === id).map((o) => o.id)
    );
    setState({
      ...state,
      properties: state.properties.filter((p) => p.id !== id),
      tasks: state.tasks.filter((t) => t.propertyId !== id),
      checklistTemplates: state.checklistTemplates.filter((c) => c.propertyId !== id),
      checklistRuns: state.checklistRuns.filter((r) => r.propertyId !== id),
      issues: state.issues.filter((i) => i.propertyId !== id),
      billableOrders: (state.billableOrders || []).filter((o) => o.propertyId !== id),
      billableTimeEntries: (state.billableTimeEntries || []).filter((e) => !orphanOrderIds.has(e.orderId)),
      invoiceBasis: (state.invoiceBasis || []).filter((b) => b.propertyId !== id),
    });
    if (editingId === id) {
      setShowForm(false);
      setEditingId(null);
    }
  };

  const editingProperty = editingId ? state.properties.find((p) => p.id === editingId) : null;

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.sectionHead}>
        <h2 style={S.h2}>Fastigheter</h2>
        <button style={S.primaryBtn} className="fk-btn" onClick={startAdd}>
          {showForm && !editingId ? "Avbryt" : "+ Ny fastighet"}
        </button>
      </div>

      {showForm && (
        <PropertyForm
          key={editingId || "new"}
          initial={editingProperty}
          onSubmit={saveProperty}
          onCancel={() => {
            setShowForm(false);
            setEditingId(null);
          }}
        />
      )}

      {state.properties.length === 0 ? (
        <EmptyNote text="Inga fastigheter registrerade ännu." />
      ) : (
        <div style={S.checklistStack}>
          {state.properties.map((p) => {
            const expanded = expandedId === p.id;
            const contacts = p.contacts || [];
            return (
              <div key={p.id} style={S.checklistCard}>
                <div style={S.checklistHead}>
                  <div>
                    <div style={S.taskCardTitle}>{p.name}</div>
                    <div style={S.taskCardProp}>{p.address || "Ingen adress angiven"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={S.stampBtn} className="fk-btn" onClick={() => startEdit(p)}>
                      Redigera
                    </button>
                    <button style={S.miniDelete} onClick={() => removeProperty(p.id)} aria-label="Ta bort fastighet">×</button>
                  </div>
                </div>

                {contacts.length > 0 && (
                  <div style={S.runBox}>
                    {contacts.map((c) => (
                      <div key={c.id} style={S.contactRow}>
                        <span style={S.contactRole}>{c.role}</span>
                        <span style={S.contactName}>{c.name}</span>
                        <span style={S.rowSub}>
                          {[c.phone, c.email].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {p.notes && (
                  <div style={S.historyRow}>
                    <button
                      onClick={() => setExpandedId(expanded ? null : p.id)}
                      style={S.linkBtn}
                    >
                      {expanded ? "Dölj anteckningar" : "Visa anteckningar"}
                    </button>
                    {expanded && <div style={{ ...S.rowSub, marginTop: 6, whiteSpace: "pre-wrap" }}>{p.notes}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PropertyForm({ initial, onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [address, setAddress] = useState(initial?.address || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [contacts, setContacts] = useState(
    initial?.contacts?.length ? initial.contacts : [{ id: uid(), role: CONTACT_ROLES[0], name: "", phone: "", email: "" }]
  );

  const updateContact = (id, field, value) => {
    setContacts((cs) => cs.map((c) => (c.id === id ? { ...c, [field]: value } : c)));
  };

  const addContactRow = () => {
    setContacts((cs) => [...cs, { id: uid(), role: CONTACT_ROLES[0], name: "", phone: "", email: "" }]);
  };

  const removeContactRow = (id) => {
    setContacts((cs) => cs.filter((c) => c.id !== id));
  };

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    const cleanContacts = contacts.filter((c) => c.name.trim() || c.phone.trim() || c.email.trim());
    onSubmit({ name: name.trim(), address: address.trim(), notes: notes.trim(), contacts: cleanContacts });
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.formRow}>
        <label style={S.label}>
          Fastighetsnamn
          <input className="fk-input" style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="t.ex. Kvarngatan 4" required />
        </label>
        <label style={S.label}>
          Adress
          <input className="fk-input" style={S.input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Gatuadress, postnr, ort" />
        </label>
      </div>

      <div>
        <div style={{ ...S.label, marginBottom: 8 }}>Kontaktuppgifter (styrelse, förvaltare m.fl.)</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {contacts.map((c) => (
            <div key={c.id} style={S.contactFormRow}>
              <select
                className="fk-input"
                style={{ ...S.input, flex: "0 0 170px" }}
                value={c.role}
                onChange={(e) => updateContact(c.id, "role", e.target.value)}
              >
                {CONTACT_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <input
                className="fk-input"
                style={{ ...S.input, flex: 1 }}
                placeholder="Namn"
                value={c.name}
                onChange={(e) => updateContact(c.id, "name", e.target.value)}
              />
              <input
                className="fk-input"
                style={{ ...S.input, flex: 1 }}
                placeholder="Telefon"
                value={c.phone}
                onChange={(e) => updateContact(c.id, "phone", e.target.value)}
              />
              <input
                className="fk-input"
                style={{ ...S.input, flex: 1 }}
                placeholder="E-post"
                value={c.email}
                onChange={(e) => updateContact(c.id, "email", e.target.value)}
              />
              <button type="button" onClick={() => removeContactRow(c.id)} style={S.miniDelete} aria-label="Ta bort kontakt">×</button>
            </div>
          ))}
        </div>
        <button type="button" onClick={addContactRow} style={S.linkBtn}>+ Lägg till kontakt</button>
      </div>

      <label style={S.label}>
        Övriga anteckningar
        <textarea
          className="fk-input"
          style={{ ...S.input, height: 80, resize: "vertical" }}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Portkoder, larmkoder, avtalsdetaljer m.m."
        />
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" style={S.primaryBtn} className="fk-btn">Spara fastighet</button>
        <button type="button" onClick={onCancel} style={S.secondaryBtn} className="fk-btn">Avbryt</button>
      </div>
    </form>
  );
}

/* ------------------------------ översikt ------------------------------ */


function Oversikt({ state, scopedProps, setTab }) {
  const ids = new Set(scopedProps.map((p) => p.id));
  const tasks = state.tasks.filter((t) => ids.has(t.propertyId));
  const issues = state.issues.filter((i) => ids.has(i.propertyId));
  const today = todayISO();

  const overdue = tasks.filter((t) => t.nextDue < today);
  const dueSoon = tasks.filter((t) => t.nextDue >= today && daysBetween(today, t.nextDue) <= 7);
  const openIssues = issues.filter((i) => i.status !== "Klar");
  const acuteIssues = openIssues.filter((i) => i.priority === "Akut");

  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.statGrid}>
        <StatCard
          label="Försenade uppgifter"
          value={overdue.length}
          tone={overdue.length ? "warn" : "ok"}
          onClick={() => setTab("uppgifter")}
        />
        <StatCard
          label="Inom 7 dagar"
          value={dueSoon.length}
          tone="accent"
          onClick={() => setTab("uppgifter")}
        />
        <StatCard
          label="Öppna ärenden"
          value={openIssues.length}
          tone={acuteIssues.length ? "warn" : "neutral"}
          onClick={() => setTab("arenden")}
        />
        <StatCard
          label="Fastigheter"
          value={scopedProps.length}
          tone="neutral"
          onClick={() => setTab("uppgifter")}
        />
      </div>

      <div style={S.twoCol}>
        <section style={S.panel}>
          <h3 style={S.panelTitle}>Försenat & nära förfall</h3>
          {overdue.length + dueSoon.length === 0 ? (
            <EmptyNote text="Inget att stämpla just nu. Bra läge." />
          ) : (
            <ul style={S.plainList}>
              {[...overdue, ...dueSoon].slice(0, 8).map((t) => (
                <li key={t.id} style={S.rowItem}>
                  <span style={{ ...S.dot, background: t.nextDue < today ? "#C4171C" : "#EA5B0C" }} />
                  <span style={{ flex: 1 }}>
                    <div style={S.rowTitle}>{t.title}</div>
                    <div style={S.rowSub}>
                      {propName(t.propertyId)} · förfaller {fmtDate(t.nextDue)}
                    </div>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section style={S.panel}>
          <h3 style={S.panelTitle}>Akuta & öppna ärenden</h3>
          {openIssues.length === 0 ? (
            <EmptyNote text="Inga öppna ärenden." />
          ) : (
            <ul style={S.plainList}>
              {openIssues
                .slice()
                .sort((a, b) => (a.priority === "Akut" ? -1 : 1))
                .slice(0, 8)
                .map((i) => (
                  <li key={i.id} style={S.rowItem}>
                    <span
                      style={{
                        ...S.dot,
                        background: i.priority === "Akut" ? "#C4171C" : "#8a8578",
                      }}
                    />
                    <span style={{ flex: 1 }}>
                      <div style={S.rowTitle}>{i.title}</div>
                      <div style={S.rowSub}>
                        {propName(i.propertyId)} · {i.status}
                      </div>
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone, onClick }) {
  const toneColor = { warn: "#C4171C", accent: "#EA5B0C", ok: "#2B6E5E", neutral: "#1C2321" }[tone];
  return (
    <button onClick={onClick} style={S.statCard} className="fk-btn">
      <div style={{ ...S.statValue, color: toneColor }}>{value}</div>
      <div style={S.statLabel}>{label}</div>
    </button>
  );
}

function EmptyNote({ text }) {
  return <div style={S.emptyNote}>{text}</div>;
}

/* ------------------------------ uppgifter ------------------------------ */

function Uppgifter({ state, setState, scopedProps, allProperties, actor, notify }) {
  const [showForm, setShowForm] = useState(false);
  const ids = new Set(scopedProps.map((p) => p.id));
  const today = todayISO();

  const tasks = state.tasks
    .filter((t) => ids.has(t.propertyId))
    .sort((a, b) => (a.nextDue < b.nextDue ? -1 : 1));

  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";

  const markDone = (task) => {
    const nextDue = addDays(today, task.intervalDays);
    const nextTasks = state.tasks.map((t) =>
      t.id === task.id ? { ...t, lastDone: today, lastDoneBy: actor || "Okänd", nextDue } : t
    );
    setState({ ...state, tasks: nextTasks });
    notify(`${task.title} stämplad klar · nästa ${fmtDate(nextDue)}`);
  };

  const removeTask = (id) => setState({ ...state, tasks: state.tasks.filter((t) => t.id !== id) });

  const addTask = (payload) => {
    const nextDue = addDays(today, 0);
    const newTask = { id: uid(), ...payload, lastDone: null, lastDoneBy: null, nextDue: addDays(today, payload.intervalDays) };
    setState({ ...state, tasks: [...state.tasks, newTask] });
    setShowForm(false);
  };

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.sectionHead}>
        <h2 style={S.h2}>Återkommande uppgifter</h2>
        <button style={S.primaryBtn} className="fk-btn" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Avbryt" : "+ Ny uppgift"}
        </button>
      </div>

      {showForm && (
        <TaskForm
          properties={allProperties}
          defaultPropertyId={scopedProps[0]?.id}
          onSubmit={addTask}
        />
      )}

      {tasks.length === 0 ? (
        <EmptyNote text="Inga uppgifter ännu. Lägg till återkommande skötsel, t.ex. snöröjning eller filterbyte." />
      ) : (
        <div style={S.cardGrid}>
          {tasks.map((t) => {
            const overdue = t.nextDue < today;
            const dueSoon = !overdue && daysBetween(today, t.nextDue) <= 7;
            return (
              <div key={t.id} style={{ ...S.taskCard, borderColor: overdue ? "#C4171C" : "#C9C4B7" }}>
                <div style={S.taskCardTop}>
                  <span style={S.categoryTag}>{t.category}</span>
                  <button
                    onClick={() => removeTask(t.id)}
                    aria-label="Ta bort uppgift"
                    style={S.miniDelete}
                  >
                    ×
                  </button>
                </div>
                <div style={S.taskCardTitle}>{t.title}</div>
                <div style={S.taskCardProp}>{propName(t.propertyId)}</div>
                <div style={S.taskCardMeta}>
                  Var {t.intervalDays}:e dag
                  {t.lastDone && <> · senast {fmtDate(t.lastDone)} av {t.lastDoneBy}</>}
                </div>
                <div style={S.taskCardFooter}>
                  <StampBadge dueDate={t.nextDue} overdue={overdue} dueSoon={dueSoon} />
                  <button style={S.stampBtn} className="fk-btn" onClick={() => markDone(t)}>
                    Stämpla klar
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StampBadge({ dueDate, overdue, dueSoon }) {
  const color = overdue ? "#C4171C" : dueSoon ? "#EA5B0C" : "#2B6E5E";
  return (
    <div style={{ ...S.stampBadge, borderColor: color, color }}>
      <div style={S.stampBadgeLabel}>{overdue ? "FÖRSENAD" : "NÄSTA"}</div>
      <div style={S.stampBadgeDate}>{fmtDate(dueDate)}</div>
    </div>
  );
}

function TaskForm({ properties, defaultPropertyId, onSubmit }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [propertyId, setPropertyId] = useState(defaultPropertyId || properties[0]?.id);
  const [intervalDays, setIntervalDays] = useState(30);

  const submit = (e) => {
    e.preventDefault();
    if (!title.trim() || !propertyId) return;
    onSubmit({ title: title.trim(), category, propertyId, intervalDays: Number(intervalDays) || 30 });
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.formRow}>
        <label style={S.label}>
          Uppgift
          <input
            className="fk-input"
            style={S.input}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="t.ex. Skotta entré"
            required
          />
        </label>
        <label style={S.label}>
          Fastighet
          <select className="fk-input" style={S.input} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={S.formRow}>
        <label style={S.label}>
          Kategori
          <select className="fk-input" style={S.input} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label style={S.label}>
          Intervall (dagar)
          <input
            className="fk-input"
            style={S.input}
            type="number"
            min="1"
            value={intervalDays}
            onChange={(e) => setIntervalDays(e.target.value)}
          />
        </label>
      </div>
      <button type="submit" style={S.primaryBtn} className="fk-btn">Spara uppgift</button>
    </form>
  );
}

/* ------------------------------ checklistor ------------------------------ */

function Checklistor({ state, setState, scopedProps, allProperties, actor, notify }) {
  const [showForm, setShowForm] = useState(false);
  const ids = new Set(scopedProps.map((p) => p.id));
  const templates = state.checklistTemplates.filter((t) => ids.has(t.propertyId));
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";

  const addTemplate = (payload) => {
    setState({
      ...state,
      checklistTemplates: [
        ...state.checklistTemplates,
        { id: uid(), ...payload, items: payload.items.map((text) => ({ id: uid(), text })) },
      ],
    });
    setShowForm(false);
  };

  const removeTemplate = (id) =>
    setState({
      ...state,
      checklistTemplates: state.checklistTemplates.filter((t) => t.id !== id),
      checklistRuns: state.checklistRuns.filter((r) => r.templateId !== id),
    });

  const runsFor = (templateId) =>
    state.checklistRuns
      .filter((r) => r.templateId === templateId)
      .sort((a, b) => (a.date < b.date ? 1 : -1));

  const startRun = (template) => {
    const run = {
      id: uid(),
      templateId: template.id,
      propertyId: template.propertyId,
      date: todayISO(),
      doneBy: actor || "Okänd",
      checkedItemIds: [],
    };
    setState({ ...state, checklistRuns: [...state.checklistRuns, run] });
  };

  const toggleItem = (run, itemId) => {
    const checked = run.checkedItemIds.includes(itemId)
      ? run.checkedItemIds.filter((x) => x !== itemId)
      : [...run.checkedItemIds, itemId];
    setState({
      ...state,
      checklistRuns: state.checklistRuns.map((r) => (r.id === run.id ? { ...r, checkedItemIds: checked } : r)),
    });
  };

  const finishRun = (run, total) => {
    notify(`Rondering klar (${run.checkedItemIds.length}/${total} punkter)`);
  };

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.sectionHead}>
        <h2 style={S.h2}>Checklistor för rondering</h2>
        <button style={S.primaryBtn} className="fk-btn" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Avbryt" : "+ Ny checklista"}
        </button>
      </div>

      {showForm && (
        <ChecklistForm properties={allProperties} defaultPropertyId={scopedProps[0]?.id} onSubmit={addTemplate} />
      )}

      {templates.length === 0 ? (
        <EmptyNote text="Inga checklistor ännu. Skapa en mall för t.ex. veckorondering." />
      ) : (
        <div style={S.checklistStack}>
          {templates.map((tmpl) => {
            const runs = runsFor(tmpl.id);
            const activeRun = runs.find((r) => r.date === todayISO()) || null;
            return (
              <div key={tmpl.id} style={S.checklistCard}>
                <div style={S.checklistHead}>
                  <div>
                    <div style={S.taskCardTitle}>{tmpl.title}</div>
                    <div style={S.taskCardProp}>{propName(tmpl.propertyId)} · {tmpl.items.length} punkter</div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {!activeRun && (
                      <button style={S.stampBtn} className="fk-btn" onClick={() => startRun(tmpl)}>
                        Starta rondering
                      </button>
                    )}
                    <button style={S.miniDelete} onClick={() => removeTemplate(tmpl.id)} aria-label="Ta bort checklista">×</button>
                  </div>
                </div>

                {activeRun && (
                  <div style={S.runBox}>
                    {tmpl.items.map((item) => {
                      const checked = activeRun.checkedItemIds.includes(item.id);
                      return (
                        <label key={item.id} style={S.checkRow}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleItem(activeRun, item.id)}
                            style={S.checkbox}
                          />
                          <span style={{ textDecoration: checked ? "line-through" : "none", opacity: checked ? 0.55 : 1 }}>
                            {item.text}
                          </span>
                        </label>
                      );
                    })}
                    <div style={S.runFooter}>
                      <span style={S.rowSub}>
                        {activeRun.checkedItemIds.length}/{tmpl.items.length} avbockade · {activeRun.doneBy}
                      </span>
                      <button
                        style={S.primaryBtnSmall}
                        className="fk-btn"
                        onClick={() => finishRun(activeRun, tmpl.items.length)}
                      >
                        Markera klar
                      </button>
                    </div>
                  </div>
                )}

                {runs.length > 0 && (
                  <div style={S.historyRow}>
                    Senast: {fmtDate(runs[0].date)} av {runs[0].doneBy} ({runs[0].checkedItemIds.length}/{tmpl.items.length})
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChecklistForm({ properties, defaultPropertyId, onSubmit }) {
  const [title, setTitle] = useState("");
  const [propertyId, setPropertyId] = useState(defaultPropertyId || properties[0]?.id);
  const [itemsText, setItemsText] = useState("");

  const submit = (e) => {
    e.preventDefault();
    const items = itemsText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!title.trim() || !propertyId || items.length === 0) return;
    onSubmit({ title: title.trim(), propertyId, items });
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.formRow}>
        <label style={S.label}>
          Namn på checklista
          <input className="fk-input" style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="t.ex. Veckorondering källare" required />
        </label>
        <label style={S.label}>
          Fastighet
          <select className="fk-input" style={S.input} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>
      <label style={S.label}>
        Punkter (en per rad)
        <textarea
          className="fk-input"
          style={{ ...S.input, height: 110, resize: "vertical" }}
          value={itemsText}
          onChange={(e) => setItemsText(e.target.value)}
          placeholder={"Kontrollera belysning\nProva branddörrar\nKolla fuktskador"}
          required
        />
      </label>
      <button type="submit" style={S.primaryBtn} className="fk-btn">Spara checklista</button>
    </form>
  );
}

/* ------------------------------ ärenden ------------------------------ */

function Arenden({ state, setState, scopedProps, allProperties, actor, notify }) {
  const [showForm, setShowForm] = useState(false);
  const ids = new Set(scopedProps.map((p) => p.id));
  const issues = state.issues
    .filter((i) => ids.has(i.propertyId))
    .sort((a, b) => (a.reportedAt < b.reportedAt ? 1 : -1));
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";

  const addIssue = (payload) => {
    const issue = {
      id: uid(),
      ...payload,
      status: "Öppen",
      reportedBy: actor || "Okänd",
      reportedAt: todayISO(),
    };
    setState({ ...state, issues: [...state.issues, issue] });
    setShowForm(false);
    notify("Ärende registrerat");
  };

  const setStatus = (issue, status) => {
    setState({ ...state, issues: state.issues.map((i) => (i.id === issue.id ? { ...i, status } : i)) });
  };

  const removeIssue = (id) => setState({ ...state, issues: state.issues.filter((i) => i.id !== id) });

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.sectionHead}>
        <h2 style={S.h2}>Felanmälningar & ärenden</h2>
        <button style={S.primaryBtn} className="fk-btn" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Avbryt" : "+ Nytt ärende"}
        </button>
      </div>

      {showForm && (
        <IssueForm properties={allProperties} defaultPropertyId={scopedProps[0]?.id} onSubmit={addIssue} />
      )}

      {issues.length === 0 ? (
        <EmptyNote text="Inga ärenden registrerade." />
      ) : (
        <div style={S.checklistStack}>
          {issues.map((i) => (
            <div key={i.id} style={{ ...S.checklistCard, borderColor: i.priority === "Akut" ? "#C4171C" : "#C9C4B7" }}>
              <div style={S.checklistHead}>
                <div>
                  <div style={S.taskCardTitle}>{i.title}</div>
                  <div style={S.taskCardProp}>
                    {propName(i.propertyId)} · anmält {fmtDate(i.reportedAt)} av {i.reportedBy}
                  </div>
                  {i.description && <div style={{ ...S.rowSub, marginTop: 6 }}>{i.description}</div>}
                </div>
                <button style={S.miniDelete} onClick={() => removeIssue(i.id)} aria-label="Ta bort ärende">×</button>
              </div>
              <div style={S.issueFooter}>
                <span style={{ ...S.priorityTag, color: i.priority === "Akut" ? "#C4171C" : "#1C2321" }}>
                  {i.priority}
                </span>
                <div style={S.statusRow}>
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatus(i, s)}
                      style={{ ...S.statusPill, ...(i.status === s ? S.statusPillActive : {}) }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IssueForm({ properties, defaultPropertyId, onSubmit }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [propertyId, setPropertyId] = useState(defaultPropertyId || properties[0]?.id);
  const [priority, setPriority] = useState("Normal");

  const submit = (e) => {
    e.preventDefault();
    if (!title.trim() || !propertyId) return;
    onSubmit({ title: title.trim(), description: description.trim(), propertyId, priority });
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.formRow}>
        <label style={S.label}>
          Vad är felet?
          <input className="fk-input" style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="t.ex. Läckande diskmaskin" required />
        </label>
        <label style={S.label}>
          Fastighet
          <select className="fk-input" style={S.input} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={S.formRow}>
        <label style={S.label}>
          Prioritet
          <select className="fk-input" style={S.input} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label style={S.label}>
          Beskrivning
          <input className="fk-input" style={S.input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Valfritt" />
        </label>
      </div>
      <button type="submit" style={S.primaryBtn} className="fk-btn">Registrera ärende</button>
    </form>
  );
}

/* ------------------------------ debitering ------------------------------ */

function Debitering({ state, setState, scopedProps, allProperties, actor, notify }) {
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [openOrderId, setOpenOrderId] = useState(null);
  const [printingBasis, setPrintingBasis] = useState(null); // { basis, order }

  const ids = new Set(scopedProps.map((p) => p.id));
  const orders = (state.billableOrders || []).filter((o) => ids.has(o.propertyId));
  const timeEntries = state.billableTimeEntries || [];
  const invoiceBasis = state.invoiceBasis || [];
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";

  const entriesFor = (orderId) => timeEntries.filter((e) => e.orderId === orderId);
  const loggedHours = (orderId) => entriesFor(orderId).reduce((s, e) => s + Number(e.hours || 0), 0);
  const unbilledHours = (orderId) =>
    entriesFor(orderId)
      .filter((e) => !e.invoicedInBasisId)
      .reduce((s, e) => s + Number(e.hours || 0), 0);

  const totalUnbilled = orders.reduce((s, o) => s + unbilledHours(o.id), 0);
  const totalUnbilledAmount = orders.reduce(
    (s, o) => s + unbilledHours(o.id) * Number(o.rate || 0),
    0
  );

  const addOrder = (payload) => {
    const order = { id: uid(), ...payload, status: "Öppen", createdAt: todayISO(), createdBy: actor || "Okänd" };
    setState({ ...state, billableOrders: [...(state.billableOrders || []), order] });
    setShowOrderForm(false);
    setOpenOrderId(order.id);
    notify("Ärende skapat");
  };

  const removeOrder = (id) => {
    setState({
      ...state,
      billableOrders: (state.billableOrders || []).filter((o) => o.id !== id),
      billableTimeEntries: timeEntries.filter((e) => e.orderId !== id),
      invoiceBasis: invoiceBasis.filter((b) => b.orderId !== id),
    });
    if (openOrderId === id) setOpenOrderId(null);
  };

  const setOrderStatus = (order, status) => {
    setState({
      ...state,
      billableOrders: state.billableOrders.map((o) => (o.id === order.id ? { ...o, status } : o)),
    });
  };

  const addTimeEntry = (order, payload) => {
    const entry = { id: uid(), orderId: order.id, ...payload, registeredBy: actor || "Okänd", invoicedInBasisId: null };
    setState({ ...state, billableTimeEntries: [...timeEntries, entry] });
    notify("Tid tillagd");
  };

  const removeTimeEntry = (id) =>
    setState({ ...state, billableTimeEntries: timeEntries.filter((e) => e.id !== id) });

  const createBasis = (order, adjustedHours, note) => {
    const unbilled = entriesFor(order.id).filter((e) => !e.invoicedInBasisId);
    const basisId = uid();
    const basis = {
      id: basisId,
      orderId: order.id,
      propertyId: order.propertyId,
      title: order.title,
      createdAt: todayISO(),
      createdBy: actor || "Okänd",
      rate: Number(order.rate || 0),
      loggedHours: unbilled.reduce((s, e) => s + Number(e.hours || 0), 0),
      adjustedHours: Number(adjustedHours),
      note: note.trim(),
      entryIds: unbilled.map((e) => e.id),
    };
    setState({
      ...state,
      invoiceBasis: [...invoiceBasis, basis],
      billableTimeEntries: timeEntries.map((e) =>
        unbilled.find((u) => u.id === e.id) ? { ...e, invoicedInBasisId: basisId } : e
      ),
    });
    notify("Faktureringsunderlag sparat");
  };

  const updateBasisHours = (basis, newHours) => {
    setState({
      ...state,
      invoiceBasis: invoiceBasis.map((b) =>
        b.id === basis.id ? { ...b, adjustedHours: Number(newHours) } : b
      ),
    });
  };

  const removeBasis = (basis) => {
    setState({
      ...state,
      invoiceBasis: invoiceBasis.filter((b) => b.id !== basis.id),
      billableTimeEntries: timeEntries.map((e) =>
        e.invoicedInBasisId === basis.id ? { ...e, invoicedInBasisId: null } : e
      ),
    });
    notify("Faktureringsunderlag borttaget, timmarna är öppna igen");
  };

  const openOrder = openOrderId ? orders.find((o) => o.id === openOrderId) : null;

  if (printingBasis) {
    return (
      <PrintableBasis
        basis={printingBasis.basis}
        order={printingBasis.order}
        propertyName={propName(printingBasis.order.propertyId)}
        onClose={() => setPrintingBasis(null)}
      />
    );
  }

  if (openOrder) {
    return (
      <OrderDetail
        order={openOrder}
        propertyName={propName(openOrder.propertyId)}
        entries={entriesFor(openOrder.id).sort((a, b) => (a.date < b.date ? 1 : -1))}
        basisList={invoiceBasis.filter((b) => b.orderId === openOrder.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))}
        loggedHours={loggedHours(openOrder.id)}
        unbilledHours={unbilledHours(openOrder.id)}
        onBack={() => setOpenOrderId(null)}
        onAddEntry={(payload) => addTimeEntry(openOrder, payload)}
        onRemoveEntry={removeTimeEntry}
        onSetStatus={(status) => setOrderStatus(openOrder, status)}
        onCreateBasis={(hours, note) => createBasis(openOrder, hours, note)}
        onUpdateBasisHours={updateBasisHours}
        onRemoveBasis={removeBasis}
        onPrintBasis={(basis) => setPrintingBasis({ basis, order: openOrder })}
      />
    );
  }

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.sectionHead}>
        <h2 style={S.h2}>Debiterbar tid utanför avtal</h2>
        <button style={S.primaryBtn} className="fk-btn" onClick={() => setShowOrderForm((s) => !s)}>
          {showOrderForm ? "Avbryt" : "+ Nytt ärende/order"}
        </button>
      </div>

      <div style={S.statGrid}>
        <div style={S.statCard}>
          <div style={{ ...S.statValue, color: "#EA5B0C" }}>{totalUnbilled}</div>
          <div style={S.statLabel}>Ofakturerade timmar</div>
        </div>
        <div style={S.statCard}>
          <div style={{ ...S.statValue, color: "#1C2321" }}>{totalUnbilledAmount.toLocaleString("sv-SE")} kr</div>
          <div style={S.statLabel}>Ofakturerat belopp (ca)</div>
        </div>
        <div style={S.statCard}>
          <div style={S.statValue}>{orders.length}</div>
          <div style={S.statLabel}>Ärenden/order</div>
        </div>
      </div>

      {showOrderForm && (
        <OrderForm properties={allProperties} defaultPropertyId={scopedProps[0]?.id} onSubmit={addOrder} />
      )}

      {orders.length === 0 ? (
        <EmptyNote text="Inga ärenden ännu. Skapa ett ärende/order för jobb utanför avtalet, och lägg sedan på tid allteftersom." />
      ) : (
        <div style={S.checklistStack}>
          {orders
            .slice()
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
            .map((o) => {
              const logged = loggedHours(o.id);
              const unbilled = unbilledHours(o.id);
              return (
                <div key={o.id} style={S.checklistCard}>
                  <div style={S.checklistHead}>
                    <div>
                      <div style={S.taskCardTitle}>{o.title}</div>
                      <div style={S.taskCardProp}>
                        {propName(o.propertyId)} · skapad {fmtDate(o.createdAt)} av {o.createdBy}
                      </div>
                      {o.description && <div style={{ ...S.rowSub, marginTop: 6 }}>{o.description}</div>}
                    </div>
                    <button style={S.miniDelete} onClick={() => removeOrder(o.id)} aria-label="Ta bort ärende">×</button>
                  </div>
                  <div style={S.issueFooter}>
                    <span style={S.rowSub}>
                      {logged} h loggat · {unbilled} h att fakturera{o.rate ? ` · ${o.rate} kr/h` : ""}
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span style={{ ...S.statusPill, ...(o.status === "Öppen" ? {} : S.statusPillActive) }}>
                        {o.status}
                      </span>
                      <button style={S.stampBtn} className="fk-btn" onClick={() => setOpenOrderId(o.id)}>
                        Öppna tidrapport
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

function OrderForm({ properties, defaultPropertyId, onSubmit }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [propertyId, setPropertyId] = useState(defaultPropertyId || properties[0]?.id);
  const [rate, setRate] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (!title.trim() || !propertyId) return;
    onSubmit({ title: title.trim(), description: description.trim(), propertyId, rate: rate ? Number(rate) : 0 });
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.formRow}>
        <label style={S.label}>
          Ärende/order
          <input className="fk-input" style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="t.ex. Stormröjning tak" required />
        </label>
        <label style={S.label}>
          Fastighet
          <select className="fk-input" style={S.input} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>
      <div style={S.formRow}>
        <label style={S.label}>
          Timpris (kr, valfritt)
          <input className="fk-input" style={S.input} type="number" min="0" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="t.ex. 650" />
        </label>
        <label style={S.label}>
          Beskrivning
          <input className="fk-input" style={S.input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Valfritt" />
        </label>
      </div>
      <button type="submit" style={S.primaryBtn} className="fk-btn">Skapa ärende</button>
    </form>
  );
}

function OrderDetail({
  order,
  propertyName,
  entries,
  basisList,
  loggedHours,
  unbilledHours,
  onBack,
  onAddEntry,
  onRemoveEntry,
  onSetStatus,
  onCreateBasis,
  onUpdateBasisHours,
  onRemoveBasis,
  onPrintBasis,
}) {
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [showBasisForm, setShowBasisForm] = useState(false);

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <button onClick={onBack} style={S.linkBtn}>‹ Alla ärenden</button>

      <div style={{ ...S.sectionHead, marginTop: 8 }}>
        <div>
          <h2 style={S.h2}>{order.title}</h2>
          <div style={S.taskCardProp}>{propertyName}{order.rate ? ` · ${order.rate} kr/h` : ""}</div>
          {order.description && <div style={{ ...S.rowSub, marginTop: 4 }}>{order.description}</div>}
        </div>
        <div style={S.statusRow}>
          {["Öppen", "Avslutad"].map((s) => (
            <button
              key={s}
              onClick={() => onSetStatus(s)}
              style={{ ...S.statusPill, ...(order.status === s ? S.statusPillActive : {}) }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div style={S.statGrid}>
        <div style={S.statCard}>
          <div style={S.statValue}>{loggedHours}</div>
          <div style={S.statLabel}>Totalt loggat (h)</div>
        </div>
        <div style={S.statCard}>
          <div style={{ ...S.statValue, color: "#EA5B0C" }}>{unbilledHours}</div>
          <div style={S.statLabel}>Att fakturera (h)</div>
        </div>
      </div>

      <div style={S.sectionHead}>
        <h3 style={S.panelTitle}>Tidrader</h3>
        <button style={S.primaryBtnSmall} className="fk-btn" onClick={() => setShowEntryForm((s) => !s)}>
          {showEntryForm ? "Avbryt" : "+ Lägg till tid"}
        </button>
      </div>

      {showEntryForm && (
        <TimeEntryForm
          onSubmit={(payload) => {
            onAddEntry(payload);
            setShowEntryForm(false);
          }}
        />
      )}

      {entries.length === 0 ? (
        <EmptyNote text="Ingen tid registrerad ännu på det här ärendet." />
      ) : (
        <div style={S.checklistStack}>
          {entries.map((e) => (
            <div key={e.id} style={S.entryRow}>
              <div>
                <div style={S.rowTitle}>
                  {fmtDate(e.date)} · {e.hours} h
                  {e.invoicedInBasisId && <span style={S.invoicedTag}>fakturerad</span>}
                </div>
                {e.note && <div style={S.rowSub}>{e.note}</div>}
                <div style={S.rowSub}>{e.registeredBy}</div>
              </div>
              {!e.invoicedInBasisId && (
                <button style={S.miniDelete} onClick={() => onRemoveEntry(e.id)} aria-label="Ta bort tidrad">×</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ ...S.sectionHead, marginTop: 24 }}>
        <h3 style={S.panelTitle}>Faktureringsunderlag</h3>
        {unbilledHours > 0 && (
          <button style={S.primaryBtnSmall} className="fk-btn" onClick={() => setShowBasisForm((s) => !s)}>
            {showBasisForm ? "Avbryt" : "Skapa underlag"}
          </button>
        )}
      </div>

      {showBasisForm && (
        <BasisForm
          suggestedHours={unbilledHours}
          onSubmit={(hours, note) => {
            onCreateBasis(hours, note);
            setShowBasisForm(false);
          }}
        />
      )}

      {basisList.length === 0 ? (
        <EmptyNote text="Inget faktureringsunderlag skapat ännu." />
      ) : (
        <div style={S.checklistStack}>
          {basisList.map((b) => (
            <div key={b.id} style={S.checklistCard}>
              <div style={S.checklistHead}>
                <div>
                  <div style={S.taskCardTitle}>Underlag {fmtDate(b.createdAt)}</div>
                  <div style={S.rowSub}>
                    Loggat {b.loggedHours} h · av {b.createdBy}
                  </div>
                  {b.note && <div style={{ ...S.rowSub, marginTop: 4 }}>{b.note}</div>}
                </div>
                <button style={S.miniDelete} onClick={() => onRemoveBasis(b)} aria-label="Ta bort underlag">×</button>
              </div>
              <div style={S.issueFooter}>
                <label style={S.adjustRow}>
                  Justerade timmar
                  <input
                    className="fk-input"
                    style={S.adjustInput}
                    type="number"
                    step="0.25"
                    min="0"
                    value={b.adjustedHours}
                    onChange={(e) => onUpdateBasisHours(b, e.target.value)}
                  />
                  <span style={S.rowSub}>× {b.rate} kr/h = {(b.adjustedHours * b.rate).toLocaleString("sv-SE")} kr</span>
                </label>
                <button style={S.stampBtn} className="fk-btn" onClick={() => onPrintBasis(b)}>
                  Öppna underlag
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TimeEntryForm({ onSubmit }) {
  const [date, setDate] = useState(todayISO());
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (!hours) return;
    onSubmit({ date, hours: Number(hours), note: note.trim() });
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.formRow}>
        <label style={S.label}>
          Datum
          <input className="fk-input" style={S.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label style={S.label}>
          Timmar
          <input
            className="fk-input"
            style={S.input}
            type="number"
            step="0.25"
            min="0"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="t.ex. 2.5"
            required
          />
        </label>
      </div>
      <label style={S.label}>
        Anteckning
        <input className="fk-input" style={S.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Vad gjordes?" />
      </label>
      <button type="submit" style={S.primaryBtnSmall} className="fk-btn">Spara tid</button>
    </form>
  );
}

function BasisForm({ suggestedHours, onSubmit }) {
  const [hours, setHours] = useState(suggestedHours);
  const [note, setNote] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (!hours && hours !== 0) return;
    onSubmit(hours, note);
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.label}>
        Timmar att fakturera just nu är föreslaget till {suggestedHours} h utifrån ej fakturerade tidrader.
        Justera vid behov, t.ex. för avrundning eller avdrag.
      </div>
      <div style={S.formRow}>
        <label style={S.label}>
          Timmar till underlag
          <input
            className="fk-input"
            style={S.input}
            type="number"
            step="0.25"
            min="0"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            required
          />
        </label>
        <label style={S.label}>
          Kommentar (valfritt)
          <input className="fk-input" style={S.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="t.ex. avrundat till hel timme" />
        </label>
      </div>
      <button type="submit" style={S.primaryBtn} className="fk-btn">Spara faktureringsunderlag</button>
    </form>
  );
}

function PrintableBasis({ basis, order, propertyName, onClose }) {
  const amount = Number(basis.adjustedHours) * Number(basis.rate);
  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }} className="fk-no-print">
        <button onClick={onClose} style={S.linkBtn}>‹ Tillbaka</button>
        <button onClick={() => window.print()} style={S.primaryBtn} className="fk-btn">
          Skriv ut / Spara som PDF
        </button>
      </div>

      <div className="fk-print-area" style={S.invoiceDoc}>
        <div style={S.invoiceHeader}>
          <div style={S.stampMark}>N2</div>
          <div>
            <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 20, fontWeight: 600 }}>Faktureringsunderlag</div>
            <div style={S.rowSub}>Skapat {fmtDate(basis.createdAt)} av {basis.createdBy}</div>
          </div>
        </div>

        <div style={S.invoiceMetaGrid}>
          <div>
            <div style={S.invoiceMetaLabel}>Fastighet</div>
            <div style={S.invoiceMetaValue}>{propertyName}</div>
          </div>
          <div>
            <div style={S.invoiceMetaLabel}>Ärende/order</div>
            <div style={S.invoiceMetaValue}>{order.title}</div>
          </div>
        </div>

        <table style={S.invoiceTable}>
          <thead>
            <tr>
              <th style={S.invoiceTh}>Beskrivning</th>
              <th style={S.invoiceTh}>Timmar</th>
              <th style={S.invoiceTh}>Timpris</th>
              <th style={S.invoiceTh}>Summa</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={S.invoiceTd}>{order.title}{basis.note ? ` — ${basis.note}` : ""}</td>
              <td style={S.invoiceTd}>{basis.adjustedHours} h</td>
              <td style={S.invoiceTd}>{basis.rate} kr/h</td>
              <td style={S.invoiceTd}>{amount.toLocaleString("sv-SE")} kr</td>
            </tr>
          </tbody>
        </table>

        <div style={S.invoiceTotal}>Totalt: {amount.toLocaleString("sv-SE")} kr</div>

        {basis.loggedHours !== basis.adjustedHours && (
          <div style={{ ...S.rowSub, marginTop: 10 }}>
            (Loggad tid var {basis.loggedHours} h, justerad till {basis.adjustedHours} h.)
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ backup ------------------------------ */

function Backup({ state, setState, notify, lastSavedAt }) {
  const [pendingImport, setPendingImport] = useState(null); // { data, summary, fileName }
  const [importError, setImportError] = useState(null);
  const fileInputRef = React.useRef(null);

  const counts = {
    Fastigheter: state.properties.length,
    Uppgifter: state.tasks.length,
    Checklistor: state.checklistTemplates.length,
    Ärenden: state.issues.length,
    "Ärenden (debitering)": (state.billableOrders || []).length,
    Tidrader: (state.billableTimeEntries || []).length,
    Faktureringsunderlag: (state.invoiceBasis || []).length,
  };

  const downloadBackup = () => {
    const payload = { exportedAt: new Date().toISOString(), app: "N2 Förvaltning", data: state };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `n2-forvaltning-backup-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notify("Backup nedladdad");
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const data = parsed.data || parsed; // accept either wrapped export or raw state
        if (!data || !Array.isArray(data.properties)) {
          throw new Error("Filen innehåller inte ett igenkännbart N2 Förvaltning-underlag.");
        }
        const summary = {
          Fastigheter: data.properties?.length || 0,
          Uppgifter: data.tasks?.length || 0,
          Checklistor: data.checklistTemplates?.length || 0,
          Ärenden: data.issues?.length || 0,
          "Ärenden (debitering)": data.billableOrders?.length || 0,
          Faktureringsunderlag: data.invoiceBasis?.length || 0,
        };
        setPendingImport({ data, summary, fileName: file.name });
      } catch (err) {
        setImportError("Kunde inte läsa filen. Kontrollera att det är en backup exporterad härifrån.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const confirmImport = () => {
    if (!pendingImport) return;
    setState({
      ...pendingImport.data,
      billableOrders: pendingImport.data.billableOrders || [],
      billableTimeEntries: pendingImport.data.billableTimeEntries || [],
      invoiceBasis: pendingImport.data.invoiceBasis || [],
    });
    setPendingImport(null);
    notify("Backup återställd");
  };

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <h2 style={S.h2}>Backup & export</h2>
      <p style={{ ...S.rowSub, fontSize: 13.5, maxWidth: 560, margin: "10px 0 20px" }}>
        All data sparas löpande i molnlagringen och delas mellan alla som öppnar den här appen.
        Det är däremot inte en fullservice-databas med garanterad redundans, så vi rekommenderar
        att ni tar en egen nedladdad kopia med jämna mellanrum — särskilt innan större ändringar.
      </p>

      <div style={S.panel}>
        <h3 style={S.panelTitle}>Innehåll just nu</h3>
        <ul style={S.plainList}>
          {Object.entries(counts).map(([label, n]) => (
            <li key={label} style={{ ...S.rowItem, alignItems: "center" }}>
              <span style={{ flex: 1, fontSize: 13.5 }}>{label}</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>{n}</span>
            </li>
          ))}
        </ul>
        <div style={{ ...S.rowSub, marginTop: 10 }}>
          {lastSavedAt
            ? `Senast bekräftat sparat i molnet: ${lastSavedAt.toLocaleString("sv-SE")}`
            : "Väntar på första sparningen…"}
        </div>
      </div>

      <div style={S.panel}>
        <h3 style={S.panelTitle}>Ladda ner backup</h3>
        <p style={{ ...S.rowSub, marginBottom: 12 }}>
          Sparar all information (fastigheter, uppgifter, checklistor, ärenden, debitering) som en
          JSON-fil på din enhet.
        </p>
        <button style={S.primaryBtn} className="fk-btn" onClick={downloadBackup}>
          Ladda ner backup (.json)
        </button>
      </div>

      <div style={S.panel}>
        <h3 style={S.panelTitle}>Återställ från backup</h3>
        <p style={{ ...S.rowSub, marginBottom: 12 }}>
          Väljer du en fil här ersätts <strong>all nuvarande data</strong> med innehållet i filen.
          Du får se en sammanfattning innan något skrivs över.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          onChange={handleFile}
          style={{ display: "none" }}
        />
        <button style={S.secondaryBtn} className="fk-btn" onClick={() => fileInputRef.current?.click()}>
          Välj backupfil…
        </button>
        {importError && <div style={{ ...S.rowSub, color: "#C4171C", marginTop: 10 }}>{importError}</div>}
      </div>

      {pendingImport && (
        <div style={{ ...S.formPanel, borderColor: "#EA5B0C" }}>
          <div style={S.taskCardTitle}>Bekräfta återställning</div>
          <div style={S.rowSub}>Fil: {pendingImport.fileName}</div>
          <ul style={S.plainList}>
            {Object.entries(pendingImport.summary).map(([label, n]) => (
              <li key={label} style={{ ...S.rowItem, alignItems: "center" }}>
                <span style={{ flex: 1, fontSize: 13.5 }}>{label}</span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>{n}</span>
              </li>
            ))}
          </ul>
          <div style={{ ...S.rowSub, color: "#C4171C" }}>
            Detta skriver över all data som finns i appen just nu. Detta går inte att ångra.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button style={S.primaryBtn} className="fk-btn" onClick={confirmImport}>
              Ja, ersätt all data
            </button>
            <button style={S.secondaryBtn} className="fk-btn" onClick={() => setPendingImport(null)}>
              Avbryt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ kalender ------------------------------ */


function Kalender({ state, scopedProps }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const ids = new Set(scopedProps.map((p) => p.id));
  const tasks = state.tasks.filter((t) => ids.has(t.propertyId));
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";

  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + monthOffset);
  const year = base.getFullYear();
  const month = base.getMonth();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const byDate = useMemo(() => {
    const map = {};
    tasks.forEach((t) => {
      map[t.nextDue] = map[t.nextDue] || [];
      map[t.nextDue].push(t);
    });
    return map;
  }, [tasks]);

  const [selected, setSelected] = useState(null);
  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const monthLabel = base.toLocaleDateString("sv-SE", { month: "long", year: "numeric" });
  const isoFor = (d) => `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const today = todayISO();

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.sectionHead}>
        <h2 style={S.h2}>Kalender & påminnelser</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={S.navBtn} onClick={() => setMonthOffset((m) => m - 1)}>‹</button>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, textTransform: "capitalize" }}>
            {monthLabel}
          </span>
          <button style={S.navBtn} onClick={() => setMonthOffset((m) => m + 1)}>›</button>
        </div>
      </div>

      <div style={S.calGrid}>
        {["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"].map((d) => (
          <div key={d} style={S.calWeekday}>{d}</div>
        ))}
        {cells.map((d, idx) => {
          if (d === null) return <div key={idx} />;
          const iso = isoFor(d);
          const items = byDate[iso] || [];
          const isToday = iso === today;
          return (
            <button
              key={idx}
              onClick={() => setSelected(iso)}
              style={{
                ...S.calCell,
                ...(isToday ? S.calCellToday : {}),
                ...(selected === iso ? S.calCellSelected : {}),
              }}
            >
              <span>{d}</span>
              {items.length > 0 && (
                <span style={{ ...S.calDot, background: iso < today ? "#C4171C" : "#EA5B0C" }} />
              )}
            </button>
          );
        })}
      </div>

      <div style={S.panel}>
        <h3 style={S.panelTitle}>
          {selected ? `Förfaller ${fmtDate(selected)}` : "Välj en dag med markering"}
        </h3>
        {selected && (byDate[selected] || []).length === 0 && <EmptyNote text="Inget förfaller denna dag." />}
        {selected && (
          <ul style={S.plainList}>
            {(byDate[selected] || []).map((t) => (
              <li key={t.id} style={S.rowItem}>
                <span style={{ ...S.dot, background: "#EA5B0C" }} />
                <span style={{ flex: 1 }}>
                  <div style={S.rowTitle}>{t.title}</div>
                  <div style={S.rowSub}>{propName(t.propertyId)} · {t.category}</div>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ styles ------------------------------ */

const S = {
  app: {
    fontFamily: "'Inter', sans-serif",
    background: "#EDEAE1",
    minHeight: "100vh",
    color: "#1C2321",
    display: "flex",
    flexDirection: "column",
  },
  loadingScreen: {
    minHeight: "100vh",
    background: "#EDEAE1",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  stampSpin: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    border: "3px solid #C9C4B7",
    borderTopColor: "#EA5B0C",
    animation: "fk-spin .8s linear infinite",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 18px",
    background: "#1C2321",
    color: "#EDEAE1",
    flexWrap: "wrap",
    gap: 10,
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  stampMark: {
    width: 38,
    height: 38,
    borderRadius: 6,
    border: "2px solid #EA5B0C",
    color: "#EA5B0C",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "'IBM Plex Mono', monospace",
    fontWeight: 600,
    fontSize: 13,
    transform: "rotate(-4deg)",
    flexShrink: 0,
  },
  title: { fontFamily: "'Oswald', sans-serif", fontSize: 20, fontWeight: 600, letterSpacing: 0.3 },
  subtitle: { fontSize: 11, color: "#9BA39C", textTransform: "uppercase", letterSpacing: 1 },
  headerRight: { display: "flex", gap: 8, flexWrap: "wrap" },
  selectHeader: {
    background: "#2A312D",
    color: "#EDEAE1",
    border: "1px solid #40473F",
    borderRadius: 6,
    padding: "8px 10px",
    fontSize: 13,
  },
  nameInput: {
    background: "#2A312D",
    color: "#EDEAE1",
    border: "1px solid #40473F",
    borderRadius: 6,
    padding: "8px 10px",
    fontSize: 13,
    width: 130,
  },
  tabRow: {
    display: "flex",
    gap: 4,
    padding: "10px 18px 0",
    overflowX: "auto",
    background: "#EDEAE1",
    borderBottom: "1px solid #C9C4B7",
  },
  tabBtn: {
    border: "none",
    background: "transparent",
    padding: "10px 14px",
    fontFamily: "'Oswald', sans-serif",
    fontSize: 14,
    letterSpacing: 0.3,
    color: "#5C594E",
    borderBottom: "3px solid transparent",
    whiteSpace: "nowrap",
  },
  tabBtnActive: { color: "#1C2321", borderBottom: "3px solid #EA5B0C" },
  main: { padding: "18px", flex: 1, overflowY: "auto", maxWidth: 1040, margin: "0 auto", width: "100%" },

  statGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 18 },
  statCard: {
    background: "#FFFFFF",
    border: "1px solid #C9C4B7",
    borderRadius: 8,
    padding: "14px 16px",
    textAlign: "left",
  },
  statValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 26, fontWeight: 600 },
  statLabel: { fontSize: 12, color: "#5C594E", marginTop: 4 },

  twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 },
  panel: { background: "#FFFFFF", border: "1px solid #C9C4B7", borderRadius: 8, padding: 16, marginBottom: 14 },
  panelTitle: { fontFamily: "'Oswald', sans-serif", fontSize: 15, fontWeight: 600, margin: "0 0 10px" },

  plainList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 },
  rowItem: { display: "flex", alignItems: "flex-start", gap: 10 },
  rowTitle: { fontSize: 13.5, fontWeight: 600 },
  rowSub: { fontSize: 12, color: "#5C594E", marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: "50%", marginTop: 5, flexShrink: 0 },

  emptyNote: { fontSize: 13, color: "#8a8578", fontStyle: "italic", padding: "6px 0" },

  sectionHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 },
  h2: { fontFamily: "'Oswald', sans-serif", fontSize: 20, fontWeight: 600, margin: 0 },

  primaryBtn: { background: "#EA5B0C", color: "#fff", border: "none", borderRadius: 6, padding: "9px 14px", fontSize: 13.5, fontWeight: 600 },
  primaryBtnSmall: { background: "#2B6E5E", color: "#fff", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12.5, fontWeight: 600 },

  formPanel: { background: "#FFFFFF", border: "1px solid #C9C4B7", borderRadius: 8, padding: 16, marginBottom: 16, display: "flex", flexDirection: "column", gap: 12 },
  formRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  label: { display: "flex", flexDirection: "column", gap: 5, fontSize: 12.5, color: "#5C594E", fontWeight: 500 },
  input: { border: "1px solid #C9C4B7", borderRadius: 6, padding: "8px 10px", fontSize: 13.5, color: "#1C2321", background: "#FBFAF7" },

  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 },
  taskCard: { background: "#FFFFFF", border: "1.5px solid #C9C4B7", borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 6 },
  taskCardTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  categoryTag: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, color: "#5C594E", background: "#EDEAE1", padding: "3px 7px", borderRadius: 4 },
  miniDelete: { border: "none", background: "transparent", color: "#8a8578", fontSize: 18, lineHeight: 1, padding: 2 },
  taskCardTitle: { fontFamily: "'Oswald', sans-serif", fontSize: 15.5, fontWeight: 600 },
  taskCardProp: { fontSize: 12, color: "#5C594E" },
  taskCardMeta: { fontSize: 11.5, color: "#8a8578" },
  taskCardFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 },

  stampBadge: { border: "2px solid", borderRadius: 6, padding: "4px 8px", textAlign: "center", transform: "rotate(-2deg)" },
  stampBadgeLabel: { fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", letterSpacing: 0.5 },
  stampBadgeDate: { fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600 },

  stampBtn: { background: "#1C2321", color: "#EDEAE1", border: "none", borderRadius: 6, padding: "8px 12px", fontSize: 12.5, fontWeight: 600 },

  checklistStack: { display: "flex", flexDirection: "column", gap: 12 },
  checklistCard: { background: "#FFFFFF", border: "1.5px solid #C9C4B7", borderRadius: 8, padding: 16 },
  checklistHead: { display: "flex", justifyContent: "space-between", gap: 10 },
  runBox: { marginTop: 12, paddingTop: 12, borderTop: "1px dashed #C9C4B7", display: "flex", flexDirection: "column", gap: 8 },
  checkRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 },
  checkbox: { width: 16, height: 16, accentColor: "#2B6E5E" },
  runFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
  historyRow: { fontSize: 11.5, color: "#8a8578", marginTop: 10 },

  issueFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, flexWrap: "wrap", gap: 8 },
  priorityTag: { fontSize: 12, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" },
  statusRow: { display: "flex", gap: 6 },
  statusPill: { border: "1px solid #C9C4B7", background: "#FBFAF7", borderRadius: 14, padding: "5px 11px", fontSize: 11.5, color: "#5C594E" },
  statusPillActive: { background: "#1C2321", color: "#EDEAE1", borderColor: "#1C2321" },

  secondaryBtn: { background: "transparent", color: "#5C594E", border: "1px solid #C9C4B7", borderRadius: 6, padding: "9px 14px", fontSize: 13.5, fontWeight: 600 },
  linkBtn: { background: "transparent", border: "none", color: "#EA5B0C", fontSize: 12.5, fontWeight: 600, padding: "4px 0", textAlign: "left" },
  filterRow: { display: "flex", gap: 6, marginBottom: 12 },

  contactRow: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", fontSize: 12.5 },
  contactRole: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: "#5C594E", background: "#EDEAE1", padding: "2px 7px", borderRadius: 4, flexShrink: 0 },
  contactName: { fontWeight: 600, fontSize: 13 },
  contactFormRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },

  entryRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "#FFFFFF", border: "1px solid #C9C4B7", borderRadius: 8, padding: "10px 14px" },
  invoicedTag: { marginLeft: 8, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, color: "#2B6E5E", border: "1px solid #2B6E5E", borderRadius: 4, padding: "1px 6px" },
  adjustRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#5C594E", fontWeight: 500 },
  adjustInput: { width: 72, border: "1px solid #C9C4B7", borderRadius: 6, padding: "6px 8px", fontSize: 13, background: "#FBFAF7" },

  invoiceDoc: { background: "#FFFFFF", border: "1px solid #C9C4B7", borderRadius: 8, padding: 28, maxWidth: 640, margin: "0 auto" },
  invoiceHeader: { display: "flex", alignItems: "center", gap: 14, marginBottom: 24, paddingBottom: 16, borderBottom: "2px solid #1C2321" },
  invoiceMetaGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 },
  invoiceMetaLabel: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, color: "#8a8578" },
  invoiceMetaValue: { fontSize: 14, fontWeight: 600, marginTop: 2 },
  invoiceTable: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  invoiceTh: { textAlign: "left", borderBottom: "1.5px solid #1C2321", padding: "6px 8px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#5C594E" },
  invoiceTd: { borderBottom: "1px solid #C9C4B7", padding: "10px 8px" },
  invoiceTotal: { textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", fontSize: 18, fontWeight: 600, marginTop: 16 },

  navBtn: { border: "1px solid #C9C4B7", background: "#FFFFFF", borderRadius: 6, width: 28, height: 28, fontSize: 16, lineHeight: 1 },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 16 },
  calWeekday: { fontSize: 10.5, color: "#8a8578", textAlign: "center", textTransform: "uppercase", letterSpacing: 0.5, paddingBottom: 4 },
  calCell: {
    aspectRatio: "1",
    border: "1px solid #C9C4B7",
    background: "#FFFFFF",
    borderRadius: 6,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    fontSize: 12.5,
    position: "relative",
  },
  calCellToday: { borderColor: "#1C2321", borderWidth: 2, fontWeight: 700 },
  calCellSelected: { background: "#1C2321", color: "#EDEAE1" },
  calDot: { width: 6, height: 6, borderRadius: "50%" },

  errorBar: { position: "fixed", bottom: 0, left: 0, right: 0, background: "#C4171C", color: "#fff", textAlign: "center", padding: "10px 12px", fontSize: 13, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  retryBtn: { background: "#fff", color: "#C4171C", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12.5, fontWeight: 700 },
  toast: {
    position: "fixed",
    bottom: 18,
    left: "50%",
    transform: "translateX(-50%)",
    background: "#1C2321",
    color: "#EDEAE1",
    padding: "10px 18px",
    borderRadius: 8,
    fontSize: 13,
    fontFamily: "'IBM Plex Mono', monospace",
    boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
    animation: "fk-rise .2s ease",
  },
};

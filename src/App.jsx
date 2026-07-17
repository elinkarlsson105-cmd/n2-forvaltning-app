import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "./lib/supabaseClient";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

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

const SORT_OPTIONS = [
  { value: "datum-senaste", label: "Datum (senaste först)" },
  { value: "datum-aldsta", label: "Datum (äldsta först)" },
  { value: "timmar-flest", label: "Antal timmar (flest först)" },
  { value: "timmar-farst", label: "Antal timmar (färst först)" },
  { value: "belopp-hogst", label: "Belopp (högst först)" },
  { value: "belopp-lagst", label: "Belopp (lägst först)" },
  { value: "typ", label: "Typ av tjänst (A–Ö)" },
];

// metricsFor(order) ska returnera { date, hours, amount }
function sortOrders(list, sortBy, metricsFor) {
  const arr = list.slice();
  const comparators = {
    "datum-senaste": (a, b) => (metricsFor(b).date || "").localeCompare(metricsFor(a).date || ""),
    "datum-aldsta": (a, b) => (metricsFor(a).date || "").localeCompare(metricsFor(b).date || ""),
    "timmar-flest": (a, b) => metricsFor(b).hours - metricsFor(a).hours,
    "timmar-farst": (a, b) => metricsFor(a).hours - metricsFor(b).hours,
    "belopp-hogst": (a, b) => metricsFor(b).amount - metricsFor(a).amount,
    "belopp-lagst": (a, b) => metricsFor(a).amount - metricsFor(b).amount,
    typ: (a, b) => (a.type || "").localeCompare(b.type || ""),
  };
  arr.sort(comparators[sortBy] || (() => 0));
  return arr;
}

function filterOrders(list, { type = "alla", category = "alla" } = {}) {
  return list.filter(
    (o) => (type === "alla" || o.type === type) && (category === "alla" || o.priceCategory === category)
  );
}

function SortFilterBar({
  sortBy,
  setSortBy,
  filterType,
  setFilterType,
  filterCategory,
  setFilterCategory,
  filterProperty,
  setFilterProperty,
  properties,
}) {
  return (
    <div style={S.sortFilterBar}>
      <label style={S.sortFilterField}>
        <span style={S.sortFilterLabel}>Sortera</span>
        <select className="fk-input" style={S.sortFilterSelect} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </label>
      {setFilterProperty && properties && properties.length > 1 && (
        <label style={S.sortFilterField}>
          <span style={S.sortFilterLabel}>Bostadsrättsförening</span>
          <select className="fk-input" style={S.sortFilterSelect} value={filterProperty} onChange={(e) => setFilterProperty(e.target.value)}>
            <option value="alla">Alla</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      )}
      {setFilterType && (
        <label style={S.sortFilterField}>
          <span style={S.sortFilterLabel}>Typ av tjänst</span>
          <select className="fk-input" style={S.sortFilterSelect} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
            <option value="alla">Alla</option>
            <option value="felanmalan">Felanmälan</option>
            <option value="tillaggstjanst">Tilläggstjänst</option>
          </select>
        </label>
      )}
      <label style={S.sortFilterField}>
        <span style={S.sortFilterLabel}>Kategori</span>
        <select className="fk-input" style={S.sortFilterSelect} value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
          <option value="alla">Alla</option>
          <option value="FA">FA</option>
          <option value="TEK">TEK</option>
        </select>
      </label>
    </div>
  );
}

const seedState = () => ({
  properties: [
    {
      id: uid(),
      name: "Kvarngatan 4",
      address: "Kvarngatan 4, 112 20 Stockholm",
      notes: "",
      contacts: [],
      rates: { FA: 0, TEK: 0, BIL: 0 },
    },
    {
      id: uid(),
      name: "Ekbacken 12",
      address: "Ekbacken 12, 141 41 Huddinge",
      notes: "",
      contacts: [],
      rates: { FA: 0, TEK: 0, BIL: 0 },
    },
  ],
  tasks: [],
  checklistTemplates: [],
  checklistRuns: [],
  issues: [],
  billableOrders: [],
  billableTimeEntries: [],
  invoiceBasis: [],
  nextOrderNumber: 1,
});

const normalizeProperty = (p) => ({
  ...p,
  rates: {
    FA: Number(p.rates?.FA || 0),
    TEK: Number(p.rates?.TEK || 0),
    BIL: Number(p.rates?.BIL || 0),
  },
});

const normalizeOrder = (o) => ({
  ...o,
  type: o.type === "felanmalan" || o.type === "tillaggstjanst" ? o.type : "tillaggstjanst",
  status: o.status === "Klar" || o.status === "Avslutad" ? "Klar" : "Pågår",
  reportedDate: o.reportedDate || o.createdAt || todayISO(),
  priceCategory: o.priceCategory === "FA" || o.priceCategory === "TEK" ? o.priceCategory : "FA",
  billCount: Number(o.billCount || 0),
  billInvoicedInBasisId: o.billInvoicedInBasisId || null,
});

const normalize = (loaded) => {
  const orders = (loaded.billableOrders || []).map(normalizeOrder);
  let counter = loaded.nextOrderNumber || 1;
  const numberedOrders = orders.map((o) => {
    if (o.orderNumber) return o;
    const numbered = { ...o, orderNumber: counter };
    counter += 1;
    return numbered;
  });
  return {
    ...seedState(),
    ...loaded,
    properties: (loaded.properties || seedState().properties).map(normalizeProperty),
    billableOrders: numberedOrders,
    billableTimeEntries: loaded.billableTimeEntries || [],
    invoiceBasis: loaded.invoiceBasis || [],
    nextOrderNumber: counter,
  };
};

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
  const [propertyModal, setPropertyModal] = useState(null); // null | "add" | { editId }

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 2600);
      return () => clearTimeout(t);
    }
  }, [toast]);

  const notify = (msg) => setToast(msg);

  // Om den valda föreningen tas bort, gå tillbaka till "Alla" — men rör
  // aldrig "Alla" i sig, det är alltid ett giltigt läge.
  useEffect(() => {
    if (!state || propertyId === "all") return;
    const stillExists = state.properties.some((p) => p.id === propertyId);
    if (!stillExists) {
      setPropertyId("all");
    }
  }, [state, propertyId]);

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
  const scopedProps = propertyId === "all" ? properties : properties.filter((p) => p.id === propertyId);
  const selectedProperty = propertyId === "all" ? null : scopedProps[0] || null;
  const billing = createBillingActions(state, setState, name, notify);

  const savePropertyForm = (payload) => {
    if (propertyModal && propertyModal !== "add") {
      setState({
        ...state,
        properties: state.properties.map((p) =>
          p.id === propertyModal.editId ? { ...p, ...payload } : p
        ),
      });
      notify("Bostadsrättsförening uppdaterad");
    } else {
      const newProp = { id: uid(), ...payload };
      setState({ ...state, properties: [...state.properties, newProp] });
      setPropertyId(newProp.id);
      notify("Bostadsrättsförening tillagd");
    }
    setPropertyModal(null);
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
    notify("Bostadsrättsförening borttagen");
  };

  const tabs = [
    { id: "oversikt", label: "Översikt" },
    { id: "uppgifter", label: "Uppgifter" },
    { id: "checklistor", label: "Checklistor" },
    { id: "arenden", label: "Ärenden" },
    { id: "felanmalan", label: "Felanmälan" },
    { id: "tillaggstjanst", label: "Tilläggstjänster" },
    { id: "debitering", label: "Debitering" },
    { id: "kalender", label: "Kalender" },
    { id: "backup", label: "Backup" },
  ];

  const editingProperty =
    propertyModal && propertyModal !== "add"
      ? properties.find((p) => p.id === propertyModal.editId)
      : null;

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
        onAddNew={() => setPropertyModal("add")}
        name={name}
        setName={setName}
        saving={saving}
        lastSavedAt={lastSavedAt}
      />

      {properties.length === 0 ? (
        <main style={S.main} className="fk-scroll">
          <div style={{ maxWidth: 560, margin: "40px auto 0" }}>
            <div style={{ ...S.taskCardTitle, fontSize: 19, marginBottom: 6 }}>
              Välkommen! Lägg till er första bostadsrättsförening
            </div>
            <div style={{ ...S.rowSub, marginBottom: 16 }}>
              Allt i appen — uppgifter, checklistor, ärenden och debitering — organiseras per
              förening. Börja med att lägga till en.
            </div>
            <PropertyForm onSubmit={savePropertyForm} onCancel={null} />
          </div>
        </main>
      ) : (
        <>
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
              <Oversikt
                state={state}
                scopedProps={scopedProps}
                selectedProperty={selectedProperty}
                setTab={setTab}
                onEditProperty={() => setPropertyModal({ editId: selectedProperty.id })}
                onRemoveProperty={removeProperty}
              />
            )}
            {tab === "uppgifter" && (
              <Uppgifter
                state={state}
                setState={setState}
                scopedProps={scopedProps}
                actor={name}
                notify={notify}
              />
            )}
            {tab === "checklistor" && (
              <Checklistor
                state={state}
                setState={setState}
                scopedProps={scopedProps}
                actor={name}
                notify={notify}
              />
            )}
            {tab === "arenden" && (
              <Arenden
                state={state}
                setState={setState}
                scopedProps={scopedProps}
                actor={name}
                notify={notify}
              />
            )}
            {tab === "felanmalan" && (
              <ArendeQueue
                type="felanmalan"
                title="Felanmälningar"
                newLabel="+ Ny felanmälan"
                titleFieldLabel="Vad är felet?"
                titlePlaceholder="t.ex. Läckande stamledning"
                emptyText="Inga pågående felanmälningar. Registrera en, och klarmarkera när jobbet är utfört — då flyttas den till Debitering."
                state={state}
                scopedProps={scopedProps}
                billing={billing}
                notify={notify}
              />
            )}
            {tab === "tillaggstjanst" && (
              <ArendeQueue
                type="tillaggstjanst"
                title="Tilläggstjänster"
                newLabel="+ Ny tilläggstjänst"
                titleFieldLabel="Vad gäller tjänsten?"
                titlePlaceholder="t.ex. Extra röjning på begäran"
                emptyText="Inga pågående tilläggstjänster. Registrera en, och klarmarkera när jobbet är utfört — då flyttas den till Debitering."
                state={state}
                scopedProps={scopedProps}
                billing={billing}
                notify={notify}
              />
            )}
            {tab === "debitering" && (
              <Debitering
                state={state}
                scopedProps={scopedProps}
                billing={billing}
                notify={notify}
              />
            )}
            {tab === "kalender" && <Kalender state={state} scopedProps={scopedProps} />}
            {tab === "backup" && (
              <Backup state={state} setState={setState} notify={notify} lastSavedAt={lastSavedAt} />
            )}
          </main>
        </>
      )}

      {propertyModal && properties.length > 0 && (
        <Modal onClose={() => setPropertyModal(null)}>
          <div style={S.taskCardTitle}>
            {propertyModal === "add" ? "Ny bostadsrättsförening" : "Redigera förening"}
          </div>
          <PropertyForm
            initial={editingProperty}
            onSubmit={savePropertyForm}
            onCancel={() => setPropertyModal(null)}
          />
        </Modal>
      )}

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

/* ------------------------------ modal ------------------------------ */

function Modal({ children, onClose }) {
  return (
    <div style={S.modalBackdrop} onClick={onClose}>
      <div style={S.modalPanel} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} style={S.modalClose} aria-label="Stäng">×</button>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------ header ------------------------------ */

function Header({ properties, propertyId, setPropertyId, onAddNew, name, setName, saving, lastSavedAt }) {
  const savedLabel = saving
    ? "sparar…"
    : lastSavedAt
    ? `sparat ${lastSavedAt.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" })}`
    : "föreningsjournal";
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
        {properties.length > 0 && (
          <select
            className="fk-input"
            value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}
            style={S.selectHeader}
          >
            <option value="all">Alla bostadsrättsföreningar</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={onAddNew}
          style={S.addPropertyBtn}
          className="fk-btn"
          title="Lägg till ny bostadsrättsförening"
        >
          + Förening
        </button>
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

/* ------------------------------ bostadsrättsförening ------------------------------ */

function PropertyForm({ initial, onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name || "");
  const [address, setAddress] = useState(initial?.address || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [faRate, setFaRate] = useState(initial?.rates?.FA ?? "");
  const [tekRate, setTekRate] = useState(initial?.rates?.TEK ?? "");
  const [bilRate, setBilRate] = useState(initial?.rates?.BIL ?? "");
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
    onSubmit({
      name: name.trim(),
      address: address.trim(),
      notes: notes.trim(),
      contacts: cleanContacts,
      rates: { FA: Number(faRate) || 0, TEK: Number(tekRate) || 0, BIL: Number(bilRate) || 0 },
    });
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.formRow}>
        <label style={S.label}>
          Föreningens namn
          <input className="fk-input" style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="t.ex. BRF Kvarngatan 4" required />
        </label>
        <label style={S.label}>
          Adress
          <input className="fk-input" style={S.input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Gatuadress, postnr, ort" />
        </label>
      </div>

      <div>
        <div style={{ ...S.label, marginBottom: 8 }}>
          Prissättning — kopplas till Felanmälan/Tilläggstjänster och används för nyckeltalen i Debitering
        </div>
        <div style={S.formRow}>
          <label style={S.label}>
            FA — kr/h
            <input
              className="fk-input"
              style={S.input}
              type="number"
              min="0"
              value={faRate}
              onChange={(e) => setFaRate(e.target.value)}
              placeholder="t.ex. 650"
            />
          </label>
          <label style={S.label}>
            TEK — kr/h
            <input
              className="fk-input"
              style={S.input}
              type="number"
              min="0"
              value={tekRate}
              onChange={(e) => setTekRate(e.target.value)}
              placeholder="t.ex. 850"
            />
          </label>
        </div>
        <div style={{ ...S.formRow, marginTop: 10 }}>
          <label style={S.label}>
            BIL — kr/styck
            <input
              className="fk-input"
              style={S.input}
              type="number"
              min="0"
              value={bilRate}
              onChange={(e) => setBilRate(e.target.value)}
              placeholder="t.ex. 50"
            />
          </label>
          <div />
        </div>
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
        <button type="submit" style={S.primaryBtn} className="fk-btn">
          {initial ? "Spara ändringar" : "Spara förening"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} style={S.secondaryBtn} className="fk-btn">
            Avbryt
          </button>
        )}
      </div>
    </form>
  );
}

/* ------------------------------ översikt ------------------------------ */


function Oversikt({ state, scopedProps, selectedProperty, setTab, onEditProperty, onRemoveProperty }) {
  const ids = new Set(scopedProps.map((p) => p.id));
  const tasks = state.tasks.filter((t) => ids.has(t.propertyId));
  const issues = state.issues.filter((i) => ids.has(i.propertyId));
  const orders = state.billableOrders || [];
  const today = todayISO();

  const overdue = tasks.filter((t) => t.nextDue < today);
  const dueSoon = tasks.filter((t) => t.nextDue >= today && daysBetween(today, t.nextDue) <= 7);
  const openIssues = issues.filter((i) => i.status !== "Klar");
  const acuteIssues = openIssues.filter((i) => i.priority === "Akut");
  const openFelanmalan = orders.filter((o) => ids.has(o.propertyId) && o.type === "felanmalan" && o.status !== "Klar");
  const openTillaggstjanst = orders.filter((o) => ids.has(o.propertyId) && o.type === "tillaggstjanst" && o.status !== "Klar");

  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      {selectedProperty && (
        <div style={{ ...S.checklistCard, marginBottom: 18 }}>
          <div style={S.checklistHead}>
            <div>
              <div style={{ ...S.taskCardTitle, fontSize: 19 }}>{selectedProperty.name}</div>
              <div style={S.taskCardProp}>{selectedProperty.address || "Ingen adress angiven"}</div>
              <div style={{ ...S.rowSub, marginTop: 4 }}>
                FA {selectedProperty.rates?.FA || 0} kr/h · TEK {selectedProperty.rates?.TEK || 0} kr/h · BIL {selectedProperty.rates?.BIL || 0} kr/st
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={S.stampBtn} className="fk-btn" onClick={onEditProperty}>
                Redigera
              </button>
              {confirmingDelete ? (
                <button
                  style={{ ...S.stampBtn, background: "#C4171C" }}
                  className="fk-btn"
                  onClick={() => onRemoveProperty(selectedProperty.id)}
                >
                  Bekräfta borttagning
                </button>
              ) : (
                <button style={S.miniDelete} onClick={() => setConfirmingDelete(true)} aria-label="Ta bort förening">×</button>
              )}
            </div>
          </div>

          {(selectedProperty.contacts || []).length > 0 && (
            <div style={S.runBox}>
              {selectedProperty.contacts.map((c) => (
                <div key={c.id} style={S.contactRow}>
                  <span style={S.contactRole}>{c.role}</span>
                  <span style={S.contactName}>{c.name}</span>
                  <span style={S.rowSub}>{[c.phone, c.email].filter(Boolean).join(" · ") || "—"}</span>
                </div>
              ))}
            </div>
          )}

          {selectedProperty.notes && (
            <div style={S.historyRow}>
              <button onClick={() => setNotesExpanded((v) => !v)} style={S.linkBtn}>
                {notesExpanded ? "Dölj anteckningar" : "Visa anteckningar"}
              </button>
              {notesExpanded && (
                <div style={{ ...S.rowSub, marginTop: 6, whiteSpace: "pre-wrap" }}>{selectedProperty.notes}</div>
              )}
            </div>
          )}
        </div>
      )}

      {!selectedProperty && (
        <div style={{ ...S.panel, marginBottom: 18 }}>
          <h2 style={{ ...S.h2, marginBottom: 4 }}>Alla bostadsrättsföreningar</h2>
          <div style={{ ...S.rowSub, marginBottom: 14 }}>
            Sammanställning över samtliga {scopedProps.length} föreningar. Välj en specifik förening i listan högst upp för att se och redigera dess detaljer.
          </div>
          {scopedProps.length === 0 ? (
            <EmptyNote text="Inga bostadsrättsföreningar ännu." />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={S.summaryTable}>
                <thead>
                  <tr>
                    <th style={S.summaryTh}>Förening</th>
                    <th style={S.summaryTh}>Försenade</th>
                    <th style={S.summaryTh}>Öppna ärenden</th>
                    <th style={S.summaryTh}>Öppna felanmälningar</th>
                    <th style={S.summaryTh}>Öppna tilläggstjänster</th>
                  </tr>
                </thead>
                <tbody>
                  {scopedProps.map((p) => {
                    const pTasks = tasks.filter((t) => t.propertyId === p.id);
                    const pOverdue = pTasks.filter((t) => t.nextDue < today).length;
                    const pOpenIssues = issues.filter((i) => i.propertyId === p.id && i.status !== "Klar").length;
                    const pOpenFelanmalan = openFelanmalan.filter((o) => o.propertyId === p.id).length;
                    const pOpenTillaggstjanst = openTillaggstjanst.filter((o) => o.propertyId === p.id).length;
                    return (
                      <tr key={p.id}>
                        <td style={S.summaryTd}>{p.name}</td>
                        <td style={{ ...S.summaryTd, color: pOverdue ? "#C4171C" : "#5C594E" }}>{pOverdue}</td>
                        <td style={{ ...S.summaryTd, color: pOpenIssues ? "#EA5B0C" : "#5C594E" }}>{pOpenIssues}</td>
                        <td style={{ ...S.summaryTd, color: pOpenFelanmalan ? "#EA5B0C" : "#5C594E" }}>{pOpenFelanmalan}</td>
                        <td style={{ ...S.summaryTd, color: pOpenTillaggstjanst ? "#EA5B0C" : "#5C594E" }}>{pOpenTillaggstjanst}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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
          label="Öppna felanmälningar"
          value={openFelanmalan.length}
          tone={openFelanmalan.length ? "warn" : "neutral"}
          onClick={() => setTab("felanmalan")}
        />
        <StatCard
          label="Öppna tilläggstjänster"
          value={openTillaggstjanst.length}
          tone={openTillaggstjanst.length ? "accent" : "neutral"}
          onClick={() => setTab("tillaggstjanst")}
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

function Uppgifter({ state, setState, scopedProps, actor, notify }) {
  const [showForm, setShowForm] = useState(false);
  const ids = new Set(scopedProps.map((p) => p.id));
  const showPropertyTag = scopedProps.length > 1;
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";
  const today = todayISO();

  const tasks = state.tasks
    .filter((t) => ids.has(t.propertyId))
    .sort((a, b) => (a.nextDue < b.nextDue ? -1 : 1));

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

      {showForm && <TaskForm properties={scopedProps} onSubmit={addTask} />}

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
                <div style={S.taskCardTitle}>
                  {t.title}
                  {showPropertyTag && <span style={S.propertyTag}>{propName(t.propertyId)}</span>}
                </div>
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

function PropertyPicker({ properties, value, onChange }) {
  if (properties.length <= 1) return null;
  return (
    <label style={S.label}>
      Bostadsrättsförening
      <select className="fk-input" style={S.input} value={value} onChange={(e) => onChange(e.target.value)}>
        {properties.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </label>
  );
}

function TaskForm({ properties, onSubmit }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [intervalDays, setIntervalDays] = useState(30);
  const [propertyId, setPropertyId] = useState(properties[0]?.id || "");

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
        <PropertyPicker properties={properties} value={propertyId} onChange={setPropertyId} />
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

function Checklistor({ state, setState, scopedProps, actor, notify }) {
  const [showForm, setShowForm] = useState(false);
  const ids = new Set(scopedProps.map((p) => p.id));
  const showPropertyTag = scopedProps.length > 1;
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";
  const templates = state.checklistTemplates.filter((t) => ids.has(t.propertyId));

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

      {showForm && <ChecklistForm properties={scopedProps} onSubmit={addTemplate} />}

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
                    <div style={S.taskCardTitle}>
                      {tmpl.title}
                      {showPropertyTag && <span style={S.propertyTag}>{propName(tmpl.propertyId)}</span>}
                    </div>
                    <div style={S.taskCardProp}>{tmpl.items.length} punkter</div>
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

function ChecklistForm({ properties, onSubmit }) {
  const [title, setTitle] = useState("");
  const [itemsText, setItemsText] = useState("");
  const [propertyId, setPropertyId] = useState(properties[0]?.id || "");

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
        <PropertyPicker properties={properties} value={propertyId} onChange={setPropertyId} />
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

function Arenden({ state, setState, scopedProps, actor, notify }) {
  const [showForm, setShowForm] = useState(false);
  const ids = new Set(scopedProps.map((p) => p.id));
  const showPropertyTag = scopedProps.length > 1;
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";
  const issues = state.issues
    .filter((i) => ids.has(i.propertyId))
    .sort((a, b) => (a.reportedAt < b.reportedAt ? 1 : -1));

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

      {showForm && <IssueForm properties={scopedProps} onSubmit={addIssue} />}

      {issues.length === 0 ? (
        <EmptyNote text="Inga ärenden registrerade." />
      ) : (
        <div style={S.checklistStack}>
          {issues.map((i) => (
            <div key={i.id} style={{ ...S.checklistCard, borderColor: i.priority === "Akut" ? "#C4171C" : "#C9C4B7" }}>
              <div style={S.checklistHead}>
                <div>
                  <div style={S.taskCardTitle}>
                    {i.title}
                    {showPropertyTag && <span style={S.propertyTag}>{propName(i.propertyId)}</span>}
                  </div>
                  <div style={S.taskCardProp}>
                    Anmält {fmtDate(i.reportedAt)} av {i.reportedBy}
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

function IssueForm({ properties, onSubmit }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("Normal");
  const [propertyId, setPropertyId] = useState(properties[0]?.id || "");

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
        <PropertyPicker properties={properties} value={propertyId} onChange={setPropertyId} />
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

/* ------------------------------ billing actions (shared) ------------------------------ */

function createBillingActions(state, setState, actor, notify) {
  const timeEntries = state.billableTimeEntries || [];
  const invoiceBasis = state.invoiceBasis || [];

  const entriesFor = (orderId) => timeEntries.filter((e) => e.orderId === orderId);
  const loggedHours = (orderId) => entriesFor(orderId).reduce((s, e) => s + Number(e.hours || 0), 0);
  const unbilledHours = (orderId) =>
    entriesFor(orderId)
      .filter((e) => !e.invoicedInBasisId)
      .reduce((s, e) => s + Number(e.hours || 0), 0);

  const rateFor = (order) => {
    const property = state.properties.find((p) => p.id === order.propertyId);
    return Number(property?.rates?.[order.priceCategory] || 0);
  };

  const billRateFor = (order) => {
    const property = state.properties.find((p) => p.id === order.propertyId);
    return Number(property?.rates?.BIL || 0);
  };

  const addOrder = (type, payload) => {
    const orderNumber = state.nextOrderNumber || 1;
    const order = {
      id: uid(),
      ...payload,
      type,
      orderNumber,
      status: "Pågår",
      createdAt: todayISO(),
      createdBy: actor || "Okänd",
      completedAt: null,
      billCount: Number(payload.billCount || 0),
      billInvoicedInBasisId: null,
    };
    setState({
      ...state,
      billableOrders: [...(state.billableOrders || []), order],
      nextOrderNumber: orderNumber + 1,
    });
    notify(type === "felanmalan" ? "Felanmälan registrerad" : "Tilläggstjänst registrerad");
    return order;
  };

  const removeOrder = (id) => {
    setState({
      ...state,
      billableOrders: (state.billableOrders || []).filter((o) => o.id !== id),
      billableTimeEntries: timeEntries.filter((e) => e.orderId !== id),
      invoiceBasis: invoiceBasis.filter((b) => b.orderId !== id),
    });
  };

  const setOrderStatus = (order, status) => {
    setState({
      ...state,
      billableOrders: state.billableOrders.map((o) =>
        o.id === order.id
          ? { ...o, status, completedAt: status === "Klar" ? todayISO() : null }
          : o
      ),
    });
    if (status === "Klar") notify(`${order.title} klarmarkerad — flyttad till Debitering`);
    else notify(`${order.title} återöppnad`);
  };

  const updateBillCount = (order, count) => {
    setState({
      ...state,
      billableOrders: state.billableOrders.map((o) =>
        o.id === order.id ? { ...o, billCount: Math.max(0, Number(count) || 0) } : o
      ),
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
    const includeBil = order.billCount > 0 && !order.billInvoicedInBasisId;
    const basisId = uid();
    const basis = {
      id: basisId,
      orderId: order.id,
      propertyId: order.propertyId,
      title: order.title,
      createdAt: todayISO(),
      createdBy: actor || "Okänd",
      rate: rateFor(order),
      loggedHours: unbilled.reduce((s, e) => s + Number(e.hours || 0), 0),
      adjustedHours: Number(adjustedHours),
      note: note.trim(),
      entryIds: unbilled.map((e) => e.id),
      billCount: includeBil ? order.billCount : 0,
      billRate: includeBil ? billRateFor(order) : 0,
    };
    setState({
      ...state,
      invoiceBasis: [...invoiceBasis, basis],
      billableTimeEntries: timeEntries.map((e) =>
        unbilled.find((u) => u.id === e.id) ? { ...e, invoicedInBasisId: basisId } : e
      ),
      billableOrders: state.billableOrders.map((o) =>
        o.id === order.id && includeBil ? { ...o, billInvoicedInBasisId: basisId } : o
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
      billableOrders: state.billableOrders.map((o) =>
        o.billInvoicedInBasisId === basis.id ? { ...o, billInvoicedInBasisId: null } : o
      ),
    });
    notify("Faktureringsunderlag borttaget, timmarna är öppna igen");
  };

  return {
    entriesFor,
    loggedHours,
    unbilledHours,
    rateFor,
    billRateFor,
    addOrder,
    removeOrder,
    setOrderStatus,
    updateBillCount,
    addTimeEntry,
    removeTimeEntry,
    createBasis,
    updateBasisHours,
    removeBasis,
  };
}

/* ------------------------------ debitering ------------------------------ */

function Debitering({ state, scopedProps, billing, notify }) {
  const [openOrderId, setOpenOrderId] = useState(null);
  const [printingBasis, setPrintingBasis] = useState(null); // { basis, order }
  const [sortBy, setSortBy] = useState("datum-senaste");
  const [filterType, setFilterType] = useState("alla");
  const [filterCategory, setFilterCategory] = useState("alla");
  const [filterProperty, setFilterProperty] = useState("alla");

  const ids = new Set(scopedProps.map((p) => p.id));
  const showPropertyTag = scopedProps.length > 1;
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";
  const orders = (state.billableOrders || []).filter((o) => ids.has(o.propertyId) && o.status === "Klar");
  const invoiceBasis = state.invoiceBasis || [];
  const propertyBasis = invoiceBasis.filter((b) => ids.has(b.propertyId));
  const hasBasis = (orderId) => invoiceBasis.some((b) => b.orderId === orderId);

  const filteredOrders = filterOrders(orders, { type: filterType, category: filterCategory }).filter(
    (o) => filterProperty === "alla" || o.propertyId === filterProperty
  );
  const filteredOrderIds = new Set(filteredOrders.map((o) => o.id));
  const toInvoice = filteredOrders.filter((o) => !hasBasis(o.id));
  const alreadyInvoiced = filteredOrders.filter((o) => hasBasis(o.id));

  const totalUnbilled = filteredOrders.reduce((s, o) => s + billing.unbilledHours(o.id), 0);
  const totalUnbilledAmount = filteredOrders.reduce(
    (s, o) => s + billing.unbilledHours(o.id) * billing.rateFor(o),
    0
  );

  const filteredBasis = propertyBasis.filter((b) => filteredOrderIds.has(b.orderId));
  const totalLogged = filteredBasis.reduce((s, b) => s + Number(b.loggedHours || 0), 0);
  const totalInvoiced = filteredBasis.reduce((s, b) => s + Number(b.adjustedHours || 0), 0);
  const writtenOff = Math.max(0, totalLogged - totalInvoiced);
  const debiteringsgrad = totalLogged > 0 ? Math.round((totalInvoiced / totalLogged) * 1000) / 10 : null;
  const filterActive = filterType !== "alla" || filterCategory !== "alla" || filterProperty !== "alla";

  const loggedAmountKr = filteredBasis.reduce((s, b) => s + Number(b.loggedHours || 0) * Number(b.rate || 0), 0);
  const invoicedAmountKr = filteredBasis.reduce((s, b) => s + Number(b.adjustedHours || 0) * Number(b.rate || 0), 0);
  const writtenOffAmountKr = Math.max(0, loggedAmountKr - invoicedAmountKr);
  const bilTotalKr = filteredBasis.reduce((s, b) => s + Number(b.billCount || 0) * Number(b.billRate || 0), 0);

  const orderInvoicedAmount = (orderId) =>
    invoiceBasis
      .filter((b) => b.orderId === orderId)
      .reduce(
        (s, b) =>
          s +
          Number(b.adjustedHours || 0) * Number(b.rate || 0) +
          Number(b.billCount || 0) * Number(b.billRate || 0),
        0
      );
  const orderInvoicedHours = (orderId) =>
    invoiceBasis.filter((b) => b.orderId === orderId).reduce((s, b) => s + Number(b.adjustedHours || 0), 0);

  const openOrder = openOrderId ? orders.find((o) => o.id === openOrderId) : null;

  if (printingBasis) {
    return (
      <PrintableBasis
        basis={printingBasis.basis}
        order={printingBasis.order}
        propertyName={propName(printingBasis.order.propertyId)}
        onClose={() => setPrintingBasis(null)}
        notify={notify}
      />
    );
  }

  if (openOrder) {
    return (
      <OrderDetail
        order={openOrder}
        propertyName={propName(openOrder.propertyId)}
        entries={billing.entriesFor(openOrder.id).sort((a, b) => (a.date < b.date ? 1 : -1))}
        basisList={invoiceBasis.filter((b) => b.orderId === openOrder.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))}
        loggedHours={billing.loggedHours(openOrder.id)}
        unbilledHours={billing.unbilledHours(openOrder.id)}
        rate={billing.rateFor(openOrder)}
        bilRate={billing.billRateFor(openOrder)}
        onUpdateBillCount={(count) => billing.updateBillCount(openOrder, count)}
        allowInvoicing
        onBack={() => setOpenOrderId(null)}
        onAddEntry={(payload) => billing.addTimeEntry(openOrder, payload)}
        onRemoveEntry={billing.removeTimeEntry}
        onReopen={() => billing.setOrderStatus(openOrder, "Pågår")}
        onCreateBasis={(hours, note) => billing.createBasis(openOrder, hours, note)}
        onUpdateBasisHours={billing.updateBasisHours}
        onRemoveBasis={billing.removeBasis}
        onPrintBasis={(basis) => setPrintingBasis({ basis, order: openOrder })}
      />
    );
  }

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.sectionHead}>
        <h2 style={S.h2}>Debitering</h2>
      </div>

      {orders.length > 0 && (
        <SortFilterBar
          sortBy={sortBy}
          setSortBy={setSortBy}
          filterType={filterType}
          setFilterType={setFilterType}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterProperty={filterProperty}
          setFilterProperty={setFilterProperty}
          properties={scopedProps}
        />
      )}

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
          <div style={S.statValue}>{filteredOrders.length}</div>
          <div style={S.statLabel}>Klarmarkerade ärenden</div>
        </div>
      </div>

      <div style={S.panel}>
        <h3 style={S.panelTitle}>Debiteringsgrad{filterActive ? " — filtrerat urval" : " — föreningen totalt"}</h3>
        <div style={S.kpiRow}>
          <div style={S.kpiBlock}>
            <div style={S.kpiValue}>{totalLogged}</div>
            <div style={S.kpiLabel}>Totalt registrerad tid (h)</div>
          </div>
          <div style={S.kpiBlock}>
            <div style={{ ...S.kpiValue, color: "#2B6E5E" }}>{totalInvoiced}</div>
            <div style={S.kpiLabel}>Fakturerad tid (h)</div>
          </div>
          <div style={S.kpiBlock}>
            <div style={{ ...S.kpiValue, color: "#C4171C" }}>{writtenOff}</div>
            <div style={S.kpiLabel}>Debiterad men ej fakturerad tid (h)</div>
          </div>
          <div style={S.kpiBlock}>
            <div style={{ ...S.kpiValue, color: "#EA5B0C" }}>
              {debiteringsgrad === null ? "–" : `${debiteringsgrad}%`}
            </div>
            <div style={S.kpiLabel}>Debiteringsgrad</div>
          </div>
        </div>

        <div style={S.kpiDivider} />

        <div style={S.kpiRow}>
          <div style={S.kpiBlock}>
            <div style={{ ...S.kpiValue, color: "#2B6E5E" }}>{invoicedAmountKr.toLocaleString("sv-SE")} kr</div>
            <div style={S.kpiLabel}>Fakturerat belopp</div>
          </div>
          <div style={S.kpiBlock}>
            <div style={{ ...S.kpiValue, color: "#C4171C" }}>{writtenOffAmountKr.toLocaleString("sv-SE")} kr</div>
            <div style={S.kpiLabel}>Debiterbart men ej fakturerat belopp</div>
          </div>
          <div style={S.kpiBlock}>
            <div style={{ ...S.kpiValue, color: "#1C2321" }}>{bilTotalKr.toLocaleString("sv-SE")} kr</div>
            <div style={S.kpiLabel}>Totalt för Bil</div>
          </div>
        </div>

        {totalLogged === 0 && (
          <div style={{ ...S.rowSub, marginTop: 10 }}>
            Nyckeltalen fylls i allt eftersom faktureringsunderlag skapas nedan.
          </div>
        )}
      </div>


      <h3 style={{ ...S.panelTitle, marginTop: 20 }}>Klarmarkerade ärenden att fakturera</h3>
      {toInvoice.length === 0 ? (
        <EmptyNote text={orders.length > 0 ? "Inga ärenden matchar filtret." : "Inga ärenden väntar på fakturaunderlag just nu."} />
      ) : (
        <div style={S.checklistStack}>
          {sortOrders(toInvoice, sortBy, (o) => ({
            date: o.completedAt,
            hours: billing.loggedHours(o.id),
            amount: billing.unbilledHours(o.id) * billing.rateFor(o),
          })).map((o) => (
            <DebiteringOrderCard
              key={o.id}
              order={o}
              billing={billing}
              propertyName={showPropertyTag ? propName(o.propertyId) : null}
              onOpen={() => setOpenOrderId(o.id)}
              onRemove={() => billing.removeOrder(o.id)}
            />
          ))}
        </div>
      )}

      <h3 style={{ ...S.panelTitle, marginTop: 28 }}>Fakturerade ärenden</h3>
      {alreadyInvoiced.length === 0 ? (
        <EmptyNote text={orders.length > 0 ? "Inga ärenden matchar filtret." : "Inga fakturerade ärenden ännu. Ärenden hamnar här så fort ett faktureringsunderlag skapats."} />
      ) : (
        <div style={S.checklistStack}>
          {sortOrders(alreadyInvoiced, sortBy, (o) => ({
            date: o.completedAt,
            hours: orderInvoicedHours(o.id),
            amount: orderInvoicedAmount(o.id),
          })).map((o) => (
              <div key={o.id} style={S.checklistCardInvoiced}>
                <div style={S.checklistHead}>
                  <div>
                    <div style={S.taskCardTitle}>
                      <span style={S.orderNumberTag}>#{o.orderNumber}</span> {o.title}
                      <span style={S.typeTag}>
                        {o.type === "felanmalan" ? "Felanmälan" : "Tilläggstjänst"}
                      </span>
                      {showPropertyTag && <span style={S.propertyTag}>{propName(o.propertyId)}</span>}
                    </div>
                    <div style={S.taskCardProp}>
                      Inkom {fmtDate(o.reportedDate)} · klarmarkerad {fmtDate(o.completedAt)}
                    </div>
                  </div>
                  <button style={S.miniDelete} onClick={() => billing.removeOrder(o.id)} aria-label="Ta bort ärende">×</button>
                </div>
                <div style={S.issueFooter}>
                  <span style={S.rowSub}>
                    {orderInvoicedHours(o.id)} h fakturerat · {orderInvoicedAmount(o.id).toLocaleString("sv-SE")} kr
                    {o.billCount > 0 && ` · 🚗 ${o.billCount} st`}
                    {billing.unbilledHours(o.id) > 0 && ` · ${billing.unbilledHours(o.id)} h kvar att fakturera`}
                  </span>
                  <button style={S.stampBtn} className="fk-btn" onClick={() => setOpenOrderId(o.id)}>
                    Visa underlag
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function DebiteringOrderCard({ order: o, billing, propertyName, onOpen, onRemove }) {
  const logged = billing.loggedHours(o.id);
  const unbilled = billing.unbilledHours(o.id);
  return (
    <div style={S.checklistCardPending}>
      <div style={S.checklistHead}>
        <div>
          <div style={S.taskCardTitle}>
            <span style={S.orderNumberTag}>#{o.orderNumber}</span> {o.title}
            <span style={S.typeTag}>{o.type === "felanmalan" ? "Felanmälan" : "Tilläggstjänst"}</span>
            {propertyName && <span style={S.propertyTag}>{propertyName}</span>}
          </div>
          <div style={S.taskCardProp}>
            Inkom {fmtDate(o.reportedDate)} · klarmarkerad {fmtDate(o.completedAt)}
          </div>
          {o.description && <div style={{ ...S.rowSub, marginTop: 6 }}>{o.description}</div>}
        </div>
        <button style={S.miniDelete} onClick={onRemove} aria-label="Ta bort ärende">×</button>
      </div>
      <div style={S.issueFooter}>
        <span style={S.rowSub}>
          {logged} h loggat · {unbilled} h att fakturera{o.priceCategory ? ` · ${o.priceCategory} (${billing.rateFor(o)} kr/h)` : ""}
          {o.billCount > 0 && ` · 🚗 ${o.billCount} st`}
        </span>
        <button style={S.stampBtn} className="fk-btn" onClick={onOpen}>
          Hantera fakturering
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ felanmälan / tilläggstjänster (delad kö) ------------------------------ */

function ArendeQueue({ type, title, newLabel, titleFieldLabel, titlePlaceholder, emptyText, state, scopedProps, billing, notify }) {
  const [showForm, setShowForm] = useState(false);
  const [openOrderId, setOpenOrderId] = useState(null);
  const [printingBasis, setPrintingBasis] = useState(null);
  const [sortBy, setSortBy] = useState("datum-senaste");
  const [filterCategory, setFilterCategory] = useState("alla");
  const [filterProperty, setFilterProperty] = useState("alla");

  const ids = new Set(scopedProps.map((p) => p.id));
  const showPropertyTag = scopedProps.length > 1;
  const propName = (id) => state.properties.find((p) => p.id === id)?.name || "";
  const invoiceBasis = state.invoiceBasis || [];
  const allActiveOrders = (state.billableOrders || []).filter(
    (o) => ids.has(o.propertyId) && o.type === type && o.status !== "Klar"
  );
  const orders = filterOrders(allActiveOrders, { category: filterCategory }).filter(
    (o) => filterProperty === "alla" || o.propertyId === filterProperty
  );

  const addOrder = (payload) => {
    billing.addOrder(type, payload);
    setShowForm(false);
  };

  const openOrder = openOrderId ? orders.find((o) => o.id === openOrderId) : null;

  if (printingBasis) {
    return (
      <PrintableBasis
        basis={printingBasis.basis}
        order={printingBasis.order}
        propertyName={propName(printingBasis.order.propertyId)}
        onClose={() => setPrintingBasis(null)}
        notify={notify}
      />
    );
  }

  if (openOrder) {
    return (
      <OrderDetail
        order={openOrder}
        propertyName={propName(openOrder.propertyId)}
        entries={billing.entriesFor(openOrder.id).sort((a, b) => (a.date < b.date ? 1 : -1))}
        basisList={invoiceBasis.filter((b) => b.orderId === openOrder.id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))}
        loggedHours={billing.loggedHours(openOrder.id)}
        unbilledHours={billing.unbilledHours(openOrder.id)}
        rate={billing.rateFor(openOrder)}
        bilRate={billing.billRateFor(openOrder)}
        onUpdateBillCount={(count) => billing.updateBillCount(openOrder, count)}
        onBack={() => setOpenOrderId(null)}
        onAddEntry={(payload) => billing.addTimeEntry(openOrder, payload)}
        onRemoveEntry={billing.removeTimeEntry}
        onComplete={() => {
          billing.setOrderStatus(openOrder, "Klar");
          setOpenOrderId(null);
        }}
        onCreateBasis={(hours, note) => billing.createBasis(openOrder, hours, note)}
        onUpdateBasisHours={billing.updateBasisHours}
        onRemoveBasis={billing.removeBasis}
        onPrintBasis={(basis) => setPrintingBasis({ basis, order: openOrder })}
      />
    );
  }

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={S.sectionHead}>
        <h2 style={S.h2}>{title}</h2>
        <button style={S.primaryBtn} className="fk-btn" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Avbryt" : newLabel}
        </button>
      </div>

      {showForm && (
        <ArendeForm
          properties={scopedProps}
          nextOrderNumber={state.nextOrderNumber || 1}
          titleFieldLabel={titleFieldLabel}
          titlePlaceholder={titlePlaceholder}
          onSubmit={addOrder}
        />
      )}

      {allActiveOrders.length > 0 && (
        <SortFilterBar
          sortBy={sortBy}
          setSortBy={setSortBy}
          filterCategory={filterCategory}
          setFilterCategory={setFilterCategory}
          filterProperty={filterProperty}
          setFilterProperty={setFilterProperty}
          properties={scopedProps}
        />
      )}

      {orders.length === 0 ? (
        <EmptyNote text={allActiveOrders.length > 0 ? "Inga ärenden matchar filtret." : emptyText} />
      ) : (
        <div style={S.checklistStack}>
          {sortOrders(orders, sortBy, (o) => ({
            date: o.reportedDate,
            hours: billing.loggedHours(o.id),
            amount: billing.loggedHours(o.id) * billing.rateFor(o),
          })).map((o) => {
              const logged = billing.loggedHours(o.id);
              return (
                <div key={o.id} style={S.checklistCard}>
                  <div style={S.checklistHead}>
                    <div>
                      <div style={S.taskCardTitle}>
                        <span style={S.orderNumberTag}>#{o.orderNumber}</span> {o.title}
                        {showPropertyTag && <span style={S.propertyTag}>{propName(o.propertyId)}</span>}
                      </div>
                      <div style={S.taskCardProp}>Inkom {fmtDate(o.reportedDate)}</div>
                      {o.description && <div style={{ ...S.rowSub, marginTop: 6 }}>{o.description}</div>}
                    </div>
                    <button style={S.miniDelete} onClick={() => billing.removeOrder(o.id)} aria-label="Ta bort">×</button>
                  </div>
                  <div style={S.issueFooter}>
                    <span style={S.rowSub}>
                      {logged} h loggat{o.priceCategory ? ` · ${o.priceCategory} (${billing.rateFor(o)} kr/h)` : ""}
                      {o.billCount > 0 && ` · 🚗 ${o.billCount} st`}
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button style={S.stampBtn} className="fk-btn" onClick={() => setOpenOrderId(o.id)}>
                        Öppna
                      </button>
                      <button
                        style={S.primaryBtnSmall}
                        className="fk-btn"
                        onClick={() => billing.setOrderStatus(o, "Klar")}
                      >
                        Markera klar
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

function ArendeForm({ properties, nextOrderNumber, titleFieldLabel, titlePlaceholder, onSubmit }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priceCategory, setPriceCategory] = useState("FA");
  const [reportedDate, setReportedDate] = useState(todayISO());
  const [propertyId, setPropertyId] = useState(properties[0]?.id || "");
  const [debiterBil, setDebiterBil] = useState(false);
  const [billCount, setBillCount] = useState(1);

  const submit = (e) => {
    e.preventDefault();
    if (!title.trim() || !propertyId) return;
    onSubmit({
      title: title.trim(),
      description: description.trim(),
      propertyId,
      priceCategory,
      reportedDate,
      billCount: debiterBil ? Math.max(1, Number(billCount) || 1) : 0,
    });
  };

  return (
    <form onSubmit={submit} style={S.formPanel}>
      <div style={S.orderNumberPreview}>
        <span style={S.orderNumberPreviewLabel}>Ordernummer</span>
        <span style={S.orderNumberPreviewValue}>#{nextOrderNumber}</span>
        <span style={S.rowSub}>tilldelas automatiskt när ärendet sparas</span>
      </div>

      <div style={S.formRow}>
        <label style={S.label}>
          {titleFieldLabel}
          <input className="fk-input" style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={titlePlaceholder} required />
        </label>
        <PropertyPicker properties={properties} value={propertyId} onChange={setPropertyId} />
      </div>
      <div style={S.formRow}>
        <label style={S.label}>
          Datum inkommen
          <input className="fk-input" style={S.input} type="date" value={reportedDate} onChange={(e) => setReportedDate(e.target.value)} required />
        </label>
        <label style={S.label}>
          Kategori
          <select className="fk-input" style={S.input} value={priceCategory} onChange={(e) => setPriceCategory(e.target.value)}>
            <option value="FA">FA</option>
            <option value="TEK">TEK</option>
          </select>
        </label>
      </div>
      <div style={S.formRow}>
        <label style={S.label}>
          Beskrivning
          <input className="fk-input" style={S.input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Valfritt" />
        </label>
      </div>

      <div style={S.bilRow}>
        <label style={S.checkRow}>
          <input
            type="checkbox"
            checked={debiterBil}
            onChange={(e) => {
              setDebiterBil(e.target.checked);
              if (e.target.checked) setBillCount(1);
            }}
            style={S.checkbox}
          />
          Debitera bil
        </label>
        {debiterBil && (
          <div style={S.bilStepper}>
            <button
              type="button"
              onClick={() => setBillCount((c) => Math.max(1, c - 1))}
              style={S.bilStepBtn}
              aria-label="Färre bilar"
            >
              −
            </button>
            <span style={S.bilCount}>{billCount} {billCount === 1 ? "bil" : "bilar"}</span>
            <button
              type="button"
              onClick={() => setBillCount((c) => c + 1)}
              style={S.bilStepBtn}
              aria-label="Fler bilar"
            >
              +
            </button>
          </div>
        )}
      </div>

      <button type="submit" style={S.primaryBtn} className="fk-btn">Spara</button>
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
  rate,
  bilRate,
  allowInvoicing,
  onBack,
  onAddEntry,
  onRemoveEntry,
  onComplete,
  onReopen,
  onCreateBasis,
  onUpdateBasisHours,
  onRemoveBasis,
  onPrintBasis,
  onUpdateBillCount,
}) {
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [showBasisForm, setShowBasisForm] = useState(false);
  const bilLocked = !!order.billInvoicedInBasisId;

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <button onClick={onBack} style={S.linkBtn}>‹ Tillbaka</button>

      <div style={{ ...S.sectionHead, marginTop: 8 }}>
        <div>
          <h2 style={S.h2}>
            <span style={S.orderNumberTag}>#{order.orderNumber}</span> {order.title}
            <span style={S.typeTag}>{order.type === "felanmalan" ? "Felanmälan" : "Tilläggstjänst"}</span>
          </h2>
          <div style={S.taskCardProp}>
            {propertyName}{order.priceCategory ? ` · ${order.priceCategory} (${rate} kr/h)` : ""} · Inkom {fmtDate(order.reportedDate)}
          </div>
          {order.description && <div style={{ ...S.rowSub, marginTop: 4 }}>{order.description}</div>}
        </div>
        {onComplete && (
          <button style={S.primaryBtnSmall} className="fk-btn" onClick={onComplete}>
            Markera klar
          </button>
        )}
        {onReopen && (
          <button style={S.secondaryBtn} className="fk-btn" onClick={onReopen}>
            Återöppna ärendet
          </button>
        )}
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

      {onUpdateBillCount && (
        <div style={{ ...S.panel, marginBottom: 18 }}>
          <h3 style={S.panelTitle}>Bil</h3>
          {bilLocked ? (
            <div style={S.rowSub}>
              🚗 {order.billCount} st redan inkluderat i ett faktureringsunderlag ({bilRate} kr/st) — låst.
            </div>
          ) : (
            <div style={S.bilRow}>
              <label style={S.checkRow}>
                <input
                  type="checkbox"
                  checked={order.billCount > 0}
                  onChange={(e) => onUpdateBillCount(e.target.checked ? 1 : 0)}
                  style={S.checkbox}
                />
                Debitera bil ({bilRate} kr/st)
              </label>
              {order.billCount > 0 && (
                <div style={S.bilStepper}>
                  <button
                    type="button"
                    onClick={() => onUpdateBillCount(Math.max(1, order.billCount - 1))}
                    style={S.bilStepBtn}
                    aria-label="Färre bilar"
                  >
                    −
                  </button>
                  <span style={S.bilCount}>{order.billCount} {order.billCount === 1 ? "bil" : "bilar"}</span>
                  <button
                    type="button"
                    onClick={() => onUpdateBillCount(order.billCount + 1)}
                    style={S.bilStepBtn}
                    aria-label="Fler bilar"
                  >
                    +
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

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

      {allowInvoicing && (
        <>
          <div style={{ ...S.sectionHead, marginTop: 24 }}>
            <h3 style={S.panelTitle}>Faktureringsunderlag</h3>
            {(unbilledHours > 0 || (order.billCount > 0 && !bilLocked)) && (
              <button style={S.primaryBtnSmall} className="fk-btn" onClick={() => setShowBasisForm((s) => !s)}>
                {showBasisForm ? "Avbryt" : "Skapa underlag"}
              </button>
            )}
          </div>

          {showBasisForm && (
            <BasisForm
              suggestedHours={unbilledHours}
              includesBil={order.billCount > 0 && !bilLocked}
              bilCount={order.billCount}
              bilRate={bilRate}
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
                        {b.billCount > 0 && ` · 🚗 ${b.billCount} st à ${b.billRate} kr`}
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
                      <span style={S.rowSub}>
                        × {b.rate} kr/h = {(b.adjustedHours * b.rate).toLocaleString("sv-SE")} kr
                        {b.billCount > 0 && ` + ${(b.billCount * b.billRate).toLocaleString("sv-SE")} kr bil`}
                      </span>
                    </label>
                    <button style={S.stampBtn} className="fk-btn" onClick={() => onPrintBasis(b)}>
                      Öppna underlag
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
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

function BasisForm({ suggestedHours, includesBil, bilCount, bilRate, onSubmit }) {
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
      {includesBil && (
        <div style={{ ...S.rowSub, color: "#2B6E5E" }}>
          🚗 {bilCount} {bilCount === 1 ? "bil" : "bilar"} á {bilRate} kr läggs automatiskt till i detta underlag
          ({(bilCount * bilRate).toLocaleString("sv-SE")} kr).
        </div>
      )}
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

/* ------------------------------ pdf-generering (faktureringsunderlag) ------------------------------ */

function buildBasisPdf(basis, order, propertyName) {
  const hoursAmount = Number(basis.adjustedHours) * Number(basis.rate);
  const bilAmount = Number(basis.billCount || 0) * Number(basis.billRate || 0);
  const amount = hoursAmount + bilAmount;

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const marginX = 48;
  let y = 56;

  // Stämpelmärke + rubrik
  doc.setFillColor(28, 35, 33);
  doc.roundedRect(marginX, y - 20, 34, 34, 4, 4, "F");
  doc.setTextColor(234, 91, 12);
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("N2", marginX + 17, y - 1, { align: "center" });

  doc.setTextColor(28, 35, 33);
  doc.setFontSize(17);
  doc.text("Faktureringsunderlag", marginX + 46, y - 4);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(92, 89, 78);
  doc.text(`Skapat ${fmtDate(basis.createdAt)} av ${basis.createdBy}`, marginX + 46, y + 12);

  y += 44;
  doc.setDrawColor(201, 196, 183);
  doc.line(marginX, y, 595 - marginX, y);
  y += 24;

  const metaCol = (label, value, x) => {
    doc.setFontSize(8.5);
    doc.setTextColor(92, 89, 78);
    doc.text(label.toUpperCase(), x, y);
    doc.setFontSize(11.5);
    doc.setTextColor(28, 35, 33);
    doc.setFont("helvetica", "bold");
    doc.text(String(value), x, y + 15);
    doc.setFont("helvetica", "normal");
  };
  metaCol("Bostadsrättsförening", propertyName, marginX);
  metaCol("Ordernummer", `#${order.orderNumber}`, marginX + 210);
  metaCol("Ärende/order", order.title, marginX + 330);

  y += 40;

  const rows = [
    [
      `${order.title}${basis.note ? ` — ${basis.note}` : ""}`,
      `${basis.adjustedHours} h`,
      `${basis.rate} kr/h`,
      `${hoursAmount.toLocaleString("sv-SE")} kr`,
    ],
  ];
  if (basis.billCount > 0) {
    rows.push(["Bil", `${basis.billCount} st`, `${basis.billRate} kr/st`, `${bilAmount.toLocaleString("sv-SE")} kr`]);
  }

  autoTable(doc, {
    startY: y,
    margin: { left: marginX, right: marginX },
    head: [["Beskrivning", "Antal", "Pris", "Summa"]],
    body: rows,
    styles: { font: "helvetica", fontSize: 10, textColor: [28, 35, 33], cellPadding: 8 },
    headStyles: { fillColor: [255, 255, 255], textColor: [92, 89, 78], fontStyle: "bold", lineWidth: { bottom: 1 }, lineColor: [28, 35, 33] },
    theme: "plain",
  });

  const afterTableY = doc.lastAutoTable.finalY + 24;
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text(`Totalt: ${amount.toLocaleString("sv-SE")} kr`, 595 - marginX, afterTableY, { align: "right" });

  if (basis.loggedHours !== basis.adjustedHours) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(92, 89, 78);
    doc.text(
      `(Loggad tid var ${basis.loggedHours} h, justerad till ${basis.adjustedHours} h.)`,
      marginX,
      afterTableY + 20
    );
  }

  return doc;
}

function basisPdfFilename(basis, order) {
  return `faktureringsunderlag-order-${order.orderNumber}-${basis.createdAt}.pdf`;
}

function PrintableBasis({ basis, order, propertyName, onClose, notify }) {
  const [sending, setSending] = useState(false);
  const hoursAmount = Number(basis.adjustedHours) * Number(basis.rate);
  const bilAmount = Number(basis.billCount || 0) * Number(basis.billRate || 0);
  const amount = hoursAmount + bilAmount;

  const downloadPdf = () => {
    const doc = buildBasisPdf(basis, order, propertyName);
    doc.save(basisPdfFilename(basis, order));
  };

  const sendByEmail = async () => {
    setSending(true);
    try {
      const doc = buildBasisPdf(basis, order, propertyName);
      const pdfBase64 = doc.output("datauristring").split(",")[1];
      const filename = basisPdfFilename(basis, order);
      const { data, error } = await supabase.functions.invoke("send-invoice-email", {
        body: {
          subject: `Faktureringsunderlag — order #${order.orderNumber} — ${propertyName}`,
          filename,
          pdfBase64,
        },
      });
      if (error || data?.error) {
        throw new Error(error?.message || data?.error || "Okänt fel");
      }
      notify?.("Faktureringsunderlag skickat via e-post");
    } catch (err) {
      console.error("Kunde inte skicka e-post:", err);
      notify?.("Kunde inte skicka e-post — kontrollera serverfunktionen och försök igen");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ animation: "fk-rise .25s ease" }}>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }} className="fk-no-print">
        <button onClick={onClose} style={S.linkBtn}>‹ Tillbaka</button>
        <button onClick={downloadPdf} style={S.primaryBtn} className="fk-btn">
          Ladda ner PDF
        </button>
        <button onClick={() => window.print()} style={S.secondaryBtn} className="fk-btn">
          Skriv ut
        </button>
        <button onClick={sendByEmail} style={S.primaryBtnSmall} className="fk-btn" disabled={sending}>
          {sending ? "Skickar…" : "Skicka via e-post"}
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
            <div style={S.invoiceMetaLabel}>Bostadsrättsförening</div>
            <div style={S.invoiceMetaValue}>{propertyName}</div>
          </div>
          <div>
            <div style={S.invoiceMetaLabel}>Ordernummer</div>
            <div style={S.invoiceMetaValue}>#{order.orderNumber}</div>
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
              <th style={S.invoiceTh}>Antal</th>
              <th style={S.invoiceTh}>Pris</th>
              <th style={S.invoiceTh}>Summa</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={S.invoiceTd}>{order.title}{basis.note ? ` — ${basis.note}` : ""}</td>
              <td style={S.invoiceTd}>{basis.adjustedHours} h</td>
              <td style={S.invoiceTd}>{basis.rate} kr/h</td>
              <td style={S.invoiceTd}>{hoursAmount.toLocaleString("sv-SE")} kr</td>
            </tr>
            {basis.billCount > 0 && (
              <tr>
                <td style={S.invoiceTd}>Bil</td>
                <td style={S.invoiceTd}>{basis.billCount} st</td>
                <td style={S.invoiceTd}>{basis.billRate} kr/st</td>
                <td style={S.invoiceTd}>{bilAmount.toLocaleString("sv-SE")} kr</td>
              </tr>
            )}
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
    Bostadsrättsföreningar: state.properties.length,
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
          Bostadsrättsföreningar: data.properties?.length || 0,
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
          Sparar all information (bostadsrättsföreningar, uppgifter, checklistor, ärenden, debitering) som en
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
  addPropertyBtn: {
    background: "transparent",
    color: "#EA5B0C",
    border: "1px solid #EA5B0C",
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(28, 35, 33, 0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    zIndex: 50,
  },
  modalPanel: {
    background: "#EDEAE1",
    borderRadius: 10,
    padding: 22,
    width: "100%",
    maxWidth: 560,
    maxHeight: "88vh",
    overflowY: "auto",
    position: "relative",
    animation: "fk-rise .2s ease",
  },
  modalClose: {
    position: "absolute",
    top: 12,
    right: 14,
    border: "none",
    background: "transparent",
    fontSize: 22,
    lineHeight: 1,
    color: "#5C594E",
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
  checklistCardPending: { background: "#FFFDF3", border: "1.5px solid #F0E4A8", borderRadius: 8, padding: 16 },
  checklistCardInvoiced: { background: "#F5FBF6", border: "1.5px solid #C3E4C6", borderRadius: 8, padding: 16 },
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
  sortFilterBar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 14,
    alignItems: "flex-end",
    background: "#FFFFFF",
    border: "1px solid #C9C4B7",
    borderRadius: 8,
    padding: "12px 14px",
    marginBottom: 16,
  },
  sortFilterField: { display: "flex", flexDirection: "column", gap: 4, minWidth: 160 },
  sortFilterLabel: { fontSize: 10.5, color: "#5C594E", textTransform: "uppercase", letterSpacing: 0.5 },
  sortFilterSelect: { border: "1px solid #C9C4B7", borderRadius: 6, padding: "7px 9px", fontSize: 13, color: "#1C2321", background: "#FBFAF7" },
  summaryTable: { borderCollapse: "collapse", width: "100%", fontSize: 13 },
  summaryTh: { textAlign: "left", padding: "6px 12px 6px 0", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#5C594E", borderBottom: "1.5px solid #1C2321" },
  summaryTd: { padding: "8px 12px 8px 0", borderBottom: "1px solid #C9C4B7", fontWeight: 500 },

  typeTag: {
    marginLeft: 10,
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#5C594E",
    background: "#EDEAE1",
    border: "1px solid #C9C4B7",
    borderRadius: 4,
    padding: "2px 8px",
    verticalAlign: "middle",
  },
  propertyTag: {
    marginLeft: 10,
    fontSize: 10.5,
    fontWeight: 600,
    color: "#2B6E5E",
    background: "#E9F4EA",
    border: "1px solid #C3E4C6",
    borderRadius: 4,
    padding: "2px 8px",
    verticalAlign: "middle",
  },
  orderNumberTag: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "0.85em",
    fontWeight: 600,
    color: "#EA5B0C",
    marginRight: 2,
  },
  orderNumberPreview: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    background: "#EDEAE1",
    border: "1px dashed #C9C4B7",
    borderRadius: 6,
    padding: "10px 14px",
    marginBottom: 4,
  },
  orderNumberPreviewLabel: { fontSize: 11.5, color: "#5C594E", textTransform: "uppercase", letterSpacing: 0.5 },
  orderNumberPreviewValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 17, fontWeight: 700, color: "#EA5B0C" },
  bilRow: { display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" },
  bilStepper: { display: "flex", alignItems: "center", gap: 10 },
  bilStepBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: "1px solid #C9C4B7",
    background: "#FBFAF7",
    fontSize: 16,
    lineHeight: 1,
    color: "#1C2321",
  },
  bilCount: { fontSize: 13.5, fontWeight: 600, minWidth: 56, textAlign: "center" },
  kpiRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 14 },
  kpiBlock: { textAlign: "center" },
  kpiValue: { fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: "#1C2321" },
  kpiLabel: { fontSize: 11.5, color: "#5C594E", marginTop: 4 },
  kpiDivider: { height: 1, background: "#C9C4B7", margin: "18px 0" },

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
  invoiceMetaGrid: { display: "grid", gridTemplateColumns: "1.4fr 0.8fr 1.4fr", gap: 16, marginBottom: 22 },
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

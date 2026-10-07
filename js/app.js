// Lancetta - versione 1
// Tutto gira nel telefono: i dati sono file statici preparati ogni mattina
// da scripts/aggiorna_dati.py. Le scelte dell'utente (carburante, auto,
// preferiti, posizione) restano salvate solo sul suo telefono.

const CARBURANTI = { benzina: "Benzina", diesel: "Diesel", gpl: "GPL", metano: "Metano" };
const UNITA = { benzina: "l", diesel: "l", gpl: "l", metano: "kg" };
const RAGGI = [5, 10, 20, 50];
const RAGGIO_INIZIALE = { benzina: 10, diesel: 10, gpl: 20, metano: 20 };
const MAX_MAPPA = 200;
const ETICHETTE_MAPPA = 20;

// ------------------- memoria sul telefono -------------------

const memoria = {
  leggi(chiave, predefinito) {
    try {
      const valore = localStorage.getItem("lancetta." + chiave);
      return valore === null ? predefinito : JSON.parse(valore);
    } catch {
      return predefinito;
    }
  },
  scrivi(chiave, valore) {
    try { localStorage.setItem("lancetta." + chiave, JSON.stringify(valore)); } catch { /* memoria non disponibile */ }
  },
};

const stato = {
  carb: memoria.leggi("carb", "benzina"),
  raggio: memoria.leggi("raggio", { ...RAGGIO_INIZIALE }),
  auto: memoria.leggi("auto", []),
  autoScelta: memoria.leggi("autoScelta", null),
  posizione: memoria.leggi("posizione", null), // { lat, lon, nome }
  preferiti: memoria.leggi("preferiti", []),   // [{ id, z }]
  vista: "lista",
  meta: null,
  zone: new Map(),
  comuni: null,
  sponsor: [],
};

// ------------------- utilita' -------------------

const $ = (sel) => document.querySelector(sel);
const esc = (testo) => String(testo ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const euro = (n, decimali = 3) => n.toFixed(decimali).replace(".", ",");
const km = (d) => (d < 10 ? d.toFixed(1).replace(".", ",") : Math.round(d)) + " km";

function distanzaKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function mediana(valori) {
  if (!valori.length) return null;
  const v = [...valori].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// I prezzi arrivano con la data e l'ora italiana in cui il distributore li
// ha comunicati. Un distributore comunica solo quando CAMBIA prezzo (o almeno
// una volta a settimana): un prezzo "del 28/09" e' quindi il prezzo ancora in
// vigore il giorno dei dati, non un prezzo vecchio. Lo diciamo cosi'.
function quandoComunicato(minuti) {
  const d = new Date(minuti * 60000);
  const giorno = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const [a, m, g] = (stato.meta?.estrazione || "").split("-").map(Number);
  const giornoDati = a ? Date.UTC(a, m - 1, g) : giorno;
  const giorni = Math.round((giornoDati - giorno) / 86400000);
  const data = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  return { giorni, testo: `in vigore dal ${data}`, breve: `dal ${data}` };
}

// ------------------- dati -------------------

async function caricaJSON(percorso) {
  const risposta = await fetch(percorso, { cache: "no-cache" });
  if (!risposta.ok) throw new Error(percorso);
  return risposta.json();
}

function chiaveZona(lat, lon) {
  const lato = stato.meta.lato_zona;
  return `${Math.floor(lat / lato)}_${Math.floor(lon / lato)}`;
}

async function zona(chiave) {
  if (!stato.zone.has(chiave)) {
    stato.zone.set(chiave, stato.meta.zone.includes(chiave)
      ? caricaJSON(`data/zone/${chiave}.json`).catch(() => [])
      : Promise.resolve([]));
  }
  return stato.zone.get(chiave);
}

async function distributoriVicini(lat, lon, raggioKm) {
  const lato = stato.meta.lato_zona;
  const dLat = raggioKm / 111;
  const dLon = raggioKm / (111 * Math.cos((lat * Math.PI) / 180));
  const chiavi = [];
  for (let a = Math.floor((lat - dLat) / lato); a <= Math.floor((lat + dLat) / lato); a++) {
    for (let o = Math.floor((lon - dLon) / lato); o <= Math.floor((lon + dLon) / lato); o++) chiavi.push(`${a}_${o}`);
  }
  const elenchi = await Promise.all(chiavi.map(zona));
  const risultato = [];
  for (const elenco of elenchi) {
    for (const d of elenco) {
      const dist = distanzaKm(lat, lon, d.la, d.lo);
      if (dist <= raggioKm) risultato.push({ ...d, dist });
    }
  }
  return risultato;
}

// Prezzo principale di un distributore per il carburante scelto: self se
// c'e', altrimenti servito (GPL e metano sono quasi sempre serviti).
function prezzoDi(d, carb) {
  const f = d.f?.[carb];
  if (!f) return null;
  const principale = f.s ?? f.v;
  if (principale == null) return null;
  return { prezzo: principale, self: f.s != null, servito: f.s != null ? f.v : null, t: f.t, sospetto: !!f.x, delta: f.d };
}

async function classifica() {
  const { lat, lon } = stato.posizione;
  const raggio = stato.raggio[stato.carb];
  const vicini = await distributoriVicini(lat, lon, raggio);
  const voci = [];
  for (const d of vicini) {
    const p = prezzoDi(d, stato.carb);
    if (p) voci.push({ d, p });
  }
  const media = mediana(voci.filter((v) => !v.p.sospetto).map((v) => v.p.prezzo));
  voci.sort((a, b) => (a.p.sospetto - b.p.sospetto) || (a.p.prezzo - b.p.prezzo) || (a.d.dist - b.d.dist));
  return { voci, media };
}

// ------------------- pezzi grafici -------------------

function autoAttiva() {
  return stato.auto.find((a) => a.id === stato.autoScelta && a.carb === stato.carb) || null;
}

function confrontoMedia(prezzo, media) {
  if (media == null) return "";
  const diff = prezzo - media;
  if (Math.abs(diff) < 0.005) return `<span class="piu">media zona</span>`;
  return diff < 0
    ? `<span class="meno num">-${euro(-diff, 2)} €/${UNITA[stato.carb]}</span>`
    : `<span class="piu num">+${euro(diff, 2)} €/${UNITA[stato.carb]}</span>`;
}

function frecciaVariazione(delta) {
  if (!delta) return "";
  return delta > 0
    ? `<span class="sale" title="salito da ieri">▲</span>`
    : `<span class="scende" title="sceso da ieri">▼</span>`;
}

function rigaServito(p) {
  if (p.servito != null) return `<div class="servito num">servito ${euro(p.servito)}</div>`;
  if (!p.self && (stato.carb === "benzina" || stato.carb === "diesel")) return `<div class="servito">solo servito</div>`;
  return "";
}

function htmlVoce({ d, p }, media) {
  const quando = quandoComunicato(p.t);
  const sotto = [km(d.dist)];
  if (p.sospetto) sotto.push(`<span class="avviso">prezzo da verificare</span>`);
  else sotto.push(confrontoMedia(p.prezzo, media));
  if (quando.giorni >= 1) sotto.push(`<span class="${quando.giorni >= 7 ? "vecchio" : ""}">${quando.breve}</span>`);
  return `
    <button class="voce" data-id="${esc(d.id)}" type="button">
      <div class="info">
        <div class="nome">${esc(d.n)} <span class="piu">· ${esc(d.c)}</span></div>
        <div class="sotto">${sotto.join(" · ")}</div>
      </div>
      <div class="prezzi">
        <div class="prezzo num">${frecciaVariazione(p.delta)} ${euro(p.prezzo)}</div>
        ${rigaServito(p)}
      </div>
    </button>`;
}

function htmlPubblicita() {
  const provincia = stato.provinciaCorrente;
  const sponsor = stato.sponsor.find((s) => !s.province?.length || s.province.includes(provincia));
  if (sponsor) {
    const tag = sponsor.link ? `a href="${esc(sponsor.link)}" target="_blank" rel="noopener sponsored"` : "div";
    return `<${tag} class="spazio-pubblicita"><div class="tipo">Sponsor</div><div class="testo">${esc(sponsor.testo)}</div></${tag.split(" ")[0]}>`;
  }
  // Nessuno sponsor locale: qui andra' l'annuncio della rete pubblicitaria.
  return `<div class="spazio-pubblicita" data-annuncio><div class="tipo">Pubblicità</div><div>Spazio pubblicitario</div></div>`;
}

function htmlFonte() {
  if (!stato.meta) return "";
  const [a, m, g] = stato.meta.estrazione.split("-");
  return `<p class="fonte">Prezzi ufficiali comunicati al Ministero (MIMIT), in vigore il ${g}/${m}/${a} alle 8:00.<br>Verifica sempre il prezzo alla pompa.</p>`;
}

// ------------------- viste -------------------

async function disegnaLista() {
  const contenitore = $("#vista-lista");
  if (!stato.posizione) {
    contenitore.innerHTML = `
      <div class="vuoto">
        <h2>Dove sei?</h2>
        <p>Ti mostriamo i distributori più convenienti intorno a te.</p>
        <button class="pulsante pieno" id="usa-posizione" type="button">Usa la mia posizione</button>
        <button class="pulsante" id="cerca-comune" type="button">Cerca un comune</button>
      </div>`;
    $("#usa-posizione").onclick = chiediPosizione;
    $("#cerca-comune").onclick = apriRicercaComune;
    return;
  }

  const { voci, media } = await classifica();
  stato.ultimaClassifica = { voci, media };
  stato.provinciaCorrente = voci[0]?.d.p ?? stato.provinciaCorrente;
  const raggio = stato.raggio[stato.carb];

  if (!voci.length) {
    const prossimo = RAGGI.find((r) => r > raggio);
    contenitore.innerHTML = `
      <div class="vuoto">
        <h2>Nessun distributore di ${CARBURANTI[stato.carb]} entro ${raggio} km</h2>
        ${prossimo ? `<button class="pulsante" id="allarga" type="button">Cerca entro ${prossimo} km</button>` : ""}
      </div>${htmlFonte()}`;
    if (prossimo) $("#allarga").onclick = () => impostaRaggio(prossimo);
    return;
  }

  const migliore = voci[0];
  const auto = autoAttiva();
  let html = "";
  if (!migliore.p.sospetto) {
    const risparmioLitro = media != null ? media - migliore.p.prezzo : 0;
    const quando = quandoComunicato(migliore.p.t);
    html += `
      <button class="migliore" data-id="${esc(migliore.d.id)}" type="button">
        <div class="etichetta">${CARBURANTI[stato.carb]} più conveniente entro ${raggio} km</div>
        <div class="riga">
          <span class="prezzo-grande num">${euro(migliore.p.prezzo)}</span>
          <span class="risparmio-litro num">${risparmioLitro >= 0.005 ? `-${euro(risparmioLitro, 2)} €/${UNITA[stato.carb]}` : "in linea con la zona"}</span>
        </div>
        ${auto && risparmioLitro >= 0.005 ? `<div class="dettaglio num">sui tuoi ${auto.litri} ${UNITA[stato.carb]} risparmi ${euro(risparmioLitro * auto.litri, 2)} €</div>` : ""}
        <div class="dettaglio">${esc(migliore.d.n)} · ${esc(migliore.d.c)} · ${km(migliore.d.dist)}</div>
        <div class="dettaglio num">${migliore.p.servito != null ? `servito ${euro(migliore.p.servito)} · ` : ""}${quando.testo}</div>
      </button>`;
  }
  const resto = migliore.p.sospetto ? voci : voci.slice(1);
  resto.forEach((v, i) => {
    html += htmlVoce(v, media);
    if (i === 2) html += htmlPubblicita();
  });
  if (resto.length < 3) html += htmlPubblicita();
  html += `<p class="fonte num">${voci.length} distributori · media zona ${media != null ? euro(media) : "-"} €/${UNITA[stato.carb]}</p>` + htmlFonte();
  contenitore.innerHTML = html;
  contenitore.querySelectorAll("[data-id]").forEach((el) => {
    el.onclick = () => apriDistributore(voci.find((v) => v.d.id === el.dataset.id).d);
  });
}

let mappa = null;
let livelloMarcatori = null;

async function disegnaMappa() {
  if (!stato.posizione || typeof L === "undefined") {
    $("#mappa").innerHTML = `<div class="vuoto"><h2>Mappa non disponibile</h2><p>Scegli prima dove sei dalla lista.</p></div>`;
    return;
  }
  if (!mappa) {
    mappa = L.map("mappa", { zoomControl: false, attributionControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap",
    }).addTo(mappa);
    livelloMarcatori = L.layerGroup().addTo(mappa);
  }
  const { voci } = stato.ultimaClassifica || (await classifica());
  livelloMarcatori.clearLayers();
  const { lat, lon } = stato.posizione;
  L.circleMarker([lat, lon], { radius: 7, color: "#1a6dd1", fillColor: "#1a6dd1", fillOpacity: 0.9, weight: 2 }).addTo(livelloMarcatori);
  // Etichette con il prezzo solo per i piu' convenienti: con tutte insieme la
  // mappa diventa illeggibile. Gli altri sono puntini (si toccano lo stesso).
  const visibili = voci.slice(0, MAX_MAPPA);
  visibili.forEach((v, i) => {
    if (i < ETICHETTE_MAPPA) {
      const classe = v.p.sospetto ? "dubbio" : i === 0 ? "top" : "";
      const icona = L.divIcon({ className: "punto-mappa", html: `<div class="etichetta-mappa ${classe}">${euro(v.p.prezzo)}</div>`, iconSize: [0, 0] });
      L.marker([v.d.la, v.d.lo], { icon: icona, zIndexOffset: 1000 - i }).on("click", () => apriDistributore(v.d)).addTo(livelloMarcatori);
    } else {
      L.circleMarker([v.d.la, v.d.lo], { radius: 5, color: "#9a9890", fillColor: "#ffffff", fillOpacity: 1, weight: 1.5 })
        .on("click", () => apriDistributore(v.d)).addTo(livelloMarcatori);
    }
  });
  setTimeout(() => {
    mappa.invalidateSize();
    const punti = [[lat, lon], ...visibili.slice(0, 15).map((v) => [v.d.la, v.d.lo])];
    mappa.fitBounds(punti, { padding: [40, 40], maxZoom: 14 });
  }, 50);
}

async function disegnaPreferiti() {
  const contenitore = $("#vista-preferiti");
  if (!stato.preferiti.length) {
    contenitore.innerHTML = `
      <div class="vuoto">
        <h2>I tuoi distributori</h2>
        <p>Apri un distributore e tocca la stella: lo ritrovi qui con il prezzo di oggi.</p>
      </div>${htmlPubblicita()}`;
    return;
  }
  const elenchi = await Promise.all([...new Set(stato.preferiti.map((p) => p.z))].map(async (z) => [z, await zona(z)]));
  const perZona = new Map(elenchi);
  const voci = [];
  for (const pref of stato.preferiti) {
    const d = perZona.get(pref.z)?.find((x) => x.id === pref.id);
    if (!d) continue;
    const dist = stato.posizione ? distanzaKm(stato.posizione.lat, stato.posizione.lon, d.la, d.lo) : null;
    voci.push({ d: { ...d, dist }, p: prezzoDi(d, stato.carb) });
  }
  const media = stato.ultimaClassifica?.media ?? null;
  let html = `<div class="titolo-sezione">${CARBURANTI[stato.carb]} nei tuoi distributori</div>`;
  for (const { d, p } of voci) {
    const sotto = [esc(d.c)];
    if (d.dist != null) sotto.push(km(d.dist));
    if (p?.delta) sotto.push(`<span class="${p.delta > 0 ? "sale" : "scende"} num">${p.delta > 0 ? "+" : "-"}${euro(Math.abs(p.delta))} da ieri</span>`);
    else if (p) sotto.push(confrontoMedia(p.prezzo, media));
    html += `
      <button class="voce" data-id="${esc(d.id)}" type="button">
        <div class="info"><div class="nome">${esc(d.n)}</div><div class="sotto">${sotto.join(" · ")}</div></div>
        <div class="prezzi">${p ? `<div class="prezzo num">${frecciaVariazione(p.delta)} ${euro(p.prezzo)}</div>${rigaServito(p)}` : `<div class="servito">niente ${CARBURANTI[stato.carb]}</div>`}</div>
      </button>`;
  }
  html += htmlPubblicita();
  contenitore.innerHTML = html;
  contenitore.querySelectorAll("[data-id]").forEach((el) => {
    el.onclick = () => apriDistributore(voci.find((v) => v.d.id === el.dataset.id).d);
  });
}

// ------------------- foglio (pannello dal basso) -------------------

function apriFoglio(html) {
  const foglio = $("#foglio");
  foglio.innerHTML = `<div class="maniglia"></div>${html}`;
  foglio.hidden = false;
  $("#foglio-sfondo").hidden = false;
}

function chiudiFoglio() {
  $("#foglio").hidden = true;
  $("#foglio-sfondo").hidden = true;
}

function apriDistributore(d) {
  const preferito = stato.preferiti.some((p) => p.id === d.id);
  let righe = "";
  for (const [carb, nome] of Object.entries(CARBURANTI)) {
    const p = prezzoDi(d, carb);
    if (!p) continue;
    righe += `<tr><td>${nome}${p.self ? " self" : ""}<span class="servito">${quandoComunicato(p.t).testo}${p.sospetto ? " · da verificare" : ""}</span></td>
      <td>${euro(p.prezzo)}${p.servito != null ? `<span class="servito">servito ${euro(p.servito)}</span>` : ""}</td></tr>`;
  }
  let premium = "";
  if (d.pr?.length) {
    premium = `<div class="titolo-sezione">Altri carburanti</div><table class="tabella-prezzi">` +
      d.pr.map(([nome, s, v]) => `<tr><td>${esc(nome)}</td><td>${s != null ? euro(s) : ""}${v != null ? `<span class="servito">servito ${euro(v)}</span>` : ""}</td></tr>`).join("") +
      `</table>`;
  }
  apriFoglio(`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <div><h2>${esc(d.n)}</h2><div class="indirizzo">${esc(d.a)}, ${esc(d.c)} (${esc(d.p)})${d.dist != null ? " · " + km(d.dist) : ""}</div></div>
      <button class="stella ${preferito ? "attiva" : ""}" id="stella" type="button" aria-label="${preferito ? "Togli dai preferiti" : "Aggiungi ai preferiti"}">${preferito ? "★" : "☆"}</button>
    </div>
    <table class="tabella-prezzi">${righe}</table>
    ${premium}
    <div class="riga-azioni">
      <a class="pulsante pieno" href="https://www.google.com/maps/dir/?api=1&destination=${d.la},${d.lo}" target="_blank" rel="noopener">Indicazioni</a>
      <button class="pulsante" id="chiudi" type="button">Chiudi</button>
    </div>
    <p class="fonte">Prezzi comunicati dal distributore al Ministero. Verifica sempre alla pompa.</p>`);
  $("#chiudi").onclick = chiudiFoglio;
  $("#stella").onclick = () => {
    if (stato.preferiti.some((p) => p.id === d.id)) stato.preferiti = stato.preferiti.filter((p) => p.id !== d.id);
    else stato.preferiti.push({ id: d.id, z: chiaveZona(d.la, d.lo) });
    memoria.scrivi("preferiti", stato.preferiti);
    apriDistributore(d);
    if (stato.vista === "preferiti") disegnaPreferiti();
  };
}

function apriAuto() {
  const elenco = stato.auto.map((a) => `
    <div style="display:flex;gap:6px;align-items:center">
      <button class="voce-auto ${a.id === stato.autoScelta ? "scelta" : ""}" data-auto="${a.id}" type="button">
        <div class="info"><div>${esc(a.nome)}</div><div class="sotto">${CARBURANTI[a.carb]} · ${a.litri} ${UNITA[a.carb]}</div></div>
        ${a.id === stato.autoScelta ? "✓" : ""}
      </button>
      <button class="stella" data-elimina="${a.id}" type="button" aria-label="Elimina ${esc(a.nome)}">✕</button>
    </div>`).join("");
  apriFoglio(`
    <h2>Le mie auto</h2>
    <div class="indirizzo">Facoltativo. Tocca un'auto: carburante e litri cambiano da soli e vedi quanto risparmi sul tuo pieno.</div>
    ${elenco}
    ${stato.auto.length ? `<button class="voce-auto ${stato.autoScelta ? "" : "scelta"}" data-auto="" type="button"><div class="info"><div>Nessuna auto</div><div class="sotto">mostra solo il risparmio al litro</div></div></button>` : ""}
    <div class="titolo-sezione">Aggiungi un'auto</div>
    <label class="etichetta-campo" for="nome-auto">Nome</label>
    <input class="campo" id="nome-auto" placeholder="Panda" maxlength="24" autocomplete="off">
    <span class="etichetta-campo">Carburante</span>
    <div class="scelte" id="scelta-carb">${Object.entries(CARBURANTI).map(([k, v]) => `<button class="chip ${k === stato.carb ? "attivo" : ""}" data-c="${k}" type="button">${v}</button>`).join("")}</div>
    <label class="etichetta-campo" for="litri-auto" id="etichetta-litri">Quanto metti di solito (${stato.carb === "metano" ? "kg" : "litri"})</label>
    <input class="campo" id="litri-auto" type="number" inputmode="decimal" min="1" max="200" placeholder="${stato.carb === "metano" ? "15" : "40"}">
    <div class="errore" id="errore-auto" hidden></div>
    <button class="pulsante pieno" id="salva-auto" type="button">Salva auto</button>
    <button class="pulsante" id="chiudi" type="button">Chiudi</button>`);

  let carbNuova = stato.carb;
  $("#scelta-carb").querySelectorAll("[data-c]").forEach((b) => {
    b.onclick = () => {
      carbNuova = b.dataset.c;
      $("#scelta-carb").querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("attivo", x === b));
      $("#etichetta-litri").textContent = `Quanto metti di solito (${carbNuova === "metano" ? "kg" : "litri"})`;
    };
  });
  const nascondiErrore = () => { $("#errore-auto").hidden = true; };
  $("#nome-auto").oninput = nascondiErrore;
  $("#litri-auto").oninput = nascondiErrore;
  $("#salva-auto").onclick = () => {
    const nome = $("#nome-auto").value.trim();
    const litri = Number(String($("#litri-auto").value).replace(",", "."));
    const errore = !nome ? "Scrivi un nome per l'auto." : !(litri >= 1 && litri <= 200) ? "Scrivi quanto metti di solito (da 1 a 200)." : "";
    if (errore) {
      $("#errore-auto").textContent = errore;
      $("#errore-auto").hidden = false;
      return;
    }
    const auto = { id: String(Date.now()), nome, carb: carbNuova, litri: Math.round(litri) };
    stato.auto.push(auto);
    memoria.scrivi("auto", stato.auto);
    scegliAuto(auto.id);
    chiudiFoglio();
  };
  $("#foglio").querySelectorAll("[data-auto]").forEach((b) => { b.onclick = () => { scegliAuto(b.dataset.auto || null); chiudiFoglio(); }; });
  $("#foglio").querySelectorAll("[data-elimina]").forEach((b) => {
    b.onclick = () => {
      stato.auto = stato.auto.filter((a) => a.id !== b.dataset.elimina);
      if (stato.autoScelta === b.dataset.elimina) stato.autoScelta = null;
      memoria.scrivi("auto", stato.auto);
      memoria.scrivi("autoScelta", stato.autoScelta);
      aggiornaTestata();
      apriAuto();
      ridisegna();
    };
  });
  $("#chiudi").onclick = chiudiFoglio;
}

async function apriRicercaComune() {
  apriFoglio(`
    <h2>Cerca un comune</h2>
    <input class="campo" id="testo-comune" placeholder="Treviso" autocomplete="off" autofocus>
    <div id="risultati-comune"></div>
    <button class="pulsante" id="usa-gps" type="button">Usa la mia posizione</button>
    <button class="pulsante" id="chiudi" type="button">Chiudi</button>`);
  $("#chiudi").onclick = chiudiFoglio;
  $("#usa-gps").onclick = () => { chiudiFoglio(); chiediPosizione(); };
  if (!stato.comuni) stato.comuni = await caricaJSON("data/comuni.json");
  const normalizza = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const campo = $("#testo-comune");
  campo.oninput = () => {
    const q = normalizza(campo.value.trim());
    if (q.length < 2) { $("#risultati-comune").innerHTML = ""; return; }
    const trovati = stato.comuni
      .filter(([nome]) => normalizza(nome).includes(q))
      .sort((a, b) => normalizza(a[0]).startsWith(q) === normalizza(b[0]).startsWith(q) ? a[0].localeCompare(b[0]) : normalizza(a[0]).startsWith(q) ? -1 : 1)
      .slice(0, 12);
    $("#risultati-comune").innerHTML = trovati.length
      ? trovati.map(([nome, prov, lat, lon]) => `<button class="risultato-comune" data-lat="${lat}" data-lon="${lon}" data-nome="${esc(nome)}" type="button">${esc(nome)} <span class="piu">(${esc(prov)})</span></button>`).join("")
      : `<p class="piu">Nessun comune trovato.</p>`;
    $("#risultati-comune").querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        impostaPosizione({ lat: Number(b.dataset.lat), lon: Number(b.dataset.lon), nome: b.dataset.nome });
        chiudiFoglio();
      };
    });
  };
  campo.focus();
}

// ------------------- azioni -------------------

function chiediPosizione() {
  if (!navigator.geolocation) { apriRicercaComune(); return; }
  $("#pulsante-luogo").textContent = "Cerco la tua posizione…";
  navigator.geolocation.getCurrentPosition(
    (pos) => impostaPosizione({ lat: pos.coords.latitude, lon: pos.coords.longitude, nome: "La tua posizione" }),
    () => { aggiornaTestata(); apriRicercaComune(); },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
  );
}

function impostaPosizione(posizione) {
  stato.posizione = posizione;
  memoria.scrivi("posizione", posizione);
  aggiornaTestata();
  ridisegna();
}

function impostaRaggio(raggio) {
  stato.raggio[stato.carb] = raggio;
  memoria.scrivi("raggio", stato.raggio);
  aggiornaTestata();
  ridisegna();
}

function scegliCarburante(carb, daAuto = false) {
  stato.carb = carb;
  memoria.scrivi("carb", carb);
  // Se scegli a mano un carburante diverso da quello dell'auto, l'auto non vale piu'.
  if (!daAuto && stato.autoScelta && stato.auto.find((a) => a.id === stato.autoScelta)?.carb !== carb) {
    stato.autoScelta = null;
    memoria.scrivi("autoScelta", null);
  }
  aggiornaTestata();
  ridisegna();
}

function scegliAuto(id) {
  stato.autoScelta = id;
  memoria.scrivi("autoScelta", id);
  const auto = stato.auto.find((a) => a.id === id);
  if (auto) scegliCarburante(auto.carb, true);
  else { aggiornaTestata(); ridisegna(); }
}

function aggiornaTestata() {
  document.querySelectorAll("#barra-carburanti [data-carb]").forEach((b) => b.classList.toggle("attivo", b.dataset.carb === stato.carb));
  const auto = stato.auto.find((a) => a.id === stato.autoScelta);
  const pulsanteAuto = $("#pulsante-auto");
  pulsanteAuto.textContent = auto ? `${auto.nome} · ${auto.litri} ${UNITA[auto.carb]}` : stato.auto.length ? "Scegli auto" : "+ La mia auto";
  pulsanteAuto.classList.toggle("con-auto", !!auto);
  $("#pulsante-luogo").textContent = stato.posizione ? `📍 ${stato.posizione.nome}` : "Scegli dove sei";
  $("#pulsante-raggio").textContent = `entro ${stato.raggio[stato.carb]} km`;
}

function mostraVista(vista) {
  stato.vista = vista;
  document.querySelectorAll(".scheda").forEach((b) => b.classList.toggle("attiva", b.dataset.vista === vista));
  for (const v of ["lista", "mappa", "preferiti"]) $(`#vista-${v}`).hidden = v !== vista;
  ridisegna();
}

let disegnoInCorso = Promise.resolve();
function ridisegna() {
  disegnoInCorso = disegnoInCorso.then(async () => {
    try {
      await disegnaLista();
      if (stato.vista === "mappa") await disegnaMappa();
      if (stato.vista === "preferiti") await disegnaPreferiti();
    } catch (errore) {
      console.error(errore);
      $("#vista-lista").innerHTML = `<div class="vuoto"><h2>Dati non disponibili</h2><p>Controlla la connessione e riprova.</p></div>`;
    }
  });
  return disegnoInCorso;
}

// ------------------- avvio -------------------

async function avvio() {
  document.querySelectorAll("#barra-carburanti [data-carb]").forEach((b) => { b.onclick = () => scegliCarburante(b.dataset.carb); });
  document.querySelectorAll(".scheda").forEach((b) => { b.onclick = () => mostraVista(b.dataset.vista); });
  $("#pulsante-auto").onclick = apriAuto;
  $("#pulsante-luogo").onclick = apriRicercaComune;
  $("#pulsante-raggio").onclick = () => impostaRaggio(RAGGI[(RAGGI.indexOf(stato.raggio[stato.carb]) + 1) % RAGGI.length] ?? 10);
  $("#foglio-sfondo").onclick = chiudiFoglio;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") chiudiFoglio(); });
  aggiornaTestata();

  try {
    stato.meta = await caricaJSON("data/meta.json");
  } catch {
    $("#vista-lista").innerHTML = `<div class="vuoto"><h2>Dati non disponibili</h2><p>Controlla la connessione e riprova.</p></div>`;
    return;
  }
  stato.sponsor = await caricaJSON("config/sponsor.json").catch(() => []);
  ridisegna();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

avvio();

"""
aggiorna_dati.py - Lancetta

Scarica i prezzi UFFICIALI dei carburanti dal Ministero (MIMIT, open data
"Osservaprezzi carburanti", pubblicati ogni mattina entro le 8:30 con i
prezzi in vigore alle 8:00) e li prepara per l'app:

- data/zone/<lat>_<lon>.json   distributori divisi in "zone" di mezzo grado
                               (~50 km), cosi' il telefono scarica solo la
                               zona dove ti trovi, non tutta l'Italia
- data/comuni.json             posizione di ogni comune (per la ricerca
                               quando la posizione GPS non e' disponibile)
- data/meta.json               data dei dati, numeri riassuntivi
- data/prezzi_ieri.json        prezzi del giorno prima, per le frecce
                               "sale / scende"

Gira da solo ogni mattina su GitHub (vedi .github/workflows/aggiorna-dati.yml).
A mano:  python3 scripts/aggiorna_dati.py
"""

import json
import math
import os
import statistics
from collections import defaultdict
from datetime import datetime, timezone

import requests

URL_IMPIANTI = "https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv"
URL_PREZZI = "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv"

CARTELLA_DATI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
LATO_ZONA = 0.5  # gradi

# I 4 carburanti "normali" della barra in alto. Tutti gli altri nomi
# (Blue Diesel, HVO, V-Power...) sono varianti "premium" o speciali e
# compaiono solo nella scheda del singolo distributore.
CARBURANTI_BASE = {"Benzina": "benzina", "Gasolio": "diesel", "GPL": "gpl", "Metano": "metano"}

# Controllo prezzi sospetti (tarato sui dati reali del 30/09/2026):
# - esiste una catena low-cost con prezzi ~25% sotto la media provinciale,
#   e Livigno e' zona franca: quei prezzi sono VERI, non vanno segnalati;
# - gli errori di inserimento visti sono molto piu' estremi (es. 1,199
#   con la provincia a 2,14 = 56%).
SOGLIA_BASSA = 0.65   # sotto il 65% della mediana provinciale -> sospetto
SOGLIA_ALTA = 1.60    # sopra il 160% -> sospetto
MINIMI_ASSOLUTI = {"benzina": 1.0, "diesel": 1.0, "gpl": 0.35, "metano": 0.7}
COMUNI_ZONA_FRANCA = {"LIVIGNO"}


def scarica(url):
    risposta = requests.get(url, headers={"User-Agent": "Mozilla/5.0 (Lancetta)"}, timeout=120)
    risposta.raise_for_status()
    risposta.encoding = "utf-8"
    return risposta.text


def leggi_impianti(testo):
    """Formato: idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|
    Indirizzo|Comune|Provincia|Latitudine|Longitudine. Alcuni nomi
    contengono a loro volta il carattere '|' (es. 'XYZ | gestori.prezzibenzina.it'):
    gli ultimi 5 campi sono sempre fissi, quindi il nome e' tutto cio' che
    sta in mezzo."""
    righe = testo.splitlines()
    estrazione = righe[0].replace("Estrazione del", "").strip()
    impianti = {}
    for riga in righe[2:]:
        campi = riga.split("|")
        if len(campi) < 10:
            continue
        try:
            lat, lon = float(campi[-2]), float(campi[-1])
        except ValueError:
            continue
        if not (35 < lat < 48 and 6 < lon < 19):  # coordinate mancanti o fuori Italia
            continue
        nome = " ".join(c.strip() for c in campi[4:-5]).split(" | ")[0].replace("\t", " ").strip()
        impianti[campi[0]] = {
            "bandiera": campi[2].strip(),
            "nome": nome,
            "indirizzo": " ".join(campi[-5].split()),
            "comune": campi[-4].strip(),
            "provincia": campi[-3].strip(),
            "lat": lat,
            "lon": lon,
        }
    return estrazione, impianti


def leggi_prezzi(testo):
    """Formato: idImpianto|descCarburante|prezzo|isSelf|dtComu"""
    prezzi = defaultdict(list)
    for riga in testo.splitlines()[2:]:
        campi = riga.split("|")
        if len(campi) != 5:
            continue
        id_impianto, carburante, prezzo, self_, data = campi
        try:
            valore = float(prezzo)
            quando = datetime.strptime(data.strip(), "%d/%m/%Y %H:%M:%S")
        except ValueError:
            continue
        if valore <= 0:
            continue
        prezzi[id_impianto].append((carburante.strip(), valore, self_ == "1", quando))
    return prezzi


def titolo(impianto):
    """Nome da mostrare: il marchio, oppure il nome del distributore per le
    pompe bianche (che un marchio non ce l'hanno)."""
    if impianto["bandiera"] and impianto["bandiera"].lower() != "pompe bianche":
        return impianto["bandiera"]
    nome = impianto["nome"]
    if not nome:
        return "Pompa bianca"
    if nome.isupper():
        return nome.title()
    return nome[0].upper() + nome[1:]


def minuti_epoch(quando):
    return int(quando.replace(tzinfo=timezone.utc).timestamp() // 60)


def main():
    os.makedirs(os.path.join(CARTELLA_DATI, "zone"), exist_ok=True)
    estrazione, impianti = leggi_impianti(scarica(URL_IMPIANTI))
    prezzi = leggi_prezzi(scarica(URL_PREZZI))

    # Prezzi del giorno precedente, per le frecce "sale / scende". Se lo
    # script gira piu' volte sugli STESSI dati (due controlli al giorno), si
    # continua a confrontare con il giorno prima, non con se stessi.
    file_ieri = os.path.join(CARTELLA_DATI, "prezzi_ieri.json")
    salvato = {}
    if os.path.exists(file_ieri):
        with open(file_ieri, encoding="utf-8") as f:
            salvato = json.load(f)
    if salvato.get("estrazione") == estrazione:
        ieri = salvato.get("precedenti", {})
    else:
        ieri = salvato.get("prezzi", {})

    # 1) per ogni distributore: prezzo self e servito dei carburanti base
    #    (il piu' recente se ce n'e' piu' d'uno), premium a parte
    distributori = {}
    for id_impianto, voci in prezzi.items():
        impianto = impianti.get(id_impianto)
        if impianto is None:
            continue
        base, premium = {}, defaultdict(dict)
        for carburante, valore, self_, quando in voci:
            chiave = CARBURANTI_BASE.get(carburante)
            tipo = "s" if self_ else "v"
            if chiave:
                voce = base.setdefault(chiave, {})
                if tipo not in voce or quando > voce[tipo + "_quando"]:
                    voce[tipo] = valore
                    voce[tipo + "_quando"] = quando
            else:
                premium[carburante][tipo] = valore
        if base or premium:
            distributori[id_impianto] = (impianto, base, premium)

    # 2) mediane provinciali per il controllo dei prezzi sospetti
    per_provincia = defaultdict(list)
    for impianto, base, _ in distributori.values():
        for chiave, voce in base.items():
            principale = voce.get("s", voce.get("v"))
            per_provincia[(impianto["provincia"], chiave)].append(principale)
    mediane = {k: statistics.median(v) for k, v in per_provincia.items()}

    # 3) composizione dei file per zona
    zone = defaultdict(list)
    comuni = defaultdict(list)
    prezzi_oggi = {}
    sospetti = 0
    for id_impianto, (impianto, base, premium) in distributori.items():
        carburanti = {}
        for chiave, voce in base.items():
            principale = voce.get("s", voce.get("v"))
            quando = max(voce[t + "_quando"] for t in ("s", "v") if t in voce)
            dato = {"t": minuti_epoch(quando)}
            if "s" in voce:
                dato["s"] = voce["s"]
            if "v" in voce:
                dato["v"] = voce["v"]
            mediana = mediane.get((impianto["provincia"], chiave))
            if impianto["comune"] not in COMUNI_ZONA_FRANCA and (
                    principale < MINIMI_ASSOLUTI[chiave]
                    or (mediana and (principale < SOGLIA_BASSA * mediana or principale > SOGLIA_ALTA * mediana))):
                dato["x"] = 1
                sospetti += 1
            prima = ieri.get(id_impianto, {}).get(chiave)
            if prima is not None and abs(principale - prima) >= 0.001:
                dato["d"] = round(principale - prima, 3)
            prezzi_oggi.setdefault(id_impianto, {})[chiave] = principale
            carburanti[chiave] = dato

        voce_zona = {
            "id": id_impianto,
            "n": titolo(impianto),
            "a": impianto["indirizzo"].title(),
            "c": impianto["comune"].title(),
            "p": impianto["provincia"],
            "la": round(impianto["lat"], 5),
            "lo": round(impianto["lon"], 5),
            "f": carburanti,
        }
        if premium:
            voce_zona["pr"] = [[nome, v.get("s"), v.get("v")] for nome, v in sorted(premium.items())]
        chiave_zona = f"{math.floor(impianto['lat'] / LATO_ZONA)}_{math.floor(impianto['lon'] / LATO_ZONA)}"
        zone[chiave_zona].append(voce_zona)
        comuni[(impianto["comune"].title(), impianto["provincia"])].append((impianto["lat"], impianto["lon"]))

    # pulizia delle zone vecchie, poi scrittura
    for vecchio in os.listdir(os.path.join(CARTELLA_DATI, "zone")):
        os.remove(os.path.join(CARTELLA_DATI, "zone", vecchio))
    for chiave_zona, elenco in zone.items():
        with open(os.path.join(CARTELLA_DATI, "zone", chiave_zona + ".json"), "w", encoding="utf-8") as f:
            json.dump(elenco, f, ensure_ascii=False, separators=(",", ":"))

    elenco_comuni = sorted(
        [nome, prov, round(sum(p[0] for p in pos) / len(pos), 4), round(sum(p[1] for p in pos) / len(pos), 4)]
        for (nome, prov), pos in comuni.items())
    with open(os.path.join(CARTELLA_DATI, "comuni.json"), "w", encoding="utf-8") as f:
        json.dump(elenco_comuni, f, ensure_ascii=False, separators=(",", ":"))

    with open(file_ieri, "w", encoding="utf-8") as f:
        json.dump({"estrazione": estrazione, "prezzi": prezzi_oggi, "precedenti": ieri}, f, separators=(",", ":"))

    meta = {
        "estrazione": estrazione,
        "aggiornato_il": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "distributori": len(distributori),
        "prezzi_sospetti": sospetti,
        "lato_zona": LATO_ZONA,
        "zone": sorted(zone),
    }
    with open(os.path.join(CARTELLA_DATI, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    print(f"Dati del {estrazione}: {len(distributori)} distributori in {len(zone)} zone, "
          f"{len(elenco_comuni)} comuni, {sospetti} prezzi sospetti")


if __name__ == "__main__":
    main()

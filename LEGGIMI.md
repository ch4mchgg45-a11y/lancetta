# Lancetta - prezzi carburanti

App web (si apre dal telefono e si aggiunge alla schermata Home) che mostra
i distributori più convenienti vicino a te, con i prezzi ufficiali del
Ministero (MIMIT, open data "Osservaprezzi carburanti").

## Versione 1 (01/10/2026)

- Barra in alto: Benzina · Diesel · GPL · Metano (l'app ricorda l'ultima scelta)
- Lista ordinata dal più conveniente, risparmio al litro rispetto alla media
  della zona; prezzo grande = self, servito scritto piccolo sotto
- "Le mie auto" (facoltativo): con un'auto salvata compare anche
  "sui tuoi N litri risparmi X €"; toccando l'auto cambiano carburante e litri
- Scheda distributore: tutti i carburanti, anche i "premium" (Blue Diesel,
  V-Power...), data da cui il prezzo è in vigore, pulsante Indicazioni
- Mappa (etichette con il prezzo sui 20 più convenienti, gli altri puntini)
- Preferiti: la stellina su un distributore, con freccia ▲▼ se il prezzo
  è cambiato dal giorno prima
- Prezzi sospetti segnalati "da verificare" e messi in fondo
- Spazio pubblicitario: sponsor locale se c'è (`config/sponsor.json`),
  altrimenti annuncio (per ora segnaposto, finché non c'è un account AdSense)
- Tema chiaro/scuro automatico

## Come arrivano i dati

`scripts/aggiorna_dati.py` scarica i due file del Ministero e prepara la
cartella `data/`. Gira **da solo ogni mattina** su GitHub
(`.github/workflows/aggiorna-dati.yml`, alle ~9:30 e ~12:00 ora italiana).

Cose importanti verificate sui dati reali (30/09/2026):
- Il file pubblicato ogni mattina (~8:45) contiene i prezzi **in vigore alle
  8:00 del giorno prima**: c'e' circa un giorno di ritardo, per tutte le app
  che usano i dati ufficiali.
- I distributori comunicano il prezzo solo quando lo cambiano (e almeno una
  volta a settimana): un prezzo "dal 28/09" è il prezzo ancora in vigore,
  non un prezzo vecchio. Per questo l'app scrive "in vigore dal ...".
- I prezzi molto bassi non sono quasi mai errori: c'è una catena low-cost
  (~25% sotto la media) e Livigno è zona franca. Il controllo "sospetto"
  scatta solo sotto il 65% o sopra il 160% della mediana della provincia
  (5 casi su ~21.600 distributori).
- Il Ministero usa oltre 50 nomi di carburante: i 4 "normali" (Benzina,
  Gasolio, GPL, Metano) vanno nella barra; tutti gli altri sono "premium"
  e si vedono solo nella scheda del distributore.

## Provare in locale

    cd lancetta
    python3 scripts/aggiorna_dati.py      # scarica i prezzi di oggi
    python3 -m http.server 8765           # poi apri http://localhost:8765

## Sponsor

`config/sponsor.json` è un elenco, per esempio:

    [{"province": ["TV"], "testo": "Autolavaggio Rapido · -20% questa settimana", "link": "https://..."}]

Lo sponsor compare nella provincia indicata; dove non c'è uno sponsor
compare lo spazio pubblicitario normale.

## Prossime versioni

- v2: pulsante "Il prezzo è cambiato?" con segnalazioni degli utenti
  (serve un piccolo database online)
- v3: sezione auto elettriche (mappa colonnine + prezzi per operatore)
- poi: app sugli store, CarPlay / Android Auto

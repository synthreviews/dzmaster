# DZMASTER + Firebase — bezpečnostní nastavení

## Nejdřív to nejdůležitější

**Samotný mastering pořád běží čistě v prohlížeči.** Analýza, EQ,
kompresor, limiter, export WAV — nic z toho nejde přes žádný server, žádné
API, žádný účet. Audio soubor sám o sobě nikdy nikam neodchází.

Tahle složka (`/firebase`) teď řeší **dvě oddělené věci**:

1. **Limit zdarma (1 mastering/měsíc na IP adresu)** — jediné volání na
   server, které DZMASTER dělá. Než návštěvník zadá odemykací kód, každé
   kliknutí na "Zpracovat" se nejdřív zeptá malé Cloud Function, jestli
   tahle IP adresa už letos tenhle měsíc jednou zdarma masterovala. Funkce
   nikdy nevidí ani nedostane samotný audio soubor — jen odpoví ano/ne.
   IP adresa se hned při příchodu požadavku zahashuje (s tajným "pepře")
   a v Firestore skončí jen ten hash, ne IP samotná — víc v komentářích
   v `functions/index.js`. Po odemčení kódem se tohle volání přeskakuje
   úplně, bez jakéhokoliv limitu.
   → **Spusť `./setup.sh`** — je to jeden skript, který založí/vybere
   projekt, zapne co jde, nasadí funkci i pravidla a sám doplní URL
   funkce do `public/dzmaster.html`. Dva kroky vyžadují lidské potvrzení
   kliknutím (Google to jinak neumožňuje) — skript ti přesně řekne kdy a
   kde: zapnutí Blaze (placeného, ale v praxi zdarma) plánu a první
   přihlášení přes prohlížeč.
2. **Volitelné počítadlo návštěv** — čistě doplňkové, popsané níž. Pokud
   ho nechceš, tuhle část klidně přeskoč.

Bez kroku 1 DZMASTER funguje úplně stejně jako doteď — jen limit zdarma
zatím nikdo nehlídá (viz "fail open" v `dzmaster.html`: dokud
`USAGE_API_URL` neukazuje na skutečnou nasazenou funkci, nástroj limit
prostě nevynucuje a nic se nerozbije).

---

## Volitelné počítadlo návštěv

Tahle část (soubory `optional-visit-counter-snippet.html`, `deploy.sh`)
řeší jen jedno: pokud budeš chtít u DZMASTERu jednoduchý počítadlo návštěv
(kolikrát lidi stránku otevřeli), tak aby to bylo nastavené bezpečně a
nedalo se to zneužít proti tvému účtu. Pokud počítadlo nechceš, tuhle
sekci můžeš úplně ignorovat a nic nedeployovat.

### Jak to funguje bezpečně (proč se API klíč "nemusí tajit")

Časté nedorozumění: lidi si myslí, že Firebase API klíč v kódu stránky je
jako heslo, které musí zůstat v tajnosti. **Není.** U Firebase webových
appek je API klíč veřejný podle návrhu — identifikuje jen *který* projekt
používáš, ne *kdo* smí co dělat. Skutečná bezpečnostní hranice jsou tyhle
tři vrstvy, všechny v této složce:

1. **Firestore Security Rules** (`firestore.rules`) — striktně definují,
   že jde zvýšit přesně jedno číslo v přesně jednom dokumentu o přesně 1,
   a nic jiného (žádné čtení, žádné mazání, žádný jiný dokument) není
   možné. I kdyby si někdo otevřel devtools a zkusil zavolat Firestore
   přímo, pravidla mu to nedovolí.
2. **App Check** — ověří, že požadavek opravdu přišel z tvé stránky
   spuštěné v reálném prohlížeči, ne ze skriptu, který si někdo napsal na
   zavolání tvého API klíče odjinud.
3. **Omezení API klíče na doménu** (Google Cloud Console) — i kdyby si
   někdo klíč zkopíroval, na jiné doméně mu prostě nebude fungovat.

A k tomu ještě jedna praktická pojistka:

4. **Plán Firestore** — samotný počítadlo návštěv by si vystačilo se
   Spark (free) plánem. Pokud jsi ale spustil `./setup.sh` výš kvůli
   limitu zdarma, projekt už na Blaze běží kvůli Cloud Functions — to
   nevadí, Firestore v rámci Blaze má pořád stejné bezpečné chování,
   jen navíc velkorysou zdarma kvótu (viz `setup.sh`).

### Jednorázové kroky pro počítadlo návštěv (udělej je jednou, ručně)

Tohle jsou jediné kroky, které nejdou zautomatizovat skriptem — Google
vyžaduje lidské potvrzení kliknutím v konzoli. Zabere to cca 10 minut,
napořád.

1. **Vytvoř Firebase projekt** — [console.firebase.google.com](https://console.firebase.google.com) → "Add project".
   Zůstaň na **Spark (free)** plánu.
2. **Zapni Firestore** — v projektu vlevo menu → Firestore Database →
   Create database → **Production mode** (ne "test mode" — test mode má
   otevřená pravidla) → zvol region blízko tvým posluchačům (např.
   `europe-west3`).
3. **Vytvoř API klíč a zjisti config** — Project settings (ozubené kolo)
   → Your apps → Add app → Web (`</>`) → pojmenuj ho třeba "dzmaster-web"
   → zkopíruj si `firebaseConfig` objekt, budeš ho potřebovat v
   `optional-visit-counter-snippet.html`.
4. **Vytvoř ten jeden počítaný dokument ručně** — Firestore Database →
   Start collection → collection ID `counters` → document ID
   `dzmaster_visits` → přidej pole `count` (typ number, hodnota `0`) a
   `lastUpdated` (typ timestamp, teď). Pravidla schválně nedovolují, aby
   si tenhle dokument vytvořil kdokoliv z webu — musí existovat předem.
5. **Zapni App Check** — Build → App Check → Apps → tvoje web app →
   Register → provider **reCAPTCHA v3** → Google tě provede založením
   reCAPTCHA klíče na [google.com/recaptcha/admin](https://www.google.com/recaptcha/admin)
   pro tvou doménu → zkopíruj "site key" do
   `optional-visit-counter-snippet.html`.
6. **Omez API klíč na svou doménu** — [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   (stejný projekt) → Credentials → klikni na klíč, který Firebase
   vytvořil (obvykle "Browser key (auto created by Firebase)") →
   **Application restrictions** → **Websites** → přidej
   `synthlucida.com/*` (a `localhost/*` pokud budeš testovat lokálně) →
   Save.

Po těchto 6 krocích už jen upravíš dva soubory a spustíš skript:

7. `cp .firebaserc.example .firebaserc` a doplň svoje skutečné Firebase
   project ID.
8. V `optional-visit-counter-snippet.html` doplň `firebaseConfig` (z
   kroku 3) a `RECAPTCHA_V3_SITE_KEY` (z kroku 5), pak ten `<script>`
   blok vlož do `dzmaster.html` (a/nebo landing page) před `</body>`.
9. `./deploy.sh` — nasadí `firestore.rules` a `firestore.indexes.json` na
   tvůj projekt. Poprvé tě to pošle přihlásit se přes Google v prohlížeči
   (firebase-tools to udělá samo), pak si to bude pamatovat.

Od téhle chvíle je jediná "údržba" spouštět `./deploy.sh` znovu, kdykoliv
bys v budoucnu upravil `firestore.rules`.

### Co dělat, kdybys chtěl v budoucnu víc (e-mailový souhrn návštěv apod.)

Počítadlo návštěv úmyslně nepoužívá Cloud Functions ani GitHub Actions cron
joby navíc — jen samotný Firestore + bezpečná pravidla, ať je toho co
nejméně, co může selhat nebo co by šlo zneužít (limit zdarma výš už Cloud
Function má, ale to je oddělená, samostatně nasazovaná funkce). Pokud
budeš chtít později přidat týdenní e-mailový souhrn návštěv (jak to máš u
jiných projektů), to už je samostatný, o něco větší kus práce — klidně to
můžeme probrat zvlášť, až bude potřeba.

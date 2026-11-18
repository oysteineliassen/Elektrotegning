# Elektrotegning

PWA for å plassere downlights (og annet elektroutstyr) på en plantegning (PDF eller DXF) og se mål til nærmeste vegg i X og Y.

- Trykk på tegningen for å plassere et symbol
- Hold inne på et symbol for å flytte det – målene oppdateres live (med lupe)
- Trykk på et mål for å skrive det inn selv (velg hvilken vegg det måles fra)
- Alt lagres lokalt på enheten (IndexedDB) og virker offline

DWG: lagre som DXF i AutoCAD LT først.

## Utstyr (installasjonstegning) – DXF
- Bytt til **Utstyr** øverst. Symboler (blokker) på utstyrslag kan flyttes, kopieres, roteres og slettes.
- **Hold inne og dra**: veggmonterte symboler (stikk, brytere …) fester seg til nærmeste vegg og roteres automatisk. Appen lærer retningen fra hvordan blokkene står i den opprinnelige tegningen.
- **Nytt utstyr**: dra et symbol opp fra paletten nederst, eller trykk på det og så på tegningen.
- Endringer vises mot prosjektert (stiplet original + strek). 👁 slår visningen av/på.
- Meny → **Eksporter DXF (som bygget)** gir en DXF med endringene, klar til plotting i AutoCAD.
- **Antall uttak**: trykk på en stikkontakt → knappen «2×» → velg 1–6. Tallet ved symbolet oppdateres (og eksporteres).
- **Føringer (skjult anlegg)**: trykk 〰, trykk på punktene etter hverandre → buet strek mellom dem. Trykk på en strek for å bøye den andre veien (⇅), endre buen (⌒) eller slette. Eksporteres som buede polylinjer på føringslaget.
- **Dimmer og termostat** ligger i paletten (E_DIMMER, E_TERMOSTAT). Blokkdefinisjonene legges inn i DXF-en ved eksport.
- **Stabling**: dra et veggsymbol oppå et annet → de stables utover fra veggen på felles stamme og flyttes samlet. ⇵ bytter rekkefølge. Dra et symbol ut av stabelen for å løsne det.
- **Rad**: «⋯ Rad» → trykk start og slutt → velg antall eller c/c, evt. «Fordel mellom veggene» (halv avstand inn mot vegg). Forhåndsvisning før de legges inn.
- **Justering**: punkter som plasseres/flyttes nær samme X eller Y som et annet punkt låses på linje (stiplet hjelpelinje).
- **c/c**: velg et punkt → avstand til naboene på samme linje vises; trykk på c/c-merket for å skrive inn avstanden.
- Takpunktene vises uten mål i **Utstyr**, kan kobles med føringer og eksporteres i DXF som blokkene E_DOWNLIGHT, E_SPOT, E_ROYKVARSLER, E_HOYTTALER, E_KOBLINGSBOKS (lampepunkt bruker tegningens E_LYS).
- **Eksport** (meny → Eksporter): PDF i valgt papirstørrelse og målestokk (vektor fra DXF, bilde fra PDF-underlag), DXF «som bygget», eller bilde. Eksporterer det som vises: Takpunkter (med mål) eller Utstyr (installasjonstegning).
- **Kursnummer**: trykk på første punkt etter tavla → «Kurs» → skriv nummer (f.eks. 3 → «-F3»). Fordeling kan legges til ved flere tavler (=433.11). Sirkelen peker mot tavla, hold inne og dra for å flytte den. Følger med i DXF og PDF.
- **PC**: på stor skjerm ligger verktøyene i et sidepanel. Med mus drar du symboler direkte (ikke langtrykk). Snarveier: Del = slett, Ctrl+Z = angre, R = roter, F = tilpass, +/- = zoom, Esc = avbryt.
- **Synk**: ☁ på startsiden. Prosjektene lagres i et privat GitHub-repo (fine-grained token med Contents: Read and write, bare for det repoet). Synker automatisk ved endringer og når appen åpnes. Ved konflikt vinner nyeste endring.
- **Tekst** (T i Utstyr): trykk på en tekst for å endre eller slette den. Flere: Ctrl/Shift+klikk på PC, ⊞ på telefon, hold inne og dra for å flytte (med mus: bare dra). Trykk på et tomt sted for ny tekst. Gjelder både romnavn, merknader og tekstene ved symbolene. Følger med i DXF og PDF.
- **Kommentar** (💬 på et valgt symbol): f.eks. «Komfyrvakt» eller «plasseres over benk». Hurtigvalg for vanlige kommentarer. Teksten følger symbolet, kan flyttes/endres med tekstverktøyet; når den flyttes et stykke bort, tegnes en strek til symbolet (kan settes til alltid/aldri) og kommer med i DXF (lag E-TEKST) og PDF.

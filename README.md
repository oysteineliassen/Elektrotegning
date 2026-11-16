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

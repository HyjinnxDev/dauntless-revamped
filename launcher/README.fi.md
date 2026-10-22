# Dauntless Revamped Launcher

*[In English](README.md)*

Windows-sovellus, jonka pelaajat asentavat pelatakseen Dauntless 1.14.7 -palvelimella, jossa pyörii
Mystic Paradox. Se liittyy palvelimelle kutsulla, luo tilin (tai kirjautuu), lataa ja tarkistaa
lukitun Dauntless 1.14.7 -asiakkaan ja palvelimen ajonaikaisen osan ja käynnistää pelin paikallisen
välityspalvelimen kautta. Kielinä englanti, suomi ja espanja.

**Tässä sovelluksessa tai repossa ei ole pelitiedostoja.** Ne tulevat ylläpitäjän palvelimelta (tai
palvelimen ilmoittamasta latauspaikasta), ja jokainen tiedosto tarkistetaan käynnistimeen käännettyä
tiedostojen, kokojen ja SHA-256-tiivisteiden listaa vasten (`data/dauntless-1.14.7.json`). Tiedosto,
joka ei täsmää, hylätään.

**Yhteisö:** [Liity Dauntless Revamped -Discordiin](https://discord.gg/HpgNEmVbBb), josta saat apua,
pelikavereita ja projektin uutiset. Käynnistimestä on myös linkki sinne.

## Pelaajille

1. Asenna `DauntlessRevampedLauncher-Setup.exe`
   [uusimmasta julkaisusta](https://github.com/HyjinnxDev/dauntless-revamped-releases/releases/latest) ja
   tarkista se saman julkaisun `SHA256SUMS.txt`-tiedostoa vasten. Asenninta ei ole allekirjoitettu,
   joten SmartScreen voi pyytää vahvistusta (Lisätietoja, sitten Suorita silti). Asennettu käynnistin
   päivittää itsensä.
2. Avaa ylläpitäjän lähettämä kutsulinkki tai liitä se Pelaa-sivulle ja paina **LIITY**.
3. Luo tili (käyttäjänimi ja salasana) tai kirjaudu, jos sinulla on jo tili sillä palvelimella.
4. Paina **ASENNA**. Voit keskeyttää, sulkea käynnistimen ja jatkaa myöhemmin. Jos sinulla on jo
   Dauntless 1.14.7, valitse **Minulla on jo pelitiedostot** ja osoita käynnistimelle se kansio: se
   tarkistaa jokaisen tiedoston ja lataa vain puuttuvat tai erilaiset. Kopioi kansio ensin, jos jokin
   muu asennus käyttää sitä vielä.
5. Paina **PELAA**.

Ikkunan yläreunan GitHub-painike avaa tämän projektin lähdekoodin, ja **Tekijät** kertoo, ketkä
tekivät käynnistimen ja palvelimen, mitä avoimen lähdekoodin ohjelmia ne käyttävät ja millä
lisenssillä.

## Palvelimet ja kutsut

```text
dauntless-revamped://join?v=1&host=<IPv4 tai DNS-nimi>&port=<HTTPS-portti, oletus 443>&fp=<palvelimen varmenteen SHA-256>&code=<kutsukoodi>&name=<palvelimen nimi>
```

Palvelimeen yhdistetään sen julkisella (tai lähiverkon) osoitteella. Kutsussa on `fp`, palvelimen
TLS-varmenteen SHA-256, ja jokainen yhteys (tila, tili, lataukset sekä pelin oma HTTP- ja
chat-liikenne) tarkistetaan sitä vasten ennen kuin mitään lähetetään. Palvelin, jolla on eri varmenne,
ei saa mitään, ja käynnistin kertoo, että "tämä ei ole kaverisi palvelin". Itse allekirjoitettu
varmenne kelpaa.

Kirjautuminen on sidottu tähän sormenjälkeen. Saman osoitteen kutsu eri varmenteella ei saa sitä:
käynnistin näyttää molemmat sormenjäljet ja kysyy ensin, ja siirtää kirjautumisen vain, jos vahvistat
(tee niin vain, kun ylläpitäjä kertoo asentaneensa palvelimen uudelleen).

Peli puhuu taustapalvelulleen pelkkää HTTP:tä, joten pelin ajan käynnistin pitää osoitteessa
`127.0.0.1:61000` **paikallista välityspalvelinta**, joka kuljettaa pyynnöt lukitun TLS-yhteyden yli
palvelimelle. Pidä käynnistin auki pelatessasi. Välityspalvelin kuuntelee vain osoitetta 127.0.0.1 ja
hylkää verkkosivulta tulevat pyynnöt. Pelin UDP-liikenne kulkee suoraan palvelimen peliportteihin.

Ylläpitäjä tekee kutsun komennolla
`node scripts/make-invite.mjs --host <osoite> --cert <fullchain.pem> --code <kutsukoodi> --name "<palvelimen nimi>"`.
Vanhan `dauntless-forever-1147://`-muodon linkit toimivat edelleen.

## Tietoturva

- Sivu on hiekkalaatikossa, kontekstit on eristetty, eikä sillä ole Node-pääsyä. Se ei pääse
  verkkoon lainkaan; pääprosessi tekee jokaisen pyynnön, ja vain kutsun palvelimelle. Sivu puhuu
  pääprosessille pienen tyypitetyn rajapinnan kautta (`src/preload.ts`), ja jokainen argumentti
  tarkistetaan uudelleen.
- Tiukka Content-Security-Policy. Kuvat tulevat vain sovelluksesta itsestään tai ylläpitäjän
  kuvapaketista, jonka pääprosessi hakee lukitun yhteyden yli ja tarjoaa sisäisen skeeman kautta.
- Siirtymät ja uudet ikkunat on estetty. Linkit avautuvat selaimeen vain kiinteältä sallittujen
  listalta: sivu nimeää linkin (kuten `project_source`), ei koskaan URL-osoitetta, ja pääprosessi
  avaa linkin kiinteän osoitteen (`src/main/links.ts`).
- Salasanaa ei tallenneta koskaan. Palvelimen uusintatunniste säilytetään Electronin `safeStorage`n
  (DPAPI) kautta, yksi palvelinta kohden, eikä se koskaan päädy sivulle.
- Palvelimen ajonaikainen osa (`MysticParadox.dll` ja `winmm.dll`) asennetaan täsmälleen palvelimen
  julkaisun mukaisena SHA-256:lla tarkistettuna.
- Electron-fuset: ei `ELECTRON_RUN_AS_NODE`:a, ei `NODE_OPTIONS`ia, ei tarkastinlippuja,
  sovelluskoodi vain eheystarkistetusta asarista.

## Kehitys

Vaatimukset: Windows ja Node.js 20.19 tai uudempi.

```text
npm ci
npm run typecheck
npm test            # yksikkötestit (node:test), paikalliset testipalvelimet osoitteessa 127.0.0.1
npm start           # käynnistin lähdekoodista
npm run make        # Squirrel-asennin + siirrettävä zip kansioon out/
```

`npm test -- relay` ajaa vain testitiedostot, joiden nimessä on "relay". Testit kattavat kutsujen
jäsentämisen, välityspalvelimen, lataukset (jatko, tarkistus, korjaus) lukitun TLS:n yli,
käynnistysasetukset, linkit, jotka käynnistin saa avata, Tekijät-sivun tiedot, koko kulun
ohjaimen läpi sekä ulkoasun: brändin värit ja kuvat. Ne tekevät kertakäyttöisiä itse
allekirjoitettuja varmenteita väliaikaiskansioon.

`DAUNTLESS_REVAMPED_RELAY_PORT` siirtää välityspalvelimen pois portista 61000 koneella, jossa se on
varattu.

`npx tsx scripts/live-check.ts "<kutsu>" <käyttäjänimi> <salasana>` tarkistaa toimivan palvelimen
alusta loppuun käynnistämättä peliä. `scripts/make-game-manifest.mjs` rakentaa lukitun
pelitiedostolistan asennuksesta uudelleen.

Värit ovat `src/renderer/styles.css`:n `--dr-*`-tokeneita (`brand/palette.json`ista). Ikkunan ja
asentimen kuvakkeet sekä otsikkopalkin tunnus ovat kopioita `brand/`-kansion tiedostoista, ja ne
tekee `npm run icon`. `npm test` epäonnistuu, jos kopio on vanhentunut, jos tyylitiedostossa on väri,
joka ei ole token, tai jos sen käyttämä väripari ei läpäise WCAG AA:ta.

## Julkaisut ja päivitykset

Nosta `package.json`in `version` ja aja `npm run release`: se rakentaa asentimen ja zipin, kerää ne
`SHA256SUMS.txt`:n kanssa (`scripts/collect-release.ps1`) ja julkaisee ne
[HyjinnxDev/dauntless-revamped-releases](https://github.com/HyjinnxDev/dauntless-revamped-releases)
-repon julkaisuna. Asennetut käynnistimet lukevat sen repon uusimman julkaisun Squirrel-päivityssyötteenään.
Siirrettävästä zipistä tehdyt asennukset eivät päivitä itseään.

Ensimmäisellä käynnistyksellä käynnistin siirtää vanhemman Dauntless Forever 1.14.7 -käynnistimen
asetukset ja kirjautumiset ja poistaa sen asennuksen (`src/main/migrate.ts`).

## Lisenssi

AGPL-3.0-only. Muokattu versio [Dauntless Revived](https://github.com/mixutin/dauntless-revived)
-käynnistimestä, joka puolestaan on muokattu versio gwogin (Gregory Morford) ja muiden tekemästä
[Undaunted](https://github.com/SyST3MDeV/Undaunted)-käynnistimestä. Se pelaa
[Mystic Paradoxin](https://github.com/pranav158/Mystic-Paradox) päällä. Epävirallinen fanien projekti,
jolla ei ole yhteyttä Phoenix Labsiin tai Epic Gamesiin eikä niiden hyväksyntää.

Käynnistimen kolmannen osapuolen ohjelmien lisenssitekstit toimitetaan sen mukana tiedostossa
`THIRD-PARTY-NOTICES.txt`. Tekijät-sivu lukee listansa tiedostosta `src/shared/credits.ts`.

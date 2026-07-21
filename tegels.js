// Actuele waardes, historie en verwachting boven aan het dashboard.
//
// Drie bronnen, elk om een andere reden:
//
//   data.sensor.community  actuele waardes, stuurt Access-Control-Allow-Origin: *
//                          maar geeft alleen de laatste ~5 minuten
//   historie.json          de gemeten lijn van 12 uur terug. Wordt bij elke
//                          deploy door .github/historie.py uit Madavi's InfluxDB
//                          gehaald; die InfluxDB laat de browser er zelf niet bij
//   Open-Meteo             de verwachting voor de komende 12 uur, weer en lucht
//
// Elke bron faalt apart: valt de historie weg, dan blijft de rest staan.

(() => {
  const PM_SENSOR   = 94016;  // SDS011 → P1 = PM10, P2 = PM2.5
  const KLIM_SENSOR = 94017;  // SHT30  → temperature, humidity
  const SENSOR      = { lat: 51.84171, lon: 5.838826 };
  const VERVERS_MS  = 60_000;
  const OUD_NA_MIN  = 20;     // sensor meldt elke ~55 s; 20 min stil = probleem
  const UUR = 3600000, VENSTER_UREN = 12;

  // WHO-advieswaarden 2021, 24-uursgemiddelde in µg/m³. De EU-grenswaarden
  // zijn ruimer (PM2.5 25, PM10 50); WHO is gezondheidsgericht en daarmee de
  // strengere, betekenisvollere maatstaf.
  const WHO24 = { pm25: 15, pm10: 45 };

  const GROEN = '#16a34a', ROOD = '#dc2626', BLAUW = '#0284c7';
  // Fellere versies voor het donkere paneel; de witte tegels houden de gedempte.
  const H_GROEN = '#4ade80', H_ROOD = '#f87171', H_BLAUW = '#38bdf8', H_PAARS = '#c084fc';

  const banden = {
    pm25: [[15,'Goed',GROEN], [25,'Matig','#ca8a04'], [50,'Onvoldoende','#ea580c'], [Infinity,'Slecht',ROOD]],
    pm10: [[45,'Goed',GROEN], [75,'Matig','#ca8a04'], [150,'Onvoldoende','#ea580c'], [Infinity,'Slecht',ROOD]]
  };
  const band = (soort, v) => banden[soort].find(([g]) => v <= g);

  const vochtDuiding = h =>
    h < 30 ? ['Droog','#ca8a04'] : h < 60 ? ['Behaaglijk',GROEN] :
    h < 80 ? ['Vochtig',BLAUW] : ['Zeer vochtig','#0369a1'];

  const nl = (v, d) => v.toFixed(d).replace('.', ',');
  let gid = 0;

  // InfluxDB levert "…T12:00:00Z", Open-Meteo levert "…T12:00" zonder zone.
  // Beide zijn UTC, dus alleen aanvullen wanneer het achtervoegsel ontbreekt.
  const parseUTC = s => Date.parse(s.endsWith('Z') ? s : s + 'Z');
  const klokVan = t => new Date(t).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

  const NAAM = 'Weerstation Nijmegen-West';

  // Datum erbij, want het venster loopt over middernacht heen: alleen "03:45"
  // laat in het midden of dat vannacht of morgennacht is.
  const stempel = t => {
    const d = new Date(t);
    return d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' }) +
           ' · ' + klokVan(t);
  };

  const geleden = ms => {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'zojuist';
    if (m === 1) return '1 minuut geleden';
    if (m < 60) return `${m} minuten geleden`;
    const u = Math.round(m / 60);
    return u === 1 ? 'ruim een uur geleden' : `${u} uur geleden`;
  };

  // Dauwpunt via Magnus — laat zien wanneer het zwoel aanvoelt en wanneer je
  // condens op de sensor kunt verwachten.
  const dauwpunt = (t, rh) => {
    const a = 17.62, b = 243.12;
    const g = Math.log(rh / 100) + (a * t) / (b + t);
    return (b * g) / (a - g);
  };

  const IJK_PCT = 60;
  // Tot de advieswaarde lineair, daarboven logaritmisch tot 10×. Zonder dit
  // staat de balk bij 130%, 250% én 950% even vol.
  const meterBreedte = r =>
    r <= 1 ? r * IJK_PCT : Math.min(100, IJK_PCT + (100 - IJK_PCT) * Math.log10(r));

  // Boven de 2× leest een factor makkelijker dan een percentage.
  const verhoudingTekst = (r, g) =>
    r > 2 ? `${nl(r, 1)}× het WHO-advies (${g})` : `${Math.round(r * 100)}% van WHO-advies (${g})`;

  // ---------------------------------------------------------------- zon & maan

  // Zonshoogte. Gecontroleerd tegen de zonsopkomstvergelijking: op zonop en
  // zononder geeft dit ~ -0,83 graden, dagpiek 20 juli 58,6 graden.
  const zonHoogte = datum => {
    const rad = Math.PI / 180, deg = 180 / Math.PI;
    const d = datum.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const L = (280.460 + 0.9856474 * d) % 360;
    const g = (357.528 + 0.9856003 * d) % 360;
    const lam = (L + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) % 360;
    const eps = 23.439 - 0.0000004 * d;
    const dec = Math.asin(Math.sin(eps * rad) * Math.sin(lam * rad));
    const ra = Math.atan2(Math.cos(eps * rad) * Math.sin(lam * rad), Math.cos(lam * rad)) * deg;
    const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
    const H = (((gmst * 15 + SENSOR.lon - ra) + 180) % 360 + 360) % 360 - 180;
    return Math.asin(Math.sin(SENSOR.lat * rad) * Math.sin(dec) +
                     Math.cos(SENSOR.lat * rad) * Math.cos(dec) * Math.cos(H * rad)) * deg;
  };

  // Maanbaan volgens de compacte methode-Schlyter, zonder storingstermen: goed
  // tot ongeveer een graad, ruim genoeg voor een icoon. Gecontroleerd: volle
  // maan 30 juli 2026, nieuwe maan rond 13 augustus.
  const maanStand = datum => {
    const rad = Math.PI / 180, deg = 180 / Math.PI, norm = x => ((x % 360) + 360) % 360;
    const d = datum.getTime() / 86400000 + 2440587.5 - 2451543.5;
    const N = norm(125.1228 - 0.0529538083 * d), i = 5.1454;
    const w = norm(318.0634 + 0.1643573223 * d), a = 60.2666, e = 0.054900;
    const M = norm(115.3654 + 13.0649929509 * d);

    let E = M + e * deg * Math.sin(M * rad) * (1 + e * Math.cos(M * rad));
    for (let k = 0; k < 4; k++)
      E -= (E - e * deg * Math.sin(E * rad) - M) / (1 - e * Math.cos(E * rad));

    const x = a * (Math.cos(E * rad) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E * rad);
    const r = Math.hypot(x, y), v = norm(Math.atan2(y, x) * deg);
    const xe = r * (Math.cos(N*rad)*Math.cos((v+w)*rad) - Math.sin(N*rad)*Math.sin((v+w)*rad)*Math.cos(i*rad));
    const ye = r * (Math.sin(N*rad)*Math.cos((v+w)*rad) + Math.cos(N*rad)*Math.sin((v+w)*rad)*Math.cos(i*rad));
    const ze = r * Math.sin((v+w)*rad) * Math.sin(i*rad);
    const lon = norm(Math.atan2(ye, xe) * deg), lat = Math.atan2(ze, Math.hypot(xe, ye)) * deg;

    const ecl = 23.4393 - 3.563e-7 * d;
    const xq = Math.cos(lon*rad)*Math.cos(lat*rad);
    const yq = Math.sin(lon*rad)*Math.cos(lat*rad)*Math.cos(ecl*rad) - Math.sin(lat*rad)*Math.sin(ecl*rad);
    const zq = Math.sin(lon*rad)*Math.cos(lat*rad)*Math.sin(ecl*rad) + Math.sin(lat*rad)*Math.cos(ecl*rad);
    const ra = norm(Math.atan2(yq, xq) * deg), dec = Math.atan2(zq, Math.hypot(xq, yq)) * deg;

    const gmst0 = norm(282.9404 + 4.70935e-5*d + 356.0470 + 0.9856002585*d + 180);
    const lst = norm(gmst0 + (datum.getUTCHours() + datum.getUTCMinutes()/60) * 15 + SENSOR.lon);
    let H = norm(lst - ra); if (H > 180) H -= 360;
    const hoogte = Math.asin(Math.sin(SENSOR.lat*rad)*Math.sin(dec*rad) +
                             Math.cos(SENSOR.lat*rad)*Math.cos(dec*rad)*Math.cos(H*rad)) * deg;

    const ds = datum.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const zonLon = norm(280.460 + 0.9856474*ds + 1.915*Math.sin(norm(357.528 + 0.9856003*ds) * rad));
    return { hoogte, fase: norm(lon - zonLon) / 360 };   // fase: 0 nieuw, 0,5 vol
  };

  // Donkere zijde van de maan. c loopt van -1 (vol) naar +1 (nieuw); de
  // terminator is een ellips met halve as R·|c|.
  const maanDonkerPad = (fase, R) => {
    const c = Math.cos(2 * Math.PI * fase);
    const rx = Math.abs(c) * R;
    const buiten = fase < 0.5 ? 0 : 1;              // wassend: donker links
    const binnen = c > 0 ? buiten : 1 - buiten;     // sikkel of bolle maan
    return `M0,${-R} A${R},${R} 0 0 ${buiten} 0,${R} A${rx.toFixed(2)},${R} 0 0 ${binnen} 0,${-R} Z`;
  };

  // ------------------------------------------------------------------- de lucht

  // Volle dekking: dit ís de achtergrond van het paneel. Nacht moet echt
  // donker zijn, anders vallen de sterren weg.
  const LUCHT = [
    [-90, [  8, 13, 28]],   // diepe nacht
    [-18, [ 12, 19, 40]],   // astronomische schemering
    [-12, [ 20, 33, 68]],   // nautische schemering
    [ -6, [ 44, 58,110]],   // burgerlijke schemering
    [ -2, [136, 84,116]],   // omslag naar warm
    [  0, [198,112, 84]],   // zonsop en zononder
    [  4, [232,160,100]],   // gouden uur
    [ 10, [ 82,148,206]],   // ochtend- en avondblauw
    [ 60, [ 49,130,196]]    // volle dag
  ];

  const luchtKleur = el => {
    if (el <= LUCHT[0][0]) return LUCHT[0][1];
    for (let i = 0; i < LUCHT.length - 1; i++) {
      const [a, ca] = LUCHT[i], [b, cb] = LUCHT[i + 1];
      if (el <= b) {
        const f = (el - a) / (b - a);
        return ca.map((c, n) => Math.round(c + (cb[n] - c) * f));
      }
    }
    return LUCHT[LUCHT.length - 1][1];
  };

  const luchtVerloop = (t0, t1, id) => {
    const N = 60, stops = [];
    for (let i = 0; i <= N; i++) {
      const rgb = luchtKleur(zonHoogte(new Date(t0 + (t1 - t0) * i / N)));
      stops.push(`<stop offset="${(i / N * 100).toFixed(2)}%" stop-color="rgb(${rgb.join(',')})"/>`);
    }
    return `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${stops.join('')}</linearGradient>`;
  };

  const HORIZON = 0.84;   // deel van de hoogte waar de horizon ligt
  const TOP_GRADEN = 55;  // hoogte die de bovenkant van de grafiek voorstelt

  const hemelLagen = (t0, t1, H, nuMs) => {
    const horizonY = H * HORIZON;
    // Begrenzen aan boven- én onderkant: in de zomer komt de zon hier boven de
    // 58 graden en zou hij anders uit de grafiek lopen.
    const naarY = el =>
      horizonY - Math.min(Math.max(el, 0), TOP_GRADEN) / TOP_GRADEN * (horizonY - H * 0.06);
    const naarX = t => (t - t0) / (t1 - t0) * 100;

    // Baan boven de horizon, plus het punt waar het icoon komt: de opkomst.
    // Alleen een échte horizonkruising telt -- stond hij bij het begin van het
    // venster al op, dan is dat geen opkomst maar de vensterrand. Is er geen
    // kruising in beeld, dan het hoogste punt; tegen de rand plakken zag
    // eruit als een fout.
    const baan = fn => {
      const stukken = []; let huidig = [], opkomst = null;
      let top = null, topEl = -Infinity;
      let vorigeOnder = fn(new Date(t0)) <= 0;
      for (let i = 0; i <= 144; i++) {
        const t = t0 + (t1 - t0) * i / 144;
        const el = fn(new Date(t));
        if (el > 0) {
          if (vorigeOnder && !opkomst) opkomst = { x: naarX(t), y: naarY(el) / H * 100 };
          if (el > topEl) { topEl = el; top = { x: naarX(t), y: naarY(el) / H * 100 }; }
          huidig.push(`${naarX(t).toFixed(2)},${naarY(el).toFixed(2)}`);
        } else if (huidig.length) { stukken.push(huidig); huidig = []; }
        vorigeOnder = el <= 0;
      }
      if (huidig.length) stukken.push(huidig);
      const plek = opkomst ?? top;
      // Half over de rand hangen oogt als een fout, dus een marge aanhouden.
      if (plek) plek.x = Math.min(97, Math.max(3, plek.x));
      return {
        d: stukken.filter(s => s.length > 1).map(s => 'M' + s.join(' L')).join(' '),
        plek, echt: !!opkomst
      };
    };

    const zon = baan(zonHoogte);
    const maan = baan(d => maanStand(d).hoogte);

    const achtergrond = `
      <path d="${zon.d}" fill="none" stroke="#fbbf24" stroke-width="1" opacity="0.3"
            stroke-dasharray="1.5 2" vector-effect="non-scaling-stroke"/>
      <path d="${maan.d}" fill="none" stroke="#cbd5e1" stroke-width="1" opacity="0.28"
            stroke-dasharray="1.5 2" vector-effect="non-scaling-stroke"/>`;

    // Sterren als overlay-divs, niet als SVG-cirkels: in de gestrekte SVG
    // zouden het uitgerekte ellipsen worden. Vaste posities uit een simpele
    // hash, zodat ze niet bij elke herteken verspringen.
    const hash = n => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
    let overlays = '';
    for (let n = 0; n < 90; n++) {
      const fx = hash(n), fy = hash(n + 500);
      const el = zonHoogte(new Date(t0 + (t1 - t0) * fx));
      if (el > -8) continue;                       // alleen waar het echt donker is
      const helder = Math.min(1, (-el - 8) / 10);  // dieper in de nacht = feller
      const px = (1.4 + hash(n + 900) * 1.6).toFixed(1);
      overlays += `<div class="ster" style="left:${(fx*100).toFixed(2)}%;top:${(fy*HORIZON*88).toFixed(2)}%;
                    width:${px}px;height:${px}px;opacity:${(0.35 + helder*0.55).toFixed(2)}"></div>`;
    }

    if (zon.plek) {
      const R = 6.5, stralen = Array.from({ length: 12 }, (_, k) => {
        const a = k * Math.PI / 6;
        return `<line x1="${(Math.cos(a)*(R+2.2)).toFixed(2)}" y1="${(Math.sin(a)*(R+2.2)).toFixed(2)}"
                      x2="${(Math.cos(a)*(R+5)).toFixed(2)}" y2="${(Math.sin(a)*(R+5)).toFixed(2)}"/>`;
      }).join('');
      overlays += `<div class="hemel zon" style="left:${zon.plek.x}%;top:${zon.plek.y}%"
                    title="${zon.echt ? 'zonsopkomst' : 'hoogste stand van de zon'}">
        <svg viewBox="-13 -13 26 26" width="28" height="28" aria-hidden="true">
          <g stroke="#fbbf24" stroke-width="1.7" stroke-linecap="round" opacity="0.9">${stralen}</g>
          <circle r="${R}" fill="#fcd34d" stroke="#f59e0b" stroke-width="0.7"/>
        </svg></div>`;
    }

    if (maan.plek) {
      const R = 7, fase = maanStand(new Date(nuMs)).fase;
      overlays += `<div class="hemel maan" style="left:${maan.plek.x}%;top:${maan.plek.y}%"
                    title="${maan.echt ? 'maansopkomst' : 'hoogste stand van de maan'}">
        <svg viewBox="-8.5 -8.5 17 17" width="22" height="22" aria-hidden="true">
          <circle r="${R}" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="0.6"/>
          <circle cx="-2.2" cy="-2" r="1.4" fill="#dbe3ec" opacity="0.9"/>
          <circle cx="2"    cy="1.3" r="1.7" fill="#dbe3ec" opacity="0.85"/>
          <circle cx="-1.1" cy="3"   r="1"   fill="#dbe3ec" opacity="0.85"/>
          <path d="${maanDonkerPad(fase, R)}" fill="#0f172a" opacity="0.62"/>
        </svg></div>`;
    }

    return { achtergrond, overlays };
  };

  // ------------------------------------------------------------------ geometrie

  // Meting (kwartier) en verwachting (uur) hebben verschillende resoluties, dus
  // posities volgen uit de tijdstempel en niet uit de index.
  const bouwPad = (gemeten, verwacht, { t0, t1, H, log }) => {
    const alles = [...gemeten, ...verwacht].filter(p => p.v != null);
    if (alles.length < 2) return null;
    const marge = H * 0.1;
    // Fijnstof is log-normaal: op een lineaire schaal drukt één piek de rest
    // van de dag plat tegen de onderkant.
    const schaal = v => log ? Math.log10(Math.max(v, 0.1)) : v;
    const w = alles.map(p => schaal(p.v));
    const min = Math.min(...w), max = Math.max(...w), bereik = (max - min) || 1;
    const x = t => (t - t0) / (t1 - t0) * 100;
    const y = v => H - marge - ((schaal(v) - min) / bereik) * (H - 2 * marge);

    const naarGeo = (rij, soort) => rij.filter(p => p.v != null && p.t >= t0 && p.t <= t1)
      .map(p => ({ t: p.t, waarde: p.v, soort, x: x(p.t), y: y(p.v), yPct: y(p.v) / H * 100 }));

    const g = naarGeo(gemeten, 'gemeten'), v = naarGeo(verwacht, 'verwacht');
    if (!g.length && !v.length) return null;
    const dVan = rij => rij.length < 2 ? '' :
      'M' + rij.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L');

    return { min, max, schaal, y, geo: [...g, ...v].sort((a, b) => a.t - b.t),
             dGemeten: dVan(g), dVerwacht: dVan(v), gemetenGeo: g };
  };

  // Twee stops op dezelfde offset geven een harde kleurbreuk op drempelhoogte.
  // userSpaceOnUse is nodig, anders rekent de browser offsets tegen de bounding
  // box van het pad in plaats van tegen de viewBox.
  const drempelVerf = (pad, drempel, kleur, H, id, over = ROOD) => {
    if (drempel == null) return { defs: '', lijn: kleur };
    const dS = pad.schaal(drempel);
    if (dS <= pad.min) return { defs: '', lijn: over };
    if (dS >= pad.max) return { defs: '', lijn: kleur };
    const t = (pad.y(drempel) / H).toFixed(4);
    return {
      defs: `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}">
               <stop offset="0" stop-color="${over}"/><stop offset="${t}" stop-color="${over}"/>
               <stop offset="${t}" stop-color="${kleur}"/><stop offset="1" stop-color="${kleur}"/>
             </linearGradient>`,
      lijn: `url(#${id})`, t };
  };

  const cursorHtml = (stippen = 1) =>
    `<div class="spark-cursor" hidden><div class="spark-guide"></div>${
      '<div class="spark-dot"></div>'.repeat(stippen)}</div>
     <div class="nu-lijn"></div>`;

  // Het aanwijsgebied is de hele tegel; de x-positie wordt tegen de grafiek
  // gemeten, want die loopt full-bleed en is dus even breed.
  const koppelHover = (raakvlak, grafiek, series, opTonen, opWeg) => {
    const cursor = grafiek.querySelector('.spark-cursor');
    if (!cursor) return;
    let vast = false;

    const toon = e => {
      const r = grafiek.getBoundingClientRect();
      if (!r.width) return;
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const eerste = series[0].geo;
      let dichtst = eerste[0];
      for (const p of eerste)
        if (Math.abs(p.x / 100 - frac) < Math.abs(dichtst.x / 100 - frac)) dichtst = p;

      cursor.hidden = false;
      grafiek.querySelector('.spark-guide').style.left = `${dichtst.x}%`;

      const gekozen = series.map((s, n) => {
        let p = s.geo[0];
        for (const q of s.geo)
          if (Math.abs(q.t - dichtst.t) < Math.abs(p.t - dichtst.t)) p = q;
        const dot = grafiek.querySelectorAll('.spark-dot')[n];
        if (dot) {
          dot.style.left = `${p.x}%`;
          dot.style.top = `${p.yPct}%`;
          // Kleur volgt de aangewezen meting, niet de huidige stand: anders
          // krijg je een groene stip midden in een rood stuk lijn.
          dot.style.background = (s.drempel != null && p.waarde > s.drempel) ? (s.over ?? ROOD) : s.kleur;
          dot.style.opacity = p.soort === 'verwacht' ? '0.55' : '1';
        }
        return p;
      });
      opTonen(gekozen, dichtst);
    };

    const verberg = () => { vast = false; cursor.hidden = true; opWeg(); };
    raakvlak.addEventListener('pointerdown', e => { vast = true; toon(e); });
    raakvlak.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' && !vast) return;   // niet tijdens scrollen
      toon(e);
    });
    raakvlak.addEventListener('pointerleave', verberg);
    raakvlak.addEventListener('pointercancel', verberg);
    raakvlak.addEventListener('pointerup', () => { vast = false; });
  };

  // ----------------------------------------------------------------- losse tegel

  const tegel = ({ label, getal, decimalen, eenheid, duiding, kleur, meter, ijk, voet,
                   gemeten, verwacht, drempel, log, t0, t1 }) => {
    const H = 40;
    const el = document.createElement('div');
    el.className = 'tegel';
    el.style.setProperty('--kleur', kleur);

    const pad = (gemeten && verwacht) ? bouwPad(gemeten, verwacht, { t0, t1, H, log }) : null;
    const id = `s${gid++}`;
    const verf = pad ? drempelVerf(pad, drempel, kleur, H, `${id}l`) : { defs: '', lijn: kleur };
    const laatsteX = pad && pad.gemetenGeo.length
      ? pad.gemetenGeo[pad.gemetenGeo.length - 1].x.toFixed(2) : '0';

    const strook = pad ? `<div class="spark-strook">
        <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">
          <defs>${verf.defs}
            <linearGradient id="${id}v" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="${kleur}" stop-opacity="0.16"/>
              <stop offset="1" stop-color="${kleur}" stop-opacity="0"/>
            </linearGradient></defs>
          <path d="${pad.dGemeten} L${laatsteX},${H} L0,${H} Z" fill="url(#${id}v)"/>
          <path d="${pad.dGemeten}" fill="none" stroke="${verf.lijn}" stroke-width="1.6"
                stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
          <path d="${pad.dVerwacht}" fill="none" stroke="${verf.lijn}" stroke-width="1.4" opacity="0.5"
                stroke-dasharray="3 2.5" stroke-linejoin="round" stroke-linecap="round"
                vector-effect="non-scaling-stroke"/>
        </svg>${cursorHtml(1)}</div>` : '';

    if (pad) el.classList.add('met-strook');

    const meterHtml = (!pad && meter != null)
      ? `<div class="meter${ijk != null ? ' geijkt' : ''}"${ijk != null
           ? ` style="--ijk:${ijk}%" title="Streepje = WHO-advieswaarde"` : ''}>
           <i style="width:${Math.min(100, meter)}%"></i></div>`
      : '';

    el.innerHTML = `
      <div class="tegel-label">${label}</div>
      <div class="waarde"><span class="getal">${nl(getal, decimalen)}</span><span class="eenheid">${eenheid}</span></div>
      <div class="duiding"><span class="stip"></span>${duiding}</div>
      ${meterHtml}
      <div class="voet">${voet ?? '&nbsp;'}</div>
      ${strook}`;

    if (pad) {
      const voetEl = el.querySelector('.voet');
      const origineel = voetEl.textContent;
      koppelHover(el, el.querySelector('.spark-strook'),
        [{ geo: pad.geo, kleur, drempel }],
        gekozen => {
          const p = gekozen[0];
          voetEl.textContent = `${klokVan(p.t)} · ${nl(p.waarde, decimalen)} ${eenheid}` +
            (p.soort === 'verwacht' ? ' (verwacht)' : '');
        },
        () => { voetEl.textContent = origineel; });
    }
    return el;
  };

  // ---------------------------------------------------------- gecombineerde tegel

  // Elke reeks krijgt zijn eigen schaal: PM, temperatuur en vocht delen geen
  // zinnige y-as. Je ziet dus vorm en samenhang; de hover geeft de getallen.
  // PM10 gestippeld, want beide fijnstoflijnen kleuren rood bij overschrijding.
  const REEKSEN = [
    { sleutel:'pm25',  label:'PM2.5',            eenheid:'µg/m³', dec:1, kleur:H_GROEN, drempel:WHO24.pm25, log:true },
    { sleutel:'pm10',  label:'PM10',             eenheid:'µg/m³', dec:1, kleur:H_GROEN, drempel:WHO24.pm10, log:true, streep:true },
    { sleutel:'temp',  label:'Temperatuur',      eenheid:'°C',    dec:1, kleur:H_BLAUW },
    { sleutel:'vocht', label:'Luchtvochtigheid', eenheid:'%',     dec:0, kleur:H_PAARS }
  ];

  const grooteTegel = (nu, gemeten, verwacht, t0, t1, versheid) => {
    const H = 44;
    const el = document.createElement('div');
    el.className = 'groot';

    const paden = REEKSEN
      .map(r => ({ ...r, pad: bouwPad(gemeten[r.sleutel] ?? [], verwacht[r.sleutel] ?? [], { t0, t1, H, log: !!r.log }) }))
      .filter(r => r.pad);
    if (!paden.length) return null;

    const hemel = hemelLagen(t0, t1, H, (t0 + t1) / 2);
    const luchtId = `lucht${gid++}`;
    let defs = luchtVerloop(t0, t1, luchtId), lijnen = '', dots = '';
    paden.forEach(r => {
      const id = `k${gid++}`;
      const verf = drempelVerf(r.pad, r.drempel, r.kleur, H, id, H_ROOD);
      defs += verf.defs;
      const streep = r.streep ? 'stroke-dasharray="3 2"' : '';
      lijnen += `<path d="${r.pad.dGemeten}" fill="none" stroke="${verf.lijn}" stroke-width="1.7"
                   ${streep} stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
                 <path d="${r.pad.dVerwacht}" fill="none" stroke="${verf.lijn}" stroke-width="1.5" opacity="0.5"
                   stroke-dasharray="3 2.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
      dots += `<div class="spark-dot" style="--kleur:${r.kleur}"></div>`;
    });

    el.innerHTML = `
      <div class="groot-kop">
        <span class="groot-naam">${NAAM}</span>
        <span class="groot-versheid"><span class="puls"></span>${versheid}</span>
        <span class="groot-tijd">${stempel(Date.now())}</span>
      </div>
      <div class="groot-waardes">
        ${paden.map(r => `<div>
          <span class="gw-label"><span class="gw-merk" style="background:${r.kleur}"></span>${r.label}</span>
          <span class="gw-getal" data-s="${r.sleutel}">${nl(nu[r.sleutel], r.dec)}</span><span class="gw-eh">${r.eenheid}</span>
        </div>`).join('')}
      </div>
      <div class="groot-graf">
        <svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">
          <defs>${defs}</defs>
          <rect x="0" y="0" width="100" height="${H}" fill="url(#${luchtId})"/>
          ${hemel.achtergrond}
          ${lijnen}
        </svg>
        ${hemel.overlays}
        ${cursorHtml(paden.length)}
        <div class="nu-label">nu</div>
      </div>`;

    const tijdEl = el.querySelector('.groot-tijd');
    const getallen = Object.fromEntries([...el.querySelectorAll('.gw-getal')].map(n => [n.dataset.s, n]));

    koppelHover(el, el.querySelector('.groot-graf'),
      paden.map(r => ({ geo: r.pad.geo, kleur: r.kleur, drempel: r.drempel, over: H_ROOD })),
      (gekozen, aangewezen) => {
        tijdEl.textContent = stempel(aangewezen.t) + (aangewezen.soort === 'verwacht' ? ' · verwacht' : '');
        paden.forEach((r, n) => { getallen[r.sleutel].textContent = nl(gekozen[n].waarde, r.dec); });
      },
      () => {
        tijdEl.textContent = stempel(Date.now());
        paden.forEach(r => { getallen[r.sleutel].textContent = nl(nu[r.sleutel], r.dec); });
      });

    return el;
  };

  // ------------------------------------------------------------------ ophalen

  const haalSensor = async id => {
    const r = await fetch(`https://data.sensor.community/airrohr/v1/sensor/${id}/`);
    if (!r.ok) throw new Error(`sensor ${id}: HTTP ${r.status}`);
    const d = await r.json();
    if (!Array.isArray(d) || !d.length) throw new Error(`sensor ${id} geeft geen metingen`);
    return d;
  };

  // De SDS011 is rumoerig; één losse meting schommelt flink. Daarom het
  // gemiddelde over het venster dat de API teruggeeft (~5 min), net zoals
  // sensor.community zelf op de kaart doet.
  const gemiddelde = (rijen, type) => {
    const w = rijen.flatMap(r => r.sensordatavalues)
                   .filter(v => v.value_type === type)
                   .map(v => parseFloat(v.value)).filter(Number.isFinite);
    return w.length ? { waarde: w.reduce((a, b) => a + b, 0) / w.length, n: w.length } : null;
  };

  const nieuwste = rijen => rijen.map(r => parseUTC(r.timestamp)).sort((a, b) => b - a)[0];

  // Historie en verwachting mogen wegvallen zonder de rest mee te nemen.
  const zacht = belofte => belofte.then(r => r, () => null);

  const haalHistorie = () =>
    fetch('historie.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(d => {
        const uit = {};
        for (const k of ['pm25','pm10','temp','vocht'])
          uit[k] = d.punten.map(p => ({ t: parseUTC(p.t), v: p[k] }));
        return uit;
      });

  // past_days=1 erbij, zodat het model ook het recente verleden dekt. Dat is
  // nodig omdat historie.json alleen bij een deploy wordt ververst en GitHub
  // geplande runs afknijpt: in de praktijk loopt de meting soms uren achter.
  // De modellijn vult dat gat, en omdat die gestippeld is blijft zichtbaar
  // dat het model is en geen meting.
  const haalVerwachting = async () => {
    const q = `latitude=${SENSOR.lat}&longitude=${SENSOR.lon}&forecast_days=2&past_days=1&timezone=UTC`;
    const [lucht, weer] = await Promise.all([
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&hourly=pm2_5,pm10`).then(r => r.json()),
      fetch(`https://api.open-meteo.com/v1/forecast?${q}&hourly=temperature_2m,relative_humidity_2m`).then(r => r.json())
    ]);
    const uren = (bron, veld) => bron.hourly.time
      .map((t, i) => ({ t: parseUTC(t), v: bron.hourly[veld][i] }))
      .filter(p => p.v != null);
    return {
      pm25: uren(lucht, 'pm2_5'), pm10: uren(lucht, 'pm10'),
      temp: uren(weer, 'temperature_2m'), vocht: uren(weer, 'relative_humidity_2m')
    };
  };

  // -------------------------------------------------------------------- tekenen

  const teken = (pmRuw, klimRuw, historie, verwachting) => {
    const nuMs = Date.now();
    const t0 = nuMs - VENSTER_UREN * UUR, t1 = nuMs + VENSTER_UREN * UUR;

    const pm25 = gemiddelde(pmRuw, 'P2'), pm10 = gemiddelde(pmRuw, 'P1');
    const temp = gemiddelde(klimRuw, 'temperature'), vocht = gemiddelde(klimRuw, 'humidity');
    const nu = { pm25: pm25?.waarde, pm10: pm10?.waarde, temp: temp?.waarde, vocht: vocht?.waarde };

    const gemeten = historie ?? {};

    // Model pas laten beginnen waar de meting ophoudt: geen overlap, en geen
    // gat als de meting achterloopt. Zonder historie begint het model bij t0.
    const verwacht = {};
    if (verwachting) {
      for (const k of ['pm25','pm10','temp','vocht']) {
        const m = (gemeten[k] ?? []).filter(p => p.v != null);
        const grens = m.length ? m[m.length - 1].t : t0;
        verwacht[k] = (verwachting[k] ?? []).filter(p => p.t >= grens);
      }
    }

    const heeftLijn = !!(historie || verwachting);
    const tijd = heeftLijn ? { t0, t1 } : {};

    const ouderdom = nuMs - nieuwste([...pmRuw, ...klimRuw]);
    const versheid = `${geleden(ouderdom)} · gemiddelde over ${pm25 ? pm25.n : '?'} metingen`;

    // Gecombineerd paneel alleen als er iets te tekenen valt. Draagt dan ook de
    // naam en de versheid; zonder paneel valt dat terug op de losse kop.
    const gDoel = document.getElementById('alles-in-een');
    const groot = (gDoel && heeftLijn) ? grooteTegel(nu, gemeten, verwacht, t0, t1, versheid) : null;
    if (gDoel) gDoel.replaceChildren(...(groot ? [groot] : []));
    zetKop(groot ? null : versheid);

    const kaarten = [];
    const reeks = k => heeftLijn ? { gemeten: gemeten[k] ?? [], verwacht: verwacht[k] ?? [] } : {};

    for (const [k, label, grens] of [['pm25','PM2.5',WHO24.pm25], ['pm10','PM10',WHO24.pm10]]) {
      if (nu[k] == null) continue;
      const [, woord, kleur] = band(k, nu[k]);
      const r = nu[k] / grens;
      kaarten.push(tegel({
        label, getal: nu[k], decimalen: 1, eenheid: 'µg/m³', duiding: woord, kleur,
        meter: meterBreedte(r), ijk: IJK_PCT, voet: verhoudingTekst(r, grens),
        drempel: grens, log: true, ...reeks(k), ...tijd
      }));
    }

    if (nu.temp != null) {
      const dp = nu.vocht != null ? dauwpunt(nu.temp, nu.vocht) : null;
      kaarten.push(tegel({
        label: 'Temperatuur', getal: nu.temp, decimalen: 1, eenheid: '°C',
        duiding: dp != null ? `Dauwpunt ${nl(dp, 1)} °C` : 'Buitensensor', kleur: BLAUW,
        voet: dp != null && dp > 18 ? 'Voelt zwoel aan' : null, ...reeks('temp'), ...tijd
      }));
    }

    if (nu.vocht != null) {
      // Geen ijkstreep: er bestaat geen advieswaarde voor luchtvochtigheid.
      const [woord, kleur] = vochtDuiding(nu.vocht);
      kaarten.push(tegel({
        label: 'Luchtvochtigheid', getal: nu.vocht, decimalen: 0, eenheid: '%',
        duiding: woord, kleur, meter: nu.vocht, ...reeks('vocht'), ...tijd
      }));
    }

    document.getElementById('tegels').replaceChildren(...kaarten);
    // Legenda gaat over gemeten versus verwacht; zonder lijnen zegt die niets.
    zetLegenda(heeftLijn);
    document.getElementById('nu').classList.toggle('verouderd', ouderdom > OUD_NA_MIN * 60000);
  };

  const zetLegenda = tonen => {
    const el = document.getElementById('legenda');
    if (el) el.hidden = !tonen;
  };

  // Losse kop tonen met tekst, of verbergen door null mee te geven -- dan
  // draagt het paneel de naam al.
  const zetKop = tekst => {
    const kop = document.getElementById('nu-kop');
    if (!kop) return;
    kop.hidden = tekst === null;
    if (tekst !== null) document.getElementById('versheid-tekst').textContent = tekst;
  };

  const toonFout = boodschap => {
    document.getElementById('tegels').innerHTML =
      `<div class="fout"><strong>Actuele waardes niet beschikbaar.</strong> ${boodschap}.
       De grafieken hieronder werken los hiervan gewoon door.</div>`;
    const gDoel = document.getElementById('alles-in-een');
    if (gDoel) gDoel.replaceChildren();
    zetKop('geen verbinding');
    zetLegenda(false);
    document.getElementById('nu').classList.add('verouderd');
  };

  const vernieuw = async () => {
    try {
      const [pm, klim, historie, verwachting] = await Promise.all([
        haalSensor(PM_SENSOR),
        haalSensor(KLIM_SENSOR),
        zacht(haalHistorie()),
        zacht(haalVerwachting())
      ]);
      teken(pm, klim, historie, verwachting);
    } catch (e) {
      toonFout(e.message);
    }
  };

  vernieuw();
  setInterval(vernieuw, VERVERS_MS);
})();

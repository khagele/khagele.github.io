// Actuele meetwaardes bovenaan het dashboard.
//
// Haalt rechtstreeks bij sensor.community op; die stuurt
// Access-Control-Allow-Origin: *, dus dit kan client-side zonder tussenlaag.
// Let op: de InfluxDB achter Grafana kan dat NIET — die staat alleen een
// andere origin toe. Alles wat daaruit moet komen, moet via de workflow.

(() => {
  const PM_SENSOR   = 94016;  // SDS011 → P1 = PM10, P2 = PM2.5
  const KLIM_SENSOR = 94017;  // SHT30  → temperature, humidity
  const VERVERS_MS  = 60_000;
  const OUD_NA_MIN  = 20;     // sensor meldt elke ~55 s; 20 min stil = probleem

  // WHO-advieswaarden 2021, 24-uursgemiddelde in µg/m³.
  // De EU-grenswaarden zijn ruimer (PM2.5 25, PM10 50 per dag); WHO is
  // gezondheidsgericht en daarmee de strengere, betekenisvollere maatstaf.
  const WHO24 = { pm25: 15, pm10: 45 };

  const banden = {
    pm25: [[15,'Goed','#16a34a'], [25,'Matig','#ca8a04'], [50,'Onvoldoende','#ea580c'], [Infinity,'Slecht','#dc2626']],
    pm10: [[45,'Goed','#16a34a'], [75,'Matig','#ca8a04'], [150,'Onvoldoende','#ea580c'], [Infinity,'Slecht','#dc2626']]
  };

  const band = (soort, v) => banden[soort].find(([grens]) => v <= grens);

  // Waar de ijkstreep staat, in procent van de balkbreedte.
  // Moet gelijk lopen met de --ijk die tegel() op de balk zet.
  const IJK_PCT = 60;

  // Tot de advieswaarde lineair, daarboven logaritmisch tot 10×. Zonder dit
  // staat de balk bij 130%, 250% én 950% even vol en zie je geen verschil
  // tussen "iets te veel" en "tien keer te veel".
  const meterBreedte = r =>
    r <= 1 ? r * IJK_PCT
           : Math.min(100, IJK_PCT + (100 - IJK_PCT) * Math.log10(r));

  // Boven de 2× leest een factor makkelijker dan een percentage:
  // "9,7× het WHO-advies" pak je sneller dan "967%".
  const verhoudingTekst = (r, grens) =>
    r > 2
      ? `${r.toFixed(1).replace('.', ',')}× het WHO-advies (${grens})`
      : `${Math.round(r * 100)}% van WHO-advies (${grens})`;

  const vochtDuiding = h =>
    h < 30 ? ['Droog','#ca8a04'] :
    h < 60 ? ['Behaaglijk','#16a34a'] :
    h < 80 ? ['Vochtig','#0ea5e9'] : ['Zeer vochtig','#0369a1'];

  // Dauwpunt via Magnus — laat zien wanneer het zwoel aanvoelt en wanneer
  // je condens op de sensor kunt verwachten.
  const dauwpunt = (t, rh) => {
    const a = 17.62, b = 243.12;
    const g = Math.log(rh / 100) + (a * t) / (b + t);
    return (b * g) / (a - g);
  };

  // Tijdstempels van de API zijn UTC zonder zone-aanduiding.
  const parseUTC = s => new Date(s.replace(' ', 'T') + 'Z');

  const geleden = ms => {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'zojuist';
    if (m === 1) return '1 minuut geleden';
    if (m < 60) return `${m} minuten geleden`;
    const u = Math.round(m / 60);
    return u === 1 ? 'ruim een uur geleden' : `${u} uur geleden`;
  };

  const haal = async id => {
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
                   .map(v => parseFloat(v.value))
                   .filter(Number.isFinite);
    return w.length ? { waarde: w.reduce((a, b) => a + b, 0) / w.length, n: w.length } : null;
  };

  const nieuwste = rijen =>
    rijen.map(r => parseUTC(r.timestamp)).sort((a, b) => b - a)[0];

  const tegel = ({ label, getal, decimalen, eenheid, duiding, kleur, meter, ijk, voet }) => {
    const el = document.createElement('div');
    el.className = 'tegel';
    el.style.setProperty('--kleur', kleur);
    el.innerHTML = `
      <div class="tegel-label">${label}</div>
      <div class="waarde">
        <span class="getal">${getal.toFixed(decimalen)}</span>
        <span class="eenheid">${eenheid}</span>
      </div>
      <div class="duiding"><span class="stip"></span>${duiding}</div>
      ${meter != null
        ? `<div class="meter${ijk != null ? ' geijkt' : ''}"${ijk != null
             ? ` style="--ijk:${ijk}%" title="Streepje = WHO-advieswaarde"` : ''}>
             <i style="width:${Math.min(100, meter)}%"></i></div>`
        : ''}
      ${voet ? `<div class="voet">${voet}</div>` : ''}`;
    return el;
  };

  const kaartenVoor = ({ pm25, pm10, temp, vocht }) => {
    const kaarten = [];

    if (pm25 != null) {
      const [, woord, kleur] = band('pm25', pm25);
      const r = pm25 / WHO24.pm25;
      kaarten.push(tegel({
        label: 'PM2.5', getal: pm25, decimalen: 1, eenheid: 'µg/m³',
        duiding: woord, kleur,
        meter: meterBreedte(r), ijk: IJK_PCT,
        voet: verhoudingTekst(r, WHO24.pm25)
      }));
    }

    if (pm10 != null) {
      const [, woord, kleur] = band('pm10', pm10);
      const r = pm10 / WHO24.pm10;
      kaarten.push(tegel({
        label: 'PM10', getal: pm10, decimalen: 1, eenheid: 'µg/m³',
        duiding: woord, kleur,
        meter: meterBreedte(r), ijk: IJK_PCT,
        voet: verhoudingTekst(r, WHO24.pm10)
      }));
    }

    if (temp != null) {
      const dp = vocht != null ? dauwpunt(temp, vocht) : null;
      kaarten.push(tegel({
        label: 'Temperatuur', getal: temp, decimalen: 1, eenheid: '°C',
        duiding: dp != null ? `Dauwpunt ${dp.toFixed(1)} °C` : 'Buitensensor',
        kleur: '#0ea5e9',
        voet: dp != null && dp > 18 ? 'Voelt zwoel aan' : null
      }));
    }

    // Geen ijkstreep: er bestaat geen advieswaarde voor luchtvochtigheid,
    // dus een streepje zou een grens suggereren die er niet is.
    if (vocht != null) {
      const [woord, kleur] = vochtDuiding(vocht);
      kaarten.push(tegel({
        label: 'Luchtvochtigheid', getal: vocht, decimalen: 0, eenheid: '%',
        duiding: woord, kleur, meter: vocht
      }));
    }

    return kaarten;
  };

  const teken = (pm, klim) => {
    const pm25 = gemiddelde(pm, 'P2');
    const pm10 = gemiddelde(pm, 'P1');
    const temp = gemiddelde(klim, 'temperature');
    const vocht = gemiddelde(klim, 'humidity');

    document.getElementById('tegels').replaceChildren(...kaartenVoor({
      pm25: pm25?.waarde, pm10: pm10?.waarde,
      temp: temp?.waarde, vocht: vocht?.waarde
    }));

    const ouderdom = Date.now() - nieuwste([...pm, ...klim]);
    document.getElementById('versheid-tekst').textContent =
      `${geleden(ouderdom)} · gemiddelde over ${pm25 ? pm25.n : '?'} metingen`;
    document.getElementById('nu').classList.toggle('verouderd', ouderdom > OUD_NA_MIN * 60000);
  };

  const toonFout = boodschap => {
    document.getElementById('tegels').innerHTML =
      `<div class="fout"><strong>Actuele waardes niet beschikbaar.</strong> ${boodschap}.
       De grafieken hieronder werken los hiervan gewoon door.</div>`;
    document.getElementById('versheid-tekst').textContent = 'geen verbinding';
    document.getElementById('nu').classList.add('verouderd');
  };

  const vernieuw = () =>
    Promise.all([haal(PM_SENSOR), haal(KLIM_SENSOR)])
      .then(([pm, klim]) => teken(pm, klim))
      .catch(e => toonFout(e.message));

  vernieuw();
  setInterval(vernieuw, VERVERS_MS);
})();

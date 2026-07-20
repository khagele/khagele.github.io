#!/usr/bin/env python3
"""Haalt de gemeten historie op en schrijft die als historie.json naast de site.

Waarom dit serverkant gebeurt: de InfluxDB achter Madavi's Grafana stuurt
Access-Control-Allow-Origin voor precies één andere site, dus de browser mag er
niet bij. De sensor.community-API mag dat wel, maar geeft alleen de laatste vijf
minuten. Voor een lijn van twaalf uur is dit de enige route.

Faalt met opzet zacht: lukt het ophalen niet, dan wordt er niets geschreven en
gaat de deploy gewoon door. De pagina laat dan de lijn weg en toont alleen de
actuele waardes en de verwachting.
"""

import json
import sys
import urllib.parse
import urllib.request

NODE = "esp8266-13493145"
UREN = 12
STAP = "15m"
DOEL = "historie.json"

BASIS = "https://api-rrd.madavi.de:3000/grafana/api/datasources/proxy/uid/zVHIU1WMz/query"

VRAAG = (
    'SELECT mean("SDS011_P2") AS pm25, mean("SDS011_P1") AS pm10, '
    'mean("temperature") AS temp, mean("humidity") AS vocht '
    'FROM "sensors" '
    f"WHERE \"node\"='{NODE}' AND time > now() - {UREN + 1}h "
    f"GROUP BY time({STAP}) fill(none)"
)


def rond(waarde, cijfers=1):
    if waarde is None:
        return None
    # Zonder cijfers geeft round() een int terug; dat scheelt ".0" per punt.
    return round(waarde, cijfers) if cijfers else round(waarde)


def main():
    url = BASIS + "?" + urllib.parse.urlencode({"db": "sensorcommunity", "q": VRAAG})
    with urllib.request.urlopen(url, timeout=45) as antwoord:
        blok = json.load(antwoord)["results"][0]

    if "series" not in blok:
        raise RuntimeError("geen meetreeks teruggekregen")

    rijen = blok["series"][0]["values"]
    punten = [
        {
            "t": rij[0],
            "pm25": rond(rij[1]),
            "pm10": rond(rij[2]),
            "temp": rond(rij[3]),
            "vocht": rond(rij[4], 0),
        }
        for rij in rijen
    ]
    if len(punten) < 2:
        raise RuntimeError(f"te weinig punten: {len(punten)}")

    with open(DOEL, "w") as bestand:
        json.dump(
            {"bron": "InfluxDB via Madavi", "node": NODE, "stap": STAP, "punten": punten},
            bestand,
            separators=(",", ":"),
        )
    print(f"{DOEL}: {len(punten)} punten, {punten[0]['t']} tot {punten[-1]['t']}")


if __name__ == "__main__":
    try:
        main()
    except Exception as fout:  # noqa: BLE001 - deploy mag hier niet op stuklopen
        print(f"historie overslaan: {fout}", file=sys.stderr)

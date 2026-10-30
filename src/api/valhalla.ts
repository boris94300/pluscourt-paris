import type { LatLon } from "../engine/types";

const BASE = "https://valhalla1.openstreetmap.de";

export interface RouteResult {
  coords: [number, number][]; // [lon, lat]
  /** secondes */
  duration: number;
  /** mètres */
  distance: number;
  /** dénivelé positif en mètres, si demandé */
  ascent?: number;
}

/** Décode une polyline Valhalla (précision 6). */
function decodePolyline(str: string, precision = 6): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0, lat = 0, lon = 0;
  const factor = 10 ** precision;
  while (index < str.length) {
    let shift = 0, result = 0, byte: number;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lon / factor, lat / factor]);
  }
  return coords;
}

/**
 * Itinéraire via Valhalla.
 * costing: "pedestrian" | "bicycle".
 * cyclingSpeed km/h personnalisable (Vélib' méca ~15, élec ~20).
 * Le profil bicycle privilégie les itinéraires directs (use_roads haut) tout en
 * utilisant les double-sens cyclables et pistes.
 */
export async function route(
  from: LatLon,
  to: LatLon,
  costing: "pedestrian" | "bicycle",
  opts: { cyclingSpeed?: number } = {},
): Promise<RouteResult> {
  const body: Record<string, unknown> = {
    locations: [
      { lat: from.lat, lon: from.lon },
      { lat: to.lat, lon: to.lon },
    ],
    costing,
    elevation_interval: 40,
    directions_options: { language: "fr-FR" },
  };
  if (costing === "bicycle") {
    body.costing_options = {
      bicycle: {
        bicycle_type: "Hybrid",
        cycling_speed: opts.cyclingSpeed ?? 17,
        use_roads: 0.6,
        use_hills: 0.4,
        avoid_bad_surfaces: 0.3,
      },
    };
  }
  const res = await fetch(`${BASE}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Valhalla HTTP ${res.status}`);
  const data = await res.json();
  const trip = data.trip;
  if (!trip) throw new Error("Valhalla: pas de trajet");

  const coords: [number, number][] = [];
  let ascent = 0;
  for (const leg of trip.legs as { shape: string; elevation?: number[][] }[]) {
    coords.push(...decodePolyline(leg.shape));
    if (leg.elevation) {
      let prev: number | null = null;
      for (const e of leg.elevation) {
        const h = e[1];
        if (h == null) continue;
        if (prev !== null && h > prev) ascent += h - prev;
        prev = h;
      }
    }
  }
  return {
    coords,
    duration: trip.summary.time,
    distance: trip.summary.length * 1000,
    ascent: Math.round(ascent),
  };
}

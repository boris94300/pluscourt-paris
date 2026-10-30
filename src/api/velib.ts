import type { LatLon } from "../engine/types";

const BASE = "https://prim.iledefrance-mobilites.fr/marketplace/velib";
const KEY = import.meta.env.VITE_PRIM_API_KEY as string;

export interface VelibStation {
  id: number;
  code: string;
  name: string;
  lat: number;
  lon: number;
  capacity: number;
  mechanical: number;
  ebike: number;
  docks: number;
  isRenting: boolean;
  isReturning: boolean;
}

interface StationInformation {
  station_id: number;
  stationCode: string;
  name: string;
  lat: number;
  lon: number;
  capacity: number;
}

interface StationStatus {
  station_id: number;
  num_bikes_available: number;
  num_bikes_available_types: Record<string, number>[];
  num_docks_available: number;
  is_renting: number;
  is_returning: number;
  is_installed: number;
}

let cache: { at: number; stations: VelibStation[] } | null = null;
const TTL = 45_000;

export async function getVelibStations(): Promise<VelibStation[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.stations;
  const [info, status] = await Promise.all([
    fetch(`${BASE}/station_information.json`, { headers: { apiKey: KEY } }).then((r) => {
      if (!r.ok) throw new Error(`velib info HTTP ${r.status}`);
      return r.json() as Promise<{ data: { stations: StationInformation[] } }>;
    }),
    fetch(`${BASE}/station_status.json`, { headers: { apiKey: KEY } }).then((r) => {
      if (!r.ok) throw new Error(`velib status HTTP ${r.status}`);
      return r.json() as Promise<{ data: { stations: StationStatus[] } }>;
    }),
  ]);

  const statusById = new Map(status.data.stations.map((s) => [s.station_id, s]));
  const stations: VelibStation[] = [];
  for (const i of info.data.stations) {
    const s = statusById.get(i.station_id);
    if (!s || !s.is_installed) continue;
    const types = Object.assign({}, ...s.num_bikes_available_types) as Record<string, number>;
    stations.push({
      id: i.station_id,
      code: i.stationCode,
      name: i.name,
      lat: i.lat,
      lon: i.lon,
      capacity: i.capacity,
      mechanical: types.mechanical ?? 0,
      ebike: types.ebike ?? 0,
      docks: s.num_docks_available,
      isRenting: s.is_renting === 1,
      isReturning: s.is_returning === 1,
    });
  }
  cache = { at: Date.now(), stations };
  return stations;
}

export function dist(a: LatLon, b: LatLon): number {
  const R = 6371e3;
  const toR = (x: number) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat);
  const dLon = toR(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Meilleure station pour PRENDRE un vélo près de `point`.
 * Écarte les stations hors service ou quasi vides (souvent vélos en panne).
 * Préfère un type donné si `want` est précisé.
 */
export function pickPickupStation(
  stations: VelibStation[],
  point: LatLon,
  want?: "mechanical" | "ebike",
  maxDist = 600,
): VelibStation | null {
  let best: VelibStation | null = null;
  let bestScore = Infinity;
  for (const s of stations) {
    if (!s.isRenting) continue;
    const d = dist(point, s);
    if (d > maxDist) continue;
    const stock = want === "ebike" ? s.ebike : want === "mechanical" ? s.mechanical : s.mechanical + s.ebike;
    if (stock < 2) continue; // <2 vélos = souvent en panne
    // score : distance + léger bonus pour les grosses stations (moins de risque)
    const score = d - Math.min(stock, 8) * 4;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/** Stations candidates autour du départ avec assez de vélos du type voulu. */
export function pickupCandidates(
  stations: VelibStation[],
  point: LatLon,
  want: "mechanical" | "ebike" | "any",
  maxDist = 500,
  limit = 4,
): VelibStation[] {
  return stations
    .filter((s) => {
      if (!s.isRenting) return false;
      const stock = want === "ebike" ? s.ebike : want === "mechanical" ? s.mechanical : s.mechanical + s.ebike;
      return stock >= 2 && dist(point, s) <= maxDist;
    })
    .sort((a, b) => dist(point, a) - dist(point, b))
    .slice(0, limit);
}

/** Stations candidates autour de l'arrivée avec des bornettes libres. */
export function dropoffCandidates(
  stations: VelibStation[],
  point: LatLon,
  maxDist = 500,
  limit = 4,
): VelibStation[] {
  return stations
    .filter((s) => s.isReturning && s.docks >= 2 && dist(point, s) <= maxDist)
    .sort((a, b) => dist(point, a) - dist(point, b))
    .slice(0, limit);
}

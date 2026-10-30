import type { LatLon } from "../engine/types";

export interface BikeParking {
  lat: number;
  lon: number;
  capacity: number;
  covered: boolean;
  secured: boolean;
  fee: boolean;
  kind: "rack" | "parking";
}

const OVERPASS = "https://overpass-api.de/api/interpreter";

/** Stationnements vélo autour d'un point (arceaux + parkings, attributs sécurité si connus). */
export async function getBikeParking(center: LatLon, radius = 350): Promise<BikeParking[]> {
  const q = `[out:json][timeout:10];
(
  node[amenity=bicycle_parking](around:${radius},${center.lat},${center.lon});
  way[amenity=bicycle_parking](around:${radius},${center.lat},${center.lon});
);
out center tags;`;
  const res = await fetch(OVERPASS, {
    method: "POST",
    body: "data=" + encodeURIComponent(q),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const out: BikeParking[] = [];
  for (const el of data.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const t = el.tags ?? {};
    const kind = t.bicycle_parking === "building" || t.building ? "parking" : "rack";
    out.push({
      lat,
      lon,
      capacity: parseInt(t.capacity) || 0,
      covered: t.covered === "yes",
      secured: t.access === "private" || t.fee === "yes" || t.supervised === "yes",
      fee: t.fee === "yes",
      kind,
    });
  }
  return out.sort((a, b) => {
    const sa = (a.secured ? 0 : 1) * 1000 + (a.covered ? 0 : 200);
    const sb = (b.secured ? 0 : 1) * 1000 + (b.covered ? 0 : 200);
    return sa - sb;
  });
}

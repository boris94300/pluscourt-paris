import type { LatLon, Place } from "../engine/types";

const BASE = "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia";
const KEY = import.meta.env.VITE_PRIM_API_KEY as string;

async function get<T>(path: string, params: Record<string, string | string[]> = {}): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  const res = await fetch(url, { headers: { apiKey: KEY } });
  if (!res.ok) throw new Error(`Navitia ${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const fmtCoord = (c: LatLon) => `${c.lon};${c.lat}`;

export interface NavitiaPlace {
  id: string;
  name: string;
  embedded_type: string;
  quality?: number;
  stop_area?: { id: string; name: string; coord: { lat: string; lon: string } };
  address?: { id: string; name: string; label: string; coord: { lat: string; lon: string } };
  poi?: { id: string; name: string; coord: { lat: string; lon: string } };
  administrative_region?: { id: string; name: string; label: string; coord: { lat: string; lon: string } };
}

export async function searchPlaces(q: string, count = 6): Promise<Place[]> {
  const data = await get<{ places: NavitiaPlace[] }>("/places", {
    q,
    count: String(count),
    "type[]": ["stop_area", "address", "poi"],
  });
  return (data.places || [])
    .map((p) => {
      const coord =
        p.stop_area?.coord ?? p.address?.coord ?? p.poi?.coord ?? p.administrative_region?.coord;
      if (!coord) return null;
      const kind =
        p.embedded_type === "stop_area"
          ? "Station"
          : p.embedded_type === "address"
            ? "Adresse"
            : "Lieu";
      const name =
        p.address?.label ?? p.poi?.name ?? p.stop_area?.name ?? p.name;
      return {
        id: p.id,
        name,
        kind,
        coord: { lat: parseFloat(coord.lat), lon: parseFloat(coord.lon) },
      } as Place;
    })
    .filter((p): p is Place => p !== null);
}

export interface NavitiaEndpoint {
  id?: string;
  name?: string;
  embedded_type?: string;
  coord?: { lat: string; lon: string };
  stop_area?: { id: string; name: string; coord: { lat: string; lon: string } };
}

export interface NavitiaSection {
  type: string; // public_transport | street_network | transfer | waiting | boarding | alighting | crow_fly
  mode?: string;
  duration: number;
  transfer_type?: string;
  from?: NavitiaEndpoint;
  to?: NavitiaEndpoint;
  links?: { id: string; type: string }[];
  departure_date_time?: string;
  arrival_date_time?: string;
  display_informations?: {
    commercial_mode?: string;
    code?: string;
    name?: string;
    color?: string;
    text_color?: string;
    network?: string;
    direction?: string;
    headsign?: string;
    label?: string;
  };
  geojson?: { type: string; coordinates: number[][] | number[][][] };
  stop_date_times?: { stop_point: { name: string }; departure_date_time?: string; arrival_date_time?: string }[];
}

export interface NavitiaJourney {
  duration: number;
  nb_transfers: number;
  departure_date_time: string;
  arrival_date_time: string;
  requested_date_time?: string;
  sections: NavitiaSection[];
}

export interface JourneysResponse {
  journeys: NavitiaJourney[];
  disruptions: NavitiaDisruption[];
}

export async function getJourneys(
  from: LatLon,
  to: LatLon,
  opts: { count?: number; datetime?: Date; wheelchair?: boolean } = {},
): Promise<JourneysResponse> {
  const params: Record<string, string> = {
    from: fmtCoord(from),
    to: fmtCoord(to),
    count: String(opts.count ?? 6),
    data_freshness: "realtime",
    max_nb_transfers: "4",
  };
  if (opts.datetime) {
    params.datetime = navitiaDate(opts.datetime);
    params.datetime_represents = "departure";
  }
  const data = await get<{ journeys?: NavitiaJourney[]; disruptions?: NavitiaDisruption[] }>("/journeys", params);
  return {
    journeys: (data.journeys || []).filter((j) => j.sections?.length),
    disruptions: data.disruptions ?? [],
  };
}

export interface NavitiaDisruption {
  id: string;
  status?: string;
  severity?: { name?: string; effect?: string; color?: string };
  application_periods?: { begin: string; end: string }[];
  messages?: { text?: string; channel?: { name?: string } }[];
}

/** Perturbations d'une ligne : on interroge line_reports par zone d'arrêt via les sections concernées. */
export async function getStopAreaDisruptions(stopAreaId: string): Promise<NavitiaDisruption[]> {
  const data = await get<{ disruptions?: NavitiaDisruption[] }>(
    `/stop_areas/${encodeURIComponent(stopAreaId)}/disruptions`,
  );
  return data.disruptions ?? [];
}

function navitiaDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

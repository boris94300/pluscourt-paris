import type { LatLon, RouteSegment, Step, TripOption } from "./types";
import { getJourneys, type NavitiaJourney, type NavitiaSection, type NavitiaDisruption } from "../api/navitia";
import { route } from "../api/valhalla";
import {
  getVelibStations,
  pickupCandidates,
  dropoffCandidates,
  dist,
  type VelibStation,
} from "../api/velib";
import { getBikeParking, type BikeParking } from "../api/parking";

const COLORS = {
  walk: "#5ac8fa",
  bike: "#35c759",
  velibMech: "#7bd389",
  velibEbike: "#4dd0e1",
  transitFallback: "#c084fc",
};

// Surcharges fixes (secondes)
const VELIB_UNDOCK = 45;
const VELIB_DOCK = 60;
const BIKE_UNLOCK = 90;
const BIKE_LOCK = 120;
const MIN_STATION_BIKES = 2;
const VELIB_MECH_SPEED = 15;
const VELIB_EBIKE_SPEED = 20;
const PERSONAL_BIKE_SPEED = 17;

function fmtMin(sec: number): string {
  return `${Math.max(1, Math.round(sec / 60))}’`;
}

function fmtClock(navitiaDt?: string): string | undefined {
  if (!navitiaDt || navitiaDt.length < 15) return undefined;
  return `${navitiaDt.slice(9, 11)}:${navitiaDt.slice(11, 13)}`;
}

function coordsOf(geojson?: { type: string; coordinates: number[][] | number[][][] }): [number, number][] {
  if (!geojson) return [];
  if (geojson.type === "LineString") return geojson.coordinates as [number, number][];
  if (geojson.type === "MultiLineString") return (geojson.coordinates as number[][][]).flat() as [number, number][];
  return [];
}

function lineLabel(s: NavitiaSection): { chip: string; color: string; name: string } {
  const di = s.display_informations;
  const mode = di?.commercial_mode ?? "Transport";
  const code = di?.code ?? di?.label ?? "";
  const color = di?.color ? `#${di.color}` : COLORS.transitFallback;
  return { chip: code, color, name: `${mode} ${code}`.trim() };
}

/* ---------------- Options individuelles ---------------- */

async function walkOption(from: LatLon, to: LatLon): Promise<TripOption | null> {
  const r = await route(from, to, "pedestrian");
  if (r.distance > 8000) return null;
  return {
    id: "walk",
    mode: "walk",
    title: "À pied",
    duration: r.duration,
    breakdown: `Marche ${fmtMin(r.duration)}`,
    badges: [],
    steps: [{ icon: "🚶", label: `Marcher ${Math.round(r.distance)} m`, duration: r.duration }],
    segments: [{ coords: r.coords, color: COLORS.walk, dash: true }],
  };
}

async function personalBikeOption(from: LatLon, to: LatLon): Promise<TripOption | null> {
  if (dist(from, to) < 250) return null; // un vélo n'a pas de sens pour si peu

  // Le parking se choisit d'abord : le vélo roule jusqu'à lui, puis on marche jusqu'à l'arrivée.
  let park: BikeParking | null = null;
  let parkingFailed = false;
  try {
    park = (await getBikeParking(to, 350))[0] ?? null;
  } catch {
    parkingFailed = true;
  }
  const bikeDest: LatLon = park ? { lat: park.lat, lon: park.lon } : to;
  const r = await route(from, bikeDest, "bicycle", { cyclingSpeed: PERSONAL_BIKE_SPEED });
  if (r.distance > 20000) return null;

  const walkBack = park ? await route(bikeDest, to, "pedestrian").catch(() => null) : null;
  const parkDist = park ? dist(bikeDest, to) : null;
  // Sans parking trouvé le vélo arrive directement à destination : pas de marche finale.
  const walkTime = park ? (walkBack?.duration ?? (parkDist ?? 0) / 1.33) : 0;

  const parkingInfo = parkingFailed
    ? "Stationnement vélo indisponible"
    : park
      ? park.secured
        ? `Parking sécurisé à ${Math.round(parkDist ?? 0)} m`
        : park.covered
          ? `Parking couvert à ${Math.round(parkDist ?? 0)} m`
          : `Arceaux à ${Math.round(parkDist ?? 0)} m`
      : "Pas de stationnement vélo référencé à moins de 350 m";

  const duration = BIKE_UNLOCK + r.duration + BIKE_LOCK + walkTime;
  const steps: Step[] = [
    { icon: "🔓", label: "Détacher le vélo", duration: BIKE_UNLOCK },
    { icon: "🚲", label: `Pédaler ${(r.distance / 1000).toFixed(1)} km`, sub: r.ascent ? `Dénivelé +${r.ascent} m` : undefined, duration: r.duration },
    { icon: "🔒", label: `Attacher le vélo — ${parkingInfo}`, duration: BIKE_LOCK },
  ];
  const segments: RouteSegment[] = [{ coords: r.coords, color: COLORS.bike }];
  if (park) {
    steps.push({ icon: "🚶", label: "Marcher jusqu'à l'arrivée", duration: walkTime });
    // Si l'itinéraire piéton échoue, on trace au moins la ligne parking→arrivée
    // pour que le marqueur d'arrivée reste sur la destination.
    const walkCoords: [number, number][] = walkBack?.coords.length
      ? walkBack.coords
      : [[bikeDest.lon, bikeDest.lat], [to.lon, to.lat]];
    segments.push({ coords: walkCoords, color: COLORS.walk, dash: true });
  }
  return {
    id: "bike",
    mode: "bike",
    title: "Vélo perso",
    duration,
    breakdown: `Cadenas ${fmtMin(BIKE_UNLOCK)} · Vélo ${fmtMin(r.duration)} · Attacher ${fmtMin(BIKE_LOCK + walkTime)}`,
    badges: [
      { text: parkingInfo, kind: park != null && (parkDist ?? 999) < 200 ? "good" : "warn" },
      ...(r.ascent && r.ascent > 15 ? [{ text: `Dénivelé +${r.ascent} m`, kind: "info" as const }] : []),
    ],
    steps,
    segments,
    ascent: r.ascent,
  };
}

async function velibOption(
  from: LatLon,
  to: LatLon,
  stations: VelibStation[],
  type: "mechanical" | "ebike",
): Promise<TripOption | null> {
  const pickups = pickupCandidates(stations, from, type, 500, 2);
  const dropoffs = dropoffCandidates(stations, to, 500, 2);
  if (!pickups.length || !dropoffs.length) return null;

  // Évalue les meilleurs couples départ/arrivée au vol d'oiseau, puis route le meilleur
  const speed = type === "ebike" ? VELIB_EBIKE_SPEED : VELIB_MECH_SPEED;
  let best: { p: VelibStation; d: VelibStation; crow: number } | null = null;
  for (const p of pickups) {
    for (const d of dropoffs) {
      const crow = dist(from, p) + dist(p, d) + dist(d, to);
      if (!best || crow < best.crow) best = { p, d, crow };
    }
  }
  if (!best) return null;

  const [walkIn, ride, walkOut] = await Promise.all([
    route(from, best.p, "pedestrian"),
    route(best.p, best.d, "bicycle", { cyclingSpeed: speed }),
    route(best.d, to, "pedestrian"),
  ]);
  const duration = walkIn.duration + VELIB_UNDOCK + ride.duration + VELIB_DOCK + walkOut.duration;
  const mech = best.p.mechanical;
  const e = best.p.ebike;
  const isE = type === "ebike";
  return {
    id: `velib_${type}`,
    mode: isE ? "velib_ebike" : "velib_mech",
    title: isE ? "Vélib' électrique" : "Vélib' mécanique",
    duration,
    breakdown: `Marche ${fmtMin(walkIn.duration)} · Vélib' ${fmtMin(ride.duration)} · Marche ${fmtMin(walkOut.duration)}`,
    badges: [
      {
        text: `${best.p.name} : ${mech} verts · ${e} bleus`,
        kind: (isE ? e : mech) >= 3 ? "good" : "warn",
      },
      { text: `${best.d.name} : ${best.d.docks} places`, kind: best.d.docks >= 4 ? "good" : "warn" },
      ...(ride.ascent && ride.ascent > 15 ? [{ text: `Dénivelé +${ride.ascent} m`, kind: "info" as const }] : []),
    ],
    steps: [
      { icon: "🚶", label: `Marcher jusqu'à la station ${best.p.name}`, sub: `${mech} verts · ${e} bleus dispo`, duration: walkIn.duration },
      { icon: isE ? "⚡" : "🚲", label: `Vélib' ${isE ? "électrique" : "mécanique"} — ${(ride.distance / 1000).toFixed(1)} km`, sub: ride.ascent ? `Dénivelé +${ride.ascent} m` : undefined, duration: ride.duration + VELIB_UNDOCK },
      { icon: "📍", label: `Reposer à ${best.d.name}`, sub: `${best.d.docks} bornettes libres`, duration: VELIB_DOCK },
      { icon: "🚶", label: `Marcher jusqu'à l'arrivée`, duration: walkOut.duration },
    ],
    segments: [
      { coords: walkIn.coords, color: COLORS.walk, dash: true },
      { coords: ride.coords, color: isE ? COLORS.velibEbike : COLORS.velibMech },
      { coords: walkOut.coords, color: COLORS.walk, dash: true },
    ],
    ascent: ride.ascent,
  };
}

/* ---------------- Transports ---------------- */

interface ParsedJourney {
  option: TripOption;
  /** première zone d'arrêt où l'on monte (pour combo vélo) */
  firstBoarding?: { name: string; coord: LatLon; walkTime: number };
  /** dernière zone où l'on descend */
  lastAlight?: { name: string; coord: LatLon; walkTime: number };
}

function endpointCoord(e?: { coord?: { lat: string; lon: string }; stop_area?: { coord: { lat: string; lon: string } } }): LatLon | null {
  const c = e?.stop_area?.coord ?? e?.coord;
  if (!c) return null;
  return { lat: parseFloat(c.lat), lon: parseFloat(c.lon) };
}

function parseJourney(j: NavitiaJourney, disruptions: NavitiaDisruption[], index: number): ParsedJourney | null {
  const steps: Step[] = [];
  const segments: RouteSegment[] = [];
  const breakdownParts: string[] = [];
  const disruptedLines = new Set<string>();
  const disruptionMsgs: string[] = [];

  for (const d of disruptions) {
    if (d.status === "past") continue;
    for (const io of (d as unknown as { impacted_objects?: { pt_object?: { id?: string } }[] }).impacted_objects ?? []) {
      if (io.pt_object?.id?.startsWith("line:")) {
        disruptedLines.add(io.pt_object.id);
        const msg = d.messages?.[0]?.text;
        if (msg) disruptionMsgs.push(msg);
      }
    }
  }

  let journeyDisrupted = false;
  let firstBoarding: ParsedJourney["firstBoarding"];
  let lastAlight: ParsedJourney["lastAlight"];
  let pendingWalk = 0;
  let pendingCoords: [number, number][] = [];

  const flushWalk = () => {
    if (pendingWalk > 0) {
      breakdownParts.push(`Marche ${fmtMin(pendingWalk)}`);
      if (pendingCoords.length) segments.push({ coords: pendingCoords, color: COLORS.walk, dash: true });
      pendingWalk = 0;
      pendingCoords = [];
    }
  };

  for (const s of j.sections) {
    if (s.type === "crow_fly" || s.type === "street_network") {
      pendingWalk += s.duration;
      pendingCoords.push(...coordsOf(s.geojson));
      if (!firstBoarding && s.to?.name) {
        const c = endpointCoord(s.to);
        if (c) firstBoarding = { name: s.to.name, coord: c, walkTime: s.duration };
      }
      continue;
    }

    if (s.type === "transfer") {
      pendingWalk += s.duration;
      pendingCoords.push(...coordsOf(s.geojson));
      steps.push({ icon: "🔀", label: "Correspondance", duration: s.duration });
      continue;
    }

    if (s.type === "waiting") {
      flushWalk();
      steps.push({ icon: "⏱", label: "Attente", duration: s.duration });
      breakdownParts.push(`Attente ${fmtMin(s.duration)}`);
      continue;
    }

    if (s.type === "boarding" || s.type === "alighting") continue;

    if (s.type === "public_transport") {
      flushWalk();
      const { name, color, chip } = lineLabel(s);
      const lineId = s.links?.find((l) => l.type === "line")?.id;
      const disrupted = lineId ? disruptedLines.has(lineId) : false;
      if (disrupted) journeyDisrupted = true;
      const dir = s.display_informations?.direction ?? s.display_informations?.headsign ?? "";
      const nStops = s.stop_date_times?.length ?? 0;
      steps.push({
        icon: "🚇",
        label: `${name}${dir ? ` → ${dir}` : ""}`,
        sub: nStops > 0 ? `${nStops} arrêts` : undefined,
        duration: s.duration,
        startsAt: fmtClock(s.departure_date_time),
      });
      breakdownParts.push(`${chip || name} ${fmtMin(s.duration)}`);
      segments.push({ coords: coordsOf(s.geojson), color });
      const alightCoord = endpointCoord(s.to);
      lastAlight = s.to?.name && alightCoord
        ? { name: s.to.name, coord: alightCoord, walkTime: 0 }
        : undefined;
      continue;
    }
  }
  flushWalk();

  // durée de marche finale après la dernière descente (pour le combo Vélib')
  if (lastAlight) {
    let lastPtEndIdx = -1;
    j.sections.forEach((s, i) => {
      if (s.type === "public_transport") lastPtEndIdx = i;
    });
    const tail = j.sections.slice(lastPtEndIdx + 1).reduce((acc, s) => acc + (s.type === "street_network" || s.type === "crow_fly" || s.type === "transfer" || s.type === "waiting" ? s.duration : 0), 0);
    lastAlight.walkTime = tail;
  }

  if (!steps.some((st) => st.icon === "🚇")) return null;

  const badges: TripOption["badges"] = [];
  if (journeyDisrupted) badges.push({ text: `⚠ ${disruptionMsgs[0] ?? "Perturbation sur une ligne"}`, kind: "warn" });
  if (j.nb_transfers === 0) badges.push({ text: "Direct", kind: "good" });
  else badges.push({ text: `${j.nb_transfers} correspondance${j.nb_transfers > 1 ? "s" : ""}`, kind: "info" });

  return {
    option: {
      id: `transit_${index}`,
      mode: "transit",
      title: "Transports en commun",
      duration: j.duration,
      breakdown: breakdownParts.join(" · "),
      badges,
      steps,
      segments,
      departure: fmtClock(j.departure_date_time),
      arrival: fmtClock(j.arrival_date_time),
    },
    firstBoarding,
    lastAlight,
  };
}

/* ---------------- Combos Vélib' + transports ---------------- */

async function velibToStation(
  stations: VelibStation[],
  from: LatLon,
  stopCoord: LatLon,
): Promise<{ stations: { p: VelibStation; d: VelibStation }; duration: number; segments: RouteSegment[]; steps: Step[] } | null> {
  const pickups = pickupCandidates(stations, from, "any", 400, 1);
  const dropoffs = dropoffCandidates(stations, stopCoord, 350, 1);
  if (!pickups.length || !dropoffs.length) return null;
  const p = pickups[0]!;
  const d = dropoffs[0]!;
  const [walkIn, ride] = await Promise.all([
    route(from, p, "pedestrian"),
    route(p, d, "bicycle", { cyclingSpeed: VELIB_EBIKE_SPEED }),
  ]);
  const duration = walkIn.duration + VELIB_UNDOCK + ride.duration + VELIB_DOCK;
  return {
    stations: { p, d },
    duration,
    segments: [
      { coords: walkIn.coords, color: COLORS.walk, dash: true },
      { coords: ride.coords, color: COLORS.velibEbike },
    ],
    steps: [
      { icon: "🚶", label: `Marcher jusqu'à ${p.name}`, duration: walkIn.duration },
      { icon: "🚲", label: `Vélib' jusqu'à ${d.name}`, sub: `${d.docks} bornettes libres`, duration: ride.duration + VELIB_UNDOCK + VELIB_DOCK },
    ],
  };
}

async function velibFromStation(
  stations: VelibStation[],
  stopCoord: LatLon,
  to: LatLon,
): Promise<{ duration: number; segments: RouteSegment[]; steps: Step[] } | null> {
  const pickups = pickupCandidates(stations, stopCoord, "any", 350, 1);
  const dropoffs = dropoffCandidates(stations, to, 500, 1);
  if (!pickups.length || !dropoffs.length) return null;
  const p = pickups[0]!;
  const d = dropoffs[0]!;
  const [walkIn, ride, walkOut] = await Promise.all([
    route(stopCoord, p, "pedestrian"),
    route(p, d, "bicycle", { cyclingSpeed: VELIB_EBIKE_SPEED }),
    route(d, to, "pedestrian"),
  ]);
  const duration = walkIn.duration + VELIB_UNDOCK + ride.duration + VELIB_DOCK + walkOut.duration;
  return {
    duration,
    segments: [
      { coords: walkIn.coords, color: COLORS.walk, dash: true },
      { coords: ride.coords, color: COLORS.velibEbike },
      { coords: walkOut.coords, color: COLORS.walk, dash: true },
    ],
    steps: [
      { icon: "🚶", label: `Marcher jusqu'à ${p.name}`, duration: walkIn.duration },
      { icon: "🚲", label: `Vélib' depuis ${p.name}`, sub: `${p.mechanical} verts · ${p.ebike} bleus`, duration: ride.duration + VELIB_UNDOCK },
      { icon: "📍", label: `Reposer à ${d.name} puis marcher`, duration: VELIB_DOCK + walkOut.duration },
    ],
  };
}

/* ---------------- Point d'entrée ---------------- */

export interface CompareResult {
  options: TripOption[];
  errors: string[];
}

export async function compare(from: LatLon, to: LatLon): Promise<CompareResult> {
  const errors: string[] = [];
  const options: TripOption[] = [];

  const stationsP = getVelibStations().catch((e) => {
    errors.push("Vélib' indisponible");
    return [] as VelibStation[];
  });

  const tasks: Promise<void>[] = [];

  tasks.push(
    walkOption(from, to)
      .then((o) => {
        if (o) options.push(o);
      })
      .catch(() => {
        errors.push("Itinéraire piéton indisponible");
      }),
  );
  tasks.push(
    personalBikeOption(from, to)
      .then((o) => {
        if (o) options.push(o);
      })
      .catch(() => {
        errors.push("Itinéraire vélo indisponible");
      }),
  );

  const journeysP = getJourneys(from, to, { count: 6 }).catch(() => {
    errors.push("Transports indisponibles");
    return { journeys: [] as NavitiaJourney[], disruptions: [] as NavitiaDisruption[] };
  });

  tasks.push(
    Promise.all([stationsP, journeysP]).then(async ([stations, jr]) => {
      // Vélib' directs (inutile pour un trajet très court)
      if (stations.length && dist(from, to) > 400) {
        const [mech, e] = await Promise.all([
          velibOption(from, to, stations, "mechanical").catch(() => null),
          velibOption(from, to, stations, "ebike").catch(() => null),
        ]);
        if (mech) options.push(mech);
        if (e) options.push(e);
      }

      let idx = 0;
      const parsed: ParsedJourney[] = [];
      for (const j of jr.journeys) {
        const p = parseJourney(j, jr.disruptions, idx++);
        if (p) parsed.push(p);
      }
      // garde les 2 meilleurs itinéraires distincts
      parsed.sort((a, b) => a.option.duration - b.option.duration);
      const seen = new Set<string>();
      const kept: ParsedJourney[] = [];
      for (const p of parsed) {
        const sig = p.option.breakdown;
        if (seen.has(sig)) continue;
        seen.add(sig);
        kept.push(p);
        if (kept.length >= 2) break;
      }
      for (const p of kept) options.push(p.option);

      // Combos Vélib' ↔ transports sur le meilleur itinéraire
      if (stations.length && kept.length) {
        const best = kept[0]!;
        const ptSection = best.option.steps.findIndex((s) => s.icon === "🚇");
        if (ptSection >= 0 && best.lastAlight?.coord) {
          // transit puis Vélib' pour le dernier kilomètre
          const tail = await velibFromStation(stations, best.lastAlight.coord, to).catch(() => null);
          if (tail) {
            const transitDur = best.option.duration - (best.lastAlight.walkTime || 0);
            // estime la fin de marche du trajet initial : on retire ~4 min si la fin marchait
            const est = transitDur + tail.duration;
            if (est < best.option.duration * 0.95 && est < best.option.duration) {
              options.push({
                id: "velib_transit_end",
                mode: "velib_transit",
                title: "Transports + Vélib'",
                duration: est,
                breakdown: best.option.breakdown,
                badges: [{ text: "Vélib' pour le dernier kilomètre", kind: "info" }],
                steps: [...best.option.steps.slice(0, -1), ...tail.steps],
                segments: [...best.option.segments.slice(0, -1), ...tail.segments],
                departure: best.option.departure,
              });
            }
          }
        }
      }
    }),
  );

  await Promise.all(tasks);

  options.sort((a, b) => a.duration - b.duration);
  // Déduplique seulement les trajets vraiment identiques (même mode + même signature de trajet).
  // Deux itinéraires transports distincts (lignes différentes) à durée proche sont conservés.
  const dedup: TripOption[] = [];
  for (const o of options) {
    const dup = dedup.find(
      (d) => d.mode === o.mode && d.breakdown === o.breakdown && Math.abs(d.duration - o.duration) < 30,
    );
    if (!dup) dedup.push(o);
  }
  return { options: dedup.slice(0, 6), errors };
}

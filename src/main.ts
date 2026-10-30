import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import type { LatLon, Place, TripOption } from "./engine/types";
import { compare } from "./engine/compare";
import { searchPlaces } from "./api/navitia";
import { getWeather } from "./api/weather";
import { getVelibStations } from "./api/velib";

const PARIS: LatLon = { lat: 48.8566, lon: 2.3522 };

/* ---------------- Carte 3D ---------------- */

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [PARIS.lon, PARIS.lat],
  zoom: 12.5,
  pitch: 55,
  bearing: -15,
  maxPitch: 70,
  attributionControl: { compact: true },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

let terrainReady = false;
map.on("load", () => {
  // Relief (tuiles Terrarium, AWS open data — sans image satellite)
  map.addSource("terrain", {
    type: "raster-dem",
    tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
    encoding: "terrarium",
    tileSize: 256,
    maxzoom: 15,
  });
  map.setTerrain({ source: "terrain", exaggeration: 3 });

  // Bâtiments en volume si le style n'en a pas déjà
  const hasBuildings = map.getStyle().layers.some((l: { id: string; type?: string }) => l.id.toLowerCase().includes("building") && l.type === "fill-extrusion");
  if (!hasBuildings) {
    const src = Object.entries(map.getStyle().sources).find(([, s]) => (s as { type?: string }).type === "vector");
    if (src) {
      map.addLayer({
        id: "buildings-3d",
        type: "fill-extrusion",
        source: src[0],
        "source-layer": "building",
        minzoom: 13.5,
        paint: {
          "fill-extrusion-color": "#8a93a3",
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], ["get", "height"], 10],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], ["get", "min_height"], 0],
          "fill-extrusion-opacity": 0.75,
        },
      });
    }
  }
  terrainReady = true;
});

/* ---------------- Tracés des trajets ---------------- */

const ROUTE_SRC = "route-src";
const STATION_SRC = "velib-src";

function clearRoute() {
  for (const id of ["route-line", "route-dash", "route-markers"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(ROUTE_SRC)) map.removeSource(ROUTE_SRC);
  if (map.getSource(STATION_SRC)) map.removeSource(STATION_SRC);
}

function showRoute(opt: TripOption, others: TripOption[] = []) {
  clearRoute();

  // les autres options en gris dessous
  const allFeatures: GeoJSON.Feature[] = [];
  for (const o of others) {
    if (o === opt) continue;
    for (const seg of o.segments) {
      allFeatures.push({
        type: "Feature",
        properties: { color: "rgba(255,255,255,0.18)", width: 3, alt: true },
        geometry: { type: "LineString", coordinates: seg.coords },
      });
    }
  }
  for (const seg of opt.segments) {
    allFeatures.push({
      type: "Feature",
      properties: { color: seg.color, width: seg.dash ? 2.5 : 5, dash: !!seg.dash },
      geometry: { type: "LineString", coordinates: seg.coords },
    });
  }
  // marqueurs départ/arrivée
  const first = opt.segments[0]?.coords[0];
  const lastSeg = opt.segments[opt.segments.length - 1];
  const last = lastSeg?.coords[lastSeg.coords.length - 1];
  if (first) {
    allFeatures.push({ type: "Feature", properties: { marker: "start" }, geometry: { type: "Point", coordinates: first } });
  }
  if (last) {
    allFeatures.push({ type: "Feature", properties: { marker: "end" }, geometry: { type: "Point", coordinates: last } });
  }

  map.addSource(ROUTE_SRC, { type: "geojson", data: { type: "FeatureCollection", features: allFeatures } });

  map.addLayer({
    id: "route-line",
    type: "line",
    source: ROUTE_SRC,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["get", "width"],
      "line-opacity": 0.95,
    },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "route-markers",
    type: "circle",
    source: ROUTE_SRC,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 8,
      "circle-color": ["match", ["get", "marker"], "start", "#35c759", "#ff6b6b"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });

  // cadre le trajet
  const allCoords = opt.segments.flatMap((s) => s.coords);
  if (allCoords.length > 1) {
    const bounds = new maplibregl.LngLatBounds(allCoords[0], allCoords[0]);
    for (const c of allCoords) bounds.extend(c);
    map.fitBounds(bounds, { padding: { top: 160, bottom: 320, left: 40, right: 40 }, duration: 800, pitch: 55 });
  }
}

/* ---------------- Recherche ---------------- */

const inputFrom = document.getElementById("input-from") as HTMLInputElement;
const inputTo = document.getElementById("input-to") as HTMLInputElement;
const suggestionsEl = document.getElementById("suggestions") as HTMLUListElement;
const loadingEl = document.getElementById("loading") as HTMLElement;
const resultsEl = document.getElementById("results") as HTMLElement;
const resultsList = document.getElementById("results-list") as HTMLElement;
const detailEl = document.getElementById("detail") as HTMLElement;
const detailContent = document.getElementById("detail-content") as HTMLElement;
const weatherChip = document.getElementById("weather-chip") as HTMLElement;

let fromPlace: Place | null = null;
let toPlace: Place | null = null;
let currentOptions: TripOption[] = [];
let suggestTimer: number | undefined;
let activeField: "from" | "to" = "from";

function debounce(fn: () => void, ms: number) {
  if (suggestTimer) window.clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(fn, ms);
}

function renderSuggestions(places: Place[]) {
  suggestionsEl.innerHTML = "";
  if (!places.length) {
    suggestionsEl.classList.add("hidden");
    return;
  }
  for (const p of places) {
    const li = document.createElement("li");
    li.innerHTML = `<span>${p.name}</span><span class="kind">${p.kind}</span>`;
    li.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pickPlace(p);
    });
    suggestionsEl.appendChild(li);
  }
  suggestionsEl.classList.remove("hidden");
}

function pickPlace(p: Place) {
  if (activeField === "from") {
    fromPlace = p;
    inputFrom.value = p.name;
  } else {
    toPlace = p;
    inputTo.value = p.name;
  }
  suggestionsEl.classList.add("hidden");
  maybeCompare();
}

function wireInput(input: HTMLInputElement, field: "from" | "to") {
  input.addEventListener("focus", () => {
    activeField = field;
    input.select();
  });
  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (field === "from") fromPlace = null;
    else toPlace = null;
    debounce(async () => {
      if (q.length < 3) {
        renderSuggestions([]);
        return;
      }
      try {
        const places = await searchPlaces(q);
        if (document.activeElement === input) renderSuggestions(places);
      } catch {
        renderSuggestions([]);
      }
    }, 280);
  });
}

wireInput(inputFrom, "from");
wireInput(inputTo, "to");

document.getElementById("btn-swap")!.addEventListener("click", () => {
  const a = inputFrom.value;
  inputFrom.value = inputTo.value;
  inputTo.value = a;
  const p = fromPlace;
  fromPlace = toPlace;
  toPlace = p;
  maybeCompare();
});

document.getElementById("btn-gps")!.addEventListener("click", () => {
  activeField = "from";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const coord = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      fromPlace = { id: "gps", name: "Ma position", kind: "GPS", coord };
      inputFrom.value = "Ma position";
      map.flyTo({ center: [coord.lon, coord.lat], zoom: 15 });
      maybeCompare();
    },
    () => alert("Position indisponible"),
    { enableHighAccuracy: true, timeout: 8000 },
  );
});

/* Météo (chip pluie) */
getWeather(PARIS).then((w) => {
  if (w && w.raining) {
    weatherChip.textContent = `🌧 Pluie en cours à Paris (${w.precipitation} mm/h) — pense aux transports`;
    weatherChip.classList.remove("hidden");
  }
});

/* ---------------- Comparaison ---------------- */

let comparing = false;
async function maybeCompare() {
  if (!fromPlace || !toPlace || comparing) return;
  comparing = true;
  loadingEl.classList.remove("hidden");
  resultsEl.classList.add("hidden");
  detailEl.classList.add("hidden");
  try {
    const { options, errors } = await compare(fromPlace.coord, toPlace.coord);
    currentOptions = options;
    renderResults(errors);
    if (options.length) {
      selectOption(options[0]!, true);
    }
  } catch (e) {
    resultsList.innerHTML = `<div class="option-card">Erreur de calcul : ${(e as Error).message}</div>`;
    resultsEl.classList.remove("hidden");
  } finally {
    loadingEl.classList.add("hidden");
    comparing = false;
  }
}

const MODE_ICONS: Record<string, string> = {
  walk: "🚶",
  bike: "🚲",
  velib_mech: "🚲",
  velib_ebike: "⚡",
  transit: "🚇",
  velib_transit: "🚲+🚇",
};

function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`;
}

function renderResults(errors: string[] = []) {
  resultsList.innerHTML = "";
  if (!currentOptions.length) {
    resultsList.innerHTML = `<div class="option-card">Aucun trajet trouvé.</div>`;
  }
  currentOptions.forEach((o, i) => {
    const card = document.createElement("div");
    card.className = `option-card${i === 0 ? " first" : ""}`;
    card.dataset.id = o.id;
    const badges = o.badges.map((b) => `<span class="badge ${b.kind}">${b.text}</span>`).join("");
    const times = o.departure ? `Départ ${o.departure} → ${o.arrival}` : "";
    card.innerHTML = `
      <div class="option-head">
        <span class="option-title">${MODE_ICONS[o.mode] ?? ""} ${o.title}</span>
        <span class="option-time">${fmtDuration(o.duration)}</span>
      </div>
      <div class="option-detail">${o.breakdown}${times ? `<br>${times}` : ""}</div>
      ${badges ? `<div class="badges">${badges}</div>` : ""}
    `;
    card.addEventListener("click", () => selectOption(o, true));
    resultsList.appendChild(card);
  });
  for (const err of errors) {
    const d = document.createElement("div");
    d.className = "option-card";
    d.innerHTML = `<div class="option-detail">⚠ ${err}</div>`;
    resultsList.appendChild(d);
  }
  resultsEl.classList.remove("hidden");
}

function selectOption(o: TripOption, showDetail: boolean) {
  document.querySelectorAll(".option-card").forEach((c) => c.classList.toggle("selected", (c as HTMLElement).dataset.id === o.id));
  showRoute(o, currentOptions);
  if (showDetail) renderDetail(o);
}

function renderDetail(o: TripOption) {
  detailContent.innerHTML = `
    <div class="option-head" style="margin-bottom:6px">
      <span class="option-title">${MODE_ICONS[o.mode] ?? ""} ${o.title}</span>
      <span class="option-time">${fmtDuration(o.duration)}</span>
    </div>
    ${o.steps
      .map(
        (s) => `
      <div class="step">
        <span class="step-icon">${s.icon}</span>
        <span class="step-main">${s.label}${s.sub ? `<div class="step-sub">${s.sub}</div>` : ""}</span>
        <span class="step-time">${s.startsAt ? s.startsAt + " · " : ""}${fmtMin(s.duration)}</span>
      </div>`,
      )
      .join("")}
  `;
  detailEl.classList.remove("hidden");
}

function fmtMin(sec: number): string {
  return `${Math.max(1, Math.round(sec / 60))}’`;
}

document.getElementById("btn-back")!.addEventListener("click", () => {
  detailEl.classList.add("hidden");
});

/* Précharge Vélib' en arrière-plan */
getVelibStations().catch(() => {});

// centre sur l'utilisateur si connue (silencieux)
if (navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(
    (pos) => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 13 }),
    () => {},
    { timeout: 5000 },
  );
}

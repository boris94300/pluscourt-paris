export interface LatLon {
  lat: number;
  lon: number;
}

export type Mode = "walk" | "bike" | "velib_mech" | "velib_ebike" | "transit" | "velib_transit";

export interface Step {
  icon: string;
  label: string;
  sub?: string;
  /** durée en secondes */
  duration: number;
  /** heure de début de l'étape (ISO) si connue */
  startsAt?: string;
}

export interface TripOption {
  id: string;
  mode: Mode;
  title: string;
  /** durée totale porte-à-porte en secondes */
  duration: number;
  steps: Step[];
  /** résumé court affiché sur la carte, ex. "Marche 4' · M1 9' · Marche 3'" */
  breakdown: string;
  badges: { text: string; kind: "warn" | "good" | "info" }[];
  /** polylines par segment : coords + couleur css */
  segments: RouteSegment[];
  /** heure de départ conseillée (transports) */
  departure?: string;
  /** heure d'arrivée */
  arrival?: string;
  /** dénivelé positif en mètres (modes vélo) */
  ascent?: number;
}

export interface RouteSegment {
  coords: [number, number][]; // [lon, lat]
  color: string;
  /** style de tracé */
  dash?: boolean;
}

export interface Place {
  id: string;
  name: string;
  kind: string;
  coord: LatLon;
}

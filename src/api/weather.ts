import type { LatLon } from "../engine/types";

export interface WeatherNow {
  precipitation: number; // mm/h
  temperature: number;
  raining: boolean;
}

export async function getWeather(p: LatLon): Promise<WeatherNow | null> {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=precipitation,temperature_2m&forecast_days=1`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const c = data.current ?? {};
    const pr = c.precipitation ?? 0;
    return { precipitation: pr, temperature: c.temperature_2m ?? NaN, raining: pr > 0.3 };
  } catch {
    return null;
  }
}

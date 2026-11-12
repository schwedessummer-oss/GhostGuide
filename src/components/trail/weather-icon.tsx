import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSnow,
  CloudSun,
  Moon,
  Snowflake,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { weatherSymbol, type WeatherKind } from "./weather";

const DAY: Record<WeatherKind, LucideIcon> = {
  clear: Sun,
  fair: CloudSun,
  partlycloudy: CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  sleet: Snowflake,
  snow: CloudSnow,
  thunder: CloudLightning,
};
const NIGHT: Partial<Record<WeatherKind, LucideIcon>> = { clear: Moon, fair: CloudMoon, partlycloudy: CloudMoon };

/** Icon for a MET Norway symbol code, with its plain label for screen readers; nothing for unknown codes. */
export function WeatherIcon({
  symbol,
  className = "size-6",
  labelled = true,
}: {
  symbol: string | null;
  className?: string;
  labelled?: boolean;
}) {
  const s = weatherSymbol(symbol);
  if (!s) return null;
  const Icon = (s.night ? NIGHT[s.kind] : undefined) ?? DAY[s.kind];
  const tone =
    s.kind === "clear" || s.kind === "fair"
      ? "text-amber-ink"
      : s.kind === "rain" || s.kind === "drizzle" || s.kind === "thunder"
        ? "text-blue-ink"
        : "text-muted";
  return (
    <>
      <Icon aria-hidden className={`${className} ${tone}`} strokeWidth={1.75} />
      {labelled ? <span className="sr-only">{s.label}</span> : null}
    </>
  );
}

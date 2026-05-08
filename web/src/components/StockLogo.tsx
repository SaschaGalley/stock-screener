import { useState, useMemo, useEffect } from "react";

// ─── Logo source configuration ───────────────────────────────────────────────
// Optional API tokens via Vite env vars (web/.env.local):
//   VITE_LOGODEV_TOKEN=pub_...     (sign up: https://logo.dev — free 10k/mo, sharp brand logos)
//   VITE_BRANDFETCH_ID=1abc...     (sign up: https://brandfetch.com  — free tier, multi-variant)
// Without tokens we fall through to free public sources.
const LOGODEV_TOKEN = (import.meta as any).env?.VITE_LOGODEV_TOKEN as
  | string
  | undefined;
const BRANDFETCH_ID = (import.meta as any).env?.VITE_BRANDFETCH_ID as
  | string
  | undefined;

/** Build the cascade of logo URLs in priority order. The component falls
 *  through to the next source on every `onError`.
 *
 *  Important: every source must return HTTP 4xx (not 200 with a blank image)
 *  on miss — otherwise the cascade can't advance. That's why we use
 *  `fallback=404` and `fallback=false` rather than `fallback=transparent`. */
function buildLogoSources(
  domain: string,
  size: number,
  symbol: string | null,
): string[] {
  const sz = size <= 32 ? 64 : size <= 64 ? 128 : 256;
  const out: string[] = [];

  // 1. Logo.dev — highest-quality brand logos. Requires free token.
  //    Ticker route (`/ticker/<SYM>`) maps directly via Logo.dev's stock
  //    database — more accurate than domain lookup for many tickers (e.g.
  //    GOOGL → Google brand directly, not Alphabet's holding domain abc.xyz).
  //    `theme=dark` returns the dark-variant logo for brands that have one
  //    designed it (~30% of majors); for the rest it falls back to default.
  if (LOGODEV_TOKEN) {
    // `fallback=404` returns 404 on miss instead of an auto-generated monogram
    // avatar (which would HTTP 200 and trap the cascade).
    const lParams = `token=${LOGODEV_TOKEN}&size=${sz}&format=png&retina=true&theme=dark&fallback=404`;
    if (symbol) {
      out.push(`https://img.logo.dev/ticker/${encodeURIComponent(symbol)}?${lParams}`);
    }
    out.push(`https://img.logo.dev/${domain}?${lParams}`);
  }

  // 2. Brandfetch CDN — high-quality, multi-variant. Requires free client ID.
  //    Same symbol-then-domain pattern + `theme=dark`. `fallback=404` is
  //    critical so the cascade can advance — `fallback=transparent` would
  //    return a blank 200 and trap us here.
  if (BRANDFETCH_ID) {
    const bParams = `c=${BRANDFETCH_ID}&theme=dark&fallback=404`;
    if (symbol) {
      out.push(`https://cdn.brandfetch.io/${encodeURIComponent(symbol)}?${bParams}`);
    }
    out.push(`https://cdn.brandfetch.io/${domain}?${bParams}`);
  }

  // 3. Unavatar — aggregator (tries Clearbit, Twitter, favicon). Free, no auth.
  //    `fallback=false` makes it 404 instead of returning a generic letter image
  //    so we can cascade to the next source.
  out.push(`https://unavatar.io/${domain}?fallback=false`);

  // 4. DuckDuckGo's icon service — decent quality, no auth.
  out.push(`https://icons.duckduckgo.com/ip3/${domain}.ico`);

  // 5. Google's favicon — last resort. Reliably available but often only 32px.
  out.push(`https://www.google.com/s2/favicons?domain=${domain}&sz=${sz}`);

  return out;
}

interface Props {
  domain: string | null;
  /** Optional ticker symbol — used by Brandfetch's symbol-based lookup as a
   *  better match than the website domain (e.g. AAPL → Apple Inc., not the
   *  generic apple.com domain registrar match). */
  symbol?: string | null;
  /** 1–2 letter fallback shown when no logo source works. */
  fallbackInitials: string;
  size?: number;
  className?: string;
  /** White background under the logo (most stock logos are designed for white). */
  whiteBg?: boolean;
}

/** Stock logo with multi-source fallback cascade. Order:
 *    1. Logo.dev /ticker/<SYM>   (token only)
 *    2. Logo.dev /<domain>       (token only)
 *    3. Brandfetch /<SYM>        (client-id only)
 *    4. Brandfetch /<domain>     (client-id only)
 *    5. Unavatar /<domain>       (free, aggregator)
 *    6. DuckDuckGo IP3           (free, favicon)
 *    7. Google S2                (free, last resort)
 *    8. 2-letter monogram        (final fallback)
 *
 *  Symbol lookups are tried before domain lookups because tickers like GOOGL
 *  resolve directly to the brand under that ticker, whereas the company's
 *  registered domain (e.g. abc.xyz for Alphabet) can mismatch the brand. */
export default function StockLogo({
  domain,
  symbol,
  fallbackInitials,
  size = 32,
  className,
  whiteBg = false,
}: Props) {
  const [idx, setIdx] = useState(0);
  const sources = useMemo(
    () =>
      domain || symbol
        ? buildLogoSources(domain ?? "", size, symbol ?? null)
        : [],
    [domain, symbol, size],
  );

  // Reset index when the source set changes (e.g., user clicks a different stock).
  useEffect(() => {
    setIdx(0);
  }, [domain, symbol]);

  if ((!domain && !symbol) || idx >= sources.length) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded bg-ink-700 font-mono font-semibold text-ink-100 ${className ?? ""}`}
        style={{
          width: size,
          height: size,
          fontSize: size <= 24 ? 10 : size <= 32 ? 11 : 13,
        }}
      >
        {fallbackInitials || "·"}
      </div>
    );
  }

  return (
    <img
      key={`${domain}-${idx}`}
      src={sources[idx]}
      alt=""
      className={`shrink-0 rounded ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        background: whiteBg ? "#fff" : "transparent",
      }}
      onError={() => setIdx((i) => i + 1)}
      loading="lazy"
    />
  );
}

/** Helper to derive sensible 2-letter monogram initials from a company name. */
export function initialsFromName(name: string | null | undefined): string {
  if (!name) return "·";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

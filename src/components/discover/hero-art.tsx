/**
 * Decorative landscape (pure SVG, no external images): layered ridges, a
 * winding trail with narration stops and sound waves. aria-hidden.
 */
export function HeroArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 420" preserveAspectRatio="xMidYMax slice" aria-hidden className={className} focusable="false">
      <defs>
        <linearGradient id="gg-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#173524" stopOpacity="0" />
          <stop offset="1" stopColor="#0f2318" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id="gg-ridge-far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a8a63" stopOpacity="0.55" />
          <stop offset="1" stopColor="#35704d" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect width="1200" height="420" fill="url(#gg-sky)" />
      {/* sun / moon */}
      <circle cx="930" cy="96" r="46" fill="#f3eee4" opacity="0.18" />
      <circle cx="930" cy="96" r="30" fill="#f3eee4" opacity="0.28" />
      {/* far ridge */}
      <path d="M0 250 L120 180 L210 225 L330 130 L450 210 L560 150 L660 205 L780 120 L900 200 L1010 150 L1120 205 L1200 170 L1200 420 L0 420 Z" fill="url(#gg-ridge-far)" />
      {/* snow caps */}
      <path d="M330 130 L305 151 L322 147 L338 158 L352 145 Z M780 120 L756 141 L774 136 L790 148 L803 135 Z" fill="#f3eee4" opacity="0.55" />
      {/* mid ridge */}
      <path d="M0 300 L90 255 L190 290 L300 230 L420 285 L540 240 L650 290 L760 245 L880 295 L1000 250 L1110 290 L1200 265 L1200 420 L0 420 Z" fill="#2a5a3e" />
      {/* trees on mid ridge */}
      <g fill="#1f4630">
        {[60, 140, 250, 375, 470, 600, 700, 830, 950, 1060, 1150].map((x, i) => (
          <path key={x} d={`M${x} ${282 - (i % 3) * 8} l12 30 h-24 Z M${x} ${270 - (i % 3) * 8} l9 22 h-18 Z`} />
        ))}
      </g>
      {/* near hill */}
      <path d="M0 360 Q200 310 420 345 T820 335 T1200 330 L1200 420 L0 420 Z" fill="#173524" />
      {/* trail */}
      <path
        d="M120 420 C220 380 260 360 360 362 S520 380 600 352 S760 312 860 322 S1000 340 1080 318"
        fill="none"
        stroke="#e7dfd0"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray="2 14"
        opacity="0.9"
      />
      {/* narration stops with sound waves */}
      {[
        [360, 362],
        [600, 352],
        [860, 322],
      ].map(([x, y]) => (
        <g key={x}>
          <circle cx={x} cy={y} r="9" fill="#f3eee4" />
          <circle cx={x} cy={y} r="4" fill="#2a5a3e" />
          <path d={`M${x + 16} ${y - 14} q8 14 0 28 M${x + 26} ${y - 22} q13 22 0 44`} fill="none" stroke="#f3eee4" strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
        </g>
      ))}
      {/* foreground trees */}
      <g fill="#0f2318">
        <path d="M30 420 l28 -90 l28 90 Z M42 360 l16 -50 l16 50 Z" />
        <path d="M1110 420 l30 -100 l30 100 Z M1124 352 l16 -52 l16 52 Z" />
        <path d="M1170 420 l20 -64 l20 64 Z" />
      </g>
    </svg>
  );
}

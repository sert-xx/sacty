/**
 * sacty のマーク（PBI-68）。S の線でつながる2つのノード（エージェントと工程の流れ）。ファビコン・Slack の通知の
 * アイコン（assets/sacty-icon.svg）と同じ形。飾りなので、読み上げない（隣に sacty の文字がある）。
 */
export function SactyMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" focusable="false" className={className}>
      <rect width="512" height="512" rx="116" fill="#111633" />
      <path
        d="M344 160 H208 A48 48 0 0 0 208 256 H304 A48 48 0 0 1 304 352 H168"
        fill="none"
        stroke="#7C86FF"
        strokeWidth="44"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="344" cy="160" r="34" fill="#FFFFFF" />
      <circle cx="168" cy="352" r="34" fill="#FFD66B" />
    </svg>
  );
}

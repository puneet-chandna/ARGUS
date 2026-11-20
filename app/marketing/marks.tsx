export function Monogram({ className, halfClosed = false }: { className?: string; halfClosed?: boolean }) {
  return <svg className={className} viewBox="0 0 256 256" width="36" height="36" aria-hidden="true">
    <rect x="1" y="1" width="254" height="254" rx="56" fill="#0F2F37" stroke="#2C6272" strokeWidth="2" />
    <path d="M64 200 128 58 192 200" fill="none" stroke="#F4F1E8" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />
    <g className={halfClosed ? "monogram-lid half-closed" : "monogram-lid"}>
      <path d="M104 152Q128 130 152 152Q128 174 104 152Z" fill="#F4F1E8" />
      <circle className="monogram-pupil" cx="128" cy="152" r="7" fill="#0F2F37" />
    </g>
    <path d="M64 218h34m13 0h34m13 0h34" stroke="#729EA7" strokeWidth="8" strokeLinecap="round" />
  </svg>;
}

export function Arrow() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

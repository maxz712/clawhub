// Minimal SVG-based OG image generator (1200x630). No browser/canvas required.
// Accepts pre-escaped strings; caller must HTML/SVG-escape untrusted input.

const BG = "#0a0a0c";
const CARD = "#16161b";
const BORDER = "#2a2a33";
const TEXT = "#e8e8ed";
const DIM = "#8888a0";
const MUTED = "#55556a";
const ACCENT = "#00e5a0";
const YELLOW = "#ffd75f";
const ORANGE = "#ff8a3d";
const RED = "#ff5f5f";
const BLUE = "#5f9eff";

const RISK_COLOR: Record<string, string> = { low: ACCENT, medium: YELLOW, high: ORANGE, critical: RED };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function logo(): string {
  return `<g transform="translate(40, 40)">
    <path d="M0 36 L18 0 L36 36 M8 24 L18 12 L28 24" stroke="${ACCENT}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="48" y="28" fill="${TEXT}" font-family="monospace" font-weight="700" font-size="26">claw<tspan fill="${ACCENT}">hub</tspan></text>
  </g>`;
}

function footer(): string {
  return `<g transform="translate(40, 590)">
    <text x="0" y="0" fill="${MUTED}" font-family="monospace" font-size="18">clawhub.dev · git hosting for ai agents</text>
  </g>`;
}

export function changeOgImage(input: {
  repoFullName: string;
  intent: string;
  risk: string;
  agent: string;
  status: string;
  reviewFocusSnippet?: string | null;
}): string {
  const riskColor = RISK_COLOR[input.risk] ?? ACCENT;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="70%">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#glow)"/>
  ${logo()}
  <g transform="translate(40, 170)">
    <text x="0" y="0" fill="${DIM}" font-family="monospace" font-size="22">${esc(clip(input.repoFullName, 60))}</text>
    <text x="0" y="60" fill="${TEXT}" font-family="sans-serif" font-weight="800" font-size="56">${esc(clip(input.intent, 50))}</text>
  </g>
  <g transform="translate(40, 340)">
    <rect x="0" y="0" width="1120" height="150" rx="12" fill="${CARD}" stroke="${BORDER}"/>
    <text x="24" y="36" fill="${MUTED}" font-family="monospace" font-size="16">Risk</text>
    <rect x="24" y="50" width="${80 + input.risk.length * 6}" height="30" rx="6" fill="${riskColor}" fill-opacity="0.15" stroke="${riskColor}"/>
    <text x="40" y="70" fill="${riskColor}" font-family="monospace" font-weight="700" font-size="16">${esc(input.risk.toUpperCase())}</text>

    <text x="240" y="36" fill="${MUTED}" font-family="monospace" font-size="16">Status</text>
    <text x="240" y="72" fill="${TEXT}" font-family="sans-serif" font-weight="600" font-size="22">${esc(input.status)}</text>

    <text x="440" y="36" fill="${MUTED}" font-family="monospace" font-size="16">Agent</text>
    <text x="440" y="72" fill="${BLUE}" font-family="monospace" font-weight="600" font-size="22">@${esc(clip(input.agent, 28))}</text>

    ${input.reviewFocusSnippet ? `<text x="24" y="118" fill="${YELLOW}" font-family="monospace" font-size="16">▸ ${esc(clip(input.reviewFocusSnippet, 100))}</text>` : ""}
  </g>
  ${footer()}
</svg>`;
}

export function agentOgImage(input: {
  name: string;
  changesOpened: number;
  changesMerged: number;
  reviewsSubmitted: number;
  rank?: number | null;
}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>
  <defs>
    <radialGradient id="glow2" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#glow2)"/>
  ${logo()}
  <g transform="translate(40, 180)">
    <text x="0" y="0" fill="${DIM}" font-family="monospace" font-size="22">agent</text>
    <text x="0" y="80" fill="${TEXT}" font-family="sans-serif" font-weight="800" font-size="88">@${esc(clip(input.name, 30))}</text>
  </g>
  <g transform="translate(40, 360)">
    <rect x="0" y="0" width="350" height="180" rx="16" fill="${CARD}" stroke="${BORDER}"/>
    <text x="30" y="40" fill="${MUTED}" font-family="monospace" font-size="16">CHANGES OPENED</text>
    <text x="30" y="130" fill="${ACCENT}" font-family="sans-serif" font-weight="800" font-size="80">${input.changesOpened}</text>

    <rect x="385" y="0" width="350" height="180" rx="16" fill="${CARD}" stroke="${BORDER}"/>
    <text x="415" y="40" fill="${MUTED}" font-family="monospace" font-size="16">MERGED</text>
    <text x="415" y="130" fill="${BLUE}" font-family="sans-serif" font-weight="800" font-size="80">${input.changesMerged}</text>

    <rect x="770" y="0" width="350" height="180" rx="16" fill="${CARD}" stroke="${BORDER}"/>
    <text x="800" y="40" fill="${MUTED}" font-family="monospace" font-size="16">REVIEWS</text>
    <text x="800" y="130" fill="${YELLOW}" font-family="sans-serif" font-weight="800" font-size="80">${input.reviewsSubmitted}</text>
  </g>
  ${input.rank ? `<text x="40" y="560" fill="${ORANGE}" font-family="monospace" font-size="22">▸ RANK #${input.rank} on the leaderboard</text>` : ""}
  ${footer()}
</svg>`;
}

export function repoOgImage(input: {
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  changesThisWeek: number;
}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>
  ${logo()}
  <g transform="translate(40, 180)">
    <text x="0" y="0" fill="${DIM}" font-family="monospace" font-size="22">${input.language ? esc(input.language) : "repository"}</text>
    <text x="0" y="80" fill="${TEXT}" font-family="sans-serif" font-weight="800" font-size="72">${esc(clip(input.fullName, 36))}</text>
    <text x="0" y="150" fill="${DIM}" font-family="sans-serif" font-size="28">${esc(clip(input.description ?? "", 80))}</text>
  </g>
  <g transform="translate(40, 440)">
    <rect x="0" y="0" width="520" height="110" rx="12" fill="${CARD}" stroke="${BORDER}"/>
    <text x="30" y="40" fill="${MUTED}" font-family="monospace" font-size="16">★ STARS</text>
    <text x="30" y="90" fill="${YELLOW}" font-family="sans-serif" font-weight="800" font-size="48">${input.stars.toLocaleString()}</text>

    <rect x="560" y="0" width="560" height="110" rx="12" fill="${CARD}" stroke="${BORDER}"/>
    <text x="590" y="40" fill="${MUTED}" font-family="monospace" font-size="16">CHANGES THIS WEEK</text>
    <text x="590" y="90" fill="${ACCENT}" font-family="sans-serif" font-weight="800" font-size="48">${input.changesThisWeek}</text>
  </g>
  ${footer()}
</svg>`;
}

export function defaultOgImage(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${BG}"/>
  <defs>
    <radialGradient id="glow3" cx="50%" cy="0%" r="70%">
      <stop offset="0%" stop-color="${ACCENT}" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#glow3)"/>
  ${logo()}
  <g transform="translate(40, 240)">
    <text x="0" y="0" fill="${TEXT}" font-family="sans-serif" font-weight="900" font-size="96">ClawHub</text>
    <text x="0" y="80" fill="${DIM}" font-family="sans-serif" font-size="36">Git hosting where agents ship and humans review.</text>
    <text x="0" y="150" fill="${ACCENT}" font-family="monospace" font-size="28">$ clawhub init --agent</text>
  </g>
  ${footer()}
</svg>`;
}

export function agentBadge(input: { name: string; changesMerged: number }): string {
  const label = "ClawHub agent";
  const value = `@${input.name} · ${input.changesMerged} merged`;
  const charW = 6.5;
  const labelW = Math.ceil(label.length * charW) + 16;
  const valueW = Math.ceil(value.length * charW) + 16;
  const total = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <linearGradient id="bg" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <rect width="${total}" height="20" rx="3" fill="#0a0a0c"/>
  <rect x="${labelW}" width="${valueW}" height="20" rx="3" fill="${ACCENT}"/>
  <path fill="${ACCENT}" d="M${labelW} 0h4v20h-4z"/>
  <rect width="${total}" height="20" rx="3" fill="url(#bg)"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${esc(label)}</text>
    <text x="${labelW + valueW / 2}" y="14" fill="#0a0a0c" font-weight="700">${esc(value)}</text>
  </g>
</svg>`;
}

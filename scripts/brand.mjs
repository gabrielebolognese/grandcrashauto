#!/usr/bin/env node
/**
 * Grand Crash Auto brand kit generator: writes SVG sources + renders PNGs (Instagram-ready) into brand/.
 *   node scripts/brand.mjs
 * Original design: sunset pastel badge, a wedge supercar mid-jump in front of a cartoon blast. Deliberately NOT the
 * stacked boxed "Grand ___ Auto" typography of any existing game.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'brand');
await mkdir(out, { recursive: true });

const C = {
  coral: '#ff7a6b', coralDeep: '#e8574a', peach: '#ffb38a', butter: '#ffe39a', cream: '#fff4e0',
  sea: '#2aa3c4', deep: '#146c94', ink: '#1d2a44', aqua: '#5cc8d6', mint: '#9ee0c8', lilac: '#b8a6e8',
};

/** Star-burst polygon points. */
function burst(cx, cy, rOut, rIn, n, rot = 0, jitter = 0.12) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = rot + (i * Math.PI) / n;
    const j = 1 + (((i * 7919) % 13) / 13 - 0.5) * jitter;
    const r = (i % 2 === 0 ? rOut : rIn) * j;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`);
  }
  return pts.join(' ');
}

/** Wedge supercar side profile (faces right), ~600 × 155 units, ground at y=154. */
function car(body = C.coralDeep, outline = true) {
  return `
  <g>
    <path d="M20,112 L10,86 L14,63 L2,52 L62,50 C122,46 172,30 222,14 C262,2 322,0 362,8 L432,44 C482,52 542,58 587,70 L599,87 L591,105 L516,113
             A44,44 0 0 0 428,113 L192,113 A46,46 0 0 0 100,113 Z" fill="${body}" ${outline ? `stroke="${C.ink}" stroke-width="9" stroke-linejoin="round" paint-order="stroke"` : ""}/>
    <path d="M24,108 L16,88 L592,96 L588,104 L516,111 A44,44 0 0 0 428,111 L192,111 A46,46 0 0 0 100,111 Z" fill="#000" opacity="0.22"/>
    <path d="M70,52 C130,47 176,33 224,18 C262,7 318,5 356,12" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="5" stroke-linecap="round"/>
    <path d="M232,22 C266,11 320,10 352,15 L412,45 L252,48 Z" fill="${C.ink}"/>
    <path d="M262,24 C290,17 318,16 340,19 L366,34 L272,36 Z" fill="#fff" opacity="0.18"/>
    <path d="M300,70 L384,66 L364,88 L302,90 Z" fill="${C.ink}" opacity="0.85"/>
    <path d="M556,67 L593,76 L591,81 L553,74 Z" fill="${C.cream}"/>
    <path d="M6,57 L44,55 L44,62 L9,65 Z" fill="${C.butter}"/>
    <path d="M30,92 L120,94" stroke="${C.ink}" stroke-width="4" opacity="0.35"/>
    <circle cx="146" cy="118" r="40" fill="#1b1d22"/><circle cx="146" cy="118" r="21" fill="#c9ccd2"/><circle cx="146" cy="118" r="7" fill="#1b1d22"/>
    <circle cx="472" cy="118" r="38" fill="#1b1d22"/><circle cx="472" cy="118" r="20" fill="#c9ccd2"/><circle cx="472" cy="118" r="7" fill="#1b1d22"/>
  </g>`;
}

function speedLines(x, y) {
  return [0, 1, 2, 3]
    .map((i) => `<path d="M${x - 40 - i * 30},${y + i * 34} L${x - 260 - i * 50},${y + i * 34 + 10}" stroke="${C.cream}" stroke-width="${14 - i * 2}" stroke-linecap="round" opacity="${0.9 - i * 0.15}"/>`)
    .join('');
}

/** Square badge (profile picture): circle-safe composition. */
function iconSvg(size = 1080) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="${size}" height="${size}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.coral}"/><stop offset="0.55" stop-color="${C.peach}"/><stop offset="0.7" stop-color="${C.butter}"/></linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.sea}"/><stop offset="1" stop-color="${C.deep}"/></linearGradient>
    <radialGradient id="fire" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fffbe6"/><stop offset="0.35" stop-color="${C.butter}"/><stop offset="0.75" stop-color="#ff9a3c"/><stop offset="1" stop-color="${C.coralDeep}"/></radialGradient>
  </defs>
  <rect width="1080" height="1080" fill="url(#sky)"/>
  <circle cx="540" cy="690" r="250" fill="${C.butter}" opacity="0.9"/>
  <rect y="760" width="1080" height="320" fill="url(#sea)"/>
  <path d="M0,760 Q135,742 270,760 T540,760 T810,760 T1080,760 V790 H0 Z" fill="#fff" opacity="0.35"/>
  <polygon points="${burst(560, 560, 400, 255, 13, 0.2)}" fill="${C.coralDeep}"/>
  <polygon points="${burst(560, 560, 340, 215, 13, 0.45)}" fill="url(#fire)"/>
  <polygon points="${burst(560, 560, 190, 120, 11, 0.1, 0.25)}" fill="#fffbe6"/>
  ${speedLines(250, 470)}
  <g transform="translate(250,400) rotate(-11 300 90)">${car()}</g>
  <circle cx="540" cy="540" r="536" fill="none" stroke="${C.cream}" stroke-width="10" opacity="0.65"/>
</svg>`;
}

/** Wordmark: hero word CRASH, small GRAND / AUTO, .lol pill. */
function wordmarkSvg(w = 1600, h = 900, bg = true) {
  const font = `font-family="'Arial Black','Segoe UI Black','Helvetica Neue',Arial,sans-serif" font-weight="900"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" width="${w}" height="${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cc6ea"/><stop offset="0.6" stop-color="#ffd9a8"/><stop offset="1" stop-color="${C.peach}"/></linearGradient>
    <radialGradient id="fire2" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fffbe6"/><stop offset="0.4" stop-color="${C.butter}"/><stop offset="0.8" stop-color="#ff9a3c"/><stop offset="1" stop-color="${C.coralDeep}"/></radialGradient>
    <linearGradient id="txt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffdf6"/><stop offset="1" stop-color="${C.butter}"/></linearGradient>
  </defs>
  ${bg ? '<rect width="1600" height="900" fill="url(#bg)"/>' : ''}
  <polygon points="${burst(1180, 300, 260, 165, 12, 0.3)}" fill="${C.coralDeep}"/>
  <polygon points="${burst(1180, 300, 215, 135, 12, 0.55)}" fill="url(#fire2)"/>
  ${speedLines(980, 230)}
  <g transform="translate(860,170) scale(0.78) rotate(-9 300 90)">${car()}</g>
  <g transform="skewX(-10)">
    <text x="262" y="448" ${font} font-size="96" fill="${C.ink}" letter-spacing="10">GRAND</text>
    <text x="232" y="690" ${font} font-size="260" fill="${C.ink}" letter-spacing="4">CRASH</text>
    <text x="220" y="676" ${font} font-size="260" fill="url(#txt)" stroke="${C.coralDeep}" stroke-width="10" paint-order="stroke" letter-spacing="4">CRASH</text>
    <text x="1010" y="790" ${font} font-size="96" fill="${C.ink}" letter-spacing="10">AUTO</text>
  </g>
  <g transform="translate(250,730)">
    <rect width="230" height="84" rx="42" fill="${C.sea}"/>
    <text x="115" y="58" text-anchor="middle" ${font} font-size="52" fill="#fff">.lol</text>
  </g>
</svg>`;
}

/** 1080×1350 launch post: logo + promise + URL. */
function launchPostSvg() {
  const font = `font-family="'Arial Black','Segoe UI Black',Arial,sans-serif" font-weight="900"`;
  const body = `font-family="'Segoe UI','Helvetica Neue',Arial,sans-serif" font-weight="700"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1350" width="1080" height="1350">
  <rect width="1080" height="1350" fill="${C.cream}"/>
  <g transform="translate(-260,40) scale(0.98)">${wordmarkSvg(1600, 900, false).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>
  <text x="540" y="1010" text-anchor="middle" ${font} font-size="74" fill="${C.ink}">DRIVE. FLY. CRASH.</text>
  <text x="540" y="1090" text-anchor="middle" ${body} font-size="40" fill="${C.ink}" opacity="0.75">Free in your browser. No download.</text>
  <g transform="translate(260,1160)"><rect width="560" height="100" rx="50" fill="${C.coral}"/>
  <text x="280" y="66" text-anchor="middle" ${font} font-size="46" fill="#fff">grandcrashauto.lol</text></g>
</svg>`;
}

const files = {
  'gca-icon.svg': iconSvg(),
  'gca-wordmark.svg': wordmarkSvg(),
  'gca-launch-post.svg': launchPostSvg(),
};
for (const [name, svg] of Object.entries(files)) await writeFile(join(out, name), svg);

// Render PNGs with the project's Playwright Chromium.
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const renders = [
  ['gca-icon.svg', 'gca-profile-picture-1080.png', 1080, 1080],
  ['gca-icon.svg', 'gca-icon-512.png', 512, 512],
  ['gca-wordmark.svg', 'gca-wordmark-1600x900.png', 1600, 900],
  ['gca-launch-post.svg', 'gca-launch-post-1080x1350.png', 1080, 1350],
];
for (const [src, dst, w, h] of renders) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const svg = files[src].replace(/<svg([^>]*?) width="\d+" height="\d+"/, `<svg$1 width="${w}" height="${h}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0;overflow:hidden">${svg}</body></html>`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(out, dst), clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  console.log('rendered', dst);
}
// Circle preview at Instagram's real display size (~110 px) to check legibility.
const { readFileSync } = await import("node:fs");
const dataUrl = "data:image/png;base64," + readFileSync(join(out, "gca-profile-picture-1080.png")).toString("base64");
const page = await browser.newPage({ viewport: { width: 360, height: 140 } });
await page.setContent(`<body style="margin:0;background:#fff;display:flex;gap:24px;align-items:center;padding:14px">
  <img src="${dataUrl}" style="width:110px;height:110px;border-radius:50%">
  <img src="${dataUrl}" style="width:56px;height:56px;border-radius:50%">
  <img src="${dataUrl}" style="width:32px;height:32px;border-radius:50%"></body>`);
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, 'preview-circle-sizes.png') });
await browser.close();
console.log('done →', out);

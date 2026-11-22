import { buildRegistry, kinds } from './registry';
const t0 = performance.now();
buildRegistry();
const t1 = performance.now();
let tris = 0;
const rows: string[] = [];
for (const k of kinds()) {
  const parts = k.lods.map((l) => (l.geo.getAttribute('position').count / 3) | 0);
  rows.push(`${k.name}: ${parts.join(' / ')}`);
  tris += parts[0];
}
console.log(`registry built in ${(t1 - t0).toFixed(1)} ms`);
console.log(rows.join('\n'));

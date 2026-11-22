/** Distance formatting for the turn card / map (metric or imperial from settings.units). */
export function formatDistance(m: number, units: 'kmh' | 'mph'): string {
  if (!Number.isFinite(m)) return '—';
  m = Math.max(0, m);
  if (units === 'mph') {
    const ft = m * 3.28084;
    const mi = m / 1609.344;
    if (mi < 0.1) return `${ft < 200 ? Math.max(0, Math.round(ft / 10) * 10) : Math.round(ft / 50) * 50} ft`;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${m < 100 ? Math.round(m / 5) * 5 : Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Scale-bar step (in metres) and its label for a given metres-per-pixel and target pixel length. */
export function niceScale(mpp: number, targetPx: number, units: 'kmh' | 'mph'): { px: number; label: string } {
  const unit = units === 'mph' ? 1609.344 : 1000;
  const small = units === 'mph' ? 0.3048 : 1; // feet / metres
  const want = mpp * targetPx;
  const steps = [1, 2, 5];
  let best = 1;
  let label = '';
  if (want >= unit * 0.5) {
    const v = want / unit;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const s of steps) if (s * p <= v) best = s * p;
    const metres = best * unit;
    label = `${best >= 1 ? best : best.toFixed(1)} ${units === 'mph' ? 'mi' : 'km'}`;
    return { px: metres / mpp, label };
  }
  const v = want / small;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v))));
  for (const s of steps) if (s * p <= v) best = s * p;
  label = `${best} ${units === 'mph' ? 'ft' : 'm'}`;
  return { px: (best * small) / mpp, label };
}

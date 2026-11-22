/**
 * Audio smoke scenario (owner: audio). Run:
 *   node scripts/smoke.mjs --tag audio --script src/audio/smoke-audio.mjs
 * Unlocks audio with a real click, drives, honks, fires synthetic part 1/2/3 events, explodes/resets repeatedly and
 * checks the debug metrics (window.__audioDebug): non-silent bus RMS, voices released, no node growth.
 * Writes .smoke/<tag>/audio-results.json and prints a compact verdict to stderr.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export default async function (page, h) {
  const out = { checks: {}, samples: {}, notes: [] };
  const ev = (js) => page.evaluate(new Function(js));
  const dbg = (expr) => page.evaluate(new Function(`const A = window.__audioDebug; return (${expr});`));
  const peakRms = async (bus, ms = 900, every = 90) => {
    let m = 0;
    for (let t = 0; t < ms; t += every) {
      const r = await dbg('A && A.rms()');
      if (r && r[bus] > m) m = r[bus];
      await h.wait(every);
    }
    return +m.toFixed(4);
  };
  const emit = (name, payloadJs) =>
    ev(`const g = window.__game; const T = g.ctx.vehicle.state.position; const V = T.clone ? T.clone() : {x:0,y:0,z:0};
        const p = (dx=0,dy=0,dz=0) => { const v = V.clone(); v.x += dx; v.y += dy; v.z += dz; return v; };
        g.ctx.events.emit('${name}', ${payloadJs}); return true;`);

  await h.wait(800);
  out.samples.beforeGesture = await dbg('A ? A.state : "no-debug"');
  // 1) real user gesture → context
  await page.mouse.click(640, 360);
  await h.wait(1800);
  out.samples.afterGesture = await dbg('({ state: A.state, sr: A.sampleRate, pending: A.pendingJobs, bake: A.bakeMs, engine: A.engine, stats: A.stats })');
  out.checks.contextRunning = out.samples.afterGesture.state === 'running';

  // 2) drive
  await page.keyboard.down('KeyW');
  const engIdle = await peakRms('engine', 400);
  await h.wait(600);
  const engDrive = await peakRms('engine', 1500);
  out.samples.engineDriving = await dbg('A.engine');
  await page.keyboard.up('KeyW');
  out.samples.engineRms = { idleStart: engIdle, driving: engDrive };
  out.checks.engineAudible = engDrive > 0.005;
  out.samples.ambienceRms = await peakRms('ambience', 500);
  out.checks.ambienceAudible = out.samples.ambienceRms > 0.001;

  // 3) horn (hold H)
  await page.keyboard.down('KeyH');
  const hornRms = await peakRms('sfx', 500);
  await page.keyboard.up('KeyH');
  out.samples.hornRms = hornRms;
  out.checks.horn = hornRms > 0.003;

  // 4) synthetic part-1 events
  const before = await dbg('A.counts');
  await emit('impact', `{ position: p(0,0.5,2), normal: p(0,1,0), strength: 0.85, force: 90000, material: 'metal', other: null, speed: 15 }`);
  const impactRms = await peakRms('sfx', 450);
  await emit('impact', `{ position: p(1,0.5,2), normal: p(0,1,0), strength: 0.5, force: 40000, material: 'concrete', other: null, speed: 9 }`);
  await h.wait(120);
  await emit('propHit', `{ position: p(3,0,3), kind: 'cone', speed: 10 }`);
  await h.wait(120);
  await emit('propHit', `{ position: p(-3,0,3), kind: 'bin', speed: 12 }`);
  await h.wait(120);
  await emit('parkedCarHit', `{ position: p(2,0,4), speed: 9 }`);
  await h.wait(120);
  await emit('glassBreak', `{ position: p(0,1,1), shattered: true }`);
  await h.wait(120);
  await emit('partDetached', `{ part: 'hood', position: p(0,1,2) }`);
  await h.wait(120);
  await emit('npcStartled', `{ position: p(5,0,5), count: 3, scream: true }`);
  await h.wait(200);
  await emit('npcHit', `{ position: p(1,0,3), speed: 8 }`);
  await h.wait(200);
  await emit('scrape', `{ position: p(0,0.3,0), intensity: 0.8 }`);
  out.samples.impactRms = impactRms;
  out.checks.impact = impactRms > 0.005;
  await h.wait(600);
  const afterEvents = await dbg('A.counts');
  out.samples.countsDelta = Object.fromEntries(Object.keys(afterEvents).map((k) => [k, afterEvents[k] - (before[k] ?? 0)]));

  // 5) explode / reset cycles; node accounting
  await h.wait(2500);
  const base = await dbg('({ voices: A.voices, live: A.liveVoices, stats: A.stats })');
  out.samples.baseline = base;
  let boomRms = 0;
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('KeyX');
    const r = await peakRms('sfx', 500, 100);
    if (i === 0) boomRms = r;
    await h.wait(900);
    if (i === 0) out.samples.fireAfterBoom = await dbg('A.fire');
    await page.keyboard.press('KeyR');
    await h.wait(900);
  }
  out.samples.boomRms = boomRms;
  out.checks.explosion = boomRms > 0.01;
  await h.wait(6500); // longest one-shot (car alarm) is ~5 s
  const after = await dbg('({ voices: A.voices, live: A.liveVoices, stats: A.stats, fire: A.fire, counts: A.counts })');
  out.samples.afterCycles = after;
  out.checks.voicesReleased = after.live <= base.live + 2;
  out.checks.noNodeGrowth = after.stats.voiceNodes <= base.stats.voiceNodes + 20 && after.stats.persistentNodes <= base.stats.persistentNodes + 4;
  out.checks.fireStoppedAfterReset = after.fire === false;

  // 6) pause ducking
  await ev('window.__game.game.pause(); return true;');
  await h.wait(900);
  out.samples.pausedDuck = await dbg('A.duck');
  out.samples.pausedRms = await dbg('A.rms()');
  out.checks.pauseDucks = out.samples.pausedDuck.engine === 0 && out.samples.pausedDuck.sfx === 0;
  await ev('window.__game.game.resume(); return true;');
  await h.wait(500);
  out.samples.stateAfterResume = await h.state();
  await dbg('A.test("confirm")');
  out.samples.uiRms = await peakRms('ui', 300, 50);

  // 7) part 2/3 synthetic events (only if the handlers exist)
  const p2 = await dbg('A.counts');
  await emit('engineExplode', `{ type: 'airliner', engine: 1, position: p(30,10,0), velocity: p(0,0,0).set(0,0,60), radius: 6 }`);
  await h.wait(250);
  await emit('planeBreak', `{ position: p(10,5,0), velocity: p().set(0,0,50), pieces: 4, intensity: 0.9 }`);
  await h.wait(250);
  await emit('planeImpact', `{ position: p(20,0,10), velocity: p().set(0,-10,40), outcome: 'waterCrash', surface: 'water', energy: 5e7, normalSpeed: 12 }`);
  await emit('touchdown', `{ position: p(0,0,5), verticalSpeed: 2.5, hard: false }`);
  await emit('gearCollapse', `{ position: p(0,0,5) }`);
  await emit('masterCaution', `{ text: 'ENGINE 1 FIRE', level: 'warning' }`);
  await emit('stallWarning', `{ on: true }`);
  await emit('outOfMap', `{ state: 'warning', countdown: 10 }`);
  const p2Rms = await peakRms('sfx', 1500, 100);
  await emit('stallWarning', `{ on: false }`);
  await emit('outOfMap', `{ state: 'ok', countdown: 0 }`);
  await emit('lightning', `{ position: p(200,80,0), intensity: 1 }`);
  await emit('turbo', `{ on: true }`);
  await emit('stunt', `{ kind: 'barrelRoll', airTime: 1.2, distance: 30, rolls: 1 }`);
  await h.wait(1500);
  await emit('turbo', `{ on: false }`);
  await emit('stunt', `{ kind: 'cleanLanding', airTime: 1.4, distance: 40 }`);
  await h.wait(1200);
  for (const k of ["tear", "water", "snap", "thunder", "wiper", "caution"]) { await dbg(`A.test("${k}")`); await h.wait(150); }
  await h.wait(600);
  // fake an airliner in flight through the plane stub state (engine 2 on fire, stall + out-of-map warnings)
  await ev(`const g = window.__game; const ps = g.ctx.planes.state; ps.type = "airliner"; ps.phase = "flying";
    ps.position.copy(g.ctx.vehicle.state.position); ps.position.y += 3; ps.airspeedKmh = 450; ps.throttle = 0.9;
    ps.engines = [{ status: "ok", spool: 0.9, thrust: 0, fire: 0 }, { status: "fire", spool: 0.4, thrust: 0, fire: 0.8 }];
    ps.stallWarning = true; ps.outOfMap.state = "warning"; g.ctx.planes.active = true; g.game.setMode("plane"); return true;`);
  await h.wait(1200);
  out.samples.planeEngineRms = await peakRms("engine", 900);
  out.samples.planeSfxRms = await peakRms("sfx", 600);
  out.samples.plane = await dbg("A.plane");
  out.checks.planeEngines = out.samples.planeEngineRms > 0.003;
  await ev(`const g = window.__game; g.ctx.planes.inCockpitSequence = true; return true;`);
  await h.wait(1000);
  out.samples.planeSeq = await dbg("A.plane");
  await ev(`const g = window.__game; const ps = g.ctx.planes.state; g.ctx.planes.inCockpitSequence = false; ps.stallWarning = false;
    ps.outOfMap.state = "ok"; ps.engines = []; ps.type = null; ps.phase = "none"; g.ctx.planes.active = false; g.game.setMode("car"); return true;`);
  await h.wait(2600);
  out.samples.afterPlane = await dbg("({ plane: A.plane, stats: A.stats, voices: A.liveVoices })");
  // tunnel echo + rain/wipers in the hood view
  await dbg("A.tunnel(1)");
  await page.keyboard.down("KeyW");
  await h.wait(900);
  out.samples.tunnel = await dbg("A.weather");
  await page.keyboard.up("KeyW");
  await dbg("A.tunnel(-1)");
  await ev(`const g = window.__game; try { Object.defineProperty(g.ctx.env, "weather", { configurable: true, writable: true, value: { kind: "storm", transition: 1, cloudCover: 1, rain: 0.9, snow: 0, fog: 0.2, wetness: 0.8, storm: 0.8, grip: 0.65, visibility: 400, windSpeed: 16, gust: 6 } }); } catch (e) { return String(e); }
    g.ctx.cameraRig.setMode("hood"); return true;`);
  await h.wait(2500);
  out.samples.rain = await dbg("({ weather: A.weather, counts: A.counts })");
  out.samples.rainAmbRms = await peakRms("ambience", 600);
  out.checks.rain = out.samples.rain.weather && out.samples.rain.weather.rain > 0.5 && out.samples.rainAmbRms > 0.005;
  await ev(`const g = window.__game; try { delete g.ctx.env.weather; } catch (e) {} g.ctx.cameraRig.setMode("chase"); return true;`);
  await h.wait(1500);
  const p2after = await dbg('A.counts');
  out.samples.part23Delta = Object.fromEntries(Object.keys(p2after).map((k) => [k, p2after[k] - (p2[k] ?? 0)]));
  out.samples.part23Rms = p2Rms;

  // 8) engine bake analysis: fundamental of each baked layer vs the expected firing frequency
  out.samples.engineBake = await page.evaluate(() => {
    const A = window.__audioDebug;
    const model = A.engine?.model || 'coupe';
    const d = A.engineData(model);
    if (!d) return null;
    const cyl = window.__game.CONFIG.audio.models[model].cylinders;
    const res = [];
    for (let i = 0; i < d.raw.length; i++) {
      const x = d.raw[i];
      if (!x) continue;
      const rpm = d.rpm[i >> 1];
      const firing = (rpm / 60) * (cyl / 2);
      // Goertzel power at k·firing for k = 0.5, 1, 2 vs neighbours (per-sample energy normalised)
      const g = (f) => {
        const w = (2 * Math.PI * f) / d.sampleRate;
        const c = 2 * Math.cos(w);
        let s1 = 0, s2 = 0;
        const n = Math.min(x.length, d.sampleRate);
        for (let j = 0; j < n; j++) {
          const s = x[j] + c * s1 - s2;
          s2 = s1;
          s1 = s;
        }
        return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / n;
      };
      let rms = 0, peak = 0;
      for (let j = 0; j < x.length; j++) { rms += x[j] * x[j]; peak = Math.max(peak, Math.abs(x[j])); }
      rms = Math.sqrt(rms / x.length);
      res.push({ rpm: Math.round(rpm), load: i % 2 ? 'off' : 'on', firingHz: +firing.toFixed(1), rms: +rms.toFixed(3), peak: +peak.toFixed(3),
        atFiring: +g(firing).toFixed(4), at2x: +g(firing * 2).toFixed(4), offHarm: +g(firing * 1.37).toFixed(4), seconds: +(x.length / d.sampleRate).toFixed(2) });
    }
    return { model, cyl, layers: res };
  });

  const ok = Object.values(out.checks).every(Boolean);
  out.ok = ok;
  const dir = join(process.cwd(), '.smoke', 'audio');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'audio-results.json'), JSON.stringify(out, null, 2));
  console.error('[audio-smoke] checks', JSON.stringify(out.checks));
  await h.shot('audio-end');
}

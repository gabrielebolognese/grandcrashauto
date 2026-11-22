/**
 * Audio bake worker: renders procedural buffers (noise, engine loops, explosion, debris, fire, glass, crunch, tear,
 * thunder, rain, reverb IR) off the main thread so unlocking audio / spawning a car never janks a frame.
 * Message in: { id, kind, args } → out: { id, chans, ms } (channel buffers transferred) or { id, error }.
 */
import { runBake, type BakeArgs, type BakeKind } from './bakes';

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<{ id: number; kind: BakeKind; args: BakeArgs }>) => {
  const { id, kind, args } = e.data;
  const t0 = performance.now();
  try {
    const chans = runBake(kind, args);
    post({ id, chans, ms: performance.now() - t0 }, chans.map((c) => c.buffer as ArrayBuffer));
  } catch (err) {
    post({ id, error: String(err) });
  }
};

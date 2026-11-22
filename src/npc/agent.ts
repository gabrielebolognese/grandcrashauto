import * as THREE from 'three';
import type { Appearance } from './appearance';

/** Behaviour states. */
export const S = {
  Walk: 0, // following the ped graph
  Return: 1, // walking back to the graph (off-graph)
  Wander: 2, // free roaming inside a wander area / ambient spot
  Stand: 3, // standing with an idle-type clip for a while
  Approach: 4, // walking to a seat / waiting spot, then turning
  SitDown: 5,
  Sit: 6,
  StandUp: 7,
  Evade: 8, // dive / hop aside
  Flee: 9,
  Knocked: 10, // physics capsule tumble
  Settle: 11, // blend from capsule pose to lying pose
  Lying: 12,
  GetUp: 13,
  Stumble: 14,
  Fall: 15, // non-physics fall (capsule pool exhausted)
  WaitCross: 16, // waiting at the curb for the car to pass
  Group: 17, // standing in a chatting group
} as const;

export const ACT = { Walker: 0, Group: 1, Bench: 2, Bus: 3, Wander: 4, Ambient: 5, Crowd: 6 } as const;

/** One pooled pedestrian. Plain data; all logic lives in NpcSystem. */
export class Npc {
  active = false;
  app!: Appearance;
  scale = 1;
  // canonical transform (origin on the ground between the feet)
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  gy = 0; // cached ground height
  gx = 1e9;
  gz = 1e9;
  gT = 0;
  vx = 0;
  vz = 0;
  speed = 0;
  want = 1.3;
  // body-frame transform (physics tumble / settle): pelvis position + orientation
  body = false;
  px = 0;
  py = 0;
  pz = 0;
  readonly q = new THREE.Quaternion();
  readonly s0 = new THREE.Vector3();
  readonly s1 = new THREE.Vector3();
  readonly q0 = new THREE.Quaternion();
  readonly q1 = new THREE.Quaternion();
  settleYaw = 0;
  upright = false;
  front = false;
  // animation (A = current, B = previous for the crossfade)
  clipA = 0;
  tA = 0;
  rateA = 1;
  clipB = 0;
  tB = 0;
  rateB = 1;
  wB = 0;
  fadeRate = 4;
  fade = 1; // dither visibility
  fadeTo = 1;
  hy = 0; // head yaw / pitch (radians)
  hp = 0;
  lookX = 0;
  lookY = 0;
  lookZ = 0;
  lookT = 0;
  curious = 0.5;
  // state machine
  st: number = S.Stand;
  stT = 0;
  stDur = 0;
  act: number = ACT.Walker;
  actT = 0; // activity time budget (bus wait, wander, ...)
  // graph navigation
  edge = -1;
  dir = 1;
  lat = 0;
  nextEdge = -1;
  nextDir = 1;
  tx = 0;
  tz = 0;
  tyaw = 0;
  // activity references
  bench = -1;
  seat = -1;
  stop = -1;
  group = -1;
  area = -1;
  spot = -1; // ambient spot id
  // reactions
  reactT = -1;
  reactKind = 0;
  escX = 0;
  escZ = 0;
  evX = 0;
  evZ = 0;
  evDist = 0;
  hitCd = 0;
  rag = -1;
  slowT = 0;
  stuckT = 0;
  homeX = 0;
  homeZ = 0;
  homeYaw = 0;
  calm = false; // flee as a calm jog (stepping out of the way) instead of a panic sprint
  // analytic tumble (when no Rapier capsule is used): linear + angular velocity
  bvx = 0;
  bvy = 0;
  bvz = 0;
  bwx = 0;
  bwy = 0;
  bwz = 0;
  // static crowd member taken over by the dynamic system
  crowdSite = -1;
  crowdGen = 0;
  crowdMember = -1;
  threatX = 0;
  threatZ = 0;
  // cached static avoidance (time-sliced)
  ax = 0;
  az = 0;
  avoidT = 0;
  // render
  vis = false;
  dist = 0;
  slot = 0;
  constructor(readonly i: number) {}
}

export interface Group {
  active: boolean;
  spot: number;
  members: number[];
  speaker: number;
  t: number;
  x: number;
  z: number;
}

export interface AmbientSpot {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  count: number;
  members: number;
  benches: number[]; // indices into NpcSystem.benchList
  active: boolean;
}

import * as THREE from 'three';
import { GLSL_ENV_PARS, GLSL_OUTPUT, envUniforms } from './shaders';

/**
 * Sky dome: horizon haze → zenith gradient, warm sun disk + glow, moon with phases, twinkling stars, Milky Way,
 * and the weather cloud deck (cover from scattered wisps to a full overcast dome).
 * One mesh centred on the camera every frame, pinned to the far plane and drawn LAST among opaques (early-z).
 * A second material ("env pass") renders the same sky with a darker ground hemisphere into the PMREM env map.
 */

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999; // pin to the far plane
}
`;

const FRAG = /* glsl */ `
${GLSL_ENV_PARS}
uniform float uEnvPass;
varying vec3 vDir;

const vec3 MW_N = vec3(0.42, 0.55, -0.72); // Milky Way great-circle normal

void main() {
  vec3 dir = normalize(vDir);
  vec3 sp = dir * 190.0;
  float spx = length(fwidth(sp)); // derivatives in uniform control flow only
  vec3 col = skyColor(dir);
  float h = dir.y;
  float horizonCut = smoothstep(-0.02, 0.01, h);

  // Night sky first (behind the clouds): Milky Way + stars.
  float bd = dot(dir, MW_N);
  float mw = exp(-bd * bd * 30.0);
  if (uMilky > 0.001 && h > 0.0) {
    // Soft dusty band: plane-projected noise (no seams), dark rifts from a second tap.
    vec3 t1 = normalize(cross(MW_N, vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(MW_N, t1);
    vec2 muv = vec2(dot(dir, t1), dot(dir, t2)) * 1.6;
    float glow = textureLod(uCloudTex, muv, 2.0).b;
    float rift = textureLod(uCloudTex, muv * 2.3 + 0.41, 1.0).a;
    float band = mw * (0.35 + 0.65 * glow) * (1.0 - 0.55 * smoothstep(0.55, 0.85, rift) * exp(-bd * bd * 160.0));
    col += vec3(0.42, 0.48, 0.72) * band * uMilky * 0.075 * smoothstep(0.0, 0.25, h);
  }
  if (uStars > 0.001 && h > 0.0) {
    vec3 ip = floor(sp);
    vec3 fp = fract(sp);
    float hs = envHash13(ip);
    if (hs > 0.991 - 0.007 * mw * uMilky) {
      vec3 c = vec3(envHash13(ip + 1.7), envHash13(ip + 3.1), envHash13(ip + 5.3)) * 0.6 + 0.2;
      float d = length(fp - c);
      float b = 1.0 - smoothstep(spx * 0.3, spx * 1.05, d);
      float tw = 0.65 + 0.35 * sin(uTime * (1.5 + hs * 4.0) + hs * 91.0);
      float mag = clamp((hs - 0.991) / 0.009, 0.0, 1.0);
      vec3 sc = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), envHash13(ip + 9.9));
      float skyLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += sc * b * tw * (0.25 + 2.4 * mag * mag * mag) * uStars * smoothstep(0.0, 0.2, h) * (1.0 - smoothstep(0.03, 0.25, skyLum));
    }
  }

  // Sun disk (HDR, blooms on High) with soft limb.
  float cosA = dot(dir, uSkySun);
  float sunR = 0.0095 * uSunSize;
  float a = sqrt(max(0.0, 2.0 * (1.0 - cosA))); // ≈ angle for small angles
  float disk = 1.0 - smoothstep(sunR * 0.75, sunR * 1.15, a);
  float diskScale = uEnvPass > 0.5 ? 0.25 : 1.0;
  vec3 sunCol = uGlow * uSunDisk * disk * horizonCut * diskScale;

  // Moon with phases (lit side faces the true sun), mottled maria, faint halo.
  vec3 moonCol = vec3(0.0);
  if (uMoon > 0.001) {
    float moonR = 0.017;
    vec3 v = dir - uMoonDir * dot(dir, uMoonDir);
    float r = length(v) / moonR;
    if (r < 1.2 && dot(dir, uMoonDir) > 0.0) {
      float md = 1.0 - smoothstep(0.88, 1.0, r);
      vec3 n = v / moonR - uMoonDir * sqrt(max(0.0, 1.0 - r * r));
      float lit = smoothstep(-0.08, 0.12, dot(normalize(n), uSkySun));
      vec3 mp = v / moonR;
      float mott = 0.82 + 0.18 * sin(mp.x * 9.0 + 1.3) * sin(mp.y * 7.0 + mp.z * 8.0 + 0.7);
      moonCol += vec3(0.95, 0.97, 1.0) * 3.0 * md * mott * (0.04 + 0.96 * lit);
    }
    float mc = max(dot(dir, uMoonDir), 0.0);
    moonCol += vec3(0.35, 0.45, 0.75) * pow(mc, 90.0) * 0.5;
    moonCol *= uMoon * horizonCut;
  }

  // Weather cloud deck in front of everything.
  vec3 deckCol;
  float deck = cloudDeck(dir, deckCol);
  col = mix(col + (sunCol + moonCol) * (1.0 - deck), deckCol, deck);
  // A bright core still shines through thin cloud.
  col += sunCol * deck * (1.0 - smoothstep(0.5, 0.95, uCover)) * 0.08;

  if (uEnvPass > 0.5) {
    // Environment capture: below the horizon a soft "ground" so cars reflect a ground, not more sky.
    col = mix(col, uSkyGround, smoothstep(0.0, -0.18, h));
  }
  col = mix(col, uFogColor, uWhiteout * (1.0 - uEnvPass));
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
  // Dither (kills gradient banding in 8-bit output).
  gl_FragColor.rgb += (envHash12(gl_FragCoord.xy) - 0.5) / 255.0;
}
`;

const _pos = new THREE.Vector3();

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly envMesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private envMat: THREE.ShaderMaterial;

  constructor() {
    this.geo = new THREE.SphereGeometry(1, 48, 24);
    this.mat = makeMaterial(0);
    this.envMat = makeMaterial(1);
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'env.sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000; // last among opaques: early-z skips pixels covered by the city
    this.mesh.matrixAutoUpdate = false;
    // Follow whichever camera renders it (main camera, cinematic cameras...), always inside its far plane.
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      const far = (camera as THREE.PerspectiveCamera).far || 1000;
      _pos.setFromMatrixPosition(camera.matrixWorld);
      this.mesh.matrixWorld.makeScale(far * 0.9, far * 0.9, far * 0.9).setPosition(_pos);
    };
    this.envMesh = new THREE.Mesh(this.geo, this.envMat);
    this.envMesh.name = 'env.skyCapture';
    this.envMesh.frustumCulled = false;
    this.envMesh.scale.setScalar(50);
    this.envMesh.updateMatrix();
    this.envMesh.matrixAutoUpdate = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.envMat.dispose();
  }
}

function makeMaterial(envPass: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: envPass ? 'env.skyCapture' : 'env.sky',
    uniforms: { ...envUniforms(), uEnvPass: { value: envPass } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: envPass ? false : true,
    fog: false,
  });
}

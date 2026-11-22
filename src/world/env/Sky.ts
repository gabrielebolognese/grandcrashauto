import * as THREE from 'three';
import { GLSL_ENV_PARS, GLSL_OUTPUT, envUniforms } from './shaders';

/**
 * Sky dome: horizon haze → zenith gradient, warm sun disk + glow, moon and twinkling stars at night.
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

void main() {
  vec3 dir = normalize(vDir);
  vec3 sp = dir * 190.0;
  float spx = length(fwidth(sp)); // derivatives in uniform control flow only
  vec3 col = skyColor(dir);
  float h = dir.y;

  if (uEnvPass > 0.5) {
    // Environment capture: below the horizon a soft "ground" (sand / sea / asphalt mix) so cars reflect a ground.
    col = mix(col, uSkyGround, smoothstep(0.0, -0.18, h));
  }

  float cosA = dot(dir, uSunDir);
  // Sun disk (HDR, blooms on High) with soft limb.
  float sunR = 0.0095 * uSunSize;
  float a = sqrt(max(0.0, 2.0 * (1.0 - cosA))); // ≈ angle for small angles
  float disk = 1.0 - smoothstep(sunR * 0.75, sunR * 1.15, a);
  float horizonCut = smoothstep(-0.02, 0.01, h);
  float diskScale = uEnvPass > 0.5 ? 0.25 : 1.0;
  col += uGlow * uSunDisk * disk * horizonCut * diskScale * (1.0 - uMoon);

  // Moon (the night "sun" light comes from it) with a faint halo and simple mottling.
  if (uMoon > 0.001) {
    float moonR = 0.016;
    float md = 1.0 - smoothstep(moonR * 0.85, moonR, a);
    vec3 mp = dir - uSunDir;
    float mott = 0.85 + 0.15 * sin(mp.x * 900.0 + 1.3) * sin(mp.y * 700.0 + mp.z * 800.0);
    col += vec3(0.95, 0.97, 1.0) * 3.2 * md * mott * uMoon * horizonCut;
    col += vec3(0.35, 0.45, 0.75) * pow(max(cosA, 0.0), 120.0) * 0.6 * uMoon;
  }

  // Stars.
  if (uStars > 0.001 && h > 0.0) {
    vec3 ip = floor(sp);
    vec3 fp = fract(sp);
    float hs = envHash13(ip);
    if (hs > 0.991) {
      vec3 c = vec3(envHash13(ip + 1.7), envHash13(ip + 3.1), envHash13(ip + 5.3)) * 0.6 + 0.2;
      float d = length(fp - c);
      float b = 1.0 - smoothstep(spx * 0.6, spx * 1.6, d);
      float tw = 0.65 + 0.35 * sin(uTime * (1.5 + hs * 4.0) + hs * 91.0);
      float mag = (hs - 0.991) / 0.009;
      vec3 sc = mix(vec3(1.0, 0.85, 0.7), vec3(0.75, 0.85, 1.0), envHash13(ip + 9.9));
      col += sc * b * tw * (0.6 + 2.2 * mag * mag) * uStars * smoothstep(0.0, 0.2, h);
    }
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

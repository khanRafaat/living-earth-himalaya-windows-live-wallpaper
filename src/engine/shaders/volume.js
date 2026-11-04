/*
 * Volumetrics (reduced resolution, temporally accumulated):
 *  • valley mist and weather fog — layered, drifting, lit by sun/moon, shadowed in valleys
 *  • cumulus / stratus cloud deck — 3D Perlin-Worley clouds with self-shadowing,
 *    powder effect and dual-lobe phase function; they pass in front of the peaks
 * Output: rgb = in-scattered light (pre-exposed), a = transmittance.
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  S.volumeCommon = `
uniform sampler3D uNoise3D;
uniform sampler2D uNoise2D;
uniform vec3 uWind;
uniform vec3 uMistWind;
uniform float uCoverage;
uniform float uOvercast;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudDensity;
uniform vec2 uCoverFront;
uniform vec2 uCoverWind;
float remap(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }
// A thick deck thins out gradually towards its base, so peaks fade into it instead of being cut off
float cloudProfile(float hf) {
  return smoothstep(0.0, 0.16 + 0.34 * uOvercast, hf) * smoothstep(1.0, 0.62 - 0.32 * uOvercast, hf);
}
// xz is fixed to the ground. Cover drifts slower than the cloud shapes, so clouds build on one side and
// fade on the other as they travel, instead of sliding past as a rigid sheet. uCoverFront is non-zero
// only while the cover is changing, and makes the change arrive from upwind.
float cloudCoverageAt(vec2 xz) {
  float wm = textureLod(uNoise2D, (xz + uCoverWind) * 0.0042 + 0.13, 0.0).r;
  float front = clamp(dot(xz, uCoverFront), -0.5, 0.5);
  return clamp(uCoverage + front + (wm - 0.5) * 0.6 * (1.0 - uOvercast), 0.0, 1.0);
}
// In fair weather, clouds build over the mountains (orographic lift) and leave the
// sky above the viewpoint open; as cover rises they spread across the whole sky.
float cloudRegion(vec2 camXZ) {
  float r = length(camXZ);
  float fair = smoothstep(8.0, 15.0, r) * (1.0 - 0.5 * smoothstep(50.0, 80.0, r));
  return mix(fair, 1.0, smoothstep(0.55, 0.9, uCoverage));
}
float cloudShape(vec3 q) {
  return textureLod(uNoise3D, q * vec3(0.10, 0.14, 0.10), 0.0).r * 0.7
       + textureLod(uNoise3D, q * 0.027 + 0.41, 0.0).r * 0.3;
}
// The shape noise centres near 0.63, so using cover directly as a threshold drew far more cloud than
// the data says, and the clouds merged into a wall. This leaves about the reported share of sky covered.
float cloudThreshold(float cov) {
  return mix(1.0, 0.75 - 0.29 * cov - 0.25 * smoothstep(0.8, 1.0, cov), smoothstep(0.0, 0.08, cov));
}
// > 0 inside a cloud, reaching 1 in its dense core
float cloudBody(vec3 q, float hf, float cov) {
  return (cloudShape(q) * cloudProfile(hf) - cloudThreshold(cov)) / 0.32;
}
// cloud bases are ragged and vary in height (up to ~0.6 km lower than the deck base)
float cloudBaseAt(vec2 qxz) {
  return uCloudBase - 0.9 * textureLod(uNoise2D, qxz * 0.045 + 0.7, 0.0).b * (0.6 + 0.4 * textureLod(uNoise2D, qxz * 0.011, 0.0).g);
}
`;

  S.volume = () => `${S.header}
${S.camera}
${S.atmosphere}
${S.atmosphereLookup}
${S.volumeCommon}
uniform sampler2D uG0;
uniform sampler2D uShadow;
uniform sampler2D uHistory;
uniform vec2 uVolRes;
uniform float uFrame;
uniform float uBlend;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunE;
uniform vec3 uMoonE;
uniform vec3 uLightMarchDir;
uniform float uCloudDark;
uniform float uMist;
uniform float uMistBottom;
uniform float uMistTop;
uniform float uFog;
uniform float uFogTop;
uniform int uCloudSteps;
uniform int uCloudFine;
uniform int uMistSteps;
uniform int uLightSteps;
uniform float uAirExt;
uniform float uKeyIsSun;
uniform vec3 uDetailDrift;
uniform int uZero; // always 0: stops the Direct3D compiler from unrolling these loops (see chunks.js)
out vec4 o;

vec2 slab(float y0, float ry, float a, float b) {
  if (abs(ry) < 1e-5) return (y0 >= a && y0 <= b) ? vec2(0.0, 1e5) : vec2(1.0, 0.0);
  float t0 = (a - y0) / ry;
  float t1 = (b - y0) / ry;
  return vec2(max(min(t0, t1), 0.0), max(t0, t1));
}

float cloudDensity(vec3 p) {
  if (p.y < uCloudBase - 0.9 || p.y > uCloudTop) return 0.0;
  float region = cloudRegion(p.xz);
  if (region <= 0.001) return 0.0;
  vec3 q = p + uWind;
  float base = cloudBaseAt(q.xz);
  float hf = (p.y - base) / (uCloudTop - base);
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  float d = cloudBody(q, hf, cloudCoverageAt(p.xz) * region);
  if (d <= 0.0) return 0.0;
  // Two sizes of billow churn against the body. Near the base they eat wisps, higher up they leave
  // round puffs (the Worley channels are highest at the centre of each cell).
  vec3 qd = q + uDetailDrift;
  float w = textureLod(uNoise3D, qd * 0.2, 0.0).g * 0.7 + textureLod(uNoise3D, qd * 0.7, 0.0).b * 0.3;
  float det = mix(w, 1.0 - w, clamp(hf * 6.0, 0.0, 1.0));
  d = remap(min(d, 1.0), det * 0.62 * (1.0 - 0.35 * hf), 1.0, 0.0, 1.0);
  return clamp(d, 0.0, 1.0) * uCloudDensity;
}

// Cloud mass without fine detail, for finding clouds and for shading. Errs towards finding cloud.
float cloudBulk(vec3 p) {
  if (p.y < uCloudBase - 0.9 || p.y > uCloudTop) return 0.0;
  float region = cloudRegion(p.xz);
  if (region <= 0.001) return 0.0;
  float hf = (p.y - uCloudBase + 0.45) / (uCloudTop - uCloudBase + 0.45);
  float d = cloudBody(p + uWind, clamp(hf, 0.17, 1.0), cloudCoverageAt(p.xz) * region);
  return clamp(d, 0.0, 1.0) * uCloudDensity;
}

float mistDensity(vec3 p) {
  float d = 0.0;
  if (uMist > 0.005) {
    float hf = (p.y - uMistBottom) / (uMistTop - uMistBottom);
    if (hf < 1.0) {
      vec3 q = (p + uMistWind) * vec3(0.30, 1.0, 0.30);
      // the top of the layer rises and falls, so it does not draw a straight line across the mountains
      float swell = texture(uNoise3D, vec3(q.x, 0.3, q.z) * 0.14).a - 0.5;
      float prof = 1.0 - smoothstep(0.1, 1.0, hf + swell * 1.1);
      float n = texture(uNoise3D, q).a * 0.68 + texture(uNoise3D, q * 2.9 + 0.3).a * 0.32;
      // never fully solid: thick mist still has thinner patches
      float lo = 1.0 - min(uMist, 0.82) * 0.95;
      float m = smoothstep(lo, lo + 0.42, n) * prof;
      d += m * (0.22 + 0.75 * uMist);
    }
  }
  if (uFog > 0.005) {
    float f = 1.0 - smoothstep(uFogTop - 1.0, uFogTop, p.y);
    float low = 1.0 + 1.5 * (1.0 - smoothstep(0.8, 2.0, p.y)); // denser in the valleys
    vec3 q2 = (p + uMistWind * 0.6) * vec3(0.45, 1.3, 0.45);
    float n2 = texture(uNoise3D, q2).a;
    d += f * uFog * (0.25 + 0.6 * n2) * 0.75 * low;
  }
  return d;
}

void main() {
  ivec2 vc = ivec2(gl_FragCoord.xy);
  vec2 fcf = (vec2(vc) + 0.5) * (uRes / uVolRes);
  ivec2 fci = ivec2(fcf);
  float t = texelFetch(uG0, fci, 0).z;
  vec3 rd = cameraRay(fcf);
  float tEnd = t < 0.0 ? 1e5 : t;
  float jit = fract(52.9829189 * fract(dot(vec2(vc) + uFrame * vec2(5.588238, 3.17), vec2(0.06711056, 0.00583715))));

  vec3 skyZen = skyLUT(vec3(0.0, 1.0, 0.0));
  vec3 skyHor = skyLUT(normalize(vec3(rd.x, 0.06, rd.z)));
  // under an overcast deck the horizon is grey, not sky-blue
  skyHor = mix(skyHor, vec3(dot(skyHor, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.93, 0.96, 1.0), uOvercast * 0.92);
  float cosS = dot(rd, uSunDir);
  float cosM = dot(rd, uMoonDir);
  // light that filters through an overcast deck: diffuse and grey, not sky-blue
  float lz = dot(skyZen, vec3(0.2126, 0.7152, 0.0722));
  vec3 greyAmb = (uSunE * transmittance(uCloudTop, uSunDir.y) * clamp(uSunDir.y + 0.08, 0.0, 1.0) * 0.16
                + uMoonE * transmittance(uCloudTop, uMoonDir.y) * clamp(uMoonDir.y + 0.08, 0.0, 1.0) * 0.16
                + vec3(lz) * 0.5) * vec3(0.95, 0.97, 1.0);
  float underCloud = 1.0 - 0.85 * uOvercast;
  vec3 L = vec3(0.0);
  float T = 1.0;

  // ---------------- mist & fog ----------------
  if (uMist > 0.005 || uFog > 0.005) {
    float top = max(uMistTop, uFog > 0.005 ? uFogTop : 0.0);
    vec2 seg = slab(uCamPos.y, rd.y, uMistBottom - 1.0, top);
    seg.y = min(seg.y, min(tEnd, 75.0));
    if (seg.y > seg.x) {
      float shadowS = t < 0.0 ? 1.0 : texelFetch(uShadow, fci, 0).r;
      float phS = mix(phaseHG(cosS, 0.55), 1.0 / (4.0 * PI), 0.4) * 4.0 * PI;
      float phM = mix(phaseHG(cosM, 0.55), 1.0 / (4.0 * PI), 0.4) * 4.0 * PI;
      // with a low sun, mist is golden only looking towards it or in front of land the sun lights.
      // Elsewhere it is the same neutral blue-grey as the air (aerial() in composite.js).
      float lowSun = 1.0 - smoothstep(0.2, 0.55, uSunDir.y);
      phS *= mix(1.0, mix(0.15, 1.0, smoothstep(0.0, 0.8, cosS)), lowSun);
      float natural = lowSun * smoothstep(-0.14, -0.03, uSunDir.y) * (1.0 - max(smoothstep(0.0, 0.8, cosS), shadowS * smoothstep(-0.03, 0.01, uSunDir.y) * 0.6));
      vec3 mistHor = mix(skyHor, vec3(dot(skyHor, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.88, 0.93, 1.0), natural);
      // under dark storm cloud the mist is in the same gloom, so it must not glow brighter than the sky
      vec3 amb = mix(skyZen * 0.75 + mistHor * 0.55, greyAmb, uOvercast) * mix(1.0, 0.5, uCloudDark);
      float dt = (seg.y - seg.x) / float(uMistSteps);
      for (int i = 0; i < 16; i++) {
        if (i >= uMistSteps) break;
        float s = seg.x + (float(i) + jit) * dt;
        vec3 p = uCamPos + rd * s;
        float sig = mistDensity(p);
        if (sig < 1e-4) continue;
        // samples near the surface share its shadow (valleys in shade keep dim mist)
        float nearSurf = t < 0.0 ? 0.0 : smoothstep(0.25, 0.9, s / tEnd);
        float sh = mix(1.0, shadowS, nearSurf * 0.85);
        float shS = uKeyIsSun > 0.5 ? sh : 1.0;
        float shM = uKeyIsSun > 0.5 ? 1.0 : sh;
        vec3 direct = uSunE * transmittance(p.y, uSunDir.y) * phS * 0.2 * shS
                    + uMoonE * transmittance(p.y, uMoonDir.y) * phM * 0.08 * shM;
        vec3 Sc = (direct * underCloud + amb) * 0.92;
        float air = 1.0 - exp(-s * uAirExt);
        Sc = mix(Sc, mistHor, air * 0.75);
        float Ti = exp(-sig * dt);
        L += T * Sc * (1.0 - Ti);
        T *= Ti;
        if (T < 0.01) break;
      }
    }
  }

  // ---------------- clouds ----------------
  if (uCoverage > 0.015 && T > 0.01) {
    vec2 seg = slab(uCamPos.y, rd.y, uCloudBase - 0.9, uCloudTop);
    seg.y = min(seg.y, min(tEnd, 130.0));
    if (seg.y > seg.x) {
      float phS = (phaseHG(cosS, 0.62) * 0.7 + phaseHG(cosS, -0.25) * 0.3) * 4.0 * PI;
      float phM = (phaseHG(cosM, 0.62) * 0.7 + phaseHG(cosM, -0.25) * 0.3) * 4.0 * PI;
      float darken = mix(1.0, 0.32, uCloudDark);
      // Search in coarse steps that grow with distance, find the cloud's surface, then take fine steps
      // through the part you can actually see. Clouds turn opaque within a few hundred metres, so even
      // steps of several km would stop at a random depth in each pixel, which shows as noise.
      float start = max(seg.x, 1.0);
      float grow = pow(max(seg.y, start + 0.01) / start, 1.0 / float(uCloudSteps));
      float s = start * pow(grow, jit);
      float dt = 0.0;
      int fine = 0;
      float belly = -1.0;
      for (int i = uZero; i < uCloudSteps + uCloudFine; i++) {
        if (s >= seg.y || T < 0.015) break;
        vec3 p = uCamPos + rd * s;
        if (fine == 0) {
          if (cloudBulk(p) <= 0.0) {
            s *= grow;
            continue;
          }
          float a = max(s / grow, seg.x);
          float b = s;
          for (int k = uZero; k < 4; k++) {
            float m = 0.5 * (a + b);
            if (cloudBulk(uCamPos + rd * m) > 0.0) b = m;
            else a = m;
          }
          s = b;
          dt = max(0.1, s * 0.005); // about what one pixel of this pass covers at that distance
          fine = uCloudFine;
          s += dt * jit;
          p = uCamPos + rd * s;
        }
        fine--;
        float d = cloudDensity(p);
        if (d > 0.001) {
          float sigma = d * 5.0;
          // The first look towards the light sees the billows, so they shade each other. Further on,
          // only the mass of the cloud matters. Under a thick deck little direct light survives
          // (see below), so that costly work would show no difference.
          float od = 0.0;
          float ls = 0.2;
          if (uOvercast < 0.7) {
            od = cloudDensity(p + uLightMarchDir * 0.18) * 0.18;
            for (int j = uZero; j < uLightSteps; j++) {
              od += cloudBulk(p + uLightMarchDir * ls * 1.5) * ls;
              ls *= 2.6;
            }
          } else {
            od = cloudBulk(p + uLightMarchDir * 0.6) * 1.5;
          }
          // Three orders of scattering: crisp shadow from the first, the soft inner glow from the others
          float Tl = (exp(-od * 3.5) + 0.3 * exp(-od * 1.1) + 0.08 * exp(-od * 0.35)) / 1.38;
          // Dark edges where little light has gathered yet, except looking towards the sun (silver lining)
          float powder = mix(1.0 - 0.6 * exp(-(od + sigma * 0.1) * 5.0), 1.0, smoothstep(0.3, 0.95, max(cosS, cosM)));
          float hf = clamp((p.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
          vec3 direct = (uSunE * transmittance(p.y, uSunDir.y) * phS + uMoonE * transmittance(p.y, uMoonDir.y) * phM) * Tl * powder * 0.26;
          // beneath a thick deck little direct light survives, and lower layers are darker
          direct *= mix(1.0, 0.12, uOvercast);
          vec3 amb = mix(skyZen * mix(0.22, 1.0, hf * hf) + skyHor * 0.22, greyAmb * mix(0.5, 1.3, hf), smoothstep(0.5, 0.95, uCoverage));
          amb *= mix(1.0, 0.45 + 0.55 * hf, uOvercast);
          amb *= mix(0.4, 1.0, exp(-od * 0.8)); // the shaded sides and undersides also see less sky
          // A thick deck is not one flat sheet: dark sagging bellies with thinner, paler patches between.
          // Sampled once per pixel, at the point you actually see.
          if (belly < 0.0) {
            vec3 qb = (p + uWind) * vec3(0.05, 0.1, 0.05);
            belly = textureLod(uNoise3D, qb, 0.0).a * 0.62 + textureLod(uNoise3D, qb * 2.7 + 0.2, 0.0).a * 0.38;
            belly = smoothstep(0.34, 0.66, belly);
          }
          amb *= mix(1.0, mix(0.5, 1.4, belly), uOvercast);
          vec3 Sc = (direct + amb) * darken;
          float air = 1.0 - exp(-s * uAirExt);
          Sc = mix(Sc, skyHor, air * 0.8);
          float Ti = exp(-sigma * dt);
          L += T * Sc * (1.0 - Ti);
          T *= Ti;
        }
        s += dt;
        dt *= 1.3;
      }
    }
  }

  vec4 cur = vec4(min(L, vec3(6e4)), T);
  vec4 hist = texelFetch(uHistory, vc, 0);
  o = mix(hist, cur, uBlend);
}
`;
})();

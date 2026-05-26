/**
 * blackhole.js — Realistic black hole background renderer
 * ─────────────────────────────────────────────────────────────────
 * WebGL fragment shader that draws an Interstellar-style black hole
 * behind the page content. Renders to a fixed full-viewport canvas.
 *
 * The shader composites, back to front:
 *   1. Starfield with gravitational lensing pull near the BH
 *   2. Distant nebula gas (very subtle, amber-tinted)
 *   3. Back arc of the accretion disk wrapped OVER the top of the BH
 *      by gravitational lensing — the iconic Interstellar halo
 *   4. Front of the tilted accretion disk (ellipse) with:
 *        - Doppler beaming (approaching side brighter and bluer)
 *        - Turbulent filamentary structure with rotation
 *        - Radial temperature gradient (hot inside, cool outside)
 *   5. Bright photon ring at the edge of the BH shadow
 *   6. Perfectly black event horizon
 *   7. Tone mapping + soft vignette
 */

(() => {
  const canvas = document.getElementById('blackhole-canvas');
  if (!canvas) return;

  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false });
  if (!gl) {
    canvas.style.background = '#040408';
    return;
  }

  /* ── Vertex shader: fullscreen triangle ───────────────────────── */
  const VS = `
    attribute vec2 a;
    void main() { gl_Position = vec4(a, 0.0, 1.0); }
  `;

  /* ── Fragment shader: the black hole ──────────────────────────── */
  const FS = `
    precision highp float;
    uniform float uT;
    uniform vec2  uR;       // resolution
    uniform vec2  uM;       // parallax mouse offset

    /* hash & noise helpers */
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float a = hash(i);
      float b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0));
      float d = hash(i + vec2(1.0, 1.0));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) {
        v += a * vnoise(p);
        p = p * 2.07 + 13.13;
        a *= 0.5;
      }
      return v;
    }

    /* Starfield — sparse bright dots with subtle twinkle */
    float starLayer(vec2 uv, float density, float seedShift) {
      vec2 cell = floor(uv);
      vec2 fp   = fract(uv) - 0.5;
      float h   = hash(cell + seedShift);
      float thresh = 1.0 - density;
      if (h < thresh) return 0.0;
      float brightness = (h - thresh) / density;
      float d = length(fp);
      float tw = 0.65 + 0.35 * sin(uT * (1.5 + h * 3.0) + h * 24.0);
      return smoothstep(0.25, 0.0, d) * brightness * tw;
    }

    /* Accretion disk temperature → color
       Inner edge is plasma-white, ramping through searing yellow and amber
       through magma orange to deep red. Pushed brighter & more saturated
       than the prior pass for a more violent look. */
    vec3 diskPalette(float t) {
      // t ∈ [0,1], 0 = inner edge (hot), 1 = outer edge (cool)
      vec3 c0 = vec3(1.30, 1.20, 1.00);   // plasma white (HDR-ish)
      vec3 c1 = vec3(1.30, 0.95, 0.40);   // searing yellow-amber
      vec3 c2 = vec3(1.20, 0.45, 0.08);   // molten orange
      vec3 c3 = vec3(0.85, 0.14, 0.02);   // glowing red
      vec3 c4 = vec3(0.18, 0.02, 0.00);   // ember
      vec3 col = mix(c0, c1, smoothstep(0.00, 0.18, t));
      col      = mix(col, c2, smoothstep(0.12, 0.45, t));
      col      = mix(col, c3, smoothstep(0.45, 0.78, t));
      col      = mix(col, c4, smoothstep(0.78, 1.00, t));
      return col;
    }

    /* Turbulent gas pattern on the disk.
       Domain-warped fbm produces sharp curving filaments that shear
       differentially — inner gas orbits faster than outer (Keplerian shear). */
    float diskGas(float r, float angle, float t) {
      // Keplerian-ish differential rotation: ω ~ r^-1.5
      float omega = 1.6 / pow(r + 0.15, 1.3);
      float a = angle + t * omega;

      // unwrap to a strip
      vec2 q = vec2(a * 2.2, r * 9.0);

      // domain warp — first noise field warps the input of the second
      vec2  w  = vec2(fbm(q + vec2(t * 0.4, 0.0)),
                      fbm(q * 1.7 + vec2(0.0, t * 0.3)));
      float n  = fbm(q + 2.4 * w);
      // second octave for fine detail
      float n2 = fbm(q * 3.1 - 1.2 * w + vec2(t * 0.7, 0.0));
      n = mix(n, n2, 0.55);

      // sharpen into filaments
      n = pow(clamp(n, 0.0, 1.0), 1.9);
      // ridged contribution — makes filament edges crisper
      float ridge = 1.0 - abs(2.0 * fbm(q * 1.4 + 0.7 * w) - 1.0);
      ridge = pow(ridge, 3.0);
      n = mix(n, ridge, 0.35);
      return n;
    }

    /* Pulsating hot-spot flares scattered through the disk.
       Several bright blobs orbit at different speeds and fade in/out,
       simulating magnetic reconnection events / shocks in the accretion flow. */
    float diskFlares(float r, float angle, float t) {
      float flare = 0.0;
      // 4 flares at varying radii and orbital speeds
      for (int i = 0; i < 4; i++) {
        float fi = float(i);
        float orbitR  = 0.28 + 0.12 * fi + 0.05 * sin(t * 0.3 + fi * 1.7);
        float orbitW  = 0.9 - 0.18 * fi;          // angular velocity (rad/s)
        float phase   = fi * 1.9;
        float theta   = phase + t * orbitW;
        // life cycle — each flare brightens then fades
        float life    = 0.5 + 0.5 * sin(t * (0.6 + fi * 0.21) + fi * 3.1);
        life = pow(life, 3.0);
        // distance from this flare in (r,θ) space, but in radians*r so it
        // shapes like a teardrop along the orbit
        float dr  = (r - orbitR);
        float dth = atan(sin(angle - theta), cos(angle - theta));
        float d   = sqrt(dr * dr * 9.0 + dth * dth * 0.6);
        flare += life * exp(-d * 8.0);
      }
      return flare;
    }

    /* Soft annular falloff for disk brightness across its width */
    float annulus(float r, float rIn, float rOut) {
      float a = smoothstep(rIn, rIn + 0.04, r);
      float b = 1.0 - smoothstep(rOut - 0.18, rOut, r);
      return clamp(a * b, 0.0, 1.0);
    }

    void main() {
      // Normalize to height; y-up so the disk tilt feels natural
      vec2 uv = (gl_FragCoord.xy - 0.5 * uR.xy) / uR.y;
      // gentle parallax from cursor
      uv += uM * 0.04;

      float t = uT;

      /* ── Black hole geometry ───────────────────────────────── */
      const float BH_R     = 0.115;   // event horizon
      const float PHOTON_R = 0.143;   // photon ring radius
      const float DISK_IN  = 0.165;   // inner edge of disk
      const float DISK_OUT = 0.78;    // outer fade radius (in elliptical coords)
      const float TILT     = 4.4;     // y-squash factor for the tilted disk

      float r0     = length(uv);
      float invR   = 1.0 / max(r0, 0.012);
      vec2  rdir   = uv * invR;

      /* ── 1. Background stars with gravitational lens deflection ── */
      // Schwarzschild-like radial pull: deflection ∝ 1/r
      float deflect = 0.055 * invR;
      // null out the pull inside the BH so we don't sample wildly
      deflect *= smoothstep(BH_R, BH_R + 0.05, r0);
      vec2 lensed = uv - rdir * deflect;

      // two star layers for parallax depth
      vec2 sUV1 = lensed * 30.0 + vec2(t * 0.6, 0.0);
      vec2 sUV2 = lensed * 60.0 + vec2(-t * 0.3, t * 0.2);
      float stars = starLayer(sUV1, 0.012, 0.0) * 1.0
                  + starLayer(sUV2, 0.006, 17.0) * 0.55;

      vec3 col = vec3(stars) * vec3(0.92, 0.96, 1.08);

      /* ── 2. Distant nebula gas (very subtle amber haze) ───── */
      {
        vec2 nUV = lensed * 1.8 + vec2(t * 0.01, t * 0.005);
        float n = fbm(nUV);
        n = pow(n, 2.5);
        vec3 nebCol = mix(vec3(0.18, 0.07, 0.02), vec3(0.45, 0.20, 0.08), n);
        col += nebCol * n * 0.16;
      }

      /* ── 3. Lensed back arc — the disk wrapping OVER the BH ── */
      // This is the iconic upper halo. It is the back half of the disk whose
      // light is bent by gravity to pass above the BH on its way to us.
      // We render it as a near-circular ring (less squashed than the front disk)
      // confined to the upper half.
      {
        vec2  ap = vec2(uv.x, uv.y * 1.7);
        float ar = length(ap);
        float aa = atan(ap.y, ap.x);
        // limit to top half plus a small bleed
        float topMask = smoothstep(-0.04, 0.06, uv.y);
        float ringMask = annulus(ar, PHOTON_R + 0.003, 0.42);
        // brightness peaks near horizontal extremes (where lensed light piles up)
        float lensBoost = 0.4 + 1.05 * pow(abs(sin(aa)), 0.35);
        // gas pattern, slightly different timing from front
        float rNorm = clamp((ar - PHOTON_R) / (0.42 - PHOTON_R), 0.0, 1.0);
        float gas = diskGas(ar, aa, t * 0.85);
        float fl  = diskFlares(ar, aa, t * 0.9);
        // strong Doppler asymmetry
        float dop = 0.55 + 1.25 * cos(aa);
        dop = clamp(dop, 0.20, 2.8);
        vec3 c = diskPalette(rNorm) * lensBoost * (0.55 + 1.05 * gas + 0.9 * fl) * dop;
        col += c * ringMask * topMask * 1.55;
      }

      /* ── 4. Front of accretion disk — tilted ellipse ───────── */
      // The "near" half of the disk is in front of the BH (uv.y < 0 region for
      // our chosen tilt). The "far" half passes behind the BH and is occluded
      // by the event horizon — but its light has already been added in step 3.
      {
        vec2  dp = vec2(uv.x, uv.y * TILT);
        float dr = length(dp);
        float da = atan(dp.y, dp.x);
        float rNorm = clamp((dr - DISK_IN) / (DISK_OUT - DISK_IN), 0.0, 1.0);
        float ring = annulus(dr, DISK_IN, DISK_OUT);

        float gas    = diskGas(dr, da, t);
        float flares = diskFlares(dr, da, t);

        // Strong relativistic Doppler beaming: the side rotating toward the
        // viewer is dramatically brighter (and a touch bluer); receding side
        // can be ~5x dimmer.
        float dop = 0.35 + 1.55 * cos(da);
        dop = clamp(dop, 0.12, 3.2);

        vec3 c = diskPalette(rNorm) * (0.45 + 1.15 * gas + 1.3 * flares) * dop;
        // blue shift on approaching side, red shift on receding
        c.b += 0.18 * max(0.0,  cos(da)) * (1.0 - rNorm);
        c.r += 0.10 * max(0.0, -cos(da)) * rNorm;

        // Near half: uv.y < 0 — fully visible, brighter (in front)
        float nearMask = smoothstep(0.012, -0.02, uv.y);
        // Far half: uv.y > 0 — partially visible only outside the BH shadow
        float farMask  = smoothstep(-0.012, 0.02, uv.y)
                       * smoothstep(PHOTON_R, PHOTON_R + 0.05, r0);

        col += c * ring * (nearMask * 1.85 + farMask * 1.25);
      }

      /* ── 5. Photon ring (bright thin ring at the BH shadow edge) ── */
      {
        float ringW = 0.0075;
        float ring = smoothstep(ringW, 0.0, abs(r0 - PHOTON_R));
        // brightness peaks at the equator (gravitational beaming)
        float equator = 1.0 - 0.35 * abs(uv.y / max(r0, 0.01));
        // gentle pulsation on the ring
        float pulse = 0.85 + 0.25 * sin(uT * 1.7);
        col += vec3(1.20, 0.92, 0.55) * ring * 2.6 * equator * pulse;
      }

      /* ── 6. Hot bloom-like glow surrounding the BH ───────────── */
      {
        float glow1 = exp(-pow((r0 - PHOTON_R) * 13.0, 2.0)) * 0.55;
        float glow2 = exp(-pow((r0 - PHOTON_R) *  5.5, 2.0)) * 0.18;
        col += vec3(1.30, 0.72, 0.22) * (glow1 + glow2);
      }

      /* ── 7. Event horizon — pure black mask ─────────────────── */
      float horizon = smoothstep(BH_R, BH_R + 0.004, r0);
      col *= horizon;

      /* ── Tone mapping + vignette + film grain ──────────────── */
      // soft Reinhard-ish tone map
      col = col / (1.0 + col * 0.85);
      col = pow(col, vec3(0.88));

      // vignette
      float vig = 1.0 - 0.32 * length(uv * vec2(0.9, 1.1));
      col *= vig;

      // very subtle film grain so flat regions feel alive
      float grain = (hash(gl_FragCoord.xy + fract(uT)) - 0.5) * 0.018;
      col += grain;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  /* ── Compile helpers ───────────────────────────────────────── */
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(s));
    }
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(prog));
    return;
  }
  gl.useProgram(prog);

  /* Fullscreen quad as two triangles */
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);
  const aLoc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);

  const uT = gl.getUniformLocation(prog, 'uT');
  const uR = gl.getUniformLocation(prog, 'uR');
  const uM = gl.getUniformLocation(prog, 'uM');

  /* ── Pause hook ─────────────────────────────────────────────
     Exposed so other scripts (e.g. modal open/close in app.js) can
     freeze rendering while a fullscreen overlay covers the canvas.
     Skipping the draw call eliminates per-frame GPU + composite work
     that the user can't see anyway. */
  let bhPaused = false;
  window.__bhSetPaused = (p) => { bhPaused = !!p; };

  /* ── Sizing ───────────────────────────────────────────────── */
  // DPR capped at 1.0 — background visuals don't need retina sharpness,
  // and halving the pixel count noticeably reduces per-frame GPU work.
  let dpr = 1.0;
  function resize() {
    const w = Math.floor(window.innerWidth  * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  resize();
  window.addEventListener('resize', resize);

  /* ── Mouse parallax (very subtle) ─────────────────────────── */
  let mx = 0, my = 0, tmx = 0, tmy = 0;
  window.addEventListener('mousemove', e => {
    tmx = (e.clientX / window.innerWidth  - 0.5) * 2.0;
    tmy = -(e.clientY / window.innerHeight - 0.5) * 2.0;
  });

  /* ── Animation loop ───────────────────────────────────────── */
  const start = performance.now();
  let last = start;
  function frame(now) {
    resize();
    const t  = (now - start) / 1000;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // ease mouse
    mx += (tmx - mx) * Math.min(1, dt * 4);
    my += (tmy - my) * Math.min(1, dt * 4);

    // Skip the draw call when paused (e.g. a modal is open). The rAF
    // loop stays alive so resuming is instant; the only cost while
    // paused is one cheap callback per frame instead of a full pass.
    if (!bhPaused) {
      gl.uniform1f(uT, t);
      gl.uniform2f(uR, canvas.width, canvas.height);
      gl.uniform2f(uM, mx, my);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

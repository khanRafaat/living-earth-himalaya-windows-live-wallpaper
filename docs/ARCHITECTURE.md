# Living Earth Himalaya — architecture

## Why not Three.js / a mesh terrain
The handoff suggested Three.js. It was evaluated against a custom WebGL 2 pipeline:

| Need | Three.js mesh scene | Custom WebGL 2 (chosen) |
|---|---|---|
| 140° panorama across 3840 px without stretched edges | Perspective camera distorts badly beyond ~100°; needs cube-map stitching | Cylindrical projection per pixel — straight horizon, upright peaks on both monitors |
| Peaks 20–40 km away and individual trees 2 km away in one frame | Huge meshes + LOD system | Ray-marched height field: detail scales with distance automatically |
| Integrated GPU budget | Re-renders all geometry every frame | Camera never moves → expensive terrain work is done **once** |
| Offline, `file://`, no build step | Must vendor the library | No dependencies at all |

The deciding fact: **a wallpaper's camera never moves.** So the terrain is ray-marched one time into a G-buffer (normals, distance, albedo, ambient occlusion, snow fields). Every frame afterwards only re-lights that buffer, which is cheap enough for an Intel UHD 730 at 3840 × 1080.

## Frame pipeline
```
startup (once, in strips)   bake.js       G-buffer: 20+ octaves of terrain, individual conifers, AO, materials
when the sun moves 0.35°    shadow        soft terrain + tree shadows, double-buffered and cross-faded
~1 Hz                       transLUT      atmospheric transmittance (Rayleigh, Mie, ozone, Earth's shadow)
~1 Hz                       skyLUT        single-scattering sky radiance, lit by sun AND moon, plus airglow
every frame (40–50% res)    volume        clouds + valley mist/fog, temporally accumulated
10 Hz (64×18)               meter/adapt   camera-like auto exposure
every frame (full res)      composite     relight, aerial perspective, sky, moon, stars, cirrus, rain, snow, village lights, wind in the trees, tone map
every frame (instanced)     sprites       birds, chimney smoke, meteors, satellites — depth-tested against the bake
when due (4–30 Hz)          tree          bark and leaves into their own multisampled target, moved by the wind
every frame                 tree overlay  that target laid over the picture, with falling leaves before and after it
```

### Life (`engine/life.js` + `shaders/sprites.js`)
- A small CPU simulation (≤ 160 objects) writes one instance buffer per frame; the GPU draws each as a rotated quad.
- Birds are analytic silhouettes (anti-aliased signed-distance shapes) with flapping wings. Their 3D flight direction and bank angle decide how the wings foreshorten on screen. They are depth-tested against the terrain G-buffer, lit by the same sky and sun, and hazed by distance.
  - **Raptors:** glide in, circle a drifting thermal with a physically consistent bank angle, then leave. They need sun above ~14°, little cloud and modest wind.
  - **Chough flocks:** boids (cohesion, alignment, separation, wandering target) with flap-and-glide rhythm. Most frequent at dawn and dusk.
  - **Geese/cranes:** V-formation, heading south-west in autumn and north-east in spring; rare outside the migration seasons.
- Villages are part of the bake: forest is cleared, terraced fields follow the contours (faded where sub-pixel), and houses are placed on a 30 m jittered grid. Each lamp's exact screen position is projected in the bake and stored in G3; the composite applies a per-house schedule (staggered switch-on at dusk, most off 21:00–24:00, a few all night, early risers before dawn). Lamps dim with distance like real point lights.
- Chimney smoke sources are picked once after the bake from lit houses 1.5–12 km away. Plumes appear at breakfast and dinner times (more in winter) and lean with the crosswind.
- Meteors: a sporadic background plus seven annual showers (Gaussian activity around each peak date, scaled by radiant altitude computed through the star matrix). They streak away from the radiant and need sun below −12°, little moonlight and clear skies.
- Satellites appear only while the sun is 6–30° below the horizon (sunlit satellites against a dark sky).

### Terrain (`shaders/chunks.js → terrainBase`)
- Derivative-damped fBm (erosion-like valleys) + ridged multifractal spurs for the foothills.
- An arc of 7–8.5 km peaks ~20–28 km away, only in front of the viewer; lower hills behind so the low sun is not blocked.
- Earth curvature is applied, so distant ranges sink naturally.
- Conifers are real geometry within ~6.5 km: one cone per jittered 7.5 m cell, so ridgelines have tree silhouettes.
- Materials: strata-banded rock, seasonal grass colour (monsoon green → November gold → winter brown), forests with a few autumn trees, snow suitability by slope/aspect plus fluting on steep high faces.

### The rock (`shaders/ledge.js`)
A solid marched in the bake, not part of the height field, because its face is cut back under its top and a ray can pass beneath it. `rockBeds` gives tilted beds, each broken by joints into blocks that stand out or sit back; the ledges they make throw real shadows in the lighting pass. It is baked once like the land, so it adds nothing per frame. The grass on top is measured in screen pixels and not on the ground, because grass stands up: anything laid on the ground would be flattened into stripes by the low view.

### Light and sky
- The sky is physically based (Hillaire-style coefficients): blue noon, orange sunsets, deep ozone blue hour, purple twilight and the Earth's shadow all come from the same equations — no colour keyframes.
- Peaks receive light from the transmittance table at their own altitude, so they glow pink after the valleys are already in shadow (alpenglow).
- Exposure: an astronomical estimate (sun/moon level) plus a metered correction (geometric mean luminance of a 64×18 render), adapted over ~2.5 s.
- Sun and moon discs use the true apparent positions, including lunar parallax, and are shown only above the real horizon (the same rule used for the rise and set times in the panel), so nothing is faked into view.
- Stars are fixed to the celestial sphere and rotated by local sidereal time and latitude; the Milky Way follows the galactic plane. The moon disc is shaded by the real sun direction, so its phase and tilt are correct.

### Weather mapping (`engine/environment.js`)
The location's Open-Meteo data → visual targets:

| Input | Drives |
|---|---|
| cloud_cover_low, cloud_cover_mid, weather_code | deck coverage (`1 − (1 − low)(1 − mid)`), overcast greying, deck height and thickness. Records without layers use cloud_cover. |
| rain / showers / drizzle codes, precipitation | rain intensity, rain shafts, wet surfaces (dry slowly over ~40 min) |
| thunderstorm codes | darker clouds, lightning flashes |
| fog codes, visibility | sea of fog in the valleys, haze |
| relative humidity | valley mist (heavier around dawn) and haze |
| wind at 850 and 700 hPa | deck drift, weighted by how much cloud each layer holds. Records without upper winds use 10 m wind × 2.4. |
| wind at 300 hPa | cirrus drift |
| wind at 10 m and gusts | mist drift, rain slant, wind in the trees |
| snow codes / sub-zero precipitation | snowfall and a lowered snow line |
| cloud_cover_high | cirrus only, so thin high cloud is never drawn as a heavy low deck |

The `cloudSpeed` setting multiplies all drift: 1 is the real wind speed. Offsets wrap at periods that are a whole number of tiles of every noise they feed (5000 km for deck and mist, 6250 km for cirrus), so a wrap doesn't show.

**Weather changes** depend on what is changing. `transitionSeconds` (default 90 s) sets the overall pace.
- Each parameter has its own speed, one for rising and one for falling (`PACE`). Clouds clear more slowly than they build, and rain stops sooner than it starts.
- Pace follows the real wind, so strong wind brings change sooner and still air lets it linger. Storms arrive faster.
- `sequenceWeather` sets the order. Rain and snow wait for clouds, lightning waits for dark clouds, and the sky holds until the rain has eased.
- Two smoothing stages ease each change in and out. The gap between them drives `uCoverFront`, which leans cloud cover along the wind while a change plays out, so it arrives from upwind. The lean rises and falls smoothly back to zero.

**Wind in the trees** is shading, because real sway is under a pixel at this range. Noise bands stretched across the wind travel downwind at gust speed, out to 14 km. Crowns within ~4.5 km also sway in waves, mostly where a gust is passing, using a per-tree id baked into G3.a wherever G1.a > 0.5. Normals lean downwind, so the light responds to the sun's direction. Strength swings between the real mean wind and the real gust speed. The band direction is smoothed over ~5 minutes, because the pattern rotates about the viewer and would otherwise sweep quickly across distant slopes.

## Services
- `weather.js` — 15-minute refresh, one request at a time, wall-clock check for overdue data after sleep, `localStorage` cache, exponential back-off (2 → 30 min), refresh on reconnect, current → cached-forecast fallback, never invents data. A location change drops the old weather at once and discards any response still in flight.
- `astronomy.js` — sun/moon position, rise/set, golden & blue hour, twilight, moon phase, sidereal time. Pure functions. Compared with SunCalc it adds standard mean sidereal time, the sun's longitude of date, the moon's main orbit perturbations and lunar parallax. For Dhaka, sun times match the US Naval Observatory within half a minute and moon times within about 1.3 minutes (`tests/logic.test.mjs`).
- `location.js` — geolocation with an 8 s timeout and Dhaka fallback.
- `clock.js` — the only source of "now"; preview/time-lapse modes are labelled in the panel.

## Performance safeguards
- The brake: at most one frame in flight on the GPU. A fence ends every frame, and the next one waits until it signals, or 5 s if a driver never signals it. Frames are also spaced so the wallpaper takes at most `render.maxGpuShare` (75%) of the chip, whatever its speed. Every tab and the browser's own interface draw through the same GPU queue, so a queue that stays full feels like a hang with no crash and no error. `?debug=1` shows the measured time as "gpu N ms a frame", beside the test panel (`src/ui/debugpanel.js`), which has a slider for every scenario.
- `render.maxPixels` (4.2 million) caps the drawn size. A desktop larger than that is drawn smaller and scaled up.
- The tree costs as much as the landscape if drawn naively. The camera never moves, so `shellOfTree` leaves out every leaf and thin twig with six leaves in front of it, keeps the rest nearest first (the depth test then rejects what is behind before it is shaded), and leaves go before bark. It is redrawn only as often as something on it changes (`treeHz`), and the last picture is reused in between. Lighting that is the same for the whole tree is read back from a 7-pixel probe into uniforms, asynchronously, so nothing waits for the GPU.
- Frame cap (default 30 fps). Rendering pauses when hidden or when Lively reports playback paused. These are separate flags and a resume needs both to agree. While paused no animation frames are requested, and a 5 s timer keeps the panel current.
- Smart frame rate: 20 fps while only clouds, mist and light drift, full cap while birds, rain, snow, lightning, meteors or satellites are on screen (3 s hysteresis).
- Calm scene (`render.calmSceneMs`, 500 ms): with no rain, snow, lightning or time-lapse, the clouds and the composite run twice a second, into a kept picture, a band at a time. The screen shows a fade between the last two pictures, with the birds and the tree drawn over it at the full frame rate. A frame that takes too long on the GPU means more, thinner bands next time, so a new picture comes later and no single frame gets longer. A finished picture waits for the running fade to end, so nothing jumps. The Windows app's rest mode is the same thing with a scene every 2 s.
- Quality governor drops a level after sustained late frames, and climbs back when a frame's measured GPU time shows headroom. Without a GPU timer it retries the default level after 5 calm minutes, waiting longer each time a try fails. Levels change volumetric resolution, step counts and update rate. A quality change doesn't reset the exposure.
- Shaders compile in the background (`KHR_parallel_shader_compile`), so compiling itself doesn't block the page. A 1.8 s freeze was once measured during a cold start, cause not confirmed. Bake-shader loops start at `n + uZero` (a uniform that is always 0), which stops the Direct3D compiler from unrolling them. Cold compile on a UHD 730 dropped from ~5 min to ~20 s, with the same output (verified per pixel: at most one half-float step in normals/AO).
- Bake and shadow work run as tiles through `GpuPacer`: one tile in flight (fence), each sized to ~12 ms of GPU from timer queries (fallback: fence wall time). Daytime shadow refreshes use ~4 ms per frame. Never `gl.finish()`: in Chromium it is only a flush.
- The full-screen composite (4 bands) and volume (2 bands) passes are flushed band by band, so Windows can schedule the desktop's GPU work between them. Exposure metering runs at 10 Hz.
- All buffers are allocated once per resolution; no per-frame allocations. WebGL context loss is handled by rebuilding.
- Memory at 3840 × 1080: ≈ 120 MB of GPU buffers (G-buffer 100 MB, shadows 8 MB, volumetrics ~11 MB, look-up tables < 1 MB).

## Tests
Tests never use the GPU, so they can run while the PC is in use.
- `npm test` (`tests/logic.test.mjs`): plain Node with stubbed browser APIs. Weather service, cloud layers, wind on each layer, weather-change order and pace, tree wind, the quality governor, and sun and moon times against the US Naval Observatory.
- `npm run test:browser` (`tests/browser/`): the real page in headless Edge with software rendering, at 960×270 and below-normal priority. It refuses to load the wallpaper on anything but software rendering. Covers shader compilation, pause, settings, exposure, debug views, context loss, resizing during the bake, cloud wrap, gust direction and weather fronts. It uses a lot of CPU for a few minutes.
- Neither can measure speed on a real graphics chip, or how it looks in Lively.

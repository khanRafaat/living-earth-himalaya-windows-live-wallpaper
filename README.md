# Living Earth 3840 — v2.0

A living Himalayan panorama that spans both of your monitors (3840 × 1080).

> **Developed fully by an AI assistant.** All of the code, shaders, the Windows app, the tests and this documentation were written by an AI assistant ([Claude](https://www.anthropic.com/claude), working in [Claude Code](https://claude.com/claude-code)), directed and tested by its author, **Khan Rafaat Abtahe** ([februne.com](https://februne.com)). See [How it was made](#how-it-was-made).

- **Light follows the real sky.** The sun and moon are calculated for your location and your PC clock (updated twice a second), so sunrise, golden hour, sunset, blue hour and night happen at the true times. The moon shows its real phase, and the stars turn around the pole as the night goes on.
- **Real positions only.** The sun and moon are drawn exactly where they really are — and only when they are truly above your horizon and inside the part of the sky on screen. When they are elsewhere you still see their light (pink alpenglow, moonlit snow), but nothing is faked into view.
- **Weather follows your location.** Live data from Open-Meteo (free, no key) sets the mood of the mountain sky: cloud cover, rain, storms, fog, humidity mist and wind. That's Dhaka, unless Windows shares your location. The panel always names the place, so it is not presented as Himalayan weather.
- **Clouds move with the real wind.** Low, middle and high cloud each follow the live wind at their own height, at true speed. Real clouds look slow from a distance, so a time-lapse slider is there if you want more motion.
- **Weather changes play out naturally.** When the real weather changes, clouds build first and then the rain starts. Rain stops before the sky clears, and clearing takes longer than building. Lightning waits for dark clouds. A change arrives from the side the wind is coming from, sooner in strong wind and more slowly in still air, and storms roll in faster.
- **It keeps moving.** Clouds change shape, mist rolls through the valleys, rain falls, lightning flickers in storms.
- **It's alive.** Each of these follows the real clock, season and local weather:
  - **Vultures and eagles** circle in thermals on sunny, calm middays.
  - **Flocks of mountain choughs** swoop past the ridge, busiest after sunrise and before sunset.
  - **Geese and cranes** cross in V-formation during the real autumn and spring migrations.
  - Birds shelter in rain, fog, snow and storms, and roost at night.
  - **Wind in the trees.** Gusts travel across the forest and meadows in the real wind direction, with lulls between them from the real gust speed. Nearby trees move in waves as a gust passes. Still air leaves the forest still.
  - **A tree on the cliff edge.** A tree rhododendron stands on the rock at the left. Its trunk leans, its limbs sway and its leaves flutter with the live wind speed and direction, turning their pale undersides up in the gusts. It is lit by the real sun and moon, wet in rain, white in snow, and red with flowers in spring. Fallen leaves drift past on the wind, so you can see which way it blows and how hard.
  - **Hill villages** with terraced fields; wood smoke rises from chimneys at breakfast and dinner time.
  - **Village lights** come on one by one at dusk and mostly go out by late evening.
  - **Shooting stars** follow the real meteor-shower calendar (Leonids ~17 Nov, Geminids ~14 Dec, Perseids ~12 Aug, …) and need a dark, clear sky.
  - **Satellites** glide across the sky in twilight.
- **It works offline.** The last forecast is cached, so the scene stays honest without internet (the panel tells you what it is using).

---

## Set it up (about 5 minutes)

### Step 1 — Arrange your monitors in Windows
1. Right-click the desktop → **Display settings**.
2. Make sure **Display 2** is on the **left** and **Display 1** on the **right**, matching your desk. Drag the boxes if needed.
3. Line up the **top edges** of the two boxes exactly (otherwise a strip gets cut off).
4. Under *Multiple displays* choose **Extend these displays**.
5. Set **Scale** to the same value on both monitors (100% recommended).

### Step 2 — Install Lively Wallpaper
1. Open the **Microsoft Store**, search **Lively Wallpaper**, install it (free).
2. Open Lively once so it can finish setting itself up.

### Step 3 — Add Living Earth
1. In Lively, click the **+** (Add wallpaper) button.
2. Pick **`index.html`** in this folder (or a **`LivingEarth3840.zip`** made with `npm run zip`).
3. Living Earth now appears in your Lively library.

### Step 4 — Make it span both monitors
1. In Lively, open the **screen / display** selector (the monitor icon at the top of the library).
2. Choose **Span** (one wallpaper across all screens) — *not* "Per screen" or "Duplicate". (Lively's default is "Per screen", so check this.)
3. Click Living Earth to apply it.

The very first start prepares the graphics shaders and generates the mountains ("Preparing the renderer…", then "Shaping the mountains…"). This can take up to about two minutes and happens again only after a graphics-driver or Edge WebView2 update, or after the wallpaper itself is updated. Every other start takes about 15 seconds. Heavy work is split into small pieces so the desktop stays usable, but it may feel less smooth during the first start.

### Step 5 — Start with Windows and save power (recommended)
1. Lively → **Settings** → **General** → turn on **Start with Windows**.
2. Lively → **Settings** → **Performance**: set *When another app is fullscreen / maximised* to **Pause**. The wallpaper then stops drawing while you work in full-screen apps.
3. Optional, for the lowest resource use: also set *When another app is focused* to **Pause**. The wallpaper then rests (frozen on its last frame) whenever you work in any window, and comes alive again when you click the desktop.

That's it — nothing else needs to be clicked after this.

---

## Customise
Right-click Living Earth in Lively → **Customise**:

| Setting | What it does |
|---|---|
| Show information panel / position | Clock, date, phase of day, live sun/moon altitude and direction, local weather, sunrise/sunset and moonrise/moonset. Put it on either monitor. |
| Frame rate limit | 30 fps is smooth and light. 24 fps saves more power. |
| Save power when the scene is calm | On by default. Renders at 20 fps while only clouds, mist and light drift slowly, and at full speed whenever birds, rain, snow, lightning, shooting stars or satellites are on screen. Slow drift looks the same, and at the 30 fps limit it draws a third fewer frames. |
| Quality | **Auto** adapts to your GPU. Choose **Eco** if the PC feels busy, **High/Ultra** for richer clouds. |
| Render resolution | Lower it (85% / 75%) if Auto still struggles. |
| Looking toward | Which part of the real sky the panorama shows. **North-east** (default): the real sunrise appears behind the peaks on the right screen, the moon is seen when it rises in the east, and sunsets give pink alpenglow. **South** shows the sun and moon low in the southern sky in the morning and late afternoon. **West** shows the setting sun. |
| Landscape variation | A different mountain range (1 is the tuned default). |
| Cloud and mist speed | **1 = the real wind speed** (default). Higher values are a time-lapse. If you used this wallpaper before, Lively may keep your old value, so check that it's at 1. |
| Wind in the trees | How strongly wind shows in the forest and meadows. **1 = natural** (default), up to 3 for stronger, 0 for off. |
| Wildlife and village life | Birds, chimney smoke, village lights, shooting stars and satellites. Untick for a quieter scene. |
| Weather | **Live** normally. The *Preview* options let you see rain, fog, storms etc. on demand — the panel labels them as previews. |
| Demo: 24-hour time-lapse | Plays a full day in two minutes, to show off the transitions. Turn it off for real time. |
| Use Windows location | Uses your PC's location if Windows allows it; otherwise Dhaka. |
| Fetch weather now | Refreshes immediately instead of waiting for the 15-minute cycle. |

---

## If something looks wrong

| Problem | Fix |
|---|---|
| The same picture on both screens | In Lively choose **Span**, not "Duplicate" or "Per screen" (Step 4). |
| A strip is cut off / not aligned | Align the top edges of the monitors in Windows Display settings (Step 1). |
| Black screen with an error message | Update your Intel graphics driver (Intel Driver & Support Assistant), then restart Lively. |
| PC feels slow | First make sure *Save power when the scene is calm* is on and Lively pauses for maximised apps (Step 5). If it's still too heavy: Quality → **Eco**, Frame rate → **24 fps**, Render resolution → **85%**. |
| Long "Preparing the renderer…" | Normal on the very first start and after a graphics-driver or WebView2 update; the shaders are being compiled. Later starts are quick. |
| Panel says "Offline" | No internet — it is using the cached forecast. It updates by itself when you are back online. |
| Panel says "Waiting for weather…" | First run with no internet yet. The sky uses calm defaults until real data arrives. |
| A location permission prompt appears | Customise → turn off **Use Windows location**. Dhaka is then used directly. |
| No birds | Normal at night, in rain, fog or storms, and between visits — flocks come and go every few minutes. Vultures only soar when it is sunny and calm. |
| No sun or moon on screen | Normal when they are below the horizon or in a part of the sky that isn't in view (for example the high midday sun). They are never faked. |

---

## Testing in a normal browser (optional)
Open `index.html` in Chrome or Edge. Add settings to the address to preview, for example:

```
index.html?time=17:20                 a fixed time (sunset)
index.html?time=06:05&weather=fog     sunrise over a sea of fog
index.html?weather=storm              thunderstorm preview
index.html?timelapse=720              24 hours in 2 minutes
index.html?debug=1                    show FPS, quality level, sun/moon and wildlife counts
index.html?lifetest=1&test=1          start with birds already on screen
index.html?quality=eco&fps=24         force a quality level
index.html?smartfps=0                 always render at the frame-rate limit (no calm-scene saving)
index.html?clouds=5&trees=2           cloud time-lapse ×5, stronger wind in the trees
```
Weather names: `clear, partly, overcast, rain, heavyrain, storm, fog, snow`.

To develop with a local server instead of `file://`: `npm start`, then open http://localhost:8080.

---

## What's inside
```
index.html               page + information panel
LivelyInfo.json          Lively metadata
LivelyProperties.json    Lively "Customise" options
src/config.js            all defaults in one place
src/services/            clock, location, astronomy, weather (no rendering code)
src/engine/              WebGL 2 renderer, shaders, environment state, quality control
src/engine/life.js       birds, chimney smoke, meteors, satellites (simulation)
src/ui/overlay.js        the information panel
docs/ARCHITECTURE.md     how the renderer works and why
tests/                   checks that run without the GPU: npm test, npm run test:browser
```

---

## How it was made
Living Earth was developed fully by an AI assistant. [Claude](https://www.anthropic.com/claude), Anthropic's AI model, wrote every part of it in [Claude Code](https://claude.com/claude-code): the WebGL 2 renderer and its shaders (terrain, atmosphere, clouds, the tree), the weather and astronomy services, the bird and village life, the Windows app with its setup screen, the tests, and this README. Development worked in conversation: the author, Khan Rafaat Abtahe, set the goals, watched the result on a real two-monitor desktop, and pointed out what looked wrong, such as stuttering birds, noisy clouds, hard shadows at golden hour or seams in the rock. The assistant then found the cause and fixed it. Its checks run on the CPU only (software rendering), so testing never loads the graphics card the wallpaper runs on.

---

## Author
**Khan Rafaat Abtahe**
- Website: [februne.com](https://februne.com)
- Email: [rafaatabtahe@gmail.com](mailto:rafaatabtahe@gmail.com)
- GitHub: [@khanRafaat](https://github.com/khanRafaat)

Questions, ideas and bug reports are welcome: open an issue on GitHub or send an email.

Weather data: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). Sun and moon formulas adapted from SunCalc (BSD-2-Clause), with moon orbit terms from Meeus, *Astronomical Algorithms*.

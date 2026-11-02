# Earth Defence – Asteroid Splitter Command

A 2D physics game about planetary defence for curious kids (aimed at ~10-year-olds).
An asteroid is heading for Earth. You design a swarm of up to 10 penetrators – kinetic
impactors and nuclear devices – smash the asteroid apart, then watch what happens to
every fragment as it reaches the atmosphere: tiny pieces burn up like shooting stars,
pieces pushed sideways miss Earth, medium ones explode in the sky (Chelyabinsk / Tunguska)
and big ones make craters.

**Play it online: https://mkb23.github.io/earthdefence/**

On an iPad, open that link in Safari, tap Share → **Add to Home Screen**, and it opens
full-screen like an app.

## Running it

No build step and no dependencies. Open `index.html` in a browser (Chrome, Edge, Firefox or
Safari). It works straight from the file system; or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

Progress (stars, unlocked missions, logbook) is saved in the browser's localStorage, keyed by
mission id (older saves are migrated automatically).

## What's in the game

- **12 missions** that introduce one idea at a time, plus a **Sandbox** for free experiments.
- **Five asteroid types**: solid rock, rubble pile, Fluffball (hard core inside fluffy regolith),
  Piñata (hard shell around loose rubble) and iron.
- **Kinetic impactors** dig a crater (soft material is cheap to dig but soaks up energy), send
  cracks through the rock and get an *ejecta boost* (β) like NASA's DART.
- **Nuclear penetrators** with four fuses – 🖐️ Manual (time slows down and *you* press
  DETONATE), 📡 Standoff, 💥 Contact and ⛏️ Deep. A standoff burst pushes, a surface burst
  wastes most of its energy, and a buried burst shatters. Nukes are crushed by hard rock, so the
  best trick is the real HAIV idea: a kinetic "leader" digs a crater and a nuclear "follower"
  goes off inside it.
- **Launch delays and the 🔮 Mission computer**: any penetrator can wait before launching
  (a "second wave"). The mission computer re-runs the real, deterministic simulation of your
  plan in the background; drag its timeline slider to see a hologram of where every fragment
  will be, then click a piece to have the selected penetrator intercept it (it picks the launch
  time and aim for you). Manual nukes are previewed as if they went off on contact.
- **Deflection**: kinetic pushes scale with speed (momentum) but smashing scales faster
  (energy), so slow impactors nudge and fast ones shatter. Hitting from the side, early, can make
  an asteroid miss Earth entirely – "✓ will miss" markers show it live, and a run where nothing
  reaches the atmosphere scores a **Clean Deflection**. *Gentle Nudge* and *Heavy Metal* are built
  around this; *Second Wave* is built around delayed launches.
- **Atmospheric entry** classifies each fragment by size and material (iron survives better,
  fluff and rubble burn up more easily).
- **Science logbook** with 25 short, kid-friendly fact cards that unlock as you play.

## How the physics works (`js/physics.js`)

- Each asteroid is a set of Poisson-disc-sampled **Voronoi cells**, each with its own material,
  joined by **breakable bonds** along shared edges. Bond strength scales with edge length, so a
  crack costs the same per metre whatever the cell size.
- Each connected group of cells is a **rigid body** (position, angle, velocity, spin, mass,
  inertia) with impulse-based collisions between bodies via a spatial hash. Earth's gravity
  gently bends paths near the planet.
- **Impacts** crush cells along the impact path, apply a momentum push (× β), shock-break
  weak bonds nearby, run cracks through the bond network and, for high energy per kilogram,
  break the body up with a seeded fragmentation pattern. Every connected piece left becomes its own body,
  and pieces get flung apart with momentum conserved.
- **Nuclear blasts** measure how buried they are (ray-cast confinement) to get the energy
  coupling; a standoff burst instead vaporises a skin of rock and pushes bodies away.
- A ballistic **predictor** draws each penetrator's path, the ✕ hit point, a ghost of the
  asteroid at the moment of impact, and solves aiming when you click a spot on the asteroid.
- The **recorder** (mission computer) runs a copy of the world with the same seed, time-sliced
  across frames, storing every cell's position 30 times a second. Delayed penetrators are
  predicted against that recording, and an intercept solver aims them at a chosen fragment.
- Penetrators punch straight through tiny crumbs (pieces of one or two cells) so debris
  clouds can't shield the big chunks.

Balance knobs live in `K` at the top of `js/physics.js`, materials and missions in
`js/data.js`.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `css/style.css` | Page shell and UI styling |
| `js/data.js` | Materials, asteroid types, missions, outcomes, science facts |
| `js/physics.js` | Fracture physics engine and aim predictor |
| `js/render.js` | Canvas drawing (Earth, cached lit asteroid sprites, overlays) |
| `js/fx.js` | Particles, flashes, floating text |
| `js/audio.js` | Synthesised sound effects (WebAudio, no files) |
| `js/game.js` | Game flow, planning UI, simulation loop, menus, results |

## A note on realism

Everything is squeezed to fit on screen and slowed down: the atmosphere is drawn far thicker
than it really is, and kinetic impactors are much more effective than in real life so that
you can see them break things. Real defence missions would act years ahead, when a small
nudge is enough. The facts in the logbook (DART, Chelyabinsk, Tunguska, Meteor Crater,
Bennu, Psyche, HAIV…) are real.

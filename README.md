# Splinetopia
A little procedural city blockout tool that runs in the browser, built on three.js.

<img width="1488" height="808" alt="Screenshot 2026-09-15 at 07 03 26" src="https://github.com/user-attachments/assets/6d05f003-07e9-4b07-ad12-6a3e25bc99fb" />
<img width="1507" height="796" alt="Screenshot 2026-09-15 at 07 04 56" src="https://github.com/user-attachments/assets/4110beb5-9924-46c2-bb2b-1f418b1b16e1" />

**Live:** https://splinetopia.netlify.app/ · **Repo:** https://github.com/DoveCharles/splinetopia

## What it does

- **Roads** — draw road networks with poly or spline nodes, as one of three types:
  - **Sidewalk** — junctions merge into one clean outline with curbs and raised sidewalks
  - **Path** — a sandy track with a soft, speckled edge
  - **River** — water, joining any water zone it runs into

  Roads get lane markings, and junctions get zebra crossings and working traffic lights. Roads and paths crossing water become bridges.
- **Zones** — draw areas and pick a type:
  - **Buildings** — lots and procedurally generated towers, with shader-drawn windows that light up at night
  - **Park** — grass, trees and a perimeter fence
  - **Water** — an animated surface sunk below the ground, with sandy beaches where it meets a park
  - **Plaza** — tiled or herringbone paving, a fountain, lamp posts, benches and trees
  - **Farmland** — crop fields, hedgerows and farmsteads
  - **Industrial** — fenced lots with warehouses, factories, storage tanks and container yards
  - **Plain** — flat ground

  Roads cut through zones, and zones higher in the list cut into the ones below (drag to reorder).
- **Trains** — glass solenoid tubes on smooth 3D paths, with stations and a shuttle running the line.
- **People & traffic** — lil people walking the sidewalks and paths and gathering in plazas and parks, and cars driving the roads (toggle and tune them in World). People stop to wave and chat when they meet (taking turns to talk), sit down on plaza benches, sit around in circles on the grass talking, or lie down in a quiet corner of a park, and now and then have a scratch or a think while they stand about. Click someone in World mode and the camera follows them, with a card (and a live headshot) saying who they are — their names, moods, likes and dislikes come from `assets/people.txt`, so edit away.
- **World** — sun position or a day/night cycle (with a realistic sun path, moonlight and stars), weather (rain, snow, cloud shadows), ground and grid colors, save/load projects as JSON, and GLB (with materials) or OBJ export.
- **Undo/redo** — Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y), or the arrows at the top.
- **Windows 3.0 look** — the whole UI dresses up as Windows 3.0 (untick it in World for the modern look), and under it a Pixelation slider turns the 3D view to chunky pixels and a 16-colour palette checkbox redraws it in sixteen colours or fewer (Windows 3.0's, PICO-8's, CGA, Commodore 64, ZX Spectrum, Apple II, Mac OS, Sweetie 16, DawnBringer 16, Endesga 16, Game Boy or 1-bit), dithered in a pattern of your choice (ordered, blue noise, halftone and more). (Its pixel font is [“MS Sans Serif Bold” by lou](https://fontstruct.com/fontstructions/show/1384862), CC BY-SA 3.0, loaded from [98.css](https://github.com/jdan/98.css).)

<img width="1506" height="762" alt="Screenshot 2026-09-15 at 16 29 31" src="https://github.com/user-attachments/assets/840b062d-51ed-4a64-ad02-edf0852cc581" />


## Running it

Use the live site, or serve the repo folder locally and open it in a browser — for example:

```
python -m http.server 8000
```

then visit http://localhost:8000. (The app is made of JavaScript modules, which browsers won't load from a file opened straight from disk.) three.js and Clipper come from CDNs, so it needs an internet connection. Pushing to `main` redeploys the site on Netlify.

## How it's laid out

- `index.html`, `style.css` — the page and its styles
- `src/main.js` — startup and the render loop; it loads every other module in order
- `src/core/` — the scene, camera controls, math and spline helpers, and `shared.js` (state shared between modules)
- `src/roads/`, `src/trains/`, `src/water/`, `src/zones/`, `src/buildings/` — what gets built
- `src/editor/`, `src/ui/` — input, tools and the side panel
- `src/sky/`, `src/life/` — day/night and weather; people and traffic
- `src/project/` — save/load, undo/redo, GLB and OBJ export
- `assets/models/` — the Blender models (train carriage, person, hairstyles)

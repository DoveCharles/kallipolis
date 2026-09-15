# Splinetopia
A little procedural city blockout tool that runs in the browser — a single HTML file built on three.js.
<img width="1507" height="765" alt="Screenshot 2026-09-15 at 01 52 15" src="https://github.com/user-attachments/assets/f91fe7ea-cd2e-4b18-be13-8e46fc094d6a" />

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
- **People & traffic** — lil people walking the sidewalks and paths and gathering in plazas and parks, and cars driving the roads (toggle and tune them in World).
- **World** — sun position or a day/night cycle (with a realistic sun path, moonlight and stars), weather (rain, snow, cloud shadows), ground and grid colors, save/load projects as JSON, and GLB (with materials) or OBJ export.
- **Undo/redo** — Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y), or the arrows at the top.

## Running it

Open `blockout.html` in a browser (it loads three.js and Clipper from CDNs, so it needs an internet connection), or use the live site. Pushing to `main` redeploys the site on Netlify.

# Blockout

A little procedural city blockout tool that runs in the browser — a single HTML file built on three.js.

**Live:** https://lilblockout.netlify.app/

## What it does

- **Roads** — draw road networks with poly or spline nodes; junctions merge into one clean outline with curbs and raised sidewalks.
- **Zones** — draw areas and pick a type:
  - **Buildings** — lots and procedurally generated towers, with shader-drawn windows that light up at night
  - **Park** — grass and trees
  - **Water** — an animated water surface; where it meets a park, the park's edge turns to sand
  - **Plain** — flat ground

  Roads cut through zones, and zones higher in the list cut into the ones below (drag to reorder).
- **Trains** — glass solenoid tubes on smooth 3D paths, with stations and a shuttle running the line.
- **World** — sun position, ground and grid colors, save/load projects as JSON, and OBJ export.

## Running it

Open `blockout.html` in a browser (it loads three.js and Clipper from CDNs, so it needs an internet connection), or use the live site. Pushing to `main` redeploys the site on Netlify.

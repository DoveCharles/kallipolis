# Kallipolis

A city-building toy that runs in your browser. Draw roads and zones, and a city grows on them: towers, terraces, parks, farms, airports, bees, traffic and little people living their lives. Then follow them around, take control of them, or strike them down with lightning.

*Kallipolis* is Greek for "beautiful city", the ideal city Plato builds in the *Republic*. Yours needn't be ideal.

**Play:** https://kallipolis.netlify.app/ · **Repo:** https://github.com/DoveCharles/kallipolis

<img width="1488" height="808" alt="A city in Kallipolis" src="https://github.com/user-attachments/assets/6d05f003-07e9-4b07-ad12-6a3e25bc99fb" />
<img width="1507" height="796" alt="A city in Kallipolis" src="https://github.com/user-attachments/assets/4110beb5-9924-46c2-bb2b-1f418b1b16e1" />

## What you can do

**Build.** Edit mode has three tabs:
- **Paths**: roads with curbs and pavements, where junctions merge cleanly and get zebra crossings and working traffic lights. Also walkways, raised walkways on pillars, rivers, and glass train tubes with stations and shuttles. Any path can be sharp corners or smooth splines, and paths over water become bridges.
- **Zones**: city towers whose windows light up at night, plus parks, beaches, water, plazas, farmland, industrial yards, suburbs, British high streets and airports. Roads cut through zones, and zones higher in the list cut into the ones below.
- **Objects**: benches, lamp posts, statues, postboxes, phone boxes, market stalls, bins, bollards and more. Each one turns to face the street it's placed by.

You can also put a map image on the ground and trace over it.

**Watch.** People walk, chat, sit on benches and the grass, go to work, go home and watch TV. Cars drive the roads and mostly give way. Planes take off and land, bees tend their hives, and pigeons gather in plazas. Click anything to follow it: a card shows its name, mood, and what it loves and hates. You can step inside buildings and train carriages to see who's in there.

**Meddle.** Click a card's picture to take control. You can walk around as a person in first person (and punch people), drive a car, or fly a plane or a bee. You can also smite things with lightning. The city notices: a morality meter tracks how good or evil the place is, and every zone, building and death counts.

**Make it yours.** The people, cars, buildings, bees, trains and planes come from plain text files in `assets/text/` (people's in `assets/text/people/`, one file per list), so you can edit them. Entries can carry traits that change behaviour, like `Energy drinks [speed = 2.5]` or `Moonwalking [backwards]`. The full list is at the top of `assets/text/people/about.txt`, and what everything is worth morally is in `assets/text/morality.txt`.

**Set the scene.** There's a day/night cycle with a real sun path, moonlight and stars, plus rain, snow and cloud shadows, and sound for everything. The whole thing dresses as Windows 3.0. You can also pixelate the view and redraw it in a 16-colour palette (Windows 3.0, PICO-8, CGA, C64, ZX Spectrum, Game Boy and more) with dithering.

**Keep it.** Your city autosaves in the browser. You can save projects as files, and export the city as GLB (with materials) or OBJ for Blender, Unity and similar tools. Press F1 in the app for the full help.

<img width="1506" height="762" alt="Kallipolis at night" src="https://github.com/user-attachments/assets/840b062d-51ed-4a64-ad02-edf0852cc581" />

## Running it locally

No build step. The code is plain ES modules served from the repo root:

```
python3 serve.py 8000
```

Then open http://localhost:8000. `serve.py` turns off caching, so edits show up on reload. three.js and Clipper load from CDNs, so you need an internet connection. Pushing to `main` redeploys the site on Netlify.

## How it's laid out

- `index.html` is the page. `css/` holds the styles (base, win3, touch, phone, ped).
- `src/main.js` handles startup and the render loop.
- `src/core/` has the scene, camera, maths and spline helpers, and shared state.
- `src/roads/`, `src/trains/`, `src/water/`, `src/zones/`, `src/buildings/`, `src/objects/` and `src/maps/` build the city.
- `src/life/` has people, traffic, bees and pigeons. `src/sky/` has day/night and weather. `src/audio/` has the sound.
- `src/editor/` and `src/ui/` handle input, tools, windows and menus.
- `src/project/` has save/load, autosave, undo/redo and export.
- `assets/` holds the editable text files, the UI icons, and the Blender models in `models/`.
- `tools/` has the Blender scripts that build the models, plus a few test pages.

[`AGENT_MAP.md`](AGENT_MAP.md) describes every file.

## Credits

The pixel font is ["MS Sans Serif Bold" by lou](https://fontstruct.com/fontstructions/show/1384862), CC BY-SA 3.0, loaded from [98.css](https://github.com/jdan/98.css).

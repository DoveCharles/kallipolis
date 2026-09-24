import { openWindow } from './w3-window.js';

// ============================================================ help
// Help > Contents (or F1) opens the help the way Windows 3.0's did: a window of topics, each a page of what that part of
// Kallipolis is and how it works, jumped between by the green underlined links (a link is <a data-topic="id">), with
// Contents and Back along the top. Like the other little windows (ui/w3-window.js) it doesn't block anything, so the
// city can be tried as it's read about. The styles are in css/win3.css (.w3-help).
//
// Keep it in step with the app: the controls here are the ones in the bottom hints (editor/tools.js, objects/objects.js,
// life/possession.js) and the keys in editor/input.js.
const link = (id, text) => `<a href="#" data-topic="${id}">${text}</a>`;
const keys = rows => `<table class="w3-keys">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;

const TOPICS = [
  { id: 'contents', title: 'Contents', html: () => `
    <p>Kallipolis is a city blockout and life sim toy. Draw paths and zones, and a city grows on them — buildings, parks,
    water, traffic and people with lives of their own. (Kallipolis, Greek for “beautiful city”, is the ideal city
    Plato builds in the <i>Republic</i>; yours needn't be ideal.) Pick a topic:</p>
    <ul class="w3-help-list">${TOPICS.slice(1).map(t => `<li>${link(t.id, t.title)}</li>`).join('')}</ul>` },

  { id: 'modes', title: 'The three modes', html: () => `
    <p>The toolbar along the top switches between them:</p>
    <p><b>Edit</b> opens the side panel for building the city, with three tabs: ${link('paths', 'Paths')},
    ${link('zones', 'Zones')} and ${link('objects', 'Objects')}. Press Edit again to put the panel away.</p>
    <p><b>World</b> (the globe at the left of the icons) opens a window of the world's controls — time of day, people,
    traffic and weather (see ${link('settings', 'Settings')}). With the panel away, clicking the city
    ${link('following', 'follows')} whatever you click.</p>
    <p><b>Maps</b> (the icon at the right) is for ${link('maps', 'tracing over map images')}.</p>
    <p>The View menu does the same, and can hide the side panel or the toolbar altogether.</p>` },

  { id: 'camera', title: 'Moving the camera', html: () => `
    ${keys([
      ['Left-drag', 'Orbit (on empty ground, when editing)'], ['Shift+left-drag', 'Pan'], ['Middle-drag', 'Orbit (anywhere)'],
      ['Scroll', 'Zoom'], ['7 / 1 / 3', 'Look from the top / front / right'],
    ])}
    <p>View &gt; Orthographic (or its toolbar button) flattens the perspective, handy for tracing from the top. Zoom in
    far enough and the camera goes inside buildings, and the walls in the way fade out.</p>
    <p>View &gt; Full Screen (or double-click the title bar) fills the screen.</p>` },

  { id: 'paths', title: 'Paths', html: () => `
    <p>Edit &gt; Paths draws networks of nodes. The carousel of cards at the top picks the type you draw, and the list
    and the nodes on show are that type's alone:</p>
    <ul class="w3-help-list">
      <li><b>Road</b> — tarmac, curbs and pavements; junctions merge cleanly and get zebra crossings and traffic
      lights. Cars drive these.</li>
      <li><b>Walkway</b> — a footpath for people only.</li>
      <li><b>Raised walkway</b> — a walkway up on pillars, with ramps down at its ends.</li>
      <li><b>River</b> — water, joining any water zone it runs into.</li>
      <li><b>Train</b> — glass tubes on 3D paths, with stations and a shuttle running the line.</li>
    </ul>
    <p>Roads and walkways crossing water become bridges.</p>
    ${keys([
      ['Click ground', 'Place a node'], ['Click a node', 'Select its path'], ['Drag a node', 'Move it'],
      ['Double-click a node', 'Delete it'], ['Double-click ground / Enter', 'Finish the path'], ['Esc', 'Stop drawing'],
      ['Cmd+click a path', 'Insert a node'], ['Cmd+click a node', 'Branch off from it'],
      ['Right-click a node', 'Poly or Spline corner; a ramp on a raised walkway; a station on a train line'],
      ['Alt+drag (train)', 'Change only a node\'s height'],
    ])}` },

  { id: 'zones', title: 'Zones', html: () => `
    <p>Edit &gt; Zones draws areas. Pick a zone's type from the carousel of cards:</p>
    <ul class="w3-help-list">
      <li><b>City</b> — lots and towers, their windows lit at night.</li>
      <li><b>Plain</b> — flat ground.</li>
      <li><b>Park</b> — grass, trees and a fence; bees keep hives in them.</li>
      <li><b>Beach</b> — sand.</li>
      <li><b>Water</b> — sunk below the ground, with beaches where it meets a park.</li>
      <li><b>Plaza</b> — paving, a fountain, lamps, benches and trees.</li>
      <li><b>Farmland</b> — fields, hedgerows and farmsteads.</li>
      <li><b>Industrial</b> — fenced yards of warehouses, tanks and containers.</li>
      <li><b>Suburbs</b> — houses facing the nearest road, with lawns and hedges.</li>
      <li><b>Town</b> — a British town: brick and stucco terraces and shops wall to wall, with slate roofs and chimney pots.</li>
      <li><b>Airport</b> — runways and aircraft coming and going.</li>
    </ul>
    <p>Roads cut through zones, and a zone higher in the list cuts into the ones below it — drag the list to reorder.</p>
    ${keys([
      ['Click ground', 'Place a boundary point'], ['Click a point', 'Select its zone'], ['Drag a point', 'Move it'],
      ['Double-click a point', 'Delete it'], ['Click the first point / Enter', 'Close the zone'],
      ['Cmd+click an edge', 'Insert a point'], ['Esc', 'Stop drawing'],
    ])}` },

  { id: 'objects', title: 'Objects', html: () => `
    <p>Edit &gt; Objects places street furniture by hand: benches, lamp posts, a statue, postboxes, phone boxes, notice
    boards, market stalls, water towers, litter bins and bollards.</p>
    <p>Pick one from the palette and every click puts another down, until Esc or a right-click. Anything with a front
    turns to face the nearest road, walkway or zone edge.</p>
    ${keys([
      ['Click one', 'Select it'], ['Drag it', 'Move it'], ['Drag its ring', 'Turn it (Shift for 15° steps)'],
      ['Alt+drag', 'Copy it'], ['G / R / S', 'Move, turn or size it with the mouse; click to keep, right-click to undo'],
      ['Double-click / Delete', 'Delete it'],
    ])}
    <p>The panel has sliders for the selected one's turn and size.</p>` },

  { id: 'maps', title: 'Tracing a map', html: () => `
    <p>File &gt; Import Map Image puts a picture on the ground to trace over. In Maps mode:</p>
    ${keys([
      ['Click an image', 'Select it'], ['G / R / S', 'Move, rotate or scale it with the mouse'],
      ['Shift (rotating)', 'Snap to 90°'], ['Click / Enter', 'Keep the change'], ['Esc / right-click', 'Undo the change'],
    ])}
    <p>The Images list in the panel shows, hides and removes them.</p>` },

  { id: 'following', title: 'Following things', html: () => `
    <p>In World mode, click a person, car, train, aircraft, bee, hive or building and the camera follows it, with a card
    at the bottom right saying who or what it is: a name, a mood, what it loves and hates.</p>
    <ul class="w3-help-list">
      <li>Click the card's <b>picture</b> to ${link('control', 'take control')} of a person, car, aircraft or bee.</li>
      <li><b>Enter</b> goes inside a building or a train carriage; the people inside are listed, and clicking one
      follows them out.</li>
      <li><b>Smite</b> strikes it down with lightning. The city notices (see ${link('morality', 'Morality')}).</li>
      <li>The <b>heart</b> adds it to your favorites, listed under the ♥ in the toolbar; a hearted thing can't be smitten.</li>
    </ul>
    <p>Close the card, or click empty ground, to stop following.</p>` },

  { id: 'control', title: 'Taking control', html: () => `
    <p>Click the picture on a card to take over. Esc always lets go.</p>
    <p><b>A person</b> — first person, through their eyes:</p>
    ${keys([['W A S D', 'Walk'], ['Shift', 'Run'], ['Click', 'Punch'], ['Mouse', 'Look around']])}
    <p><b>A car</b>:</p>
    ${keys([['W / S', 'Drive forward / back'], ['A / D', 'Steer'], ['Shift', 'Boost'], ['Space', 'Brake'], ['Mouse / scroll', 'Look around / zoom']])}
    <p><b>An aircraft or a bee</b>:</p>
    ${keys([['W / S', 'Dive / climb'], ['A / D', 'Bank'], ['Shift', 'Power'], ['Space', 'Slow down']])}
    <p><b>A train</b> — Enter on its card takes a seat inside; drag to look around.</p>` },

  { id: 'people', title: 'People and their traits', html: () => `
    <p>People walk the pavements and walkways, stop to chat, sit on benches and the grass, go home, work in offices and
    watch TV. Cars drive the roads and give way to them — mostly.</p>
    <p>Who they are comes from text files in <b>assets/</b>: <b>people.txt</b> for names, moods, loves and hates, and
    cars.txt, buildings.txt, bees.txt, trains.txt and planes.txt for the rest. Any entry can carry traits in brackets
    that change how whoever gets it behaves:</p>
    <p class="w3-help-code">Energy drinks [speed = 2.5]<br>Moonwalking [backwards]</p>
    <p>The full list of traits is at the top of people.txt.</p>
    <p>View &gt; Ped View (the smiling head in the toolbar) greys out everything but the people, so you can see where the
    crowd is, indoors and out.</p>` },

  { id: 'morality', title: 'Morality', html: () => `
    <p>The meter at the right of the toolbar is how good or evil the city is: green to the right, red to the left. Every
    zone, path and building counts for something, and so does what happens — people getting killed, say. Each change
    pops up beside it for a moment.</p>
    <p>Click the meter to see what it's made of. What everything's worth is in <b>assets/morality.txt</b>.</p>` },

  { id: 'settings', title: 'Settings', html: () => `
    <p><b>World</b> (the globe in the toolbar): the sun, a day/night cycle and its length, how many people and cars and
    how fast, rain, snow and cloud shadows.</p>
    <p><b>Options &gt; Display</b>: UI scale, ground and grid colours, the colour grade, pixelation, a 16-colour palette
    with dithering, flat shading and toon characters.</p>
    <p><b>Options &gt; Effects</b>: gibs and particles, and how far and how many.</p>
    <p><b>Options &gt; Game</b>: how far off cars appear, first-person options, starting in Edit mode, and more.</p>
    <p><b>Options &gt; Sound Levels</b>: master, people, traffic and ambience. The speaker in the toolbar mutes it all.</p>
    <p>Options &gt; Snap to Grid snaps new nodes to the grid. View &gt; Edit Hints and General Hints turn off the tips
    along the bottom.</p>` },

  { id: 'saving', title: 'Saving and exporting', html: () => `
    <p>Your city, and where the camera is, saves itself in the browser as you go, so reloading picks up where you left
    off. File &gt; New clears it and starts again.</p>
    ${keys([
      ['File > Save (Ctrl+S)', 'Download the project as a file'], ['File > Open (Ctrl+O)', 'Load one'],
      ['File > Export GLB', 'The city as a 3D model with materials, for Blender, Unity and the like'],
      ['File > Export OBJ', 'The same, as plain geometry'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo (or the arrows in the toolbar)'],
    ])}` },

  { id: 'keys', title: 'Keyboard shortcuts', html: () => `
    ${keys([
      ['F1', 'Help'], ['Alt+letter', 'Open a menu'], ['Ctrl+Z', 'Undo'], ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'],
      ['Ctrl+S / Ctrl+O', 'Save / open a project'], ['7 / 1 / 3', 'View from the top / front / right'],
      ['Enter', 'Finish the path or zone being drawn'], ['Esc', 'Stop drawing; let go of what you control; leave a building'],
      ['Cmd+click', 'Insert a node into a path or zone edge, or branch off a path\'s node'], ['G / R / S', 'Move, turn or size the selected object or map image'],
      ['Delete', 'Remove the selected object'],
    ])}
    <p>See also ${link('camera', 'Moving the camera')} and ${link('control', 'Taking control')}.</p>` },
];
const topicOf = id => TOPICS.find(t => t.id === id) ?? TOPICS[0];

let turnTo = null; // while the help's open, turns it to a topic (so openHelp turns it rather than opening another)

/** Open the help at a topic (Contents if none), or turn the open help to it. */
export function openHelp(id = 'contents') {
  if (turnTo) { turnTo(id); return openWindow({ id: 'help' }); } // (brings it to the front)
  return openWindow({ id: 'help', title: 'Kallipolis Help', width: 460, resizable: true, onClose: () => { turnTo = null; }, fill: body => {
    body.classList.add('w3-help');
    body.innerHTML = `<div class="w3-help-buttons"><button class="btn" data-go="contents"><u>C</u>ontents</button><button class="btn" data-go="back"><u>B</u>ack</button></div><div class="w3-help-page"></div>`;
    const page = body.querySelector('.w3-help-page');
    const back = body.querySelector('[data-go=back]');
    const trail = []; // the topics read before this one, for Back
    let shown = null;
    const show = (topicId, remember = true) => {
      const topic = topicOf(topicId);
      if (remember && shown && shown !== topic.id) trail.push(shown);
      shown = topic.id;
      page.innerHTML = `<h3>${topic.title}</h3>${topic.html()}`;
      page.scrollTop = 0;
      back.disabled = !trail.length;
    };
    body.addEventListener('click', e => {
      const a = e.target.closest('[data-topic]'), b = e.target.closest('[data-go]');
      if (a) { e.preventDefault(); show(a.dataset.topic); }
      else if (b?.dataset.go === 'contents') show('contents');
      else if (b?.dataset.go === 'back' && trail.length) show(trail.pop(), false);
    });
    body.addEventListener('keydown', e => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Enter' && e.target.matches('a')) e.stopPropagation(); // (a link's Enter follows it, not closes the window)
      else if (e.key === 'c' || e.key === 'C') show('contents');
      else if ((e.key === 'b' || e.key === 'B') && trail.length) show(trail.pop(), false);
    });
    turnTo = show;
    show(id, false);
  } });
}

// F1 anywhere (the browser's own help is no use here) — but not on a phone, where the little windows don't show
window.addEventListener('keydown', e => {
  if (e.key !== 'F1' || !document.getElementById('app-frame')?.getClientRects().length) return;
  e.preventDefault();
  openHelp();
});

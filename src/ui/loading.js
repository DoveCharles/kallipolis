// The loading screen (#loading-screen, index.html): says what's being done and fills a bar as it goes.
// - Every fetch while loading is counted; models (.glb) are named on screen while pending (see watchBody), data files
//   aren't.
// - `loadingTask(text, promise, weight)`: named work of its own (see interior.js's warm-up), waited for like a fetch;
//   `weight` is how many fetches' worth of the bar it's given. `loadingSay(text)`: what the newest task's doing now.
// - The label is the newest pending model, else the newest pending task. While nothing new's come up for a moment it
//   flicks through the other models ("Unpacking X") — a little faked, but they're all being set up around then (see
//   flick) — and the bar creeps toward the next step. Neither can move while the page is frozen.
// - Models load before the city's built (`waitForModels`, `modelsLoaded`), so it's built once.
// - Keeping freezes short: models are handed over to be unpacked one a frame (`takeTurn`), and nothing's drawn while
//   loading — the scene's shaders are compiled in the background instead (`compileWhileLoading`, called by main.js).
// - `whenLoaded(run)`: runs once the page has loaded, nothing's been pending for a couple of frames and the scene's
//   compiled, or after GIVE_UP_AFTER regardless (view-prefs.js takes the screen away then).
// - Once done, the console lists how long the page was frozen under each step: what to speed up.
const screen = document.getElementById('loading-screen');
const label = screen.querySelector('.ls-text');
const fill = screen.querySelector('.ls-fill');

const GIVE_UP_AFTER = 60000, UNREAD_AFTER = 20000; // ms
const IDLE_TEXT = 'Starting...';
const isModel = name => /\.(glb|gltf)$/i.test(name);
let started = 0, finished = 0, shownShare = 0, loaded = false;
const fetches = new Set(), tasks = new Set();

// ---------------------------------------------------------------- label and bar
const newest = (set, pass = () => true) => { let last = null; for (const item of set) if (pass(item)) last = item; return last; };
const doing = [{ at: 0, text: IDLE_TEXT }]; // what's being done (data files too) and since when, to put frozen time down to
let labelAt = 0;
function nowDoing(text) { if (text !== doing.at(-1).text) doing.push({ at: performance.now(), text }); }
function showLabel() {
  nowDoing((newest(fetches) ?? newest(tasks))?.text ?? IDLE_TEXT);
  const text = (newest(fetches, item => item.model) ?? newest(tasks))?.text;
  if (text && text !== label.textContent) { label.textContent = text; labelAt = performance.now(); }
}
export function loadingSay(text) {
  const task = newest(tasks);
  if (task) { task.text = text; showLabel(); }
}

// Flicking through names, while fetching: pending models and every model in so far. And the bar creeps on between real
// steps, up to just short of the next one.
const FLICK_EVERY = 30, FLICK_AFTER = 60; // ms
const CREEP = 0.04;                       // of the way to the next step, each flick
const models = [];
let flicks = 0;
const flick = setInterval(() => {
  creep();
  if (performance.now() - labelAt < FLICK_AFTER) return;
  const pool = [...fetches].filter(item => item.model).map(item => item.text);
  if (fetches.size) pool.push(...models.map(name => `Unpacking ${name}...`));
  if (tasks.size && !fetches.size) pool.push(newest(tasks).text);
  if (pool.length < 2) return;
  label.textContent = pool[flicks++ % pool.length];
}, FLICK_EVERY);
function creep() {
  if (!started || shownShare >= 1) return;
  const next = Math.min(0.95, (finished + 0.9)/started);
  if (shownShare < next) setBar(shownShare + (next - shownShare)*CREEP);
}
function setBar(share) {
  shownShare = share;
  fill.style.width = `${(share*100).toFixed(1)}%`;
}
function advance() {
  setBar(Math.max(shownShare, started ? Math.min(0.95, finished/started) : 0)); // (never back; full only when done)
}

// `settled` resolves when it's finished with; `item` is its label, which can change meanwhile.
function track(set, item, settled, weight = 1) {
  set.add(item); started += weight;
  showLabel(); advance();
  const done = () => { set.delete(item); finished += weight; showLabel(); advance(); };
  settled.then(done, done);
}

// ---------------------------------------------------------------- fetches
// A fetch is "Loading" till its body's all in (read whole, or streamed to the end as three's FileLoader does), then
// "Unpacking" till the tick after, so whatever parses it straight away is counted under its name. A model's body is
// only handed over on its turn: one a frame, so their unpacking's spread out rather than all in one long freeze.
let turns = Promise.resolve();
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
const takeTurn = () => (turns = turns.then(nextFrame));

const fileName = url => decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop() || String(url));
const realFetch = window.fetch.bind(window);
const bodyOf = Object.getOwnPropertyDescriptor(Response.prototype, 'body').get;
function watchBody(response, model, arrived) {
  const handOver = value => (model ? takeTurn() : Promise.resolve()).then(() => { arrived(); return value; });
  for (const read of ['arrayBuffer', 'text', 'json', 'blob']) {
    const real = response[read].bind(response);
    response[read] = () => real().then(handOver, err => { arrived(); throw err; });
  }
  Object.defineProperty(response, 'body', { get() {
    const body = bodyOf.call(response);
    if (body && !body.watched) {
      body.watched = true;
      const getReader = body.getReader.bind(body);
      body.getReader = (...args) => {
        const reader = getReader(...args), readNext = reader.read.bind(reader);
        reader.read = () => readNext().then(chunk => chunk.done ? handOver(chunk) : chunk);
        return reader;
      };
    }
    return body;
  } });
}
window.fetch = (input, init) => {
  const name = fileName(input?.url ?? input), model = isModel(name);
  if (model) models.push(name);
  const item = { text: `Loading ${name}...`, model };
  let finish;
  const settled = new Promise(resolve => { finish = resolve; });
  const arrived = () => { item.text = `Unpacking ${name}...`; showLabel(); setTimeout(finish, 0); };
  const fetched = realFetch(input, init);
  fetched.then(response => { if (response.ok) watchBody(response, model, arrived); else finish(); }, finish);
  setTimeout(finish, UNREAD_AFTER); // (a body nobody reads)
  track(fetches, item, settled);
  return fetched;
};

export function loadingTask(text, promise, weight = 1) {
  track(tasks, { text }, promise, weight);
  return promise;
}

// ---------------------------------------------------------------- models before the city
// main.js hands over its model loads (`waitForModels`); autosave.js waits on `modelsLoaded` before building the city,
// so it's built once with the real models — not with stand-ins, then again for each model as it arrives (airports,
// plazas, suburbs, statues all rebuild then). Given up on after MODELS_WAIT, so a stuck load can't hold the city back.
const MODELS_WAIT = 30000; // ms
let modelsIn;
export const modelsLoaded = new Promise(resolve => { modelsIn = resolve; });
setTimeout(() => modelsIn(), MODELS_WAIT);
export function waitForModels(loads) {
  loadingTask('Setting up models...', Promise.allSettled(loads).then(() => modelsIn()), 0);
}

// ---------------------------------------------------------------- the scene, compiled rather than drawn
// Drawing compiles every material it hasn't met yet then and there, freezing the page till the driver's done. Under
// the screen nothing needs drawing, so main.js calls this instead of drawing: compileAsync lets the driver compile in
// the background (KHR_parallel_shader_compile, where the browser has it), polling till the shaders are ready.
const COMPILE_EVERY = 250; // ms between passes, to pick up what's been added since
let compileScene = null, compiling = null, compiledAt = -Infinity;
export const stillLoading = () => !loaded;
export function compileWhileLoading(renderer, scene, camera) {
  compileScene ??= () => renderer.compileAsync(scene, camera).catch(err => console.warn('Splinetopia: compile failed', err));
  if (compiling || performance.now() - compiledAt < COMPILE_EVERY) return;
  compiling = timedCompile().finally(() => { compiling = null; compiledAt = performance.now(); });
}
// (compileAsync starts every new shader before it returns: that part's timed as a step of its own)
function timedCompile() {
  const was = doing.at(-1).text;
  nowDoing('Compiling shaders');
  const done = compileScene();
  nowDoing(was);
  return done;
}

// ---------------------------------------------------------------- where the time went
const frozenBy = new Map(); // step → ms frozen while it was being done
// the step under way for most of the time from `from` to `to` (steps change mid-task, and the page isn't redrawn till it ends)
function mostlyDoing(from, to) {
  let best = IDLE_TEXT, longest = -1;
  doing.forEach((s, i) => {
    const overlap = Math.min(to, doing[i + 1]?.at ?? Infinity) - Math.max(from, s.at);
    if (overlap > longest) { longest = overlap; best = s.text; }
  });
  return best;
}
// Frozen time is measured from the gaps between animation frames (long-task reports aren't in every browser): the first
// gap is every module being set up and main.js starting things off; later ones go to the step under way longest.
const FRAME_MS = 1000/60, FROZEN_AFTER = 50; // ms: a gap longer than this counts, less one frame
const scriptsIn = performance.now(); // (how long the page and its scripts took to arrive)
let lastFrame = scriptsIn, measuring = true;
function countFrame(now) {
  if (!measuring) return;
  const gap = now - lastFrame;
  if (gap > FROZEN_AFTER) {
    const text = lastFrame === scriptsIn ? 'Setting up scripts' : mostlyDoing(lastFrame, now);
    frozenBy.set(text, (frozenBy.get(text) ?? 0) + gap - FRAME_MS);
  }
  lastFrame = now;
  requestAnimationFrame(countFrame);
}
requestAnimationFrame(countFrame);
function report() {
  measuring = false;
  const lines = [...frozenBy].sort((a, b) => b[1] - a[1]).map(([step, ms]) => `  ${String(Math.round(ms)).padStart(6)} ms  ${step}`);
  console.info([`Splinetopia: loaded in ${Math.round(performance.now())} ms (scripts arrived at ${Math.round(scriptsIn)} ms); frozen time by step:`,
    ...lines].join('\n'));
}

// ---------------------------------------------------------------- done
export function whenLoaded(run) {
  let quietFrames = 0;
  // Drawing starts a few frames before the screen lifts, so the first frames' hitch (shadows, post-processing, anything
  // not compiled yet) happens behind it rather than in the middle of its fade.
  const FRAMES_BEHIND = 3;
  const finish = () => {
    loaded = true;
    window.fetch = realFetch;
    clearInterval(flick);
    setBar(1); label.textContent = 'Ready';
    let frames = 0;
    const lift = () => {
      if (++frames < FRAMES_BEHIND) { requestAnimationFrame(lift); return; }
      report();
      run();
    };
    nowDoing('First frames');
    requestAnimationFrame(lift);
  };
  const check = () => {
    quietFrames = fetches.size === 0 && tasks.size === 0 ? quietFrames + 1 : 0;
    if (quietFrames < 2 && performance.now() < GIVE_UP_AFTER) { requestAnimationFrame(check); return; }
    if (!compileScene || performance.now() >= GIVE_UP_AFTER) { finish(); return; }
    // (one last pass, for whatever's come in since the last)
    loadingTask('Preparing the city...', (compiling ?? Promise.resolve()).then(timedCompile)).then(finish);
  };
  const begin = () => requestAnimationFrame(check);
  if (document.readyState === 'complete') begin(); else window.addEventListener('load', begin, { once: true });
}

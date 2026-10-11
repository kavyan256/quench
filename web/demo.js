import { simulate, compare, DEFAULTS } from './core/sim.js';
import { escape } from './api.js';

const $ = (id) => document.getElementById(id);
const PLAY_MS = 30000; // the whole evening plays in 30 seconds
const GROUPS = {
  typical: { lastJarMessageRate: 0.6, readDelayMin: 4 },
  disciplined: { lastJarMessageRate: 1, readDelayMin: 2 },
};
const RUNNER_COLOURS = ['#e8590c', '#7c3aed', '#2563eb', '#db2777', '#0891b2'];

// Map: the storeroom in the middle; by default every station on a ring, DEFAULTS.tripMin minutes away.
const CENTRE = { x: 350, y: 285 };
const RING = 190;
const PX_PER_MIN = RING / DEFAULTS.tripMin;
const BOUNDS = { x0: 115, x1: 605, y0: 80, y1: 480 }; // inside the visible map, room for names
const STAGE = [2, 3]; // the two stations next to the stage

const ringLayout = () =>
  DEFAULTS.stations.map((_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / DEFAULTS.stations.length;
    return { x: CENTRE.x + RING * Math.cos(a), y: CENTRE.y + RING * Math.sin(a) };
  });
let layout = ringLayout();

const walkMin = (p) => Math.max(2, Math.round(Math.hypot(p.x - CENTRE.x, p.y - CENTRE.y) / PX_PER_MIN));
const stations = () => DEFAULTS.stations.map((s, i) => ({ ...s, tripMin: walkMin(layout[i]) }));

const settings = () => ({
  ...GROUPS[$('group').value],
  tapRate: Number($('tapRate').value),
  runners: Number($('runners').value),
  seed: Math.max(1, Number($('seed').value) || 1),
  stations: stations(),
});
const clock = (t) => {
  const m = 18 * 60 + Math.floor(t);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// People around a station: fixed spots per station so dots don't jump between frames.
const spots = DEFAULTS.stations.map((_, i) => {
  let a = (i + 1) * 2654435761;
  const r = () => ((a = (Math.imul(a ^ (a >>> 13), 1103515245) + 12345) >>> 0) / 4294967296);
  return Array.from({ length: 16 }, () => ({ a: r() * Math.PI * 2, d: 40 + r() * 16 }));
});

function runnerAt(trips, k, t) {
  const trip = trips.find((x) => x.runner === k && x.leave <= t && t < x.back);
  if (!trip) return null;
  const out = t < trip.arrive;
  const f = out ? (t - trip.leave) / (trip.arrive - trip.leave) : 1 - (t - trip.arrive) / (trip.back - trip.arrive);
  return { station: trip.station, f, jars: trip.jars, out };
}

function draw(svg, run, t, isQuench) {
  const frame = run.frames[Math.min(run.frames.length - 1, Math.floor(t))];
  const walks = run.config.stations.map((s) => s.tripMin);
  let s = '';
  // Stage, beside the two stage stations, pushed outwards.
  const mid = { x: (layout[STAGE[0]].x + layout[STAGE[1]].x) / 2, y: (layout[STAGE[0]].y + layout[STAGE[1]].y) / 2 };
  const len = Math.hypot(mid.x - CENTRE.x, mid.y - CENTRE.y) || 1;
  const stage = {
    x: Math.min(590, Math.max(130, mid.x + ((mid.x - CENTRE.x) / len) * 70)),
    y: Math.min(540, Math.max(50, mid.y + ((mid.y - CENTRE.y) / len) * 70)),
  };
  const onStage = t >= DEFAULTS.peakFrom && t < DEFAULTS.peakTo;
  s += `<g transform="translate(${stage.x} ${stage.y})"><rect class="m-stage${onStage ? ' live' : ''}" x="-40" y="-15" width="80" height="30" rx="6"/><text class="m-stage-t" y="5">STAGE${onStage ? ' ♪' : ''}</text></g>`;
  // Paths with walking times.
  layout.forEach((p, i) => {
    s += `<line class="m-path" x1="${CENTRE.x}" y1="${CENTRE.y}" x2="${p.x}" y2="${p.y}"/>`;
    s += `<text class="m-min" x="${(CENTRE.x + p.x) / 2}" y="${(CENTRE.y + p.y) / 2 - 6}">${walks[i]} min</text>`;
  });
  // Stations.
  frame.stations.forEach((st, i) => {
    const p = layout[i];
    const state = st.dry ? 'dry' : st.spare === 0 ? 'last' : 'ok';
    const people = Math.min(16, Math.max(3, Math.round(st.lph / 9)));
    for (let k = 0; k < people; k++) {
      const q = spots[i][k];
      s += `<circle class="m-person${st.dry ? ' waiting' : ''}" cx="${p.x + q.d * Math.cos(q.a)}" cy="${p.y + q.d * Math.sin(q.a)}" r="3.2"/>`;
    }
    if (isQuench && st.alert && !st.dry) s += `<circle class="m-alert" cx="${p.x}" cy="${p.y}" r="36"/>`;
    const lv = st.dry ? 0 : st.level;
    s += `<g class="m-station" data-st="${i}"><clipPath id="${svg.id}c${i}"><circle cx="${p.x}" cy="${p.y}" r="28"/></clipPath>`;
    s += `<circle class="m-st ${state}" cx="${p.x}" cy="${p.y}" r="28"/>`;
    s += `<rect class="m-water" x="${p.x - 28}" y="${p.y + 28 - 56 * lv}" width="56" height="${56 * lv}" clip-path="url(#${svg.id}c${i})"/>`;
    s += `<circle class="m-ring ${state}" cx="${p.x}" cy="${p.y}" r="28"/>`;
    if (st.dry) s += `<text class="m-dry" x="${p.x}" y="${p.y + 5}">DRY</text>`;
    const jars = Math.min(st.spare, 8);
    for (let j = 0; j < jars; j++) s += `<rect class="m-jar" x="${p.x - (jars * 9) / 2 + j * 9 + 1}" y="${p.y + 34}" width="7" height="10" rx="1.5"/>`;
    if (state === 'last') s += `<text class="m-last" x="${p.x}" y="${p.y + 45}">last jar</text>`;
    s += `<text class="m-name" x="${p.x}" y="${p.y + 64}">${escape(DEFAULTS.stations[i].name)}</text></g>`;
  });
  // Runners: walking out with jars, or walking back.
  for (let k = 0; k < run.config.runners; k++) {
    const r = runnerAt(run.trips, k, t);
    const colour = RUNNER_COLOURS[k % RUNNER_COLOURS.length];
    if (!r) {
      const x = CENTRE.x - 30 + k * 15;
      s += `<rect x="${x - 6}" y="${CENTRE.y + 28}" width="12" height="12" rx="3" fill="${colour}" opacity="0.7"/>`;
      continue;
    }
    const p = layout[r.station];
    const x = CENTRE.x + (p.x - CENTRE.x) * r.f;
    const y = CENTRE.y + (p.y - CENTRE.y) * r.f;
    s += `<rect class="m-runner" x="${x - 13}" y="${y - 13}" width="26" height="26" rx="5" fill="${colour}"/><text class="m-runner-t" x="${x}" y="${y + 4.5}">${r.out ? r.jars : '↩'}</text>`;
  }
  // Storeroom, on top: runners walk into it.
  s += `<rect class="m-store" x="${CENTRE.x - 38}" y="${CENTRE.y - 22}" width="76" height="44" rx="8"/><text class="m-store-t" x="${CENTRE.x}" y="${CENTRE.y + 5}">STORE</text>`;
  svg.innerHTML = s;
}

let runs = null;
// ?t=118 opens the evening at that minute (handy for screenshots and the video).
const startAt = Number(new URLSearchParams(location.search).get('t'));
let t = Number.isFinite(startAt) && startAt > 0 ? Math.min(startAt, DEFAULTS.minutes - 1) : DEFAULTS.minutes - 1;
let playing = false;
let last = 0;

function show() {
  if (!runs) return;
  draw($('mapW'), runs.w, t, false);
  draw($('mapQ'), runs.q, t, true);
  const f = Math.min(DEFAULTS.minutes - 1, Math.floor(t));
  $('dryW').textContent = `${runs.w.frames[f].dryMinutes} dry min`;
  $('dryQ').textContent = `${runs.q.frames[f].dryMinutes} dry min`;
  $('dryW').classList.toggle('bad', runs.w.frames[f].dryMinutes > runs.q.frames[f].dryMinutes);
  $('dryQ').classList.toggle('bad', runs.q.frames[f].dryMinutes > runs.w.frames[f].dryMinutes);
  $('clock').innerHTML = `<strong>${clock(t)}</strong>${t >= DEFAULTS.peakFrom && t < DEFAULTS.peakTo ? ' · headliner on stage' : ''}`;
  $('scrub').value = f;
}

function rerun() {
  const s = settings();
  runs = { w: simulate('whatsapp', s), q: simulate('quench', s) };
  show();
}

function averages() {
  const { seed, ...rest } = settings();
  const c = compare(rest, 20);
  $('avg').innerHTML = `<div><div class="big">${c.whatsapp}</div><div class="small">dry station-minutes, WhatsApp (average)</div></div>
    <div><div class="big">${c.quench}</div><div class="small">dry station-minutes, Quench (average)</div></div>`;
  $('verdict').textContent =
    c.quench < c.whatsapp * 0.8
      ? `With these settings Quench cut dry minutes by about ${Math.round((1 - c.quench / Math.max(1, c.whatsapp)) * 100)}%.`
      : c.quench <= c.whatsapp
        ? 'With these settings Quench is only slightly better. It depends on volunteers tapping.'
        : 'With these settings the WhatsApp group does as well or better. Quench only helps when most swaps are tapped.';
}

function setPlaying(on) {
  playing = on;
  $('play').textContent = on ? '❚❚ Pause' : '▶ Play';
  if (on) {
    if (t >= DEFAULTS.minutes - 1) t = 0;
    last = performance.now();
    requestAnimationFrame(tick);
  }
}
function tick(now) {
  if (!playing) return;
  t += ((now - last) / PLAY_MS) * DEFAULTS.minutes;
  last = now;
  if (t >= DEFAULTS.minutes - 1) {
    t = DEFAULTS.minutes - 1;
    show();
    setPlaying(false);
    return;
  }
  show();
  requestAnimationFrame(tick);
}

$('play').addEventListener('click', () => setPlaying(!playing));
// For recording the video frame by frame: jump to any (fractional) minute of the evening.
window.quenchSimSeek = (minute) => {
  setPlaying(false);
  t = Math.min(DEFAULTS.minutes - 1, Math.max(0, minute));
  show();
};
$('scrub').addEventListener('input', () => {
  setPlaying(false);
  t = Number($('scrub').value);
  show();
});
for (const id of ['group', 'tapRate', 'runners', 'seed']) $(id).addEventListener('change', () => {
  rerun();
  averages();
});

// Dragging a station moves it on both maps; the evening reruns when it is dropped.
function svgPoint(svg, e) {
  const pt = svg.createSVGPoint();
  pt.x = e.clientX;
  pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
for (const svg of [$('mapW'), $('mapQ')]) {
  let dragging = null;
  svg.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('[data-st]');
    if (!g) return;
    dragging = Number(g.dataset.st);
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('dragging');
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (dragging === null) return;
    const p = svgPoint(svg, e);
    let x = Math.min(BOUNDS.x1, Math.max(BOUNDS.x0, p.x));
    let y = Math.min(BOUNDS.y1, Math.max(BOUNDS.y0, p.y));
    const d = Math.hypot(x - CENTRE.x, y - CENTRE.y);
    const min = 2 * PX_PER_MIN + 20;
    if (d < min) {
      x = CENTRE.x + ((x - CENTRE.x) / (d || 1)) * min;
      y = CENTRE.y + ((y - CENTRE.y) / (d || 1)) * min;
    }
    layout[dragging] = { x, y };
    show(); // live preview of the new position and walking time
    for (const m of [$('mapW'), $('mapQ')]) {
      const label = m.querySelectorAll('.m-min')[dragging];
      if (label) label.textContent = `${walkMin(layout[dragging])} min`;
    }
  });
  const drop = () => {
    if (dragging === null) return;
    dragging = null;
    svg.classList.remove('dragging');
    $('resetMap').hidden = false;
    rerun();
    averages();
  };
  svg.addEventListener('pointerup', drop);
  svg.addEventListener('pointercancel', drop);
}
$('resetMap').addEventListener('click', () => {
  layout = ringLayout();
  $('resetMap').hidden = true;
  rerun();
  averages();
});

// Phones show one map at a time.
for (const [id, which] of [['showW', 'whatsapp'], ['showQ', 'quench']]) {
  $(id).addEventListener('click', () => {
    $('maps').dataset.show = which;
    $('showW').setAttribute('aria-selected', String(which === 'whatsapp'));
    $('showQ').setAttribute('aria-selected', String(which === 'quench'));
  });
}

$('assumptions').innerHTML = [
  `Demand per station: ${DEFAULTS.stations.map((s) => `${s.name} ${s.baseLph} L/hr`).join(', ')}; ±${DEFAULTS.noise * 100}% hour to hour; stage stations ×${DEFAULTS.stations[2].peak} during the headliner.`,
  `Each station starts with ${DEFAULTS.startJars} full 20 L jars. The WhatsApp lead sends ${DEFAULTS.jarsPerTrip} jars every time; Quench sends what the app would (about 2 hours of water, 2–6 jars).`,
  `Walking times come from the map: on the default ring every station is ${DEFAULTS.tripMin} minutes from the storeroom. Drag a station and its walk changes for both sides.`,
  'Everyone notices an empty station: in both worlds it is reported and handled after the read delay.',
  `Quench checks every 2 minutes and sends runners to the stations that will run dry soonest (that station's walk + 10 min). Its plan is off by up to ±${DEFAULTS.planError * 100}%, so measured swap times matter.`,
  'A "dry minute" is one station without water for one minute. Numbers are from this model only, not from a real event.',
].map((x) => `<li>${escape(x)}</li>`).join('');

rerun();
averages();

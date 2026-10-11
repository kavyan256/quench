// Event hub: Set up (checklist), Live (board), Summary.
import { api, escape, param, clockTime, dayTime } from './api.js';
import { organiserKey, organiserLink, rememberEvent } from './store.js';
import { boardMarkup } from './liveboard.js';
import { mountSummary } from './summary-view.js';
import { shareText, copyText, downloadReminder } from './share.js';
import { mountArt, svg } from './art.js';
import { maybeTour, startTour } from './onboarding.js';
import './auth.js'; // sends the signed-in organiser's token, so the owner can edit from any device

const $ = (id) => document.getElementById(id);
const eventId = param('e');
const key = organiserKey(eventId);
// The organiser link's key, or (after loading) the signed-in owner's account. See applyEditMode().
let canEdit = Boolean(key);
const POLL_MS = 5000;
const STALE_MS = 30000;

let data = null;
let lastOk = 0;
let tab = ['setup', 'live', 'summary'].includes(param('tab')) ? param('tab') : 'setup';
let summaryLoaded = false;

const nf = (n) => Number(n).toLocaleString('en-IN');
// An order is for the whole event: round the total, not each station.
const orderTotals = (t) => ({ jarsLow: Math.ceil(t.litresLow / 20), jarsHigh: Math.ceil(t.litresHigh / 20), cupsLow: Math.ceil(t.litresLow / 0.2), cupsHigh: Math.ceil(t.litresHigh / 0.2) });
const shortList = (names, max = 4) => (names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`);
const time = clockTime;
// Each link carries its station's or runner's token (only in the organiser's view of the event).
const withToken = (url, item) => (item.token ? `${url}&t=${item.token}` : url);
const stationUrl = (s) => withToken(`${location.origin}/v.html?e=${eventId}&s=${s.id}`, s);
const runnerUrl = (r) => withToken(`${location.origin}/r.html?e=${eventId}&r=${r.id}`, r);
const edit = (method, path, body) => api(method, path, { body, key });

// ---------- Tabs ----------
function showTab(name) {
  tab = name;
  for (const t of ['setup', 'live', 'summary']) {
    $(`tab-${t}`).hidden = t !== name;
    $(`tabBtn-${t}`).setAttribute('aria-selected', String(t === name));
    $(`tabBtn-${t}`).classList.toggle('on', t === name);
  }
  const url = new URL(location.href);
  url.searchParams.set('tab', name);
  history.replaceState(null, '', url);
  if (name === 'summary' && !summaryLoaded) loadSummary();
  if (name === 'live') renderLive();
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

async function loadSummary() {
  summaryLoaded = true;
  try {
    await mountSummary($('summaryMount'), eventId);
  } catch (err) {
    summaryLoaded = false;
    $('summaryMount').innerHTML = `<p class="error">${escape(err.message)}</p>`;
  }
}

// ---------- Set up ----------
function renderSetup() {
  const { event, stations, runners, plan } = data;
  const busy = stations.filter((s) => s.busy).length;
  const counted = stations.filter((s) => s.stocked).length;
  const steps = [
    true,
    Boolean(event.setup?.ordered),
    Boolean(event.setup?.linksShared),
    stations.length > 0 && counted === stations.length,
  ];
  const doneCount = steps.filter(Boolean).length;
  const next = steps.findIndex((d) => !d);
  steps.forEach((done, i) => {
    const el = $(`step${i + 1}`);
    el.className = `step ${done ? 'done' : i === next ? 'next' : 'todo'}`;
    el.querySelector('.step-mark').textContent = done ? '✓' : String(i + 1);
    el.querySelector('.step-mark').setAttribute('aria-label', done ? 'Done' : `Step ${i + 1}`);
  });
  $('progressText').textContent = doneCount === 4 ? 'Ready for the event!' : `Ready in 4 steps · ${doneCount} of 4 done`;
  $('progressBar').setAttribute('aria-label', `${doneCount} of 4 steps done`);
  [...$('progressBar').children].forEach((seg, i) => seg.classList.toggle('on', i < doneCount));
  const art = doneCount === 4 ? 'dropCheer' : 'clipboard';
  if ($('progressArt').dataset.art !== art) {
    $('progressArt').dataset.art = art;
    $('progressArt').innerHTML = svg(art);
  }

  $('stationsLine').textContent = `${stations.length} stations${busy ? ` · ${busy} busy spot${busy === 1 ? '' : 's'}` : ''} · ${runners.length} runner${runners.length === 1 ? '' : 's'}`;
  $('stationsNames').textContent = shortList(stations.map((s) => s.name), 5);
  const t = orderTotals(plan.total);
  $('orderJars').textContent = `${nf(t.jarsLow)}–${nf(t.jarsHigh)}`;
  $('orderCups').textContent = `${nf(t.cupsLow)}–${nf(t.cupsHigh)}`;
  $('orderLine').textContent = `Order about ${nf(t.jarsLow)}–${nf(t.jarsHigh)} jars (20 L) and ${nf(t.cupsLow)}–${nf(t.cupsHigh)} cups`;
  $('orderBasis').textContent = `For ${nf(event.attendees)} people over ${event.hourCount} h at ${event.litresPerPersonHr.low}–${event.litresPerPersonHr.high} L per person per hour${event.heatFactor > 1 ? ', hot day' : ''}.`;
  $('markOrdered').textContent = event.setup?.ordered ? 'Ordered ✓ (undo)' : 'Mark as ordered';
  $('stockLine').textContent = `${counted} of ${stations.length} stations counted`;
  $('stockBar').style.width = `${stations.length ? Math.round((counted / stations.length) * 100) : 0}%`;
  const missing = stations.filter((s) => !s.stocked).map((s) => s.name);
  $('stockMissing').textContent = missing.length ? `Waiting for: ${shortList(missing)}` : 'All stations have counted their jars and cups.';
  $('reminder').hidden = !event.startsAt;

  // Fine-tune (only fill fields the organiser is not editing right now).
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  // datetime-local wants local time without a zone: "2026-10-10T18:00".
  if (event.startsAt) { const d = new Date(event.startsAt); set('startsAt', new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)); }
  set('runnerTrip', event.runnerTripMin ?? 10);
  set('lphLow', event.litresPerPersonHr.low);
  set('lphHigh', event.litresPerPersonHr.high);
  $('hotDay').checked = (event.heatFactor || 1) > 1;
  $('rdVolunteers').checked = event.volunteerCount !== undefined && event.volunteerCount >= stations.length;
  $('rdSupplier').checked = event.jarSupplier === true;
  $('rdSignal').checked = event.signal === true;

  if (!canEdit) for (const el of document.querySelectorAll('[data-edit]')) el.disabled = true;
}

function renderHeader() {
  const { event } = data;
  document.title = `${event.name} · Quench`;
  $('title').textContent = event.name;
  const when = event.startsAt
    ? `${new Date(event.startsAt).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} · ${time(Date.parse(event.startsAt))}–${time(Date.parse(event.startsAt) + event.hourCount * 3600000)}`
    : `${event.hourCount} h`;
  $('subtitle').textContent = `${when} · ${nf(event.attendees)} people`;
  $('qrLink').href = key ? `qr.html?e=${eventId}#k=${key}` : `qr.html?e=${eventId}`;
  $('fullBoard').href = `board.html?e=${eventId}`;
}

// ---------- Live ----------
function renderLive() {
  if (!data || tab !== 'live') return;
  const now = Date.now();
  const { clockText, summaryHtml, tilesHtml } = boardMarkup(data, now, { wide: window.innerWidth >= 700 });
  $('clock').textContent = clockText;
  $('summary').innerHTML = summaryHtml;
  const wasOpen = document.querySelector('#tiles details.all-good')?.open;
  $('tiles').innerHTML = tilesHtml;
  const group = document.querySelector('#tiles details.all-good');
  if (group && wasOpen !== undefined) group.open = wasOpen;
  const age = now - lastOk;
  $('freshness').className = `freshness ${age > STALE_MS ? 'stale' : ''}`;
  $('freshness').textContent = age > STALE_MS ? `Not updating: last update ${time(lastOk)}. Check the internet connection.` : `Updated ${Math.max(0, Math.round(age / 1000))} s ago`;
}

// ---------- Data ----------
async function load() {
  data = await api('GET', `/events/${eventId}`, { key });
  if (data.canEdit && !canEdit) applyEditMode(true);
  if (data.event.showcase) {
    $('viewOnly').textContent = 'Sample event: look around as much as you like, but it can’t be changed. Create your own event to try everything.';
    $('viewOnly').hidden = false;
  }
  lastOk = Date.now();
  rememberEvent({ id: eventId, name: data.event.name, startsAt: data.event.startsAt, key });
  renderHeader();
  renderSetup();
  renderLive();
  if ($('stationsSheet').open) renderSheet();
  // First time an organiser opens a hub: a short tour of the checklist (never on view-only links).
  if (canEdit && !toured && tab === 'setup' && !$('stationsSheet').open) {
    toured = true;
    requestAnimationFrame(maybeTour);
  }
}
let toured = false;

async function poll() {
  try {
    await load();
    $('loadError').hidden = true;
  } catch (err) {
    if (!data) {
      $('title').textContent = 'Event not available';
      $('loadError').textContent = err.message;
      $('loadError').hidden = false;
    }
  }
}

// ---------- Actions ----------
async function saveEvent(patch, status) {
  try {
    await edit('PATCH', `/events/${eventId}`, patch);
    if (status) $(status).textContent = 'Saved ✓';
    await load();
  } catch (err) {
    if (status) $(status).textContent = err.message;
  }
}

$('shareOrder').addEventListener('click', async () => {
  const t = orderTotals(data.plan.total);
  const when = data.event.startsAt ? dayTime(data.event.startsAt) : '';
  await shareText(`Hello! For ${data.event.name}${when ? ` (${when})` : ''}, please deliver ${nf(t.jarsHigh)} sealed 20 L drinking-water jars and ${nf(t.cupsHigh)} cups (kulhad, bagasse or paper without plastic lining; please no plastic-lined paper cups). Thank you.`, `${data.event.name}: water order`);
  if (!data.event.setup?.ordered) await saveEvent({ setup: { ordered: true } });
});
$('markOrdered').addEventListener('click', () => saveEvent({ setup: { ordered: !data.event.setup?.ordered } }));

async function markLinksShared() {
  if (canEdit && !data.event.setup?.linksShared) await saveEvent({ setup: { linksShared: true } });
}
$('qrLink').addEventListener('click', markLinksShared);
$('shareLinks').addEventListener('click', async () => {
  const lines = [
    `${data.event.name}: water station links. Open yours on your phone (no app, no login).`,
    ...data.stations.map((s) => `• ${s.name}: ${stationUrl(s)}`),
    ...(data.runners.length ? ['Runners:', ...data.runners.map((r) => `• ${r.name}: ${runnerUrl(r)}`)] : []),
  ];
  await shareText(lines.join('\n'), `${data.event.name}: links`);
  await markLinksShared();
});
$('reminder').addEventListener('click', () =>
  downloadReminder({
    title: `${data.event.name}: stock check`,
    startsAt: data.event.startsAt,
    minutesBefore: 30,
    details: `Ask every station volunteer to count jars and cups in Quench. ${location.origin}/event.html?e=${eventId}`,
  })
);
$('copyLink').addEventListener('click', async () => {
  await copyText(organiserLink(eventId, key));
  $('copyLink').textContent = 'Copied ✓';
});
$('sendLink').addEventListener('click', () => shareText(`My Quench organiser link for ${data.event.name} (keep it private): ${organiserLink(eventId, key)}`, 'Quench organiser link'));

// Fine-tune: save on change.
$('startsAt').addEventListener('change', () => {
  const d = new Date($('startsAt').value); // read as local time
  if (Number.isFinite(d.getTime())) saveEvent({ startsAt: d.toISOString(), startHour: d.getHours() }, 'fineStatus');
});
$('runnerTrip').addEventListener('change', () => saveEvent({ runnerTripMin: Number($('runnerTrip').value) }, 'fineStatus'));
for (const id of ['lphLow', 'lphHigh']) $(id).addEventListener('change', () => saveEvent({ litresPerPersonHr: { low: Number($('lphLow').value), high: Number($('lphHigh').value) } }, 'fineStatus'));
$('hotDay').addEventListener('change', () => saveEvent({ heatFactor: $('hotDay').checked ? 1.3 : 1 }, 'fineStatus'));
$('rdVolunteers').addEventListener('change', () => saveEvent({ volunteerCount: $('rdVolunteers').checked ? data.stations.length : 0 }, 'fineStatus'));
$('rdSupplier').addEventListener('change', () => saveEvent({ jarSupplier: $('rdSupplier').checked }, 'fineStatus'));
$('rdSignal').addEventListener('change', () => saveEvent({ signal: $('rdSignal').checked }, 'fineStatus'));

// ---------- Stations sheet ----------
function renderSheet() {
  $('stationRows').innerHTML = data.stations
    .map(
      (s) => `<li class="station-edit" data-sid="${s.id}">
        <label class="sr-only" for="sn-${s.id}">Station name</label>
        <input id="sn-${s.id}" value="${escape(s.name)}" maxlength="40" data-field="name">
        <label class="check-row"><input type="checkbox" data-field="busy" ${s.busy ? 'checked' : ''}> busy spot</label>
        <button type="button" class="ghost small-btn" data-remove="${s.id}" aria-label="Remove ${escape(s.name)}">Remove</button>
      </li>`
    )
    .join('');
  $('runnerRows').innerHTML = data.runners.length
    ? data.runners.map((r) => `<li><span>${escape(r.name)}</span><button type="button" class="ghost small-btn" data-remove-runner="${r.id}" aria-label="Remove ${escape(r.name)}">Remove</button></li>`).join('')
    : '<li class="small">No runners yet.</li>';
}

async function sheetAction(fn) {
  $('sheetSaved').textContent = 'Saving…';
  try {
    await fn();
    $('sheetSaved').textContent = 'Saved ✓';
    await load();
  } catch (err) {
    $('sheetSaved').textContent = err.message;
  }
}

$('editStations').addEventListener('click', () => {
  renderSheet();
  $('stationsSheet').showModal();
});
$('closeSheet').addEventListener('click', () => $('stationsSheet').close());
$('stationRows').addEventListener('change', (e) => {
  const li = e.target.closest('[data-sid]');
  if (!li) return;
  const field = e.target.dataset.field;
  const value = field === 'busy' ? e.target.checked : e.target.value;
  if (field === 'name' && !value.trim()) return;
  sheetAction(() => edit('PATCH', `/events/${eventId}/stations/${li.dataset.sid}`, { [field]: value }));
});
// Remove asks once, inline (tap again to confirm), instead of a pop-up.
$('stationRows').addEventListener('click', (e) => {
  const sid = e.target.dataset.remove;
  if (!sid) return;
  if (e.target.dataset.armed) return sheetAction(() => edit('DELETE', `/events/${eventId}/stations/${sid}`));
  e.target.dataset.armed = '1';
  e.target.textContent = 'Tap again to remove';
});
$('addStation').addEventListener('click', () => sheetAction(() => edit('POST', `/events/${eventId}/stations`, { name: `Station ${data.stations.length + 1}` })));
$('runnerRows').addEventListener('click', (e) => {
  const rid = e.target.dataset.removeRunner;
  if (rid) sheetAction(() => edit('DELETE', `/events/${eventId}/runners/${rid}`));
});
$('addRunner').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('runnerName').value.trim();
  if (!name) return;
  sheetAction(async () => {
    await edit('POST', `/events/${eventId}/runners`, { name });
    $('runnerName').value = '';
  });
});

// Edit controls on or off. The owner's sign-in can switch them on after the first load.
function applyEditMode(on) {
  canEdit = on;
  $('viewOnly').hidden = on;
  $('keepLink').hidden = !(on && key); // the shareable organiser link exists only on the device that has it
  $('replayTour').hidden = !on;
  if (on) for (const el of document.querySelectorAll('[data-edit]')) el.disabled = false;
}

// ---------- Start ----------
if (!eventId) {
  $('title').textContent = 'No event in the link';
  $('loadError').textContent = 'Start from the home page or your organiser link.';
  $('loadError').hidden = false;
} else {
  mountArt();
  applyEditMode(canEdit);
  $('replayTour').addEventListener('click', () => { showTab('setup'); startTour(); });
  showTab(tab);
  poll();
  setInterval(poll, POLL_MS);
  setInterval(renderLive, 1000);
}

// Event storage: one DynamoDB partition per event.
//   PK EVT#<id>  SK META        event settings + hash of the organiser key (and of the PIN, for older events)
//   PK EVT#<id>  SK STN#<sid>   station (+ token: the secret in its volunteer QR link)
//   PK EVT#<id>  SK RUN#<rid>   runner (+ token: the secret in their runner link)
//   PK EVT#<id>  SK JOB#<jobId> runner job (see dispatch.js)
//   PK EVT#<id>  SK TAP#<uuid>  volunteer tap (see taps.js); sorts after the others
//   PK EVENTS    SK <startsAt>#<id>  index of events by start time (for the scheduled projector)
import { GetCommand, QueryCommand, TransactWriteCommand, PutCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { db, TABLE } from './db.js';
import { hashPin, verifyPin, newId, sameSecret } from './pin.js';
import { validateEvent, validatePin, validateStation, validateRunner, validateStationPatch, validateEventPatch, crowdShare, hourLabels, LIMITS } from '../core/event.js';
import { planEvent, readiness } from '../core/plan.js';
import { isDemo } from './auth.js';

// Guardrails on what one account can run at once (anything stored costs AWS money).
export const MAX_ACTIVE_EVENTS = 20;
export const MAX_ACTIVE_EVENTS_DEMO = 5;
const DEMO_RETAIN_SEC = 24 * 3600; // the shared judges' account: its events vanish after a day

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pk = (id) => `EVT#${id}`;
// DynamoDB TTL: every item of an event is deleted automatically 90 days after the event ends
// (taps 90 days after they happened). expiresAt is in epoch seconds, as TTL requires.
export const RETAIN_DAYS = 90;
export const expiryAfter = (when) => Math.floor(Date.parse(when) / 1000) + RETAIN_DAYS * 86400;
const eventEnd = (startsAt, hourCount, fallback) => new Date((startsAt ? Date.parse(startsAt) : Date.parse(fallback)) + hourCount * 3600000).toISOString();
// Station and runner ids are public (the board shows them); the token in each QR link is what grants access.
const TOKEN_LENGTH = 16;
const newToken = () => newId(TOKEN_LENGTH);

// Returns { id, key }. Creating (storing) an event needs a signed-in organiser (user from a verified token).
// The key goes in the organiser's private link for co-organisers; only its hash is stored.
// A PIN is still accepted (older clients and tests) but no longer needed.
export async function createEvent(input, user) {
  if (!user) throw new HttpError(401, 'Sign in to save and run an event. Planning is free without an account.');
  const ev = validateEvent(input);
  const demo = isDemo(user);
  const cap = demo ? MAX_ACTIVE_EVENTS_DEMO : MAX_ACTIVE_EVENTS;
  if ((await activeEventCount(user.sub)) >= cap) {
    throw new HttpError(429, `This account already has ${cap} events that haven't ended. Remove one, or wait for one to finish.`);
  }
  const pin = input?.pin === undefined ? undefined : validatePin(input.pin);
  const key = newId(24);
  const id = newId();
  const now = new Date().toISOString();
  const { stations, runners, ...settings } = ev;
  const end = eventEnd(settings.startsAt, settings.hourCount, now);
  // Demo-account events (and everything under them) are deleted a day after they're created.
  const expiresAt = demo ? Math.floor(Date.now() / 1000) + DEMO_RETAIN_SEC : expiryAfter(end);

  const items = [
    { PK: pk(id), SK: 'META', type: 'event', id, expiresAt, ownerSub: user.sub, ownerEmail: user.email, ...settings, keyHash: hashPin(key), ...(pin ? { pinHash: hashPin(pin) } : {}), setup: { ordered: false, linksShared: false }, createdAt: now },
    // Index of events by start time, so the scheduled projector finds live events without a table scan.
    ...(settings.startsAt
      ? [{ PK: 'EVENTS', SK: `${settings.startsAt}#${id}`, type: 'event-index', id, endsAt: end, expiresAt: Math.min(expiresAt, Math.floor(Date.parse(end) / 1000) + 86400) }]
      : []),
    // The owner's list of events ("My events" on any device).
    { PK: `OWNER#${user.sub}`, SK: `${settings.startsAt || now}#${id}`, type: 'owner-index', id, name: settings.name, startsAt: settings.startsAt, endsAt: end, expiresAt },
    ...stations.map((s, i) => ({ PK: pk(id), SK: `STN#${newId(6)}`, type: 'station', ...s, token: newToken(), expiresAt, order: i, jarsOnHand: 0, cupsOnHand: 0, stocked: false, createdAt: now })),
    ...runners.map((r, i) => ({ PK: pk(id), SK: `RUN#${newId(6)}`, type: 'runner', ...r, token: newToken(), expiresAt, order: i, status: 'free', createdAt: now })),
  ];
  await db.send(
    new TransactWriteCommand({
      TransactItems: items.map((Item, i) => ({
        Put: { TableName: TABLE, Item, ...(i === 0 ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}) },
      })),
    })
  );
  return { id, key };
}

// Events of this owner that haven't ended yet (the owner index is small: one item per event).
async function activeEventCount(sub, now = Date.now()) {
  const res = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `OWNER#${sub}` } }));
  return res.Items.filter((x) => !x.showcase && Date.parse(x.endsAt) > now).length; // sample events don't count
}

// "My events": every event this account owns, newest first. The organiser key is never stored, so it isn't here;
// the owner's verified token is what lets them edit.
export async function myEvents(user) {
  if (!user) throw new HttpError(401, 'Sign in to see your events.');
  const res = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `OWNER#${user.sub}` }, ScanIndexForward: false }));
  return { events: res.Items.map(({ id, name, startsAt, endsAt, showcase }) => ({ id, name, startsAt, endsAt, ...(showcase ? { sample: true } : {}) })) };
}

// Public view: no PIN or key hash, and no link tokens unless withTokens (the organiser, who prints the QR codes).
// The plan is worked out on read, so it always matches the current stations.
export async function getEvent(id, { withTokens = false } = {}) {
  // SK < "TAP#" reads META, RUN# and STN# items but skips the (many) taps.
  const res = await db.send(
    new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :pk AND SK < :taps', ExpressionAttributeValues: { ':pk': pk(id), ':taps': 'TAP#' } })
  );
  const meta = res.Items.find((x) => x.SK === 'META');
  if (!meta) throw new HttpError(404, 'Event not found.');
  const { PK, SK, pinHash, keyHash, type, ownerSub, ownerEmail, ...event } = meta;
  // In the order they were added (items are stored by random id).
  const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || (a.createdAt || '').localeCompare(b.createdAt || '') || a.name.localeCompare(b.name, undefined, { numeric: true });
  const strip = ({ PK, SK, type, token, ...rest }) => ({ id: SK.slice(4), ...rest, ...(withTokens && token ? { token } : {}) });
  const stations = res.Items.filter((x) => x.type === 'station').map(strip).sort(byOrder);
  const runners = res.Items.filter((x) => x.type === 'runner').map(strip).sort(byOrder);
  // Task tokens resume the dispatch state machine, so they never leave the server.
  const jobs = res.Items.filter((x) => x.type === 'job').map(({ PK, SK, type, ackToken, doneToken, executionArn, ...j }) => ({ id: SK.slice(4), ...j, running: Boolean(executionArn) }));

  const hours = hourLabels(event.startHour, event.hourCount);
  // Without a crowd grid (new events), each station is its own "zone" with an equal share; busy spots double.
  const byWeight = !event.share;
  const planStations = byWeight ? stations.map((s) => ({ ...s, zone: s.id })) : stations;
  const share = byWeight ? crowdShare(stations, event.hourCount) : event.share;
  const plan = planEvent({ attendees: event.attendees, hours, stations: planStations, share, litresPerPersonHr: event.litresPerPersonHr, heatFactor: event.heatFactor });
  const ready = readiness({ attendees: event.attendees, stationCount: stations.length, volunteerCount: event.volunteerCount, jarSupplier: event.jarSupplier, signal: event.signal });
  const zonesWithoutShare = byWeight ? [] : [...new Set(stations.map((s) => s.zone))].filter((z) => !event.share[z]);
  const warnings = [
    ...ready.warnings,
    ...plan.warnings,
    ...zonesWithoutShare.map((z) => `Zone "${z}" has no crowd share, so its stations are planned at 0 jars.`),
  ];
  return { event, canEdit: withTokens, hours, stations, runners, jobs, plan: { rows: plan.rows.map((r) => ({ stationId: r.station.id, byHour: r.byHour, total: r.total })), total: plan.total }, warnings };
}

// auth: { key } from the organiser link, or { pin } for older events.
async function requirePin(id, auth = {}) {
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(id), SK: 'META' } }));
  if (!res.Item) throw new HttpError(404, 'Event not found.');
  const owner = Boolean(auth.user && res.Item.ownerSub && auth.user.sub === res.Item.ownerSub);
  const ok = owner || (auth.key && res.Item.keyHash && verifyPin(auth.key, res.Item.keyHash)) || (auth.pin && res.Item.pinHash && verifyPin(auth.pin, res.Item.pinHash));
  if (!ok) throw new HttpError(403, auth.key ? 'This organiser link is not valid for this event.' : auth.user ? 'This event belongs to another account.' : 'Wrong organiser PIN.');
  // Sample events in the judges' demo account (scripts/seed-sample-events.mjs) are read-only for everyone.
  if (res.Item.showcase) throw new HttpError(403, "This is a sample event, so it can't be changed. Create your own event to try everything.");
  return res.Item;
}

// True when auth carries this event's organiser key (or PIN). Never throws for a bad key: the caller just gets the public view.
export async function isOrganiser(id, auth = {}) {
  if (!auth.key && !auth.pin && !auth.user) return false;
  try {
    await requirePin(id, auth);
    return true;
  } catch (err) {
    if (err.status === 403) return false;
    throw err;
  }
}

// Volunteer and runner actions: the token from their QR link must match the station's or runner's.
// Stations and runners from before tokens existed have none and stay open, so printed links keep working.
export async function requireLink(id, kind, itemId, token) {
  const label = kind === 'STN' ? 'Station' : 'Runner';
  if (!itemId) throw new HttpError(403, 'This link is not valid. Ask the organiser for your QR code.');
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(id), SK: `${kind}#${itemId}` }, ProjectionExpression: '#t, expiresAt', ExpressionAttributeNames: { '#t': 'token' } }));
  if (!res.Item) throw new HttpError(404, `${label} not found.`);
  if (res.Item.token && !sameSecret(token, res.Item.token)) throw new HttpError(403, 'This link is not valid. Ask the organiser for your QR code.');
  return res.Item;
}

export async function updateEvent(id, auth, input) {
  await requirePin(id, auth);
  const patch = validateEventPatch(input);
  const names = {};
  const values = {};
  const sets = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'setup') {
      for (const [sk, sv] of Object.entries(v)) {
        names['#setup'] = 'setup';
        names[`#${sk}`] = sk;
        values[`:${sk}`] = sv;
        sets.push(`#setup.#${sk} = :${sk}`);
      }
    } else {
      names[`#${k}`] = k;
      values[`:${k}`] = v;
      sets.push(`#${k} = :${k}`);
    }
  }
  const update = { TableName: TABLE, Key: { PK: pk(id), SK: 'META' }, UpdateExpression: `SET ${sets.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values };
  if (!patch.startsAt) {
    await db.send(new UpdateCommand(update));
    return { ok: true };
  }
  // New start time: move the event's entry in the start-time index too, so the scheduled check finds it.
  const meta = (await db.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(id), SK: 'META' } }))).Item;
  const index = (startsAt) => ({ PK: 'EVENTS', SK: `${startsAt}#${id}` });
  const endsAt = new Date(Date.parse(patch.startsAt) + meta.hourCount * 3600000).toISOString();
  update.UpdateExpression += ', #expiresAt = :expiresAt';
  update.ExpressionAttributeNames['#expiresAt'] = 'expiresAt';
  update.ExpressionAttributeValues[':expiresAt'] = expiryAfter(endsAt);
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        { Update: update },
        ...(meta.startsAt && meta.startsAt !== patch.startsAt ? [{ Delete: { TableName: TABLE, Key: index(meta.startsAt) } }] : []),
        { Put: { TableName: TABLE, Item: { ...index(patch.startsAt), type: 'event-index', id, endsAt, expiresAt: Math.floor(Date.parse(endsAt) / 1000) + 86400 } } },
      ],
    })
  );
  return { ok: true };
}

export async function updateStation(id, auth, sid, input) {
  await requirePin(id, auth);
  const patch = validateStationPatch(input);
  const names = Object.fromEntries(Object.keys(patch).map((k) => [`#${k}`, k]));
  const values = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`:${k}`, v]));
  await db
    .send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: pk(id), SK: `STN#${sid}` },
        ConditionExpression: 'attribute_exists(SK)',
        UpdateExpression: `SET ${Object.keys(patch).map((k) => `#${k} = :${k}`).join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    )
    .catch(notFound('Station'));
  return { ok: true };
}

async function countItems(id, prefix) {
  const res = await db.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': pk(id), ':p': prefix },
      Select: 'COUNT',
    })
  );
  return res.Count;
}

export async function addStation(id, pin, input) {
  const meta = await requirePin(id, pin);
  const s = validateStation(input);
  if ((await countItems(id, 'STN#')) >= LIMITS.stations) throw new HttpError(400, `At most ${LIMITS.stations} stations.`);
  const sid = newId(6);
  await db.send(new PutCommand({ TableName: TABLE, Item: { PK: pk(id), SK: `STN#${sid}`, type: 'station', ...s, token: newToken(), expiresAt: meta.expiresAt ?? expiryAfter(new Date().toISOString()), order: Date.now(), jarsOnHand: 0, cupsOnHand: 0, stocked: false, createdAt: new Date().toISOString() } }));
  return { id: sid };
}

export async function removeStation(id, pin, sid) {
  await requirePin(id, pin);
  if ((await countItems(id, 'STN#')) <= 1) throw new HttpError(400, 'An event needs at least one station.');
  // A station with a runner on the way keeps its job until it is delivered (or times out); removing it
  // then would leave that job unable to close.
  await db
    .send(new DeleteCommand({ TableName: TABLE, Key: { PK: pk(id), SK: `STN#${sid}` }, ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(openJobId)' }))
    .catch(busyOrNotFound(id, `STN#${sid}`, 'Station', (x) => `${x.name} has a runner job open. Remove it after the jars are delivered.`));
  return { ok: true };
}

export async function addRunner(id, pin, input) {
  const meta = await requirePin(id, pin);
  const r = validateRunner(input);
  if ((await countItems(id, 'RUN#')) >= LIMITS.runners) throw new HttpError(400, `At most ${LIMITS.runners} runners.`);
  const rid = newId(6);
  await db.send(new PutCommand({ TableName: TABLE, Item: { PK: pk(id), SK: `RUN#${rid}`, type: 'runner', ...r, token: newToken(), expiresAt: meta.expiresAt ?? expiryAfter(new Date().toISOString()), order: Date.now(), status: 'free', createdAt: new Date().toISOString() } }));
  return { id: rid };
}

export async function removeRunner(id, pin, rid) {
  await requirePin(id, pin);
  // Same for a runner with a job in progress: the job needs them to close.
  await db
    .send(new DeleteCommand({ TableName: TABLE, Key: { PK: pk(id), SK: `RUN#${rid}` }, ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(currentJobId)' }))
    .catch(busyOrNotFound(id, `RUN#${rid}`, 'Runner', (x) => `${x.name} has a job in progress. Remove them after it is delivered.`));
  return { ok: true };
}

// A failed conditional delete: 404 if the item is gone, 409 (with why) if it is busy.
const busyOrNotFound = (id, sk, what, busyMessage) => async (err) => {
  if (err.name !== 'ConditionalCheckFailedException') throw err;
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { PK: pk(id), SK: sk } }));
  if (!res.Item) throw new HttpError(404, `${what} not found.`);
  throw new HttpError(409, busyMessage(res.Item));
};

const notFound = (what) => (err) => {
  if (err.name === 'ConditionalCheckFailedException') throw new HttpError(404, `${what} not found.`);
  throw err;
};

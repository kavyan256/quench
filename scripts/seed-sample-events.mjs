// Two read-only sample events in the judges' demo account, so "My events" isn't empty on first sign-in:
//   Spring Fest 2026 (finished, with 4 hours of taps and runner deliveries: a full summary)
//   City Half Marathon (upcoming, set-up half done)
// Re-running replaces the previous samples. Sample events are marked showcase: read-only (events.js) and not
// counted towards the account's limit.
//
// Local:  DDB_ENDPOINT=http://localhost:8000 OWNER_EMAIL=judge@quench.kavyan.dev node scripts/seed-sample-events.mjs
// AWS:    AWS_PROFILE=quenchsip AWS_REGION=ap-south-1 TABLE_NAME=<table> OWNER_SUB=<cognito sub> OWNER_EMAIL=judge@quench.kavyan.dev node scripts/seed-sample-events.mjs
import { createHmac, randomUUID } from 'node:crypto';
import { QueryCommand, BatchWriteCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { db, TABLE } from '../src/lib/db.js';
import { createEvent, getEvent, expiryAfter } from '../src/lib/events.js';

const email = (process.env.OWNER_EMAIL || 'judge@quench.kavyan.dev').toLowerCase();
// Locally the dev server derives the user id from the email (auth.js issueLocalToken); on AWS it is the Cognito sub.
const sub = process.env.OWNER_SUB || `local-${createHmac('sha256', 'sub').update(email).digest('hex').slice(0, 16)}`;
const owner = { sub, email: `seed+${email}` }; // not the demo email, so createEvent keeps normal (90-day) retention
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;

// ---- Remove earlier samples ----
const old = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `OWNER#${sub}` } }));
for (const o of old.Items.filter((x) => x.showcase)) {
  const keys = [{ PK: o.PK, SK: o.SK }];
  let start;
  do {
    const r = await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `EVT#${o.id}` }, ProjectionExpression: 'PK, SK', ExclusiveStartKey: start }));
    keys.push(...r.Items);
    start = r.LastEvaluatedKey;
  } while (start);
  if (o.startsAt) keys.push({ PK: 'EVENTS', SK: `${o.startsAt}#${o.id}` });
  for (let i = 0; i < keys.length; i += 25) {
    await db.send(new BatchWriteCommand({ RequestItems: { [TABLE]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) } }));
  }
  console.log(`removed old sample ${o.name} (${keys.length} items)`);
}

async function markSample(id, startsAt, setup) {
  await db.send(new UpdateCommand({
    TableName: TABLE, Key: { PK: `EVT#${id}`, SK: 'META' },
    UpdateExpression: 'SET showcase = :t, ownerEmail = :e, setup = :s',
    ExpressionAttributeValues: { ':t': true, ':e': email, ':s': setup },
  }));
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { PK: `OWNER#${sub}`, SK: `${startsAt}#${id}` }, UpdateExpression: 'SET showcase = :t', ExpressionAttributeValues: { ':t': true } }));
}

// Taps with past times, stored the way recordTap() stores them (taps.js). recordTap() itself can't be used:
// it only trusts phone clocks up to a day back, and after "Last jar" it starts a real runner job.
// The seed writes taps in time order, so the "last ... at" fields can simply be set.
const LAST_AT = { swap: 'lastSwapAt', last_jar: 'lastJarAt', cups_low: 'cupsLowAt', stocked: 'stockedAt' };
const COUNTER = { swap: 'swapCount', last_jar: 'lastJarCount', cups_low: 'cupsLowCount', stocked: 'stockCount' };
async function tapAt(eventId, station, type, at, extra = {}) {
  const uuid = randomUUID();
  const when = iso(at);
  await db.send(new PutCommand({ TableName: TABLE, Item: { PK: `EVT#${eventId}`, SK: `TAP#${uuid}`, type: 'tap', tapType: type, stationId: station.id, tappedAt: when, receivedAt: iso(at + 2000), deviceTs: when, clockTrusted: true, expiresAt: Math.min(expiryAfter(when), station.expiresAt), ...extra } }));
  const sets = [`${LAST_AT[type]} = :at`, 'lastTapAt = :at'];
  const values = { ':one': 1, ':at': when };
  if (type === 'swap') { sets.push('swapTimes = list_append(if_not_exists(swapTimes, :empty), :t)'); Object.assign(values, { ':t': [when], ':empty': [] }); }
  if (type === 'stocked') { sets.push('stocked = :yes', 'stockedJars = :j', 'stockedCups = :c'); Object.assign(values, { ':yes': true, ':j': extra.jars, ':c': extra.cups }); }
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { PK: `EVT#${eventId}`, SK: `STN#${station.id}` }, UpdateExpression: `ADD ${COUNTER[type]} :one SET ${sets.join(', ')}`, ExpressionAttributeValues: values }));
}

// ---- 1. Spring Fest 2026: finished ----
{
  const start = Date.parse('2026-10-04T10:30:00Z'); // 4:00 pm in India
  const hours = 4;
  const names = ['Main gate', 'Food court', 'Stage left', 'Stage right', 'Hostel road', 'Library lawn'];
  const { id } = await createEvent({
    name: 'Spring Fest 2026', startsAt: iso(start), attendees: 2000, startHour: 0, hourCount: hours, runnerTripMin: 8,
    litresPerPersonHr: { low: 0.25, high: 0.5 }, share: { Field: [0.8, 0.9, 1, 0.7] },
    stations: names.map((name) => ({ name, zone: 'Field' })), runners: [{ name: 'Asha' }, { name: 'Ravi' }, { name: 'Meera' }],
  }, owner);
  await markSample(id, iso(start), { ordered: true, linksShared: true });
  const data = await getEvent(id, { withTokens: true });
  const stations = names.map((n) => data.stations.find((s) => s.name === n));
  const runners = data.runners.map((r) => ({ ...r, freeAt: 0 }));

  // Minutes per jar at each station; the stage stations drink much faster while the headliner plays (hour 3).
  const mpj = [16, 11, 10, 10, 20, 24];
  const peak = (i, m) => (m >= 120 && m < 180 ? ([2, 3].includes(i) ? 0.55 : 0.8) : 1);
  const end = hours * 60;
  const jobs = [];
  const st = stations.map(() => ({ level: 1, spare: 5, dry: 0, job: null }));
  for (const s of stations) await tapAt(id, s, 'stocked', start - 20 * MIN, { jars: 6, cups: 1200 });

  for (let m = 0; m < end; m++) {
    const at = start + m * MIN;
    for (let i = 0; i < stations.length; i++) {
      const s = st[i];
      // A runner arriving.
      if (s.job && s.job.arrive === m) {
        s.spare += s.job.jars;
        if (s.level <= 0) { s.level = 1; s.spare--; await tapAt(id, stations[i], 'swap', at); }
        s.job.closedAt = at;
        s.job = null;
      }
      if (s.level <= 0) { s.dry++; continue; }
      s.level -= 1 / (mpj[i] * peak(i, m));
      if (s.level <= 0) {
        if (s.spare > 0) {
          s.spare--;
          s.level += 1;
          await tapAt(id, stations[i], 'swap', at);
          if (s.spare === 1) await tapAt(id, stations[i], 'last_jar', at + 20000);
        }
      }
      // Quench sends a runner when a station is down to its last spare jar (as the projection would).
      // At a busy station the projection reaches "too soon" a jar earlier.
      if (!s.job && s.spare <= (peak(i, m) < 1 ? 2 : 1) && m < end - 20) {
        const r = runners.filter((x) => x.freeAt <= m).sort((a, b) => a.freeAt - b.freeAt)[0];
        if (r) {
          const jars = m > end - 60 ? 3 : 6;
          s.job = { stationIndex: i, runner: r, created: m, arrive: m + 1 + 2 + 8, jars };
          r.freeAt = m + 1 + 2 + 16;
          jobs.push(s.job);
        }
      }
    }
    if (m === 128) await tapAt(id, stations[1], 'cups_low', at);
  }

  // Runner jobs (as dispatch.js stores them) and the station side of each delivery.
  for (const j of jobs.filter((x) => x.closedAt)) {
    const s = stations[j.stationIndex];
    const jobId = randomUUID().replace(/-/g, '').slice(0, 8);
    const created = start + j.created * MIN;
    await db.send(new PutCommand({ TableName: TABLE, Item: {
      PK: `EVT#${id}`, SK: `JOB#${jobId}`, type: 'job', eventId: id, stationId: s.id, stationName: s.name, zone: s.zone,
      reason: 'projected', state: 'done', jars: j.jars, cups: 0, excluded: [], attempts: 1,
      runnerId: j.runner.id, runnerName: j.runner.name,
      createdAt: iso(created), assignedAt: iso(created + 20000), ackedAt: iso(created + 2 * MIN), closedAt: iso(j.closedAt),
      deliveredJars: j.jars, deliveredCups: 0, expiresAt: expiryAfter(iso(created)),
    } }));
    await db.send(new UpdateCommand({
      TableName: TABLE, Key: { PK: `EVT#${id}`, SK: `STN#${s.id}` },
      UpdateExpression: 'SET restocks = list_append(if_not_exists(restocks, :e), :r), lastRestockAt = :at',
      ExpressionAttributeValues: { ':e': [], ':r': [{ at: iso(j.closedAt), jars: j.jars, cups: 0, jobId, by: j.runner.name }], ':at': iso(j.closedAt) },
    }));
  }
  for (let i = 0; i < stations.length; i++) {
    await db.send(new UpdateCommand({ TableName: TABLE, Key: { PK: `EVT#${id}`, SK: `STN#${stations[i].id}` }, UpdateExpression: 'SET dryMinutes = :d', ExpressionAttributeValues: { ':d': st[i].dry } }));
  }
  console.log(`Spring Fest 2026 ${id}: ${jobs.length} runner jobs, dry minutes ${st.map((s) => s.dry).join('/')}`);
}

// ---- 2. City Half Marathon: upcoming ----
{
  const start = Date.parse('2026-11-15T00:30:00Z'); // 6:00 am in India
  const names = ['Start line', 'Km 3', 'Km 6', 'Km 9', 'Km 12', 'Km 15', 'Km 18', 'Finish'];
  const { id } = await createEvent({
    name: 'City Half Marathon', startsAt: iso(start), attendees: 5000, startHour: 0, hourCount: 4, runnerTripMin: 12,
    litresPerPersonHr: { low: 0.25, high: 0.5 }, share: { Route: [1, 0.9, 0.7, 0.5] },
    stations: names.map((name) => ({ name, zone: 'Route' })), runners: [{ name: 'Asha' }, { name: 'Ravi' }, { name: 'Meera' }],
  }, owner);
  await markSample(id, iso(start), { ordered: true, linksShared: false });
  console.log(`City Half Marathon ${id}: upcoming`);
}
process.exit(0);

// Accounts: anything stored needs a signed-in organiser; identity comes only from a verified token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/api/handler.js';
import { db, TABLE } from '../src/lib/db.js';
import { organiserToken } from './link.js';

const call = async (method, path, body, headers = {}) => {
  const res = await handler({ rawPath: path, requestContext: { http: { method } }, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.statusCode, data: JSON.parse(res.body) };
};
const as = (token) => ({ authorization: `Bearer ${token}` });
const uniq = (who) => `${who}-${Math.random().toString(36).slice(2)}@quench.test`;
const eventBody = (name = 'Account Fest') => ({ name, attendees: 500, startHour: 18, hourCount: 3, startsAt: new Date(Date.now() + 3600000).toISOString(), stations: [{ name: 'Gate' }] });

// A token signed with the wrong secret, or already expired.
const forged = (claims) => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc({ sub: 'attacker', email: 'a@b.c', token_use: 'id', exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return `${head}.${body}.${createHmac('sha256', 'not-the-secret').update(`${head}.${body}`).digest('base64url')}`;
};

test('creating an event needs a signed-in organiser; a forged token is refused', async () => {
  const none = await call('POST', '/events', eventBody());
  assert.equal(none.status, 401);
  assert.match(none.data.error, /Sign in to save and run an event/);
  assert.equal((await call('POST', '/events', eventBody(), as(forged({})))).status, 401, 'wrong signature');
  assert.equal((await call('POST', '/events', eventBody(), as('not.a.jwt'))).status, 401);
  assert.equal((await call('POST', '/events', eventBody(), as(organiserToken(uniq('ok'))))).status, 201);
});

test('the owner edits from any device with their sign-in; another account cannot; reads stay public', async () => {
  const owner = organiserToken(uniq('owner'));
  const other = organiserToken(uniq('other'));
  const { data } = await call('POST', '/events', eventBody(), as(owner));
  assert.equal((await call('PATCH', `/events/${data.id}`, { runnerTripMin: 7 }, as(owner))).status, 200, 'owner, no link key needed');
  const refused = await call('PATCH', `/events/${data.id}`, { runnerTripMin: 7 }, as(other));
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /another account/);
  assert.equal((await call('PATCH', `/events/${data.id}`, { runnerTripMin: 8 }, { 'x-organiser-key': data.key })).status, 200, 'the organiser link still works for co-organisers');
  assert.equal((await call('GET', `/events/${data.id}`, undefined, as(owner))).data.canEdit, true);
  assert.equal((await call('GET', `/events/${data.id}`, undefined, as(other))).data.canEdit, false);
  assert.equal((await call('GET', `/events/${data.id}`)).data.canEdit, false, 'anyone can view');
  assert.equal((await call('GET', `/events/${data.id}`, undefined, as(forged({})))).status, 200, 'a bad token never blocks reading');
  assert.equal((await call('PATCH', `/events/${data.id}`, { runnerTripMin: 7 }, as(forged({ exp: 1 })))).status, 401, 'expired: sign in again');
});

test('"My events" lists only this account\'s events', async () => {
  const me = organiserToken(uniq('me'));
  const a = (await call('POST', '/events', eventBody('Mine A'), as(me))).data.id;
  const b = (await call('POST', '/events', eventBody('Mine B'), as(me))).data.id;
  await call('POST', '/events', eventBody('Not mine'), as(organiserToken(uniq('someone'))));
  const mine = await call('GET', '/me/events', undefined, as(me));
  assert.deepEqual(mine.data.events.map((e) => e.id).sort(), [a, b].sort());
  assert.equal((await call('GET', '/me/events')).status, 401);
});

test('guardrails: the demo account runs at most 5 events, and they vanish after a day', async () => {
  const demo = organiserToken('judge@quench.kavyan.dev');
  // Clear the demo account's index left by earlier runs (DynamoDB Local has no TTL).
  const old = (await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `OWNER#${JSON.parse(Buffer.from(demo.split('.')[1], 'base64url')).sub}` } }))).Items;
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  for (const it of old) await db.send(new DeleteCommand({ TableName: TABLE, Key: { PK: it.PK, SK: it.SK } }));
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/events', eventBody(`Demo ${i}`), as(demo));
    assert.equal(r.status, 201);
    ids.push(r.data.id);
  }
  const sixth = await call('POST', '/events', eventBody('Demo 6'), as(demo));
  assert.equal(sixth.status, 429);
  assert.match(sixth.data.error, /already has 5 events/);
  const items = (await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `EVT#${ids[0]}` } }))).Items;
  const inADay = Math.floor(Date.now() / 1000) + 24 * 3600;
  for (const it of items) assert.ok(Math.abs(it.expiresAt - inADay) < 60, `${it.SK} expires a day after creation`);
});

test('sample events (judges\' demo account) are read-only, marked, and not counted towards the limit', async () => {
  const email = uniq('sample');
  const owner = organiserToken(email);
  const { data } = await call('POST', '/events', eventBody('Sample Fest'), as(owner));
  const mine = await call('GET', '/me/events', undefined, as(owner));
  const sub = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url').toString()).sub;
  const ownerItem = (await db.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'PK = :p', ExpressionAttributeValues: { ':p': `OWNER#${sub}` } }))).Items[0];
  // As scripts/seed-sample-events.mjs marks them.
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { PK: `EVT#${data.id}`, SK: 'META' }, UpdateExpression: 'SET showcase = :t', ExpressionAttributeValues: { ':t': true } }));
  await db.send(new UpdateCommand({ TableName: TABLE, Key: { PK: ownerItem.PK, SK: ownerItem.SK }, UpdateExpression: 'SET showcase = :t', ExpressionAttributeValues: { ':t': true } }));
  assert.equal(mine.data.events.length, 1);

  const refused = await call('PATCH', `/events/${data.id}`, { runnerTripMin: 7 }, as(owner));
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /sample event/);
  const view = await call('GET', `/events/${data.id}`, undefined, as(owner));
  assert.equal(view.data.canEdit, false, 'the owner sees it view-only, without link tokens');
  assert.equal(view.data.stations[0].token, undefined);
  assert.equal((await call('GET', '/me/events', undefined, as(owner))).data.events[0].sample, true);
  // The sample does not use up one of the account's event slots: 20 more still fit.
  for (let i = 0; i < 20; i++) assert.equal((await call('POST', '/events', eventBody(`Own ${i}`), as(owner))).status, 201);
  assert.equal((await call('POST', '/events', eventBody('One too many'), as(owner))).status, 429);
});

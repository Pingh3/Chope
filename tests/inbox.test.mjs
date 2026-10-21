import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { buildInboxTask, cleanGmailLink, taskIdFor, createMemoryInbox, ValidationError, MAX_PENDING_PER_USER, CATEGORY_KEYS } from '../lib/inbox.js';
import { createGoogleVerifier } from '../lib/verifyGoogleToken.js';

const USER = { email: 'danial@example.com', name: 'Danial' };
const NOW = new Date('2026-10-14T04:00:00Z'); // 12:00 Singapore, Wed 14 Oct
const P = (o = {}) => ({ requestId: 'r1', name: 'Reply to LP about Fund III', ...o });

test('builds a Chope task assigned to the caller, with sensible defaults', () => {
  const t = buildInboxTask(P({ notes: ' From: Jane <j@x.com> ', deadline: '2026-10-21', priority: 'high', cat: 'ir', link: 'https://mail.google.com/mail/u/0/#inbox/FMfcg?compose=1' }), USER, { now: NOW });
  assert.equal(t.assignee, 'Danial');
  assert.equal(t.name, 'Reply to LP about Fund III');
  assert.equal(t.desc, 'From: Jane <j@x.com>');
  assert.equal(t.cat, 'ir');
  assert.equal(t.priority, 'high');
  assert.equal(t.deadline, '2026-10-21');
  assert.equal(t.startDate, '2026-10-14');
  assert.equal(t.status, 'todo');
  assert.equal(t.fund, ''); assert.equal(t.ws, '');
  assert.equal(t.source, 'gmail-extension');
  assert.equal(t.emailLink, 'https://mail.google.com/mail/u/0/#inbox/FMfcg'); // query dropped, hash kept
  assert.equal(t.createdAt, NOW.toISOString());
});

test('defaults: no deadline, medium priority, Admin category when omitted or unknown', () => {
  const t = buildInboxTask(P({ cat: 'not-a-category', priority: 'urgent!!' }), USER, { now: NOW });
  assert.equal(t.deadline, null); assert.equal(t.priority, 'med'); assert.equal(t.cat, 'admin');
  assert.ok(CATEGORY_KEYS.includes('admin'));
});

test('start date uses the Singapore calendar day, not UTC', () => {
  const lateUtc = new Date('2026-10-14T17:30:00Z'); // already 01:30 on the 15th in Singapore
  assert.equal(buildInboxTask(P(), USER, { now: lateUtc }).startDate, '2026-10-15');
});

test('rejects bad input with a clear message', () => {
  const bad = (p, re) => assert.throws(() => buildInboxTask(p, USER, { now: NOW }), e => e instanceof ValidationError && re.test(e.message));
  bad(P({ name: '   ' }), /name is required/i);
  bad(P({ name: 'x'.repeat(201) }), /too long/i);
  bad(P({ requestId: '' }), /requestId/);
  bad(P({ deadline: '21/10/2026' }), /YYYY-MM-DD/);
  bad(P({ deadline: '2026-02-30' }), /real date/i);
  assert.throws(() => buildInboxTask(P(), { email: 'a@b.com', name: null }, { now: NOW }), /no Chope name/);
});

test('only Gmail links are kept — anything else is dropped, not stored', () => {
  assert.equal(cleanGmailLink('https://mail.google.com/mail/u/0/#all/abc123'), 'https://mail.google.com/mail/u/0/#all/abc123');
  assert.equal(cleanGmailLink('https://evil.example.com/phish'), null);
  assert.equal(cleanGmailLink('http://mail.google.com/mail/u/0/#inbox/x'), null);
  assert.equal(cleanGmailLink('javascript:alert(1)'), null);
  assert.equal(cleanGmailLink('https://mail.google.com.evil.com/x'), null);
  assert.equal(cleanGmailLink('not a url'), null);
  assert.equal(buildInboxTask(P({ link: 'https://evil.example.com' }), USER, { now: NOW }).emailLink, undefined);
});

test('the same request always yields the same task id (retries and double-clicks are harmless)', async () => {
  assert.equal(taskIdFor('A@x.com', 'r1'), taskIdFor('a@x.com', 'r1'));
  assert.notEqual(taskIdFor('a@x.com', 'r1'), taskIdFor('a@x.com', 'r2'));
  const inbox = createMemoryInbox();
  const t = buildInboxTask(P(), USER, { now: NOW });
  assert.equal(await inbox.add(USER.email, t, 1000), true);
  assert.equal(await inbox.add(USER.email, buildInboxTask(P(), USER, { now: NOW }), 2000), false); // duplicate
  assert.equal((await inbox.list(USER.email)).length, 1);
});

test('add -> drain -> ack: each person only ever sees and clears their own items', async () => {
  const inbox = createMemoryInbox();
  const mine = buildInboxTask(P({ requestId: 'a' }), USER, { now: NOW });
  const theirs = buildInboxTask(P({ requestId: 'b' }), { email: 'denise@example.com', name: 'Denise' }, { now: NOW });
  await inbox.add(USER.email, mine, 1000); await inbox.add('denise@example.com', theirs, 1000);
  assert.deepEqual((await inbox.list(USER.email)).map(t => t.id), [mine.id]);
  await inbox.ack(USER.email, [mine.id, theirs.id]);               // trying to ack someone else's id is a no-op
  assert.equal((await inbox.list(USER.email)).length, 0);
  assert.equal((await inbox.list('denise@example.com')).length, 1);
  assert.equal((await inbox.list('DENISE@example.com')).length, 1); // email match is case-insensitive
});

test('un-acked items stay (so a crash between save and ack loses nothing) but expire after 30 days', async () => {
  const inbox = createMemoryInbox();
  const old = buildInboxTask(P({ requestId: 'old' }), USER, { now: NOW });
  await inbox.add(USER.email, old, 0);
  assert.equal((await inbox.list(USER.email)).length, 1);
  await inbox.add(USER.email, buildInboxTask(P({ requestId: 'new' }), USER, { now: NOW }), 31 * 86400000);
  assert.deepEqual((await inbox.list(USER.email)).map(t => t.id), [taskIdFor(USER.email, 'new')]);
});

test('caps how many items can pile up per person', async () => {
  const inbox = createMemoryInbox();
  for (let i = 0; i < MAX_PENDING_PER_USER; i++) await inbox.add(USER.email, buildInboxTask(P({ requestId: 'q' + i }), USER, { now: NOW }), 1000);
  await assert.rejects(inbox.add(USER.email, buildInboxTask(P({ requestId: 'over' }), USER, { now: NOW }), 1000), ValidationError);
});

// ── Google ID token verification ──
const CLIENT = '1052353371305-test.apps.googleusercontent.com';
async function googleSetup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'g1', alg: 'RS256', use: 'sig' };
  const verify = createGoogleVerifier({ clientId: CLIENT, keySet: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (claims = {}, { key = privateKey, iss = 'https://accounts.google.com', aud = CLIENT, exp = '1h' } = {}) =>
    new SignJWT({ email: 'danial@example.com', email_verified: true, ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer(iss).setAudience(aud).setSubject('1234').setIssuedAt().setExpirationTime(exp).sign(key);
  return { verify, sign };
}

test('Google token: accepts a valid one for OUR client and returns the email', async () => {
  const { verify, sign } = await googleSetup();
  assert.equal((await verify(await sign())).email, 'danial@example.com');
  assert.equal((await verify(await sign({}, { iss: 'accounts.google.com' }))).email, 'danial@example.com');
});

test('Google token: rejects another app\'s token, wrong issuer, expiry, forgery, unverified email', async () => {
  const { verify, sign } = await googleSetup();
  await assert.rejects(verify(await sign({}, { aud: 'some-other-app.apps.googleusercontent.com' })));
  await assert.rejects(verify(await sign({}, { iss: 'https://evil.example.com' })));
  await assert.rejects(verify(await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })));
  await assert.rejects(verify(await sign({}, { key: (await generateKeyPair('RS256')).privateKey })));
  await assert.rejects(verify(await sign({ email_verified: false })), /verified email/);
  await assert.rejects(verify(await sign({ email: undefined })));
  await assert.rejects(verify('garbage'));
});

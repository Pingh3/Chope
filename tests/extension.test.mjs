import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { cleanSubject, titleToSubject, looksLikeThread, decodeJwt, parseAuthRedirect, tokenStillGood } from '../extension/lib.js';

const jwt = claims => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

test('cleanSubject strips stacked Re:/Fwd: prefixes and tidies whitespace', () => {
  assert.equal(cleanSubject('Re: RE: Fwd:  Fund III   capital call'), 'Fund III capital call');
  assert.equal(cleanSubject('Fw: lease'), 'lease');
  assert.equal(cleanSubject('Regarding the lease'), 'Regarding the lease'); // not a prefix
  assert.equal(cleanSubject(''), '');
  assert.equal(cleanSubject('x'.repeat(300)).length, 200);
});

test('titleToSubject only trusts the "Subject - account - Mail" shape', () => {
  assert.equal(titleToSubject('Fund III call - victor@co.com - Company Mail'), 'Fund III call');
  assert.equal(titleToSubject('Q3 - plan - v2 - victor@co.com - Company Mail'), 'Q3 - plan - v2');
  assert.equal(titleToSubject('Inbox (3) - Gmail'), '');
});

test('looksLikeThread tells an opened conversation from a list view', () => {
  const g = h => `https://mail.google.com/mail/u/0/${h}`;
  assert.equal(looksLikeThread(g('#inbox/FMfcgzQbdxrKqPSrLwrjhVjMkQfHcWkV')), true);
  assert.equal(looksLikeThread(g('#all/FMfcgzQbdxrKqPSrLwrjhVjMkQfHcWkV')), true);
  assert.equal(looksLikeThread(g('#label/Chope/FMfcgzQbdxrKqPSrLwrjhVjMkQfHcWkV')), true);
  assert.equal(looksLikeThread(g('#search/lease/FMfcgzQbdxrKqPSrLwrjhVjMkQfHcWkV')), true);
  assert.equal(looksLikeThread(g('#inbox')), false);
  assert.equal(looksLikeThread(g('#label/Chope')), false);
  assert.equal(looksLikeThread(g('#starred')), false);
  assert.equal(looksLikeThread('https://example.com/#inbox/FMfcgzQbdxrKqPSrLwrjhVjMkQfHcWkV'), false);
  assert.equal(looksLikeThread('nonsense'), false);
});

test('decodeJwt reads base64url payloads, including non-ASCII', () => {
  assert.equal(decodeJwt(jwt({ email: 'a@b.com', n: 'José' })).n, 'José');
  assert.throws(() => decodeJwt('nope'));
});

test('parseAuthRedirect: token + matching nonce succeeds; mismatch/error/missing do not', () => {
  const ok = parseAuthRedirect(`https://abc.chromiumapp.org/#id_token=${jwt({ nonce: 'N1', email: 'v@co.com', exp: 2000000000 })}&state=x`, 'N1');
  assert.deepEqual([ok.ok, ok.email, ok.exp], [true, 'v@co.com', 2000000000000]);
  assert.equal(parseAuthRedirect(`https://abc.chromiumapp.org/#id_token=${jwt({ nonce: 'OTHER' })}`, 'N1').ok, false); // replayed/foreign
  const needs = parseAuthRedirect('https://abc.chromiumapp.org/#error=login_required', 'N1');
  assert.deepEqual([needs.ok, needs.needsInteraction], [false, true]);
  assert.equal(parseAuthRedirect('https://abc.chromiumapp.org/#error=access_denied', 'N1').needsInteraction, false);
  assert.equal(parseAuthRedirect('https://abc.chromiumapp.org/', 'N1').ok, false);
  assert.equal(parseAuthRedirect('https://abc.chromiumapp.org/#id_token=garbage', 'N1').ok, false);
});

test('tokenStillGood refreshes 2 minutes before expiry', () => {
  const now = 1_000_000;
  assert.equal(tokenStillGood({ idToken: 't', exp: now + 600000 }, now), true);
  assert.equal(tokenStillGood({ idToken: 't', exp: now + 60000 }, now), false);
  assert.equal(tokenStillGood(null, now), false);
});

test('manifest is valid MV3, asks only for what it uses, and every file it names exists', () => {
  const m = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'identity', 'scripting', 'storage']);
  assert.deepEqual(m.host_permissions, ['https://chope.vercel.app/*']); // no <all_urls>, no mail.google.com host access
  const files = [m.action.default_popup, m.background.service_worker, ...Object.values(m.icons), ...Object.values(m.action.default_icon)];
  for (const f of files) assert.ok(existsSync(new URL(`../extension/${f}`, import.meta.url)), `missing ${f}`);
  const config = readFileSync(new URL('../extension/config.js', import.meta.url), 'utf8');
  assert.ok(config.includes(m.host_permissions[0].replace('/*', '')), 'config origin matches host permission');
});

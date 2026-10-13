import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import { createFirebaseVerifier } from '../lib/verifyFirebaseToken.js';

const PROJECT = 'chope-test';
const ISS = `https://securetoken.google.com/${PROJECT}`;

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const verify = createFirebaseVerifier({ projectId: PROJECT, keySet: createLocalJWKSet({ keys: [jwk] }) });
  const sign = (claims = {}, { key = privateKey, kid = 'k1', alg = 'RS256', iss = ISS, aud = PROJECT, exp = '1h' } = {}) =>
    new SignJWT({ email: 'v@example.com', ...claims }).setProtectedHeader({ alg, kid })
      .setIssuer(iss).setAudience(aud).setSubject('uid-1').setIssuedAt().setExpirationTime(exp).sign(key);
  return { verify, sign, privateKey };
}

test('accepts a correctly signed token for this project and returns its claims', async () => {
  const { verify, sign } = await setup();
  const p = await verify(await sign());
  assert.equal(p.email, 'v@example.com');
  assert.equal(p.sub, 'uid-1');
});

test('rejects a token for another Firebase project (audience)', async () => {
  const { verify, sign } = await setup();
  await assert.rejects(verify(await sign({}, { aud: 'someone-elses-project' })));
});

test('rejects a token from the wrong issuer', async () => {
  const { verify, sign } = await setup();
  await assert.rejects(verify(await sign({}, { iss: 'https://evil.example.com' })));
});

test('rejects an expired token', async () => {
  const { verify, sign } = await setup();
  await assert.rejects(verify(await sign({}, { exp: Math.floor(Date.now() / 1000) - 60 })));
});

test('rejects a token signed with a different key (forgery)', async () => {
  const { verify, sign } = await setup();
  const other = await generateKeyPair('RS256');
  await assert.rejects(verify(await sign({}, { key: other.privateKey })));
});

test('rejects an HS256 token (algorithm confusion) and an unsigned token', async () => {
  const { verify } = await setup();
  const hs = await new SignJWT({ email: 'v@example.com' }).setProtectedHeader({ alg: 'HS256', kid: 'k1' })
    .setIssuer(ISS).setAudience(PROJECT).setSubject('uid-1').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length-123456'));
  await assert.rejects(verify(hs));
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: ISS, aud: PROJECT, sub: 'uid-1', exp: 9999999999, email: 'v@example.com' })}.`;
  await assert.rejects(verify(unsigned));
  await assert.rejects(verify('not-a-jwt'));
});

test('requires a project id', () => {
  assert.throws(() => createFirebaseVerifier({}));
});

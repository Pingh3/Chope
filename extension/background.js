// Sign-in lives here, not in the popup: the Google sign-in window steals focus, which closes a toolbar
// popup and would kill the flow half-way. The service worker survives that, stores the token, and the
// popup just reads it next time it opens.
import { CONFIG } from './config.js';
import { parseAuthRedirect, tokenStillGood } from './lib.js';

async function signIn(interactive) {
  const stored = (await chrome.storage.local.get('auth')).auth;
  if (!interactive && tokenStillGood(stored)) return { ok: true, email: stored.email };

  const nonce = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email',
    nonce,
    prompt: interactive ? 'select_account' : 'none', // 'none' = refresh quietly if Google already trusts us
  });
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive });
  } catch (e) {
    return { ok: false, needsInteraction: !interactive, error: e.message || 'Sign-in was cancelled' };
  }
  if (!redirect) return { ok: false, needsInteraction: !interactive, error: 'Sign-in was cancelled' };
  const r = parseAuthRedirect(redirect, nonce);
  if (!r.ok) return r;
  await chrome.storage.local.set({ auth: { idToken: r.idToken, email: r.email, exp: r.exp } });
  return { ok: true, email: r.email };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'signIn') { signIn(!!msg.interactive).then(sendResponse); return true; }
  if (msg?.type === 'signOut') { chrome.storage.local.remove('auth').then(() => sendResponse({ ok: true })); return true; }
  return false;
});

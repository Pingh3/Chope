// Pure helpers for the "Add to Chope" extension — no chrome.* APIs in here so they can be unit tested.

// "Re: Fwd: Fund III call" -> "Fund III call"
export function cleanSubject(s) {
  return String(s || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Gmail's tab title is "Subject - you@company.com - Company Mail" when an email is open. Only a
// fallback: the on-page subject element is preferred, and the user can always edit the field.
export function titleToSubject(title) {
  const parts = String(title || '').split(' - ');
  return parts.length >= 3 ? parts.slice(0, -2).join(' - ') : '';
}

// Is this Gmail URL an opened conversation (as opposed to a list like #inbox or #label/Foo)?
// Conversation routes end in a long id: #inbox/FMfcgzQ..., #all/FMfcg..., #label/Work/FMfcg..., #search/x/FMfcg...
export function looksLikeThread(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'mail.google.com') return false;
    const last = decodeURIComponent(u.hash.replace(/^#/, '').split('?')[0]).split('/').pop() || '';
    return /^[A-Za-z0-9_-]{16,}$/.test(last);
  } catch { return false; }
}

export function decodeJwt(token) {
  const payload = String(token).split('.')[1];
  if (!payload) throw new Error('Malformed token');
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
}

// Result of chrome.identity.launchWebAuthFlow for an implicit id_token flow: the token (or an error)
// comes back in the URL fragment. The nonce we sent must come back inside the token.
export function parseAuthRedirect(redirectUrl, nonce) {
  const frag = new URLSearchParams(new URL(redirectUrl).hash.replace(/^#/, ''));
  const idToken = frag.get('id_token');
  if (!idToken) return { ok: false, error: frag.get('error') || 'No token returned', needsInteraction: /login_required|interaction_required|consent_required|account_selection_required/.test(frag.get('error') || '') };
  let claims;
  try { claims = decodeJwt(idToken); } catch { return { ok: false, error: 'Unreadable sign-in response' }; }
  if (claims.nonce !== nonce) return { ok: false, error: 'Sign-in response did not match this request' };
  return { ok: true, idToken, email: claims.email, exp: (claims.exp || 0) * 1000 };
}

export const tokenStillGood = (auth, now = Date.now()) => !!(auth?.idToken && auth.exp - 120000 > now);

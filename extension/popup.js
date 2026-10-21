import { CONFIG } from './config.js';
import { cleanSubject, titleToSubject, looksLikeThread, tokenStillGood } from './lib.js';

const $ = id => document.getElementById(id);
const setStatus = (msg, kind = '') => { const s = $('status'); s.textContent = msg; s.className = kind; };

// One id per popup opening: a double-click or a retry after a network blip is the SAME task to the
// server, so it can never be added twice.
const requestId = crypto.randomUUID();

// Runs inside the Gmail tab (best effort — Gmail's markup changes without notice, and every field
// it fills in stays editable, so a miss just means a blank box, never a failure).
function readGmailPage() {
  const text = el => (el && (el.innerText || el.textContent) || '').trim();
  const senders = [...document.querySelectorAll('span.gD')];
  const last = senders[senders.length - 1];
  return {
    subject: text(document.querySelector('h2.hP')),
    senderName: (last && last.getAttribute('name')) || text(last),
    senderEmail: (last && last.getAttribute('email')) || '',
    url: location.href,
    title: document.title,
  };
}

async function readActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https:\/\/mail\.google\.com\//.test(tab.url)) return null;
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readGmailPage });
    return res?.result || null;
  } catch { return null; }
}

async function getAuth() {
  const stored = (await chrome.storage.local.get('auth')).auth;
  if (tokenStillGood(stored)) return stored;
  const r = await chrome.runtime.sendMessage({ type: 'signIn', interactive: false }); // quiet refresh
  return r?.ok ? (await chrome.storage.local.get('auth')).auth : null;
}

function showSignedOut() {
  $('signedOut').hidden = false; $('form').hidden = true; $('who').textContent = '';
  $('signInBtn').onclick = async () => {
    setStatus('Opening Google sign-in…');
    // The sign-in window closes this popup; the background worker finishes the job.
    const r = await chrome.runtime.sendMessage({ type: 'signIn', interactive: true });
    if (r && !r.ok) setStatus(r.error || 'Sign-in failed', 'err');
    else if (r?.ok) location.reload();
  };
}

function showForm(auth, page) {
  $('signedOut').hidden = true; $('form').hidden = false;
  $('who').innerHTML = '';
  $('who').append(`${auth.email} `);
  const out = Object.assign(document.createElement('a'), { textContent: 'sign out' });
  out.onclick = async () => { await chrome.runtime.sendMessage({ type: 'signOut' }); location.reload(); };
  $('who').append(out);

  $('cat').innerHTML = CONFIG.CATEGORIES.map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
  // Left blank on purpose: a due date is for a real commitment only (team rule), so it's never guessed.

  const onThread = page && looksLikeThread(page.url);
  if (onThread) {
    $('name').value = cleanSubject(page.subject || titleToSubject(page.title));
    const from = page.senderEmail ? `${page.senderName || page.senderEmail} <${page.senderEmail}>` : page.senderName;
    $('notes').value = from ? `From: ${from}` : '';
    $('pageHint').textContent = 'Linked to this email — you can open it again from the task.';
  } else {
    $('pageHint').textContent = page ? 'Open an email in Gmail to pre-fill this.' : 'Not on Gmail — adding a plain task.';
  }
  chrome.storage.local.get(['lastCat', 'lastPriority']).then(s => {
    if (s.lastCat) $('cat').value = s.lastCat;
    if (s.lastPriority) $('priority').value = s.lastPriority;
  });
  $('name').focus();

  $('form').onsubmit = async e => {
    e.preventDefault();
    const btn = $('addBtn'); btn.disabled = true; setStatus('Adding…');
    const send = async token => fetch(`${CONFIG.CHOPE_ORIGIN}/api/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: 'add', requestId, name: $('name').value, notes: $('notes').value,
        deadline: $('deadline').value || null, priority: $('priority').value, cat: $('cat').value,
        link: onThread ? page.url : null,
      }),
    });
    try {
      let res = await send(auth.idToken);
      if (res.status === 401) { // token expired between opening and clicking: refresh once and retry
        await chrome.storage.local.remove('auth');
        const fresh = await getAuth();
        if (!fresh) { showSignedOut(); setStatus('Your sign-in expired — please sign in again.', 'err'); return; }
        res = await send(fresh.idToken);
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Chope said ${res.status}`);
      await chrome.storage.local.set({ lastCat: $('cat').value, lastPriority: $('priority').value });
      setStatus(body.duplicate ? 'Already added ✓' : 'Added to Chope ✓ — it appears next time Chope is open.', 'ok');
      setTimeout(() => window.close(), 1600);
    } catch (err) {
      setStatus(err.message || 'Could not reach Chope', 'err');
      btn.disabled = false;
    }
  };
}

(async () => {
  const [auth, page] = await Promise.all([getAuth(), readActiveTab()]);
  if (auth) showForm(auth, page); else showSignedOut();
})();

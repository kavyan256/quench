import { api, escape, dayTime } from './api.js';
import { currentUser, signOut } from './auth.js';
import { openAuthSheet } from './auth-ui.js';
import { myEvents } from './store.js';
import { mountArt, svg } from './art.js';
import { maybeWelcome, showWelcome } from './onboarding.js';

mountArt();
document.getElementById('replayIntro').addEventListener('click', showWelcome);
maybeWelcome();

// Events on this device (organiser links) plus, when signed in, every event this account owns (any device).
async function renderEvents() {
  const local = myEvents();
  let owned = [];
  if (currentUser()) {
    try { owned = (await api('GET', '/me/events')).events; } catch {}
  }
  const byId = new Map(local.map((e) => [e.id, e]));
  for (const e of owned) byId.set(e.id, { ...byId.get(e.id), ...e, mine: true });
  const list = [...byId.values()].sort((a, b) => (b.startsAt || '').localeCompare(a.startsAt || ''));
  document.getElementById('mine').hidden = !list.length;
  document.getElementById('eventList').innerHTML = list
    .map((e) => {
      const when = e.startsAt ? dayTime(e.startsAt) : '';
      const href = `event.html?e=${e.id}${e.key ? `#k=${e.key}` : ''}`;
      const viewOnly = !e.key && !e.mine;
      const now = Date.now();
      const status = !e.startsAt || !e.endsAt ? '' : Date.parse(e.endsAt) < now ? 'Finished' : Date.parse(e.startsAt) <= now ? 'Live now' : 'Upcoming';
      const bits = [when, status, e.sample ? 'sample' : '', viewOnly ? 'view only' : ''].filter(Boolean).join(' · ');
      return `<li><a href="${href}"><span class="art sm">${svg('station')}</span><span class="grow"><strong>${escape(e.name)}</strong><span class="small">${escape(bits)}</span></span><span aria-hidden="true">›</span></a></li>`;
    })
    .join('');
}

// Small account control, top right: "Sign in", or the account chip with "Sign out".
function renderAccount() {
  const el = document.getElementById('account');
  const user = currentUser();
  if (!user) {
    el.innerHTML = '<button type="button" class="signin-link" id="signIn">Sign in</button>';
    document.getElementById('signIn').onclick = async () => {
      if (await openAuthSheet()) { renderAccount(); renderEvents(); }
    };
    return;
  }
  el.innerHTML = `<button type="button" class="acct-chip" id="acct" aria-label="Signed in as ${escape(user.email)}. Sign out" title="Signed in as ${escape(user.email)}"><i aria-hidden="true">${escape((user.email || '?')[0].toUpperCase())}</i>Sign out</button>`;
  document.getElementById('acct').onclick = () => { signOut(); renderAccount(); renderEvents(); };
}

renderAccount();
renderEvents();

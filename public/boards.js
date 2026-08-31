// Group boards: a shared shortlist that several people nominate to and vote on.
//
// Talks to Supabase's PostgREST endpoint with plain fetch -- no SDK, no CDN
// script, so the site stays dependency-free. There is no login: a board is
// reachable by anyone holding its link, and each visitor gets a random voter id
// kept in localStorage plus a display name they choose.
//
// Updates arrive by polling rather than websockets. For a handful of friends
// deciding on prints, a few seconds of lag is invisible and the code stays
// small enough to reason about.

const IDENTITY_KEY = 'galc-explorer:identity';
const POLL_MS = 6000;
/** Board ids are the only thing protecting a board, so make them unguessable. */
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const ID_LENGTH = 12;

const config = window.GALC_SUPABASE || {};

export const boards = {
  /** False when config.js has not been filled in; the UI degrades to a note. */
  configured: Boolean(config.url && config.anonKey),
  active: null,
  /** item_id -> nomination row */
  nominations: new Map(),
  /** item_id -> array of vote rows */
  votes: new Map(),
  error: null,
  loading: false
};

let identity = loadIdentity();
persistIdentity();
let listeners = [];
let pollTimer = null;

export function onBoardChange(fn) {
  listeners.push(fn);
}

function emit() {
  for (const fn of listeners) fn();
}

// ------------------------------------------------------------------ identity

function loadIdentity() {
  try {
    const stored = JSON.parse(localStorage.getItem(IDENTITY_KEY) || 'null');
    if (stored && stored.id) return stored;
  } catch {
    /* fall through to a fresh identity */
  }
  // Persisted by the caller, not here: this runs inside `identity`'s own
  // initializer, so it cannot touch that binding yet.
  return { id: randomId(16), name: '' };
}

function persistIdentity() {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } catch {
    /* private browsing: the name just will not stick between visits */
  }
}

function saveIdentity(next) {
  identity = next;
  persistIdentity();
}

export function getName() {
  return identity.name;
}

export function setName(name) {
  saveIdentity({ ...identity, name: name.trim().slice(0, 40) });
}

export function getVoterId() {
  return identity.id;
}

// --------------------------------------------------------------- REST helper

async function rest(path, { method = 'GET', body, prefer } = {}) {
  if (!boards.configured) throw new Error('Supabase is not configured yet.');
  const headers = {
    apikey: config.anonKey,
    Authorization: `Bearer ${config.anonKey}`
  };
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${config.url}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${detail.slice(0, 200) || res.statusText}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ----------------------------------------------------------------- lifecycle

export async function createBoard(name) {
  const id = randomId(ID_LENGTH, ID_ALPHABET);
  await rest('boards', {
    method: 'POST',
    body: { id, name: name.trim().slice(0, 80) || 'Untitled board' },
    prefer: 'return=minimal'
  });
  await openBoard(id);
  return id;
}

export async function openBoard(id) {
  if (!boards.configured) return;
  boards.loading = true;
  boards.error = null;
  emit();
  try {
    const rows = await rest(`boards?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!rows || !rows.length) {
      boards.active = null;
      boards.error = 'That board link does not point at anything. It may have been deleted.';
    } else {
      boards.active = rows[0];
      await refresh();
      startPolling();
    }
  } catch (err) {
    boards.active = null;
    boards.error = err.message;
  } finally {
    boards.loading = false;
    emit();
  }
}

export function leaveBoard() {
  boards.active = null;
  boards.nominations = new Map();
  boards.votes = new Map();
  boards.error = null;
  stopPolling();
  emit();
}

export async function refresh() {
  if (!boards.active) return;
  const id = encodeURIComponent(boards.active.id);
  try {
    const [noms, votes] = await Promise.all([
      rest(`nominations?board_id=eq.${id}&select=*`),
      rest(`votes?board_id=eq.${id}&select=*`)
    ]);
    boards.nominations = new Map((noms || []).map((n) => [n.item_id, n]));
    const grouped = new Map();
    for (const vote of votes || []) {
      if (!grouped.has(vote.item_id)) grouped.set(vote.item_id, []);
      grouped.get(vote.item_id).push(vote);
    }
    boards.votes = grouped;
    boards.error = null;
  } catch (err) {
    // Keep showing the last good data rather than blanking the board.
    boards.error = err.message;
  }
  emit();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden) return; // do not poll a background tab
    refresh();
  }, POLL_MS);
}

// Coming back to a backgrounded tab should show current scores immediately
// rather than whatever was on screen when it was hidden.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && boards.active) refresh();
});

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ------------------------------------------------------------------- actions

export async function nominate(itemId) {
  if (!boards.active) return;
  const row = {
    board_id: boards.active.id,
    item_id: String(itemId),
    added_by: identity.name || 'someone'
  };
  // Optimistic: the board should feel instant even on a slow connection.
  boards.nominations.set(row.item_id, row);
  emit();
  try {
    await rest('nominations', {
      method: 'POST',
      body: row,
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
  } catch (err) {
    boards.nominations.delete(row.item_id);
    boards.error = err.message;
  }
  await refresh();
}

export async function unnominate(itemId) {
  if (!boards.active) return;
  const id = String(itemId);
  const previous = boards.nominations.get(id);
  boards.nominations.delete(id);
  emit();
  try {
    const board = encodeURIComponent(boards.active.id);
    await rest(`nominations?board_id=eq.${board}&item_id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      prefer: 'return=minimal'
    });
    await rest(`votes?board_id=eq.${board}&item_id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      prefer: 'return=minimal'
    });
  } catch (err) {
    if (previous) boards.nominations.set(id, previous);
    boards.error = err.message;
  }
  await refresh();
}

/** value is 1, -1, or 0 to clear an existing vote. */
export async function vote(itemId, value) {
  if (!boards.active) return;
  const id = String(itemId);
  const board = encodeURIComponent(boards.active.id);
  try {
    if (value === 0) {
      await rest(
        `votes?board_id=eq.${board}&item_id=eq.${encodeURIComponent(id)}` +
          `&voter_id=eq.${encodeURIComponent(identity.id)}`,
        { method: 'DELETE', prefer: 'return=minimal' }
      );
    } else {
      await rest('votes', {
        method: 'POST',
        body: {
          board_id: boards.active.id,
          item_id: id,
          voter_id: identity.id,
          voter_name: identity.name || 'someone',
          value
        },
        prefer: 'resolution=merge-duplicates,return=minimal'
      });
    }
  } catch (err) {
    boards.error = err.message;
  }
  await refresh();
}

// ------------------------------------------------------------------ readouts

export function isNominated(itemId) {
  return boards.nominations.has(String(itemId));
}

export function votesFor(itemId) {
  return boards.votes.get(String(itemId)) || [];
}

export function scoreFor(itemId) {
  return votesFor(itemId).reduce((sum, v) => sum + v.value, 0);
}

export function myVote(itemId) {
  const mine = votesFor(itemId).find((v) => v.voter_id === identity.id);
  return mine ? mine.value : 0;
}

/** Everyone who has nominated or voted on this board, for a "who's in" line. */
export function participants() {
  const names = new Set();
  for (const nom of boards.nominations.values()) names.add(nom.added_by);
  for (const list of boards.votes.values()) for (const v of list) names.add(v.voter_name);
  names.delete('someone');
  return [...names].sort();
}

export function inviteUrl() {
  if (!boards.active) return '';
  return `${location.origin}${location.pathname}#board=${boards.active.id}`;
}

// ----------------------------------------------------------------- utilities

function randomId(length, alphabet) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  if (!alphabet) return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

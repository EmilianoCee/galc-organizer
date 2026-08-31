// GALC Explorer -- everything runs client-side over one prebuilt JSON snapshot.

import {
  boards, onBoardChange, createBoard, openBoard, leaveBoard, refresh as refreshBoard,
  nominate, unnominate, vote, isNominated, scoreFor, myVote, votesFor,
  participants, inviteUrl, getName, setName
} from './boards.js';

const DATA_URL = 'data/collection.json';
const SAVED_KEY = 'galc-explorer:saved';
const CHUNK = 60;
const WALL_PX_PER_INCH = 10;
/** How close two widths must be to count as "matching" for a hanging set. */
const MATCH_TOLERANCE_IN = 0.5;

const FACET_ORDER = ['Genre', 'Medium', 'Appearance', 'Decade', 'Size'];

/** @type {{meta: object, facets: object, items: object[]}} */
let collection = null;
let filtered = [];
let rendered = 0;
let saved = loadSaved();

const state = {
  q: '',
  width: null, // [min, max] or null for "full range"
  height: null,
  available: false,
  savedOnly: false,
  hideUnsized: false,
  orientation: '',
  facets: {}, // facetName -> Set(values)
  sort: 'width-asc',
  view: 'grid',
  matchOf: null, // item id whose width we are matching
  boardId: null
};

const bounds = { width: [0, 100], height: [0, 100] };

const $ = (sel) => document.querySelector(sel);
const els = {};

init();

async function init() {
  cacheEls();
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    collection = await res.json();
  } catch (err) {
    els.results.innerHTML = '';
    els.results.append(
      el('p', { class: 'empty' }, `Could not load the collection snapshot (${err.message}). Run \`npm run fetch\` to build it.`)
    );
    return;
  }

  computeBounds();
  buildFacetPanels();
  wireControls();
  readUrl();
  syncControls();
  apply();
  showFreshness();

  onBoardChange(() => {
    renderBoardPanel();
    renderBoardBar();
    // A board view showing stale scores is worse than a brief flicker.
    if (state.view === 'board' || state.boardId) render();
  });
  renderBoardPanel();
  if (state.boardId) openBoard(state.boardId);
}

function cacheEls() {
  els.results = $('#results');
  els.empty = $('#empty');
  els.count = $('#result-count');
  els.freshness = $('#freshness');
  els.facets = $('#facets');
  els.detail = $('#detail');
  els.detailBody = els.detail.querySelector('.detail-body');
  els.banner = $('#match-banner');
  els.sentinel = $('#sentinel');
  els.savedCount = $('#saved-count');
  els.boardBar = $('#board-bar');
  els.boardPanel = $('#board-panel-body');
  els.viewBoard = $('#view-board');
}

// ------------------------------------------------------------------ setup

function computeBounds() {
  for (const axis of ['width', 'height']) {
    const key = axis === 'width' ? 'width_in' : 'height_in';
    const values = collection.items.map((i) => i[key]).filter((v) => typeof v === 'number');
    bounds[axis] = values.length
      ? [Math.floor(Math.min(...values)), Math.ceil(Math.max(...values))]
      : [0, 100];
  }
}

function buildFacetPanels() {
  const names = Object.keys(collection.facets).sort(
    (a, b) => indexOrLast(FACET_ORDER, a) - indexOrLast(FACET_ORDER, b)
  );
  for (const name of names) {
    const values = collection.facets[name];
    if (!values || values.length < 2) continue;

    const panel = el('section', { class: 'panel' }, el('h2', {}, name));
    const list = el('div', { class: 'facet-list' });
    if (values.length > 8) {
      list.style.maxHeight = '188px';
      list.style.overflowY = 'auto';
    }
    for (const { value, count } of values) {
      const box = el('input', { type: 'checkbox', value });
      box.addEventListener('change', () => {
        const set = (state.facets[name] ||= new Set());
        box.checked ? set.add(value) : set.delete(value);
        if (!set.size) delete state.facets[name];
        apply();
      });
      const label = el('label', { class: 'check' }, box, document.createTextNode(value));
      label.append(el('span', { class: 'pill' }, String(count)));
      list.append(label);
    }
    panel.append(list);
    els.facets.append(panel);
  }
}

function wireControls() {
  $('#q').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); apply(); }, 150));
  $('#only-available').addEventListener('change', (e) => { state.available = e.target.checked; apply(); });
  $('#only-saved').addEventListener('change', (e) => { state.savedOnly = e.target.checked; apply(); });
  $('#hide-unsized').addEventListener('change', (e) => { state.hideUnsized = e.target.checked; apply(); });
  $('#orientation').addEventListener('change', (e) => { state.orientation = e.target.value; apply(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; apply(); });
  $('#reset').addEventListener('click', resetAll);
  $('#toggle-filters').addEventListener('click', (e) => {
    const open = $('#sidebar').classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  for (const button of document.querySelectorAll('.segmented button')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      for (const b of document.querySelectorAll('.segmented button')) {
        b.classList.toggle('is-active', b === button);
      }
      apply();
    });
  }

  setupRange('width');
  setupRange('height');

  els.detail.addEventListener('click', (e) => {
    if (e.target === els.detail || e.target.classList.contains('detail-close')) closeDetail();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting) && rendered < filtered.length) renderMore();
  }).observe(els.sentinel);

  window.addEventListener('hashchange', () => { readUrl(); syncControls(); apply(); });
}

/** Two overlapping range inputs acting as one min/max control. */
function setupRange(axis) {
  const root = document.querySelector(`[data-range="${axis}"]`);
  const [lo, hi] = bounds[axis];
  const minThumb = root.querySelector('[data-thumb="min"]');
  const maxThumb = root.querySelector('[data-thumb="max"]');
  const numMin = document.querySelector(`[data-num="${axis}-min"]`);
  const numMax = document.querySelector(`[data-num="${axis}-max"]`);

  for (const input of [minThumb, maxThumb]) {
    input.min = lo; input.max = hi; input.step = 0.25;
  }
  for (const input of [numMin, numMax]) {
    input.min = lo; input.max = hi;
  }
  minThumb.value = lo; maxThumb.value = hi;

  const commit = (from) => {
    let min = Number(from === 'num' ? numMin.value : minThumb.value);
    let max = Number(from === 'num' ? numMax.value : maxThumb.value);
    if (!isFinite(min)) min = lo;
    if (!isFinite(max)) max = hi;
    min = clamp(min, lo, hi);
    max = clamp(max, lo, hi);
    if (min > max) { if (from === 'num') max = min; else [min, max] = [max, min]; }
    state[axis] = min <= lo && max >= hi ? null : [min, max];
    state.matchOf = null;
    setRange(axis, min, max);
    apply();
  };

  minThumb.addEventListener('input', () => {
    if (Number(minThumb.value) > Number(maxThumb.value)) maxThumb.value = minThumb.value;
    commit('thumb');
  });
  maxThumb.addEventListener('input', () => {
    if (Number(maxThumb.value) < Number(minThumb.value)) minThumb.value = maxThumb.value;
    commit('thumb');
  });
  numMin.addEventListener('change', () => commit('num'));
  numMax.addEventListener('change', () => commit('num'));

  els[`range_${axis}`] = { root, minThumb, maxThumb, numMin, numMax };
  setRange(axis, lo, hi);
}

/** Push values into a range control's inputs and repaint its filled track. */
function setRange(axis, min, max) {
  const r = els[`range_${axis}`];
  if (!r) return;
  const [lo, hi] = bounds[axis];
  r.minThumb.value = min;
  r.maxThumb.value = max;
  r.numMin.value = round2(min);
  r.numMax.value = round2(max);
  const fill = r.root.querySelector('[data-fill]');
  const span = hi - lo || 1;
  fill.style.left = `${((min - lo) / span) * 100}%`;
  fill.style.right = `${100 - ((max - lo) / span) * 100}%`;
}

// ----------------------------------------------------------- filter/sort

function apply() {
  filtered = collection.items.filter(matches);
  sortItems(filtered);
  writeUrl();
  renderBanner();
  render();
  els.savedCount.textContent = saved.size ? String(saved.size) : '';
}

function matches(item) {
  if (state.available && item.available !== true) return false;
  if (state.savedOnly && !saved.has(item.id)) return false;
  if (state.hideUnsized && item.width_in === null) return false;
  if (state.orientation && item.orientation !== state.orientation) return false;

  if (state.width) {
    if (item.width_in === null) return false;
    if (item.width_in < state.width[0] || item.width_in > state.width[1]) return false;
  }
  if (state.height) {
    if (item.height_in === null) return false;
    if (item.height_in < state.height[0] || item.height_in > state.height[1]) return false;
  }

  for (const [facet, values] of Object.entries(state.facets)) {
    const owned = item.facets[facet];
    if (!owned || !owned.some((v) => values.has(v))) return false;
  }

  if (state.q) {
    const needle = state.q.toLowerCase();
    const hay = [item.title, item.artist, item.description, item.series, item.date]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function sortItems(list) {
  const byNumber = (key, dir) => (a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === null && y === null) return a.title.localeCompare(b.title);
    if (x === null) return 1; // unsized items always sink
    if (y === null) return -1;
    return x === y ? a.title.localeCompare(b.title) : (x - y) * dir;
  };
  const sorts = {
    'width-asc': byNumber('width_in', 1),
    'width-desc': byNumber('width_in', -1),
    'height-asc': byNumber('height_in', 1),
    'height-desc': byNumber('height_in', -1),
    'area-asc': byNumber('area_sq_in', 1),
    'area-desc': byNumber('area_sq_in', -1),
    'year-asc': byNumber('year', 1),
    'year-desc': byNumber('year', -1),
    title: (a, b) => a.title.localeCompare(b.title),
    artist: (a, b) => (a.artist || '￿').localeCompare(b.artist || '￿')
  };
  list.sort(sorts[state.sort] || sorts['width-asc']);
}

// ---------------------------------------------------------------- render

function render() {
  rendered = 0;
  els.results.innerHTML = '';
  els.results.className = `results ${state.view}`;

  if (state.view === 'board') {
    els.empty.hidden = true;
    els.count.replaceChildren(
      el('strong', {}, String(boards.nominations.size)),
      document.createTextNode(` nominated on “${boards.active ? boards.active.name : 'board'}”`)
    );
    renderBoardView();
    return;
  }

  els.empty.hidden = filtered.length > 0;

  const total = collection.items.length;
  els.count.replaceChildren(
    el('strong', {}, filtered.length.toLocaleString()),
    document.createTextNode(filtered.length === total ? ' prints' : ` of ${total.toLocaleString()} prints`)
  );

  if (state.view === 'table') {
    const table = el('table');
    table.append(
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, ''),
          el('th', {}, 'Title'),
          el('th', {}, 'Artist'),
          el('th', { class: 'num' }, 'W'),
          el('th', { class: 'num' }, 'H'),
          el('th', {}, 'Date'),
          el('th', {}, 'Status'),
          el('th', {}, '')
        )
      )
    );
    table.append(el('tbody'));
    els.results.append(table);
  }
  renderMore();
}

function renderMore() {
  const slice = filtered.slice(rendered, rendered + CHUNK);
  const target = state.view === 'table' ? els.results.querySelector('tbody') : els.results;
  const frag = document.createDocumentFragment();
  for (const item of slice) {
    frag.append(
      state.view === 'table' ? rowFor(item) : state.view === 'wall' ? wallFor(item) : cardFor(item)
    );
  }
  target.append(frag);
  rendered += slice.length;

  // The observer only fires on a *change* in intersection, so a chunk that does
  // not fill the viewport would leave the sentinel visible and never re-trigger.
  if (rendered < filtered.length && els.sentinel.getBoundingClientRect().top < window.innerHeight) {
    requestAnimationFrame(renderMore);
  }
}

function cardFor(item) {
  const art = el('button', { class: 'card-art', type: 'button', title: 'View details' });
  if (item.thumbnail_url) {
    art.append(el('img', { src: item.thumbnail_url, alt: item.title, loading: 'lazy', decoding: 'async' }));
  }
  art.addEventListener('click', () => openDetail(item));

  const dims = el('div', { class: 'card-dims' });
  if (item.width_in !== null) {
    dims.append(
      el('span', { class: 'dims-w' }, `${fmt(item.width_in)}"`),
      el('span', { class: 'dims-sep' }, 'w'),
      el('span', { class: 'dims-h' }, `× ${fmt(item.height_in)}" h`)
    );
    if (item.dim_confidence !== 'high') dims.append(el('span', { class: 'badge badge-approx' }, 'approx'));
  } else {
    dims.append(el('span', { class: 'dims-h' }, item.dimensions_raw || 'size unknown'));
  }
  dims.append(availabilityBadge(item));

  const body = el(
    'div',
    { class: 'card-body' },
    el('h3', { class: 'card-title' }, item.title),
    el('p', { class: 'card-artist' }, item.artist || 'Unknown artist'),
    dims
  );

  const saveBtn = el('button', { type: 'button' });
  paintSave(saveBtn, item);
  saveBtn.addEventListener('click', () => { toggleSave(item.id); paintSave(saveBtn, item); apply(); });

  const matchBtn = el('button', { type: 'button', title: 'Find prints of the same width' }, 'Match width');
  matchBtn.disabled = item.width_in === null;
  matchBtn.addEventListener('click', () => matchWidth(item));

  const actions = el('div', { class: 'card-actions' }, saveBtn, matchBtn);
  if (boards.active) actions.append(nominateButton(item));

  return el('article', { class: 'card' }, art, body, actions);
}

function rowFor(item) {
  const thumb = el('td');
  if (item.thumbnail_url) {
    thumb.append(el('img', { src: item.thumbnail_url, alt: '', loading: 'lazy', decoding: 'async' }));
  }
  const titleBtn = el('button', { class: 'link-title', type: 'button' }, item.title);
  titleBtn.addEventListener('click', () => openDetail(item));

  const saveBtn = el('button', { class: 'link-title', type: 'button' });
  paintSave(saveBtn, item);
  saveBtn.addEventListener('click', () => { toggleSave(item.id); paintSave(saveBtn, item); apply(); });

  return el(
    'tr',
    {},
    thumb,
    el('td', {}, titleBtn),
    el('td', {}, item.artist || '—'),
    el('td', { class: 'num' }, item.width_in !== null ? fmt(item.width_in) : '—'),
    el('td', { class: 'num' }, item.height_in !== null ? fmt(item.height_in) : '—'),
    el('td', {}, item.date || '—'),
    el('td', {}, availabilityBadge(item)),
    el('td', {}, saveBtn)
  );
}

/** Scale-accurate thumbnail: same inches-per-pixel for every print. */
function wallFor(item) {
  const w = (item.width_in || 12) * WALL_PX_PER_INCH;
  const h = (item.height_in || 12) * WALL_PX_PER_INCH;
  const frame = el('div', { class: 'wall-frame' });
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  if (item.thumbnail_url) {
    frame.append(el('img', { src: item.thumbnail_url, alt: item.title, loading: 'lazy', decoding: 'async' }));
  }
  const caption = el(
    'div',
    { class: 'wall-caption' },
    item.width_in !== null ? `${fmt(item.width_in)}×${fmt(item.height_in)}"` : 'size unknown'
  );
  const wrap = el('div', { class: 'wall-item', title: `${item.title}${item.artist ? ' — ' + item.artist : ''}` }, frame, caption);
  wrap.addEventListener('click', () => openDetail(item));
  return wrap;
}

function nominateButton(item, className = '') {
  const button = el('button', { class: className, type: 'button' });
  const paint = () => {
    const on = isNominated(item.id);
    button.textContent = on ? 'On board' : 'Nominate';
    button.classList.toggle('is-saved', on);
  };
  paint();
  button.addEventListener('click', async () => {
    button.disabled = true;
    await (isNominated(item.id) ? unnominate(item.id) : nominate(item.id));
    button.disabled = false;
    paint();
  });
  return button;
}

function availabilityBadge(item) {
  if (item.available === true) return el('span', { class: 'badge badge-available' }, 'On shelf');
  if (item.available === false) return el('span', { class: 'badge badge-out' }, 'Out');
  return el('span', { class: 'badge badge-out' }, 'Unknown');
}

function paintSave(button, item) {
  const isSaved = saved.has(item.id);
  button.textContent = isSaved ? 'Saved' : 'Save';
  button.classList.toggle('is-saved', isSaved);
}

// ---------------------------------------------------------- width matching

function matchWidth(item) {
  if (item.width_in === null) return;
  state.width = [
    round2(item.width_in - MATCH_TOLERANCE_IN),
    round2(item.width_in + MATCH_TOLERANCE_IN)
  ];
  state.sort = 'height-asc';
  state.matchOf = item.id;
  syncControls();
  apply();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderBanner() {
  if (!state.matchOf) { els.banner.hidden = true; return; }
  const source = collection.items.find((i) => i.id === state.matchOf);
  if (!source) { els.banner.hidden = true; return; }

  const clear = el('button', { class: 'ghost-button', type: 'button' }, 'Clear');
  clear.addEventListener('click', () => {
    state.width = null;
    state.matchOf = null;
    setRange('width', bounds.width[0], bounds.width[1]);
    apply();
  });
  els.banner.replaceChildren(
    el(
      'span',
      {},
      `Prints within ±${MATCH_TOLERANCE_IN}" of `,
      el('strong', {}, `${fmt(source.width_in)}"`),
      ` wide — the width of “${source.title}”.`
    ),
    clear
  );
  els.banner.hidden = false;
}

// ---------------------------------------------------------------- detail

function openDetail(item) {
  const img = el('div');
  if (item.thumbnail_url) {
    const picture = el('img', { src: item.thumbnail_url, alt: item.title, decoding: 'async' });
    img.append(picture);
    if (item.full_url) {
      img.append(
        el('p', { class: 'detail-note' },
          anchor(item.full_url, 'Open full-size scan from the Library →'))
      );
    }
  }

  const facts = el('dl', { class: 'detail-facts' });
  const addFact = (label, value) => {
    if (value === null || value === undefined || value === '') return;
    facts.append(el('dt', {}, label), el('dd', {}, value));
  };
  addFact('Size', item.width_in !== null
    ? `${fmt(item.width_in)}" wide × ${fmt(item.height_in)}" high${item.dim_confidence !== 'high' ? ' (approximate)' : ''}`
    : item.dimensions_raw || 'Not recorded');
  addFact('As catalogued', item.dimensions_raw);
  addFact('Date', item.date);
  addFact('Status', availabilityBadge(item));
  addFact('Series', item.series);
  addFact('Description', item.description);
  addFact('Notes', item.notes);

  const tags = el('div');
  for (const [facet, values] of Object.entries(item.facets)) {
    for (const value of values) tags.append(el('span', { class: 'tag', title: facet }, value));
  }
  if (tags.childElementCount) facts.append(el('dt', {}, 'Tags'), el('dd', {}, tags));

  const actions = el('div', { class: 'detail-actions' });
  if (item.permalink) {
    actions.append(el('a', { class: 'ghost-button', href: item.permalink, target: '_blank', rel: 'noopener noreferrer' }, 'Library record →'));
  }
  if (item.artist_url) {
    actions.append(el('a', { class: 'ghost-button', href: item.artist_url, target: '_blank', rel: 'noopener noreferrer' }, 'Artist site →'));
  }
  const saveBtn = el('button', { class: 'ghost-button', type: 'button' });
  paintSave(saveBtn, item);
  saveBtn.addEventListener('click', () => { toggleSave(item.id); paintSave(saveBtn, item); apply(); });
  actions.append(saveBtn);

  if (boards.active) actions.append(nominateButton(item, 'ghost-button'));

  if (item.width_in !== null) {
    const matchBtn = el('button', { class: 'ghost-button', type: 'button' }, `Find other ${fmt(item.width_in)}" widths`);
    matchBtn.addEventListener('click', () => { closeDetail(); matchWidth(item); });
    actions.append(matchBtn);
  }

  const info = el(
    'div',
    {},
    el('h2', { id: 'detail-title' }, item.title),
    el('p', { class: 'detail-artist' }, item.artist || 'Unknown artist'),
    facts,
    el('p', { class: 'detail-note' }, 'Check out this print through the Library, not through this page.'),
    actions
  );

  els.detailBody.replaceChildren(el('div', { class: 'detail-grid' }, img, info));
  els.detail.hidden = false;
}

function closeDetail() {
  els.detail.hidden = true;
}

// ------------------------------------------------------------ saved list

function loadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    return new Set();
  }
}

function toggleSave(id) {
  saved.has(id) ? saved.delete(id) : saved.add(id);
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...saved]));
  } catch {
    /* private browsing: the list just does not persist */
  }
}

// ------------------------------------------------------------- url state

function writeUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.width) p.set('w', state.width.join('-'));
  if (state.height) p.set('h', state.height.join('-'));
  if (state.available) p.set('avail', '1');
  if (state.savedOnly) p.set('saved', '1');
  if (state.hideUnsized) p.set('sized', '1');
  if (state.orientation) p.set('o', state.orientation);
  if (state.sort !== 'width-asc') p.set('sort', state.sort);
  if (state.view !== 'grid') p.set('view', state.view);
  if (state.matchOf) p.set('match', state.matchOf);
  if (state.boardId) p.set('board', state.boardId);
  for (const [facet, values] of Object.entries(state.facets)) {
    p.set(`f.${facet}`, [...values].join('|'));
  }
  const next = p.toString();
  if (next !== location.hash.slice(1)) {
    history.replaceState(null, '', next ? `#${next}` : location.pathname);
  }
}

function readUrl() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get('q') || '';
  state.width = parsePair(p.get('w'));
  state.height = parsePair(p.get('h'));
  state.available = p.get('avail') === '1';
  state.savedOnly = p.get('saved') === '1';
  state.hideUnsized = p.get('sized') === '1';
  state.orientation = p.get('o') || '';
  state.sort = p.get('sort') || 'width-asc';
  state.view = p.get('view') || 'grid';
  state.matchOf = p.get('match') || null;
  state.boardId = p.get('board') || null;
  state.facets = {};
  for (const [key, value] of p.entries()) {
    if (!key.startsWith('f.')) continue;
    state.facets[key.slice(2)] = new Set(value.split('|').filter(Boolean));
  }
  // Checked last: the board view has nothing to show without a board id, and
  // boardId is only known once every parameter above has been read.
  if (state.view === 'board' && !state.boardId) state.view = 'grid';
}

function parsePair(raw) {
  if (!raw) return null;
  const [a, b] = raw.split('-').map(Number);
  return isFinite(a) && isFinite(b) ? [a, b] : null;
}

/** Push `state` back out into every form control. */
function syncControls() {
  $('#q').value = state.q;
  $('#only-available').checked = state.available;
  $('#only-saved').checked = state.savedOnly;
  $('#hide-unsized').checked = state.hideUnsized;
  $('#orientation').value = state.orientation;
  $('#sort').value = state.sort;
  for (const b of document.querySelectorAll('.segmented button')) {
    b.classList.toggle('is-active', b.dataset.view === state.view);
  }
  els.viewBoard.hidden = !boards.active;
  for (const axis of ['width', 'height']) {
    const [lo, hi] = bounds[axis];
    const value = state[axis] || [lo, hi];
    setRange(axis, clamp(value[0], lo, hi), clamp(value[1], lo, hi));
  }
  for (const box of els.facets.querySelectorAll('input[type="checkbox"]')) {
    const facet = box.closest('.panel').querySelector('h2').textContent;
    box.checked = Boolean(state.facets[facet]?.has(box.value));
  }
}

function resetAll() {
  state.q = '';
  state.width = null;
  state.height = null;
  state.available = false;
  state.savedOnly = false;
  state.hideUnsized = false;
  state.orientation = '';
  state.facets = {};
  state.matchOf = null;
  syncControls();
  apply();
}

// --------------------------------------------------------------- group board

function renderBoardPanel() {
  const body = els.boardPanel;
  if (!body) return;

  if (!boards.configured) {
    body.replaceChildren(
      el('p', { class: 'panel-note' },
        'Not connected yet. Add your Supabase URL and anon key to ',
        el('code', {}, 'public/config.js'),
        ' to turn on shared boards.')
    );
    return;
  }

  if (boards.active) {
    const people = participants();
    const nameInput = el('input', {
      type: 'text', placeholder: 'your name', value: getName(), maxlength: '40'
    });
    nameInput.addEventListener('change', () => setName(nameInput.value));

    const copy = el('button', { class: 'ghost-button wide', type: 'button' }, 'Copy invite link');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inviteUrl());
        copy.textContent = 'Link copied';
        setTimeout(() => (copy.textContent = 'Copy invite link'), 1600);
      } catch {
        // Clipboard is blocked outside a secure context; show it to copy by hand.
        window.prompt('Copy this link:', inviteUrl());
      }
    });

    const addSaved = el('button', { class: 'ghost-button wide', type: 'button' },
      `Add my ${saved.size} saved pick${saved.size === 1 ? '' : 's'}`);
    addSaved.disabled = saved.size === 0;
    addSaved.addEventListener('click', async () => {
      addSaved.disabled = true;
      for (const id of saved) await nominate(id);
    });

    const leave = el('button', { class: 'link-button', type: 'button' }, 'Leave board');
    leave.addEventListener('click', () => {
      state.boardId = null;
      if (state.view === 'board') state.view = 'grid';
      leaveBoard();
      syncControls();
      apply();
    });

    body.replaceChildren(
      el('p', { class: 'board-name' }, boards.active.name),
      el('p', { class: 'panel-note' },
        `${boards.nominations.size} nominated` +
        (people.length ? ` · ${people.length} ${people.length === 1 ? 'person' : 'people'} in` : '')),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Vote as'), nameInput),
      copy,
      addSaved,
      leave
    );
    return;
  }

  const nameInput = el('input', { type: 'text', placeholder: 'name the board', maxlength: '80' });
  const start = el('button', { class: 'ghost-button wide', type: 'button' }, 'Start a group board');
  const go = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    start.disabled = true;
    start.textContent = 'Creating…';
    try {
      const id = await createBoard(name);
      state.boardId = id;
      state.view = 'board';
      syncControls();
      apply();
    } finally {
      start.disabled = false;
      start.textContent = 'Start a group board';
    }
  };
  start.addEventListener('click', go);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  // replaceChildren is the raw DOM method, so a null child would become the
  // text "null" -- filter before handing it over.
  body.replaceChildren(
    ...[
      el('p', { class: 'panel-note' },
        'Make a board, send the link to friends, and everyone nominates and votes.'),
      nameInput,
      start,
      boards.error ? el('p', { class: 'panel-error' }, boards.error) : null
    ].filter(Boolean)
  );
}

function renderBoardBar() {
  const bar = els.boardBar;
  if (!bar) return;
  if (!boards.active) { bar.hidden = true; return; }

  const open = el('button', { class: 'ghost-button', type: 'button' }, 'Open board');
  open.addEventListener('click', () => {
    state.view = 'board';
    syncControls();
    apply();
  });

  bar.replaceChildren(
    el('span', {},
      el('strong', {}, boards.active.name),
      ` — ${boards.nominations.size} nominated, ${totalVotes()} vote${totalVotes() === 1 ? '' : 's'} cast`),
    el('span', { class: 'board-bar-actions' },
      boards.error ? el('span', { class: 'panel-error' }, 'Sync problem — retrying') : null,
      open)
  );
  bar.hidden = false;
  els.viewBoard.hidden = false;
}

function totalVotes() {
  let n = 0;
  for (const list of boards.votes.values()) n += list.length;
  return n;
}

/** Nominated prints, ranked by score, with the voting controls. */
function renderBoardView() {
  const ids = [...boards.nominations.keys()];
  const byId = new Map(collection.items.map((i) => [i.id, i]));
  const entries = ids
    .map((id) => ({ id, item: byId.get(id), score: scoreFor(id) }))
    .filter((e) => e.item);
  entries.sort((a, b) =>
    b.score - a.score || votesFor(b.id).length - votesFor(a.id).length || a.item.title.localeCompare(b.item.title)
  );

  els.results.replaceChildren();
  if (!entries.length) {
    els.results.append(
      el('p', { class: 'empty' },
        'Nothing nominated yet. Browse in Grid or Table and hit “Nominate” on anything you like.')
    );
    return;
  }

  const top = entries[0].score;
  for (const [rank, entry] of entries.entries()) {
    // A leader only counts as a favourite once somebody has actually voted.
    const leading = top > 0 && entry.score === top;
    els.results.append(boardRow(entry, rank + 1, leading));
  }
}

function boardRow(entry, rank, leading) {
  const { id, item, score } = entry;
  const mine = myVote(id);

  const art = el('button', { class: 'board-thumb', type: 'button', title: 'View details' });
  if (item.thumbnail_url) {
    art.append(el('img', { src: item.thumbnail_url, alt: item.title, loading: 'lazy' }));
  }
  art.addEventListener('click', () => openDetail(item));

  const up = el('button', { class: `vote-button${mine === 1 ? ' is-on' : ''}`, type: 'button', title: 'Yes' }, '▲');
  up.addEventListener('click', () => vote(id, mine === 1 ? 0 : 1));
  const down = el('button', { class: `vote-button${mine === -1 ? ' is-on' : ''}`, type: 'button', title: 'No' }, '▼');
  down.addEventListener('click', () => vote(id, mine === -1 ? 0 : -1));

  const voters = votesFor(id);
  const yes = voters.filter((v) => v.value === 1).map((v) => v.voter_name);
  const no = voters.filter((v) => v.value === -1).map((v) => v.voter_name);

  const remove = el('button', { class: 'link-button', type: 'button' }, 'Remove');
  remove.addEventListener('click', () => unnominate(id));

  const meta = el('div', { class: 'board-meta' },
    el('h3', { class: 'card-title' }, item.title),
    el('p', { class: 'card-artist' }, item.artist || 'Unknown artist'),
    el('p', { class: 'board-dims' },
      item.width_in !== null
        ? `${fmt(item.width_in)}" w × ${fmt(item.height_in)}" h`
        : item.dimensions_raw || 'size unknown'),
    el('p', { class: 'panel-note' },
      `Added by ${boards.nominations.get(id)?.added_by || 'someone'}` +
      (yes.length ? ` · yes: ${yes.join(', ')}` : '') +
      (no.length ? ` · no: ${no.join(', ')}` : ''))
  );

  return el('article', { class: `board-row${leading ? ' is-leading' : ''}` },
    el('div', { class: 'board-rank' }, leading ? '★' : String(rank)),
    art,
    meta,
    el('div', { class: 'board-score' },
      up,
      el('span', { class: 'score-value' }, score > 0 ? `+${score}` : String(score)),
      down,
      remove)
  );
}

function showFreshness() {
  const m = collection.meta;
  const when = new Date(m.fetched_at);
  const days = Math.floor((Date.now() - when) / 86400000);
  const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  els.freshness.textContent = `Shelf status as of ${when.toLocaleDateString()} (${ago}) — ${m.available_count} of ${m.item_count} in`;
  els.freshness.title =
    'Availability is a snapshot taken when the data was last pulled from the Library, not live. Confirm on the Library record before making the trip.';
}

// ------------------------------------------------------------- utilities

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function anchor(href, text) {
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

function fmt(n) {
  if (typeof n !== 'number') return '—';
  return Number.isInteger(n) ? String(n) : String(round2(n));
}

const round2 = (n) => Math.round(n * 100) / 100;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const indexOrLast = (arr, v) => (arr.indexOf(v) === -1 ? arr.length : arr.indexOf(v));

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

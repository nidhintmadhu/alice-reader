// Alice reader: a graded reader for iPhone that works offline and keeps all progress on the phone.
import * as db from './db.js';

const APP_VERSION = '1.0.0';
const DEFAULT_PREFS = {
  fontSize: 19, theme: 'auto', markNew: true, markStory: true, markSaved: true,
  lastBackup: null, persistAsked: false,
};
const LEVEL_LABEL = { A1: 'A1', A2: 'A2', B1: 'B1', B2: 'B2', B2x: 'B2+', OUT: 'rare', F: 'grammar word', NAME: 'name', NUM: 'number' };
const POS_LABEL = {
  NOUN: 'noun', PROPN: 'name', VERB: 'verb', AUX: 'auxiliary verb', ADJ: 'adjective', ADV: 'adverb',
  ADP: 'preposition', DET: 'article', PRON: 'pronoun', NUM: 'number', CCONJ: 'conjunction',
  SCONJ: 'conjunction', PART: 'particle', INTJ: 'interjection', X: 'word',
};
const COMMON_GRAMMAR = new Set(['PRAES', 'KON_UND_ABER_ODER', 'W_FRAGE', 'PRAET_VOLL', 'PRAET_SEIN_HABEN']);
const ICON = {
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  words: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

const state = {
  meta: null, manifest: null, lexicon: {}, glosses: {}, prefs: { ...DEFAULT_PREFS },
  progress: new Map(), words: new Map(), voices: [], streak: 0, reader: null,
};
const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const backdrop = document.getElementById('sheet-backdrop');

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => fmtDate(new Date());
const mdInline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
const cleanEntry = (s) => String(s).split(',')[0].trim();

function articleFor(gender) {
  if (!gender) return '';
  const map = { m: 'der', f: 'die', n: 'das', pl: 'die' };
  return gender.split('/').map((g) => map[g] || '').filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('/');
}

function progressOf(num) {
  return state.progress.get(num) || { num, status: 'new', pct: 0, pos: 0, seconds: 0, updated: null };
}

function wordStatus(lemma) {
  return state.words.get(lemma)?.status || null;
}

function partOf(num) {
  return state.manifest.parts.find((p) => p.num === num);
}

function toast(msg, actionLabel, action, ms = 4500) {
  const el = document.getElementById('toast');
  el.innerHTML = `${esc(msg)}${actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  if (actionLabel) el.querySelector('button').onclick = () => { el.hidden = true; action(); };
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

async function savePrefs() {
  await db.put('settings', state.prefs, 'prefs');
}

function applyPrefs() {
  const root = document.documentElement;
  root.dataset.theme = state.prefs.theme;
  root.style.setProperty('--fs', `${state.prefs.fontSize}px`);
  const dark = state.prefs.theme === 'dark' || (state.prefs.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#111213' : (state.prefs.theme === 'sepia' ? '#f4ecd8' : '#fbfaf7');
}

function setMeta(meta) {
  state.meta = meta;
  state.manifest = meta.manifest;
  state.lexicon = meta.lexicon || {};
  state.glosses = meta.glosses || {};
}

// ------------------------------------------------------------------ start
async function init() {
  applyPrefs();
  try {
    await db.openDB();
  } catch (e) {
    app.innerHTML = `<div class="card"><h2>Storage is not available</h2><p>${esc(e.message || e)}</p><p class="muted">Private browsing can block storage. Open the app from the Home Screen icon.</p></div>`;
    return;
  }
  state.prefs = { ...DEFAULT_PREFS, ...((await db.get('settings', 'prefs')) || {}) };
  applyPrefs();
  const meta = await db.get('meta', 'book');
  if (meta) setMeta(meta);
  for (const p of await db.getAll('progress')) state.progress.set(p.num, p);
  for (const w of await db.getAll('words')) state.words.set(w.lemma, w);
  await computeStreak();
  window.addEventListener('hashchange', route);
  backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyPrefs);
  route();
  registerSW();
  loadVoices();
  maybePersist(false);
}

function route() {
  closeSheet();
  stopReading();
  const h = location.hash || '#/';
  if (!state.meta) { renderWelcome(); return; }
  const m = h.match(/^#\/read\/(\d+)/);
  if (m) { renderReader(Number(m[1])); return; }
  if (h.startsWith('#/words')) { renderWords(); return; }
  if (h.startsWith('#/settings')) { renderSettings(); return; }
  renderLibrary();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch(() => {});
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('A new version of the app is ready.', 'Reload', () => location.reload(), 10000);
    hadController = true;
  });
}

async function maybePersist(force) {
  if (!navigator.storage || !navigator.storage.persist) return;
  try {
    if (await navigator.storage.persisted()) return;
    if (!force && state.prefs.persistAsked) return;
    if (isIOS() && !isStandalone()) return;
    await navigator.storage.persist();
    state.prefs.persistAsked = true;
    await savePrefs();
  } catch (e) { /* not supported */ }
}

// ------------------------------------------------------------------ speech
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const set = () => { state.voices = speechSynthesis.getVoices().filter((v) => /^de([-_]|$)/i.test(v.lang)); };
  set();
  if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', set);
}

function speak(text) {
  if (!('speechSynthesis' in window)) { toast('Speech is not available on this device.'); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  const v = state.voices.find((x) => /de[-_]DE/i.test(x.lang)) || state.voices[0];
  if (v) u.voice = v;
  u.rate = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ------------------------------------------------------------------ welcome and book import
function renderWelcome() {
  const ios = isIOS();
  const sa = isStandalone();
  const showInstall = ios && !sa;
  app.innerHTML = `
    <div class="hero"><h1>Alice im Wunderland</h1><div class="sub">Leseroman A1 bis B2</div></div>
    ${showInstall ? `
    <div class="card">
      <h2>1. Install the app</h2>
      <ol class="steps">
        <li>Tap the <b>Share</b> button in Safari.</li>
        <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open <b>Alice</b> from the new icon on your Home Screen.</li>
      </ol>
      <div class="note">Load the book inside the installed app, not here in Safari. On iPhone, Safari and the installed app keep separate storage.</div>
    </div>` : ''}
    <div class="card">
      <h2>${showInstall ? '2. ' : ''}Load the book</h2>
      <p>Choose the book file (its name ends in <b>Book file for app-v1.json</b>) from the Files app. The book is saved on this phone only. Nothing is uploaded.</p>
      <button class="btn primary block" id="load-btn" type="button">Choose book file</button>
      <input type="file" id="book-file" hidden>
      <p id="load-status" class="small muted" aria-live="polite"></p>
    </div>
    <p class="small muted">Version ${APP_VERSION}</p>`;
  $('#load-btn').onclick = () => $('#book-file').click();
  $('#book-file').onchange = (e) => handleBookFile(e.target.files[0], $('#load-status'));
}

async function handleBookFile(file, statusEl) {
  if (!file) return;
  statusEl.textContent = 'Reading the file …';
  try {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('This file is not a book file (it is not JSON).'); }
    if (!data || data.format !== 'alice-book' || !Array.isArray(data.chapters) || !data.manifest) {
      throw new Error('This is not the Alice book file.');
    }
    statusEl.textContent = `Saving ${data.chapters.length} chapters …`;
    const meta = {
      manifest: data.manifest, lexicon: data.lexicon || {}, glosses: data.glosses || {},
      built: data.built || null, bookVersion: data.version || 1, loadedAt: new Date().toISOString(),
    };
    await db.replaceBook(meta, data.chapters);
    setMeta(meta);
    statusEl.textContent = 'Done.';
    toast('Book loaded. Viel Spaß beim Lesen!');
    await maybePersist(true);
    if (location.hash !== '#/') location.hash = '#/'; else route();
  } catch (e) {
    statusEl.innerHTML = `<span class="error">${esc(e.message || e)}</span>`;
  }
}

// ------------------------------------------------------------------ library
function statusIcon(p) {
  if (p.status === 'done') {
    return '<svg class="status" viewBox="0 0 26 26" role="img" aria-label="finished"><circle cx="13" cy="13" r="11" fill="var(--accent)"/><path d="M8 13.5l3.2 3.2L18.5 9.5" fill="none" stroke="var(--accent-text)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  const pct = Math.max(0, Math.min(1, p.pct || 0));
  const C = 2 * Math.PI * 10;
  const arc = pct > 0 ? `<circle cx="13" cy="13" r="10" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(pct * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 13 13)"/>` : '';
  return `<svg class="status" viewBox="0 0 26 26" role="img" aria-label="${Math.round(pct * 100)} percent read"><circle cx="13" cy="13" r="10" fill="none" stroke="var(--line)" stroke-width="3"/>${arc}</svg>`;
}

function continueTarget() {
  const reading = [...state.progress.values()].filter((p) => p.status === 'reading').sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  if (reading.length) return reading[0].num;
  const next = state.manifest.chapters.find((c) => progressOf(c.num).status !== 'done');
  return next ? next.num : null;
}

function renderLibrary() {
  const man = state.manifest;
  const chs = man.chapters;
  const done = chs.filter((c) => progressOf(c.num).status === 'done').length;
  const words = [...state.words.values()];
  const known = words.filter((w) => w.status === 'known').length;
  const minutes = Math.round([...state.progress.values()].reduce((s, p) => s + (p.seconds || 0), 0) / 60);
  const contNum = continueTarget();
  const cont = contNum ? chs.find((c) => c.num === contNum) : null;
  const contP = cont ? progressOf(cont.num) : null;
  const lastBackup = state.prefs.lastBackup ? new Date(state.prefs.lastBackup) : null;
  const backupDue = minutes >= 20 && (!lastBackup || (Date.now() - lastBackup.getTime()) > 30 * 864e5);

  const parts = man.parts.map((part) => {
    const rows = part.chapters.map((n) => {
      const c = chs.find((x) => x.num === n);
      if (!c) return '';
      const p = progressOf(n);
      return `<button class="ch-row" type="button" data-open="${n}">
        <span class="ch-num">${n}</span>
        <span class="ch-title"><b>${esc(c.title)}</b><span>${c.reading_minutes} min${p.status === 'reading' ? ` · ${Math.round((p.pct || 0) * 100)} %` : ''}</span></span>
        ${statusIcon(p)}
      </button>`;
    }).join('');
    return `<div class="part-head"><h2>${esc(part.label)}</h2><span class="badge lv-${part.level}">${part.level}</span><span class="muted">${esc(part.title || '')}</span></div><div class="chapters">${rows}</div>`;
  }).join('');

  app.innerHTML = `
    <header class="topbar">
      <div class="title">${esc(man.book?.title || 'Alice im Wunderland')}</div>
      <a class="icon-btn" href="#/words" aria-label="Saved words">${ICON.words}</a>
      <a class="icon-btn" href="#/settings" aria-label="Settings">${ICON.gear}</a>
    </header>
    <div class="stats">
      <div class="stat"><b>${done}</b><span>of ${chs.length} chapters</span></div>
      <div class="stat"><b>${known}</b><span>known words</span></div>
      <div class="stat"><b>${minutes}</b><span>minutes read</span></div>
      <div class="stat"><b>${state.streak}</b><span>day streak</span></div>
    </div>
    ${cont ? `
    <div class="card">
      <div class="continue">
        <div class="grow">
          <div class="k">${contP.status === 'reading' ? 'Continue reading' : 'Start'} · Kapitel ${cont.num} · ${cont.level}</div>
          <div class="t">${esc(cont.title)}</div>
          <div class="bar"><i style="width:${Math.round((contP.pct || 0) * 100)}%"></i></div>
        </div>
        <a class="btn primary" href="#/read/${cont.num}">${contP.status === 'reading' ? 'Continue' : 'Start'}</a>
      </div>
    </div>` : '<div class="card"><h2>You finished the book!</h2><p>Herzlichen Glückwunsch.</p></div>'}
    ${backupDue ? `<div class="note">Your progress lives only on this phone. <a href="#/settings">Save a backup</a> to Files or iCloud Drive.</div>` : ''}
    ${parts}`;
  app.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { location.hash = `#/read/${b.dataset.open}`; }; });
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ reader
function legendHTML() {
  const p = state.prefs;
  const items = [];
  if (p.markNew) items.push('<span class="s1">new word</span>');
  if (p.markStory) items.push('<span class="s2">story word</span>');
  if (p.markSaved) items.push('<span class="s3">saved word</span>');
  items.push('<span>Tap any word</span>');
  return `<div class="legend">${items.join('')}</div>`;
}

function chapterHTML(ch) {
  const prefs = state.prefs;
  const sents = ch.sentences;
  const newFirst = new Set((ch.new_vocab || []).filter((e) => e.first && !e.deferred).map((e) => `${e.first[0]}:${e.first[1]}`));
  const tokens = (si) => sents[si].tokens.map((t, ti) => {
    const [surf, lemma, pos, level, ws, , story] = t;
    if (pos === 'PUNCT' || level === 'PUNCT') return esc(surf) + ws;
    let cls = 'w';
    const st = wordStatus(lemma);
    if (prefs.markNew && newFirst.has(`${si}:${ti}`) && st !== 'known') cls += ' nw';
    if (prefs.markStory && story) cls += ' sw';
    if (prefs.markSaved && st === 'learning') cls += ' saved';
    return `<span class="${cls}" data-s="${si}" data-t="${ti}">${esc(surf)}</span>${ws}`;
  }).join('');
  const run = (a, z) => { let h = ''; for (let s = a; s < z; s += 1) h += tokens(s); return h; };
  return ch.blocks.map((b, bi) => {
    if (b.type === 'p') return `<p data-b="${bi}">${run(b.range[0], b.range[1])}</p>`;
    if (b.type === 'sign') {
      const lines = b.lines.map(([a, z]) => (a === null ? '<div>&nbsp;</div>' : `<div>${run(a, z)}</div>`)).join('');
      return `<div class="sign" data-b="${bi}">${lines}</div>`;
    }
    if (b.type === 'break') return `<div class="scene" data-b="${bi}" role="separator" aria-label="scene break">* * *</div>`;
    return '';
  }).join('');
}

function endCardHTML(ch, info) {
  const p = progressOf(info.num);
  const g = info.grammar_new || [];
  const notes = ch.notes?.grammar || [];
  const story = ch.notes?.story_words || [];
  const nv = (ch.new_vocab || []).filter((e) => !e.deferred && e.first);
  const next = state.manifest.chapters.find((c) => c.num === info.num + 1);
  return `<section class="card end-card" data-b="end">
    <h2>Ende von Kapitel ${info.num}</h2>
    ${g.length ? `<h3>New grammar in this chapter</h3><div class="chips">${g.map((x) => `<span class="chip hl">${esc(x.de)}</span>`).join('')}</div>` : '<p class="muted">This chapter repeats the grammar of the part.</p>'}
    ${notes.length ? `<div class="grammar-notes">${notes.map((n) => `<p>${mdInline(n)}</p>`).join('')}</div>` : ''}
    ${story.length ? `<h3>Story words</h3><table class="glossary">${story.map((s) => `<tr><td>${esc(s.word)}</td><td>${esc(s.gloss || '')}</td></tr>`).join('')}</table>` : ''}
    ${nv.length ? `<h3>New words in this chapter (${nv.length})</h3><p class="small muted">Tap a word to find it in the text.</p><div class="chips">${nv.map((e) => `<button class="chip" type="button" data-jump="${e.first[0]}:${e.first[1]}">${esc(cleanEntry(e.entry))}</button>`).join('')}</div>` : ''}
    <div class="btn-row">
      <button class="btn primary" id="finish" type="button">${p.status === 'done' ? 'Finished ✓' : 'Mark as finished'}</button>
      ${next ? `<a class="btn" href="#/read/${next.num}">Next: Kapitel ${next.num}</a>` : '<a class="btn" href="#/">Back to the book</a>'}
    </div>
  </section>`;
}

async function renderReader(num) {
  const info = state.manifest.chapters.find((c) => c.num === num);
  if (!info) { location.hash = '#/'; return; }
  const ch = await db.get('chapters', num);
  if (!ch) {
    app.innerHTML = `<div class="card"><h2>Chapter missing</h2><p>Load the book file again in Settings.</p><a class="btn" href="#/settings">Settings</a></div>`;
    return;
  }
  const part = partOf(info.part);
  const p = progressOf(num);
  state.reader = {
    num, ch, info, activeEl: null, visible: new Set(), lastActive: Date.now(), pending: 0,
    storyGloss: new Map((ch.notes?.story_words || []).map((s) => [s.lemma, s])),
    blocks: ch.blocks.length,
  };
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back to the book">${ICON.back}</a>
      <div class="title">Kapitel ${num}</div>
      <button class="icon-btn" id="aa" type="button" aria-label="Text settings">Aa</button>
    </header>
    <div class="reader-head">
      <div class="kicker">${esc(part?.label || '')} · ${esc(part?.title || '')}</div>
      <h1>${esc(info.title)}</h1>
      <div class="meta"><span class="badge lv-${info.level}">${info.level}</span><span>${info.reading_minutes} min</span><span>${info.words.toLocaleString('en')} words</span></div>
    </div>
    ${legendHTML()}
    <article class="text" id="text" lang="de">${chapterHTML(ch)}</article>
    ${endCardHTML(ch, info)}`;

  $('#text').addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (w) openWordSheet(Number(w.dataset.s), Number(w.dataset.t), w);
  });
  $('#aa').onclick = openTextSettings;
  $('#finish').onclick = () => finishChapter(num);
  app.querySelectorAll('[data-jump]').forEach((b) => {
    b.onclick = () => {
      const [s, t] = b.dataset.jump.split(':');
      const el = app.querySelector(`.w[data-s="${s}"][data-t="${t}"]`);
      if (!el) return;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3, behavior: 'smooth' });
      setTimeout(() => openWordSheet(Number(s), Number(t), el), 350);
    };
  });

  if (p.status !== 'done' && p.status !== 'reading') {
    await saveProgress({ ...p, status: 'reading', updated: new Date().toISOString() });
  }
  const restore = () => {
    if (p.pos > 0) {
      const el = app.querySelector(`[data-b="${p.pos}"]`);
      if (el) { window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 76); return; }
    }
    window.scrollTo(0, 0);
  };
  requestAnimationFrame(() => requestAnimationFrame(restore));
  startReading();
}

async function saveProgress(p) {
  state.progress.set(p.num, p);
  await db.put('progress', p);
}

function startReading() {
  const r = state.reader;
  if (!r) return;
  r.observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const b = en.target.dataset.b;
      if (en.isIntersecting) r.visible.add(b); else r.visible.delete(b);
    }
    r.lastActive = Date.now();
    schedulePositionSave();
  }, { rootMargin: '-70px 0px -35% 0px' });
  app.querySelectorAll('[data-b]').forEach((el) => r.observer.observe(el));
  r.onActivity = () => { r.lastActive = Date.now(); };
  window.addEventListener('scroll', r.onActivity, { passive: true });
  window.addEventListener('touchstart', r.onActivity, { passive: true });
  r.timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - r.lastActive > 120000) return;
    r.pending += 5;
    if (r.pending >= 30) flushTime();
  }, 5000);
  r.onHide = () => { if (document.visibilityState === 'hidden') { flushTime(); flushPosition(); } };
  document.addEventListener('visibilitychange', r.onHide);
}

function stopReading() {
  const r = state.reader;
  if (!r) return;
  clearInterval(r.timer);
  clearTimeout(r.posTimer);
  if (r.observer) r.observer.disconnect();
  window.removeEventListener('scroll', r.onActivity);
  window.removeEventListener('touchstart', r.onActivity);
  document.removeEventListener('visibilitychange', r.onHide);
  flushTime();
  flushPosition();
  state.reader = null;
}

function currentBlock() {
  const r = state.reader;
  if (!r || !r.visible.size) return null;
  if (r.visible.has('end')) return 'end';
  return Math.min(...[...r.visible].filter((x) => x !== 'end').map(Number));
}

function schedulePositionSave() {
  const r = state.reader;
  if (!r) return;
  clearTimeout(r.posTimer);
  r.posTimer = setTimeout(flushPosition, 1200);
}

function flushPosition() {
  const r = state.reader;
  if (!r) return;
  const b = currentBlock();
  if (b === null) return;
  const p = progressOf(r.num);
  const pos = b === 'end' ? Math.max(0, r.blocks - 1) : b;
  const pct = b === 'end' ? 1 : Math.min(0.99, (pos + 1) / r.blocks);
  if (pos === p.pos && Math.abs((p.pct || 0) - pct) < 0.005) return;
  saveProgress({ ...p, pos, pct: p.status === 'done' ? 1 : pct, status: p.status === 'done' ? 'done' : 'reading', updated: new Date().toISOString() });
}

async function flushTime() {
  const r = state.reader;
  if (!r || !r.pending) return;
  const secs = r.pending;
  r.pending = 0;
  const p = progressOf(r.num);
  await saveProgress({ ...p, seconds: (p.seconds || 0) + secs, updated: new Date().toISOString() });
  const d = (await db.get('daily', today())) || { date: today(), seconds: 0 };
  d.seconds += secs;
  await db.put('daily', d);
  await computeStreak();
}

async function computeStreak() {
  const days = new Map((await db.getAll('daily')).map((d) => [d.date, d.seconds]));
  const d = new Date();
  if (!((days.get(fmtDate(d)) || 0) >= 60)) d.setDate(d.getDate() - 1);
  let n = 0;
  while ((days.get(fmtDate(d)) || 0) >= 60) { n += 1; d.setDate(d.getDate() - 1); }
  state.streak = n;
}

async function finishChapter(num) {
  const p = progressOf(num);
  await saveProgress({ ...p, status: 'done', pct: 1, updated: new Date().toISOString() });
  const btn = $('#finish');
  if (btn) btn.textContent = 'Finished ✓';
  toast(`Kapitel ${num} finished. Super!`);
}

// ------------------------------------------------------------------ word sheet
function openSheet(html, label) {
  sheet.innerHTML = `<div class="grab"></div>${html}`;
  sheet.setAttribute('aria-label', label || 'Details');
  sheet.hidden = false;
  backdrop.hidden = false;
}

function closeSheet() {
  if (sheet.hidden) return;
  sheet.hidden = true;
  backdrop.hidden = true;
  const r = state.reader;
  if (r && r.activeEl) { r.activeEl.classList.remove('on'); r.activeEl = null; }
}

function sentenceText(sentence, boldIndex = -1) {
  return sentence.tokens.map((t, i) => (i === boldIndex ? `<b>${esc(t[0])}</b>${t[4]}` : esc(t[0]) + t[4])).join('');
}

function plainSentence(sentence) {
  return sentence.tokens.map((t) => t[0] + t[4]).join('').trim();
}

function grammarChips(grammar, info) {
  const codes = Object.keys(grammar || {});
  const newCodes = new Set((info.grammar_new || []).map((g) => g.code));
  const shown = codes.filter((c) => newCodes.has(c) || !COMMON_GRAMMAR.has(c)).slice(0, 5);
  if (!shown.length) return '';
  const gc = state.manifest.grammar_codes || {};
  return `<div class="chips">${shown.map((c) => `<span class="chip${newCodes.has(c) ? ' hl' : ''}">${esc(gc[c]?.de || c)}</span>`).join('')}</div>`;
}

function openWordSheet(si, ti, el) {
  const r = state.reader;
  if (!r) return;
  const sentence = r.ch.sentences[si];
  const tok = sentence.tokens[ti];
  const [surf, lemma, pos, level, , , story] = tok;
  if (r.activeEl) r.activeEl.classList.remove('on');
  el.classList.add('on');
  r.activeEl = el;
  const lx = state.lexicon[lemma] || null;
  const gender = lx ? lx[2] : null;
  const plural = lx ? lx[3] : null;
  const firstCh = lx ? lx[4] : null;
  const art = pos === 'NOUN' ? articleFor(gender) : '';
  const sg = r.storyGloss.get(lemma) || r.storyGloss.get(surf);
  const gloss = state.glosses[lemma] || (sg && sg.gloss) || null;
  const st = wordStatus(lemma);
  let lemmaLine = '';
  if (pos === 'NOUN') lemmaLine = `${art ? `${esc(art)} ` : ''}<b>${esc(lemma)}</b>${plural ? `, Plural: die ${esc(plural)}` : ''}`;
  else if (lemma && lemma.toLowerCase() !== surf.toLowerCase()) lemmaLine = `from <b>${esc(lemma)}</b>`;
  const where = [];
  if (story) where.push('story word');
  if (firstCh && firstCh === r.num) where.push('new in this chapter');
  else if (firstCh) where.push(`first in Kapitel ${firstCh}`);
  const speech = 'speechSynthesis' in window;
  openSheet(`
    <div class="word" lang="de">${esc(surf)}</div>
    ${lemmaLine ? `<div class="lemma" lang="de">${lemmaLine}</div>` : ''}
    <div class="info"><span class="badge lv-${esc(level)}">${esc(LEVEL_LABEL[level] || level)}</span><span>${esc(POS_LABEL[pos] || 'word')}</span>${where.length ? `<span>· ${esc(where.join(' · '))}</span>` : ''}</div>
    <div class="gloss${gloss ? '' : ' none'}">${gloss ? esc(gloss) : (level === 'NAME' ? 'A name.' : (level === 'NUM' ? 'A number.' : 'No translation yet.'))}</div>
    <div class="sentence" lang="de">${sentenceText(sentence, ti)}</div>
    ${grammarChips(sentence.grammar, r.info)}
    <div class="btn-row">
      ${speech ? '<button class="btn" type="button" id="say-word">▶ Word</button><button class="btn" type="button" id="say-sent">▶ Sentence</button>' : ''}
    </div>
    <div class="btn-row">
      <button class="btn${st === 'learning' ? ' on' : ''}" type="button" id="w-save">${st === 'learning' ? '★ Saved' : '☆ Save word'}</button>
      <button class="btn${st === 'known' ? ' on' : ''}" type="button" id="w-known">${st === 'known' ? '✓ Known' : 'I know it'}</button>
    </div>`, `Word ${surf}`);
  if (speech) {
    $('#say-word').onclick = () => speak(surf);
    $('#say-sent').onclick = () => speak(plainSentence(sentence));
  }
  const entry = { lemma, surface: surf, chapter: r.num, sentence: plainSentence(sentence), gloss: gloss || '', level, pos, article: art };
  $('#w-save').onclick = () => setWordStatus(entry, st === 'learning' ? null : 'learning').then(() => openWordSheet(si, ti, el));
  $('#w-known').onclick = () => setWordStatus(entry, st === 'known' ? null : 'known').then(() => openWordSheet(si, ti, el));
}

async function setWordStatus(entry, status) {
  if (!status) {
    state.words.delete(entry.lemma);
    await db.del('words', entry.lemma);
  } else {
    const prev = state.words.get(entry.lemma);
    const rec = { ...(prev || {}), ...entry, status, added: prev?.added || new Date().toISOString(), changed: new Date().toISOString() };
    state.words.set(entry.lemma, rec);
    await db.put('words', rec);
  }
  refreshWordMarks(entry.lemma);
}

function refreshWordMarks(lemma) {
  const r = state.reader;
  if (!r) return;
  const st = wordStatus(lemma);
  app.querySelectorAll('#text .w').forEach((el) => {
    const t = r.ch.sentences[Number(el.dataset.s)].tokens[Number(el.dataset.t)];
    if (t[1] !== lemma) return;
    el.classList.toggle('saved', state.prefs.markSaved && st === 'learning');
    if (st === 'known') el.classList.remove('nw');
  });
}

// ------------------------------------------------------------------ text settings (in the reader)
function segHTML(id, options, value) {
  return `<div class="seg" id="${id}">${options.map(([v, label]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

function switchHTML(id, checked, label) {
  return `<div class="set-row"><label for="${id}">${label}</label><span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span></div>`;
}

const SIZES = [[17, 'S'], [19, 'M'], [21, 'L'], [24, 'XL']];
const THEMES = [['auto', 'Auto'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']];

function bindPrefControls(root, onChange) {
  root.querySelectorAll('#seg-size button').forEach((b) => {
    b.onclick = async () => { state.prefs.fontSize = Number(b.dataset.v); applyPrefs(); await savePrefs(); onChange('size'); };
  });
  root.querySelectorAll('#seg-theme button').forEach((b) => {
    b.onclick = async () => { state.prefs.theme = b.dataset.v; applyPrefs(); await savePrefs(); onChange('theme'); };
  });
  for (const [id, key] of [['t-new', 'markNew'], ['t-story', 'markStory'], ['t-saved', 'markSaved']]) {
    const el = root.querySelector(`#${id}`);
    if (el) el.onchange = async () => { state.prefs[key] = el.checked; await savePrefs(); onChange('marks'); };
  }
}

function prefControlsHTML() {
  const p = state.prefs;
  return `
    <div class="set-row"><span>Text size</span>${segHTML('seg-size', SIZES, p.fontSize)}</div>
    <div class="set-row"><span>Theme</span>${segHTML('seg-theme', THEMES, p.theme)}</div>
    ${switchHTML('t-new', p.markNew, 'Mark the chapter\'s new words')}
    ${switchHTML('t-story', p.markStory, 'Mark story words')}
    ${switchHTML('t-saved', p.markSaved, 'Highlight saved words')}`;
}

function openTextSettings() {
  openSheet(`<h2 style="margin:4px 0 8px">Text</h2>${prefControlsHTML()}`, 'Text settings');
  bindPrefControls(sheet, (what) => {
    if (what === 'marks' && state.reader) {
      const r = state.reader;
      const keep = window.scrollY;
      $('#text').innerHTML = chapterHTML(r.ch);
      const lg = app.querySelector('.legend');
      if (lg) lg.outerHTML = legendHTML();
      window.scrollTo(0, keep);
      r.observer.disconnect();
      app.querySelectorAll('[data-b]').forEach((el) => r.observer.observe(el));
    }
    openTextSettings();
  });
}

// ------------------------------------------------------------------ saved words
function renderWords(tab) {
  const current = tab || (location.hash.includes('known') ? 'known' : 'learning');
  const list = [...state.words.values()].filter((w) => w.status === current).sort((a, b) => String(b.changed || b.added).localeCompare(String(a.changed || a.added)));
  const nLearning = [...state.words.values()].filter((w) => w.status === 'learning').length;
  const nKnown = [...state.words.values()].filter((w) => w.status === 'known').length;
  const rows = list.map((w) => `
    <div class="list-row">
      <div class="grow"><b lang="de">${w.article ? `${esc(w.article)} ` : ''}${esc(w.lemma)}</b><span>${esc(w.gloss || w.sentence || '')}</span></div>
      <span class="badge lv-${esc(w.level)}">${esc(LEVEL_LABEL[w.level] || w.level || '')}</span>
      <button class="icon-btn" type="button" data-del="${esc(w.lemma)}" aria-label="Remove ${esc(w.lemma)}">✕</button>
    </div>`).join('');
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back to the book">${ICON.back}</a>
      <div class="title">Words</div>
    </header>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" data-tab="learning" class="${current === 'learning' ? 'on' : ''}">Saved (${nLearning})</button>
      <button type="button" role="tab" data-tab="known" class="${current === 'known' ? 'on' : ''}">Known (${nKnown})</button>
    </div>
    <div class="list">${rows || `<div class="empty">${current === 'learning' ? 'No saved words yet. Tap a word while reading and choose “Save word”.' : 'No known words yet. Tap a word and choose “I know it”.'}</div>`}</div>
    <p class="small muted">Flashcard training with spaced repetition comes in the next version.</p>`;
  app.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => renderWords(b.dataset.tab); });
  app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      state.words.delete(b.dataset.del);
      await db.del('words', b.dataset.del);
      renderWords(current);
    };
  });
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ settings, backup, restore
async function storageInfo() {
  if (!navigator.storage) return 'not available';
  try {
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const mb = est && est.usage ? `${(est.usage / 1048576).toFixed(1)} MB used` : '';
    return `${persisted ? 'Protected (persistent storage)' : 'Not protected yet'}${mb ? ` · ${mb}` : ''}`;
  } catch (e) { return 'unknown'; }
}

async function renderSettings() {
  const lb = state.prefs.lastBackup ? new Date(state.prefs.lastBackup).toLocaleDateString() : 'never';
  app.innerHTML = `
    <header class="topbar">
      <a class="icon-btn" href="#/" aria-label="Back to the book">${ICON.back}</a>
      <div class="title">Settings</div>
    </header>
    <div class="card"><h2>Reading</h2>${prefControlsHTML()}</div>
    <div class="card">
      <h2>Your progress</h2>
      <p class="small">Progress is saved only on this phone. A backup file keeps it safe if the phone is reset or replaced.</p>
      <p class="small muted">Last backup: ${esc(lb)}<br>Storage: <span id="st-info">checking …</span></p>
      <div class="btn-row">
        <button class="btn primary" id="backup" type="button">Save backup</button>
        <button class="btn" id="restore" type="button">Restore backup</button>
      </div>
      <input type="file" id="restore-file" hidden>
      <p id="restore-status" class="small" aria-live="polite"></p>
    </div>
    <div class="card">
      <h2>Book</h2>
      <p class="small muted">${esc(state.manifest.book?.title || '')}, ${state.manifest.chapters.length} chapters. Loaded ${state.meta.loadedAt ? esc(new Date(state.meta.loadedAt).toLocaleDateString()) : ''}.</p>
      <button class="btn block" id="reload-book" type="button">Load a new book file</button>
      <input type="file" id="book-file" hidden>
      <p id="load-status" class="small muted" aria-live="polite"></p>
    </div>
    <div class="card">
      <h2>Start over</h2>
      <p class="small">Deletes reading progress and saved words on this phone. The book stays.</p>
      <button class="btn danger block" id="reset" type="button">Delete my progress</button>
    </div>
    <p class="small muted">Alice Leseroman, app version ${APP_VERSION}. Works offline after the first start.</p>`;
  bindPrefControls(app, () => renderSettings());
  $('#st-info').textContent = await storageInfo();
  $('#backup').onclick = exportBackup;
  $('#restore').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = (e) => importBackup(e.target.files[0], $('#restore-status'));
  $('#reload-book').onclick = () => $('#book-file').click();
  $('#book-file').onchange = (e) => handleBookFile(e.target.files[0], $('#load-status'));
  let armed = false;
  $('#reset').onclick = async () => {
    if (!armed) { armed = true; $('#reset').textContent = 'Tap again to delete everything'; setTimeout(() => { armed = false; const b = $('#reset'); if (b) b.textContent = 'Delete my progress'; }, 4000); return; }
    await db.clear('progress'); await db.clear('words'); await db.clear('daily');
    state.progress.clear(); state.words.clear(); state.streak = 0;
    toast('Progress deleted.');
    location.hash = '#/';
  };
}

async function exportBackup() {
  const data = {
    format: 'alice-progress', version: 1, app: APP_VERSION, exported: new Date().toISOString(),
    progress: await db.getAll('progress'), words: await db.getAll('words'), daily: await db.getAll('daily'),
    prefs: state.prefs,
  };
  const name = `alice-backup-${today()}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  let shared = false;
  try {
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Alice backup' });
      shared = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  if (!shared) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  state.prefs.lastBackup = new Date().toISOString();
  await savePrefs();
  toast('Backup saved.');
  if (location.hash.startsWith('#/settings')) renderSettings();
}

async function importBackup(file, statusEl) {
  if (!file) return;
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { throw new Error('This is not a backup file.'); }
    if (!data || data.format !== 'alice-progress') throw new Error('This is not an Alice backup file.');
    await db.clear('progress'); await db.putMany('progress', data.progress || []);
    await db.clear('words'); await db.putMany('words', data.words || []);
    await db.clear('daily'); await db.putMany('daily', data.daily || []);
    if (data.prefs) { state.prefs = { ...DEFAULT_PREFS, ...data.prefs, persistAsked: state.prefs.persistAsked }; await savePrefs(); applyPrefs(); }
    state.progress = new Map((data.progress || []).map((p) => [p.num, p]));
    state.words = new Map((data.words || []).map((w) => [w.lemma, w]));
    await computeStreak();
    statusEl.textContent = `Restored: ${state.progress.size} chapters, ${state.words.size} words.`;
    toast('Backup restored.');
  } catch (e) {
    statusEl.innerHTML = `<span class="error">${esc(e.message || e)}</span>`;
  }
}

init();

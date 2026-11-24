// Opposito Zones: everything persists under one key -- in the CrazyGames data module when the SDK is
// there (synced to the player's account, as CrazyGames requires), otherwise in localStorage.
(function () {
  'use strict';
  const OP = window.OP;
  const KEY = 'oppositozones.save.v1'; // own key: Opposito runs on the same origin and must never share progress

  function defaults() {
    return {
      coins: 0,
      level: 1,
      skin: 'fireice',
      owned: ['fireice'],
      boosters: { hint: 3, check: 2, reveal: 1 },
      settings: { sound: true, music: true, auto: true },
      free: { n: 6, diff: 1, count: 0 },
      daily: { streak: 0, last: null, solved: null, dates: [] }, // solved: { date, time }
      login: { day: 0, last: null },
      lastAdAt: 0,
      cur: null, // { levels|free|daily: { key, pz, board, hist, elapsed, level } }
    };
  }

  function merge(base, data) {
    if (!data || typeof data !== 'object') return base;
    for (const k in base) {
      if (!(k in data)) continue;
      const b = base[k], d = data[k];
      if (b && typeof b === 'object' && !Array.isArray(b) && d && typeof d === 'object' && !Array.isArray(d)) base[k] = merge(b, d);
      else if (b === null || typeof d === typeof b || (Array.isArray(b) && Array.isArray(d))) base[k] = d;
    }
    return base;
  }

  // The data module has the localStorage API. If it is unavailable (Progress Save not enabled on the
  // portal, or any error), fall back to localStorage for good.
  let cgData = (OP.cg && OP.cg.sdk && OP.cg.sdk.data) || null;
  function getRaw() {
    if (cgData) {
      try {
        const r = cgData.getItem(KEY);
        if (r != null) return r;
        // First run with the data module: carry over a save made before it was used.
        let old = null; try { old = window.localStorage.getItem(KEY); } catch (e) { /* ignore */ }
        if (old) { try { cgData.setItem(KEY, old); } catch (e) { /* ignore */ } }
        return old;
      } catch (e) { cgData = null; }
    }
    return window.localStorage.getItem(KEY);
  }
  function setRaw(v) {
    if (cgData) { try { cgData.setItem(KEY, v); return; } catch (e) { cgData = null; } }
    window.localStorage.setItem(KEY, v);
  }

  let data = defaults();
  try {
    const raw = getRaw();
    if (raw) data = merge(defaults(), JSON.parse(raw));
  } catch (e) { /* storage unavailable: play without saving */ }
  if (!data.lastAdAt) data.lastAdAt = Date.now(); // no ad break in the first minutes of a fresh install

  let timer = null;
  function write() {
    clearTimeout(timer); timer = null;
    try { setRaw(JSON.stringify(data)); } catch (e) { /* quota or private mode */ }
  }

  OP.save = {
    get d() { return data; },
    persist() { write(); },
    soon() { if (!timer) timer = setTimeout(write, 120); },
    reset() {
      const keepSettings = data.settings;
      data = defaults();
      data.settings = keepSettings;
      data.lastAdAt = Date.now();
      write();
    },
  };
  window.addEventListener('pagehide', write);
  document.addEventListener('visibilitychange', () => { if (document.hidden) write(); });
})();

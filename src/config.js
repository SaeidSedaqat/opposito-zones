// Opposito Zones: game constants, economy and the level / daily curves.
(function () {
  'use strict';
  const OP = (window.OP = window.OP || {});

  const DIFFS = ['Easy', 'Medium', 'Hard', 'Expert'];

  // Hand-made boards: 0 = Fire, 1 = Ice, -1 = empty. zones: lists of cell indexes.
  const I = 1, F = 0, E = -1;
  const FIXED = {
    // Level 1: rows and columns only (zones come in level 2).
    1: { n: 4, zones: [], givens: [E, F, F, I, F, I, I, F, I, F, F, I, E, I, I, F],
      sol: [I, F, F, I, F, I, I, F, I, F, F, I, F, I, I, F] },
    // Level 2: the zone tutorial. Zones: 0 = {0,1}, 1 = {2,3,6,7}, 2 = {4,8,12,13}, 3 = {5,9,10,14}, 4 = {11,15}.
    2: { n: 4, zones: [[0, 1], [2, 3, 6, 7], [4, 8, 12, 13], [5, 9, 10, 14], [11, 15]],
      givens: [E, I, F, E, I, F, I, F, F, I, I, F, E, F, F, I],
      sol: [F, I, F, I, I, F, I, F, F, I, I, F, I, F, F, I] },
  };
  // Guided steps, in order: the one cell the player may tap, the piece it needs, the row/column
  // (line: 0-3 rows, 4-7 columns) or zone to spotlight, and what the message says ({A}/{B} = the
  // skin's piece names). A step whose piece is B on an empty cell is taught as a double tap.
  const GUIDE1 = [
    { i: 12, v: F, line: 3, say: 'Each row needs as many {A} as {B}.<br>Tap here to place {A}!' },
    { i: 0, v: I, line: 4, say: 'Columns too! This one needs {B}.<br>Double tap to get {B}.' },
  ];
  const GUIDE2 = [
    { i: 0, v: F, zone: 0, say: 'Zones need balance too! These two share a zone, so they are opposites.<br>Tap here to place {A}!' },
    { i: 3, v: I, zone: 1, say: 'This zone already has 2 {A}, so the rest is {B}.<br>Double tap to get {B}.' },
    { i: 12, v: I, zone: 2, say: 'This zone has its 2 {A} too.<br>Double tap to get {B}.' },
  ];

  // Levels and Daily use 4x4 and 6x6 only: on a 390 px wide phone an 8x8 board would have 42 px tiles,
  // below the 54 px minimum (8x8 is Free Play on big screens). Level 1 is the guided row/column tutorial, level 2 the guided zone
  // tutorial, 3-5 easy 4x4 zone boards and 6 the first 6x6. From level 2 on every board has zones.
  function levelSpec(L) {
    let s;
    if (L === 1) s = { n: 4, diff: 1, tut: 1, fixed: FIXED[1], guide: GUIDE1, done: 'Perfect! Every row and column is balanced.' };
    else if (L === 2) s = { n: 4, diff: 1, tut: 2, fixed: FIXED[2], guide: GUIDE2, done: 'Perfect! Every zone is balanced too.' };
    else if (L <= 5) s = { n: 4, diff: 1, extra: [2, 1, 0][L - 3] };
    else if (L <= 10) s = { n: 6, diff: 1, extra: [6, 5, 4, 3, 2][L - 6] }; // first 6x6 boards start with extra givens, easing off each level
    else if (L <= 15) s = { n: 6, diff: 1 };
    else if (L <= 25) s = { n: 6, diff: 2 };
    else if (L <= 40) s = { n: 6, diff: L % 3 === 0 ? 3 : 2 };
    else if (L < 60) s = { n: 6, diff: L % 2 ? 3 : 2 };
    else if (L < 90) s = { n: 6, diff: 3 };
    else if (L < 130) s = { n: 6, diff: L % 3 === 0 ? 4 : 3 };
    else s = { n: 6, diff: L % 2 ? 4 : 3 };
    // Every 5th level is one step easier.
    if (L > 5 && L % 5 === 1) s.diff = Math.max(1, s.diff - 1);
    s.seed = 'zlevel-' + L;
    return s;
  }

  // Daily: always 6x6, Hard or Medium by weekday. No boosters (game.js).
  const DAILY = [3, 2, 3, 2, 3, 2, 3]; // Sun..Sat
  function pad(x) { return (x < 10 ? '0' : '') + x; }
  function today() {
    const d = new Date();
    let y = d.getFullYear(), m = d.getMonth(), day = d.getDate(), wd = d.getDay();
    if (!isFinite(y)) { y = d.getUTCFullYear(); m = d.getUTCMonth(); day = d.getUTCDate(); wd = d.getUTCDay(); }
    return { key: y + '-' + pad(m + 1) + '-' + pad(day), y, m, day, wd };
  }
  function dayKeyOffset(key, off) {
    const p = key.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + off));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function dailySpec(t) { return { n: 6, diff: DAILY[t.wd], seed: 'zdaily-' + t.key }; }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dateLabel(t) { return MONTHS[t.m] + ' ' + t.day + ', ' + t.y; }

  OP.config = {
    VERSION: '0.2.27',
    DIFFS,
    SIZES: [4, 6, 8],
    coins: [0, 10, 20, 30, 50],      // by diff (1..4)
    // Free Play pays about half of Levels (it never runs out), more for bigger and harder boards.
    freeCoins: { 4: [2, 4], 6: [5, 10, 15, 20], 8: [8, 15, 20, 30] },
    tutorialCoins: 10,
    drop: [0, 0, 0, 0.25, 0.4],      // bonus booster chance by diff (Levels only)
    adGives: { hint: 3, check: 2, reveal: 1 },
    boosterPrice: { hint: 40, check: 50, reveal: 60 }, // coins for the same pack an ad gives
    adCooldown: 180000,
    unlockLevel: 10,                 // Free Play and Daily Play open after this level is beaten
    adSeconds: 3,
    login: [
      { coins: 50 }, { skin: 'catdog' }, { coins: 75 }, { skin: 'ninjapirate' },
      { coins: 100 }, { coins: 150 }, { skin: 'swordshield' },
    ],
    freeReward(n, diff) { const r = this.freeCoins[n]; return (r && r[diff - 1]) || 0; },
    // Levels pay the Free Play rate for the same size and difficulty.
    levelReward(n, diff) { const r = this.freeCoins[n] || [10]; return diff <= r.length ? r[diff - 1] : r[r.length - 1] + 5 * (diff - r.length); },
    levelSpec, dailySpec, today, dayKeyOffset, dateLabel,
  };
})();

// Opposito Zones: the Phaser board renderer plus the OP.game controller that drives it.
(function () {
  'use strict';
  const OP = window.OP;
  const C = OP.config;
  const S = () => OP.save.d;
  const skin = () => OP.skins.get(S().skin);
  function curObj() { const d = S(); if (!d.cur) d.cur = {}; return d.cur; }

  // ---------- module state ----------
  let scene = null, curL = null;
  let mode = null, curSpec = null, pz = null, board = null, hist = [], elapsed = 0, solved = false;
  let armed = null, adPaused = false;
  let dailyTimerId = null, dailyStart = 0;
  let prevGood = [];
  const fx = { bad: [], badZones: [], glowLines: [], broken: [], brokenZones: [], hint: null, evidence: [], focus: null, hover: [] };
  // Levels that introduce a rule open the matching How to Play section once, on a fresh start.
  const TUT_HELP = { 1: ['balance', 'three'], 2: ['zones'] }; // level 1 teaches Balance + No three, level 2 the zones

  function isFull(b) { for (let i = 0; i < b.length; i++) if (b[i] < 0) return false; return true; }

  // ---------- generation (worker with main-thread fallback) ----------
  let worker = null, workerOk = false;
  try { worker = new Worker('src/puzzle.js?v=' + C.VERSION); workerOk = true; } catch (e) { worker = null; }
  const genCbs = {}; let genSeq = 0;
  if (worker) {
    worker.onmessage = (e) => { const d = e.data || {}; const cb = genCbs[d.id]; delete genCbs[d.id]; if (cb) cb(d.error ? null : d.puzzle); };
    worker.onerror = () => { workerOk = false; };
  }
  // Worker timeout: if no board arrives in GEN_TIMEOUT ms (or the worker fails), make one on the main
  // thread with a small attempt cap so the player is never stuck. The late worker answer is dropped.
  const GEN_TIMEOUT = 6000;
  function genLocal(spec, cb, quickCap) {
    setTimeout(() => {
      let p = null;
      try { p = OP.Puzzle.generate(quickCap ? Object.assign({}, spec, { attempts: 25 }) : spec); if (p && quickCap) p.dev.fallback = true; } catch (e2) { p = null; }
      cb(p);
    }, 0);
  }
  function genPuzzle(spec, cb) {
    if (!workerOk) { genLocal(spec, cb, false); return; }
    const id = ++genSeq;
    let done = false;
    const finish = (p) => { if (done) return; done = true; clearTimeout(timer); delete genCbs[id]; if (p) cb(p); else genLocal(spec, cb, true); };
    const timer = setTimeout(() => finish(null), GEN_TIMEOUT);
    genCbs[id] = finish;
    try { worker.postMessage({ id, opts: spec }); }
    catch (e) { workerOk = false; finish(null); }
  }
  const cache = {};
  const NEUTRAL = ['stone', 'silver'].map((k) => OP.Puzzle.PALETTE_NAMES.indexOf(k)); // greyish colours kept off tutorial zones
  function prefetch(spec) { if (spec.fixed || cache[spec.seed]) return; genPuzzle(spec, (p) => { if (p) cache[spec.seed] = p; }); }
  function obtain(spec, cb) {
    if (spec.fixed) {
      const p = Object.assign({ diff: spec.diff, rating: 1, seed: spec.seed }, JSON.parse(JSON.stringify(spec.fixed)));
      p.colors = OP.Puzzle.colourZones(p.n, p.zones, OP.Puzzle.mulberry32(OP.Puzzle.hashStr(spec.seed)), NEUTRAL);
      cb(p); return;
    }
    if (cache[spec.seed]) { const p = cache[spec.seed]; delete cache[spec.seed]; cb(p); return; }
    genPuzzle(spec, cb);
  }

  // ---------- layout ----------
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  const BAR_SIDE = 84; // width of the upright booster bar in compact (landscape) layout
  function computeLayout(w, h) {
    const compact = w >= h * 1.15 && h < 640;
    // Real rendered height of the booster bar (icons grew in 0.1.108), plus a bottom margin so it never clips.
    const barEl = document.getElementById('gBar');
    const bar = barEl && barEl.hidden ? 8 : Math.max(84, (barEl && barEl.offsetHeight) || 0) + 16;
    let x, y, size;
    if (compact) {
      // Landscape phones: the board takes nearly the full height on the right, the booster bar
      // stands upright beside it, and the pause button, label and messages use the left side.
      size = clamp(h - 24, 160, Math.min(w - 20 - BAR_SIDE - 12 - 200, w * 0.62));
      x = w - size - 16;
      y = (h - size) / 2;
    } else {
      // The message starts just under the pause button (its size differs by orientation), and the board under that.
      const pe = document.getElementById('gPause'), top = 16 + 10 + ((pe && pe.offsetHeight) || 60) + 6, msgH = 56;
      size = clamp(Math.min(w - 32, h - top - msgH - bar - 24), 160, 620);
      x = (w - size) / 2;
      const blockH = size + 12 + bar;
      y = top + msgH + Math.max(12, (h - top - msgH - blockH) * 0.3); // sit high: 30% of the spare room above, 70% below
    }
    return { W: w, H: h, x, y, size, compact, safe: { l: 16, t: 16, r: 16 } };
  }
  // Big screens: lay the game out as if the window were a normal-sized one (w/g x h/g), then scale
  // everything up by g -- the HUD through CSS zoom (--g), the board by multiplying its rect --
  // so a 3200x1920 window looks like a 1280x800 one, only larger. Never shrinks (g >= 1).
  function hudScale(w, h) {
    return h > w ? Math.max(1, Math.min(w / 600, h / 1000)) : Math.max(1, Math.min(w / 1280, h / 800));
  }
  // Tile width in CSS px an n x n board would get in this window. A size is offered only when its
  // tiles are at least MIN_TILE wide (8x8 needs a tablet, a desktop or a wide landscape window).
  const MIN_TILE = 54;
  function tilePx(n) {
    const w = window.innerWidth, h = window.innerHeight, g = hudScale(w, h);
    return computeLayout(w / g, h / g).size * g * 0.94 / n;
  }
  function sizeFits(n) { return n <= 6 || tilePx(n) >= MIN_TILE; }
  function layout(w, h) {
    const g = hudScale(w, h);
    document.documentElement.style.setProperty('--g', g.toFixed(4));
    const v = computeLayout(w / g, h / g);
    OP.ui.placeHud(v);
    curL = Object.assign({}, v, { W: w, H: h, x: v.x * g, y: v.y * g, size: v.size * g, g, dpr: dprFor(w, h) });
    if (scene) scene.setLayout(curL);
    if (guideStep()) pointAtCell(guideStep().i); // keep the hand on its cell after a resize
    syncNums();
  }

  // ---------- performance ----------
  // Canvas resolution: device pixel ratio capped at 2, and the whole canvas capped at ~8.3M pixels
  // (one 4K screen), so huge or high-DPI monitors don't multiply the GPU fill cost.
  // main.js sizes the canvas with this same function.
  function dprFor(w, h) { return Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8.3e6 / Math.max(1, w * h))); }
  // Draw on demand: Phaser's loop sleeps whenever nothing on the board is changing or animating,
  // so an idle board costs no CPU or GPU at all. Anything that changes the picture calls kick().
  let idleUntil = 0;
  function kick(ms) {
    idleUntil = Math.max(idleUntil, performance.now() + (ms || 0) + 250);
    const loop = scene && scene.game && scene.game.loop;
    if (loop && !loop.running) loop.wake(true);
  }

  // ---------- hint text ----------
  // Every hint names its reason. "this row / column / zone" is the group highlighted on the board.
  function stepText(step) {
    const sk = skin(); const nameOf = (v) => (v === 0 ? sk.an : sk.bn);
    const place = 'Place ' + nameOf(step.v) + ' here';
    const grp = 'this ' + (step.gt || 'line');
    const P = nameOf(step.p), V = nameOf(step.v);
    switch (step.kind) {
      case 'pair': return 'Two ' + P + ' side by side, so ' + V + ' here.';
      case 'sand': return P + ' on both sides, so ' + V + ' in the gap.';
      case 'count': return 'This ' + step.gt + ' has its ' + step.k + ' ' + P + ', so the rest are ' + V + '.';
      case 'zone2': return 'Same zone means opposites: ' + V + ' here.';
      case 'zonefull': return 'This zone has its ' + step.k + ' ' + P + ', so the rest are ' + V + '.';
      case 'meet': return step.sub === 1
        ? 'The zone gives ' + grp + ' all its ' + P + ', so ' + V + ' here.'
        : 'This ' + step.gt + ' gives the zone all its ' + P + ', so ' + V + ' here.';
      case 'line': return 'Only ' + V + ' works here in ' + grp + '.';
      case 'trial': {
        const w = nameOf(step.wrong);
        if (step.why === 'three') return w + ' here makes three ' + P + ' in a row, so ' + V + '.';
        if (step.why === 'over') return w + ' here leaves ' + grp + ' short of ' + nameOf(1 - step.p) + ', so ' + V + '.';
        return w + ' here breaks ' + grp + ', so ' + V + '.';
      }
      default: return place + '.';
    }
  }
  // The cells that show the evidence behind a step, highlighted so the reasoning is visible.
  function evidenceFor(step) { return (step.ev || []).slice(); }

  // ---------- guided tutorial (level 1) ----------
  // The current step is worked out from the board itself, so resuming, restarting or resizing
  // always lands on the right step. Only that step's cell can be tapped.
  function guideStep() {
    if (!curSpec || !curSpec.guide || !board || solved) return null;
    return curSpec.guide.find((s) => board[s.i] !== s.v) || null;
  }
  function showGuide() {
    if (!curSpec || !curSpec.guide) { fx.focus = null; OP.ui.pointer(null); return; }
    const st = guideStep();
    // Spotlight: the step's row/column or zone, as a list of cells.
    fx.focus = st ? (st.zone != null ? pz.zones[st.zone].slice() : OP.Puzzle.ctxOf(pz).lc[st.line].slice()) : null;
    fx.hint = st ? st.i : null;
    if (scene) scene.applyFx();
    if (!st) { OP.ui.pointer(null); OP.ui.msg(curSpec.done || 'Perfect!', { tone: 'good' }); return; }
    const sk = skin(), B = sk.bn;
    const t = board[st.i] === 0 && st.v === 1 ? 'Tap again to turn it into ' + B + '.'
      : st.say.replace(/\{A\}/g, sk.an).replace(/\{B\}/g, sk.bn);
    OP.ui.msg(t, { tone: 'tut' });
    pointAtCell(st.i);
  }
  // The tutorial's second-piece step on an empty cell is taught as a double tap (empty -> second piece).
  function needsDouble(st) { return st.v === 1 && board[st.i] < 0; }
  let guideTapAt = 0;
  function pointAtCell(i) {
    if (!curL || !pz) return;
    const g = curL.g || 1, n = pz.n, size = curL.size / g, pad = size * 0.03, cs = (size - 2 * pad) / n;
    const cx = curL.x / g + pad + (i % n + 0.5) * cs, cy = curL.y / g + pad + (((i / n) | 0) + 0.5) * cs;
    const st = guideStep(), dbl = !!(st && st.i === i && needsDouble(st));
    OP.ui.pointer(cx - 16, cy - 3, dbl); // the hand's ring is centred 16px right / 3px down of its anchor
  }

  // ---------- save / resume ----------
  function saveCur() {
    if (!mode || !pz) return;
    curObj()[mode] = { spec: curSpec, pz, board: Array.from(board), hist: hist.slice(-300), elapsed };
    OP.save.soon();
  }

  // ---------- spec builders ----------
  function buildSpec(which) {
    if (which === 'levels') { const L = S().level; const s = C.levelSpec(L); s.level = L; return s; }
    if (which === 'free') {
      const f = S().free;
      f.count = (f.count || 0) + 1; // every Play press is a fresh seed, so two free puzzles are never the same
      OP.save.soon();
      return { n: f.n, diff: f.diff, seed: 'zfree-' + f.count };
    }
    const t = C.today(); const s = C.dailySpec(t); s.key = t.key; return s;
  }

  // ---------- flow ----------
  // Pressing Play fades the current screen out and shows "Loading..." for at least a second while
  // the puzzle is made, then the game screen fades in. (Boot into the level-1 tutorial skips it:
  // the main loading screen has just been shown.)
  function start(which, opts) {
    mode = which;
    const spec = opts && opts.spec ? Object.assign({}, opts.spec) : buildSpec(which);
    const quick = opts && opts.quick, t0 = Date.now();
    const saved = curObj()[which];
    const resume = !!(saved && saved.spec && saved.spec.seed === spec.seed);
    if (!quick) OP.ui.playLoading(true);
    const go = (p) => {
      OP.ui.playLoading(false);
      OP.ui.show('game');
      begin(which, spec, p);
    };
    const ready = (p) => { if (quick) go(p); else setTimeout(() => go(p), Math.max(0, 1000 - (Date.now() - t0))); };
    if (resume) ready(null); else obtain(spec, ready);
  }

  function begin(which, spec, made) {
    clearHint();
    curSpec = spec; armed = null; prevGood = []; solved = false;
    clearTimeout(brokenTimer); fx.bad = []; fx.badZones = []; fx.glowLines = []; fx.broken = []; fx.brokenZones = []; fx.hint = null; fx.evidence = [];
    fx.focus = null; OP.ui.pointer(null);
    const saved = curObj()[which];
    if (saved && saved.spec && saved.spec.seed === spec.seed) {
      pz = saved.pz; board = saved.board.slice(); hist = saved.hist || []; elapsed = saved.elapsed || 0;
      afterLoad(which, spec);
      return;
    }
    const use = (p) => {
      pz = p; board = Array.from(pz.givens); hist = []; elapsed = 0;
      afterLoad(which, spec);
      if (TUT_HELP[spec.tut]) OP.ui.openHelp(TUT_HELP[spec.tut], () => showGuide()); // re-show the tutorial step once the rules are dismissed
    };
    if (made) use(made); else obtain(spec, use);
  }

  function afterLoad(which, spec) {
    const labels = {
      levels: ['Level ' + spec.level, C.DIFFS[spec.diff - 1] + ' · ' + spec.n + '×' + spec.n],
      free: ['Free Play', C.DIFFS[spec.diff - 1] + ' · ' + spec.n + '×' + spec.n],
      daily: ['Daily', C.dateLabel(C.today()).replace(/^(\w{3})\w*/, '$1')], // "Nov 14, 2026": fits beside pause/timer on phones
    }[which];
    // Levels 1-2 have no boosters at all (not even Undo); the board grows into the freed space.
    const noBar = which === 'levels' && spec.level <= 2;
    const pz1 = document.getElementById('gPause'); if (pz1) pz1.hidden = which === 'levels' && spec.level === 1; // no pause in the tutorial
    OP.ui.setHud({ l1: labels[0], l2: labels[1], timer: which === 'daily', bar: !noBar, gen: false, skip: which === 'levels' && !!spec.tut });
    if (curL) layout(curL.W, curL.H);
    if (which === 'daily') { OP.ui.setTimer(elapsed); startDailyTimer(); } else stopDailyTimer();

    prevGood = OP.Puzzle.goodLines(pz, board);
    if (scene) { if (curL) scene.setLayout(curL); else scene.redraw(); }
    updateBoosterUI();
    saveCur();
    OP.ui.syncPlay();

    OP.ui.msg('');
    showGuide();

    if (which === 'levels') prefetch(C.levelSpec(spec.level + 1));

    // Safety net: if a reload lands us back on a board that was already fully (and correctly)
    // filled in — e.g. the page closed during the win delay below — finish the win now.
    if (isFull(board)) checkWinOrBroken();
  }

  // ---------- rendering helpers ----------
  let badTimer = null, brokenTimer = null;
  function afterPlace() {
    if (activeHint && board[activeHint.i] === activeHint.v) clearHint(true); // the player followed the hint
    fx.broken = []; fx.brokenZones = []; clearTimeout(brokenTimer);
    const newGood = OP.Puzzle.goodLines(pz, board);
    const added = newGood.filter((L) => prevGood.indexOf(L) < 0);
    prevGood = newGood;
    if (added.length) {
      fx.glowLines = added; OP.audio.play('line');
      setTimeout(() => { fx.glowLines = []; if (scene) scene.applyFx(); }, 650);
    }
    // Clear any stale red mark right away, but don't flag a fresh one instantly — give the
    // player a beat to fix it themselves before auto-highlight calls it out.
    fx.bad = []; fx.badZones = [];
    if (scene) scene.updatePieces(); // just the pieces moved/changed, not the board frame
    clearTimeout(badTimer);
    if (S().settings.auto && !guideStep()) { // no red marks mid-tutorial (Fire is briefly in the Ice cell)
      badTimer = setTimeout(() => {
        setMarks();
        if (scene) scene.applyFx();
      }, 500);
    }
  }
  // Red marks: broken tiles, and broken zones (red border plus an icon).
  function setMarks() {
    if (!S().settings.auto) { fx.bad = []; fx.badZones = []; return; }
    const v = OP.Puzzle.violations(pz, board);
    fx.bad = Array.from(v.cells); fx.badZones = Array.from(v.zones);
  }
  function flashBad(cells, ms, zones) {
    fx.bad = cells; fx.badZones = zones || []; if (scene) scene.applyFx();
    setTimeout(() => { if (pz) setMarks(); if (scene) scene.applyFx(); }, ms || 1400);
  }

  function checkWinOrBroken() {
    if (!isFull(board)) return;
    const v = OP.Puzzle.violations(pz, board);
    if (!v.any) {
      solved = true; armed = null; // lock the board: taps during the win celebration must not change it
      OP.ui.syncPlay();
      if (mode === 'daily') stopDailyTimer(); // freeze the clock at the exact solve moment
      OP.audio.play('win');
      if (scene) scene.winRipple();
      setTimeout(win, 2000); // let the player enjoy the finished board before the modal covers it
    }
    else {
      // Same beat as the auto-highlight: let the last tile land before calling the board wrong.
      clearTimeout(brokenTimer);
      brokenTimer = setTimeout(() => {
        if (!isFull(board)) return;
        if (guideStep()) return; // tutorial: the cell is mid-cycle (Fire on its way to Ice), not a mistake
        const v2 = OP.Puzzle.violations(pz, board);
        if (!v2.any) return;
        fx.broken = Array.from(v2.cells); fx.brokenZones = Array.from(v2.zones);
        if (scene) scene.applyFx();
        OP.ui.msg('Not quite right yet', { tone: 'bad', ms: 1600 });
      }, 500);
    }
  }
  // Skip (Levels 1-2 only): straight to Level 3, the first normal board. The rules stay in Help.
  function skipTutorial() {
    if (mode !== 'levels' || !curSpec || !curSpec.tut || solved || OP.ui.modalOpen()) return;
    clearHint(true); fx.focus = null; OP.ui.pointer(null); OP.ui.msg('');
    S().level = Math.max(S().level, 3);
    curObj().levels = null;
    OP.save.persist();
    start('levels');
  }
  function isPlaying() { return !!(mode && pz && !solved); }
  function win() { if (mode === 'levels') winLevel(); else if (mode === 'free') winFree(); else if (mode === 'daily') winDaily(); }

  function winLevel() {
    const spec = curSpec, diff = spec.diff;
    const coins = C.levelReward(spec.n, diff); // same pay as Free Play: bigger and harder boards pay more
    let bonus = null;
    if (Math.random() < C.drop[diff]) {
      const pool = spec.n >= 6 ? ['hint', 'check', 'reveal'] : ['hint', 'check'];
      bonus = pool[Math.floor(Math.random() * pool.length)];
      S().boosters[bonus] = (S().boosters[bonus] || 0) + 1;
    }
    S().coins += coins;
    S().level = spec.level + 1;
    curObj().levels = null;
    OP.save.persist();
    prefetch(C.levelSpec(S().level));
    // Beating Level C.unlockLevel opens Free Play and Daily Play: say so before moving on.
    const then = (f) => (spec.level === C.unlockLevel ? () => OP.ui.openUnlocked(f) : f);
    if (spec.level === C.unlockLevel && OP.cg) OP.cg.happytime(); // new modes unlocked: a rare, real milestone
    OP.ui.openWin({ mode: 'levels', coins, bonus, next: then(() => (S().level >= 4 ? OP.ui.adBreak(() => start('levels')) : start('levels'))), home: then(() => OP.ui.show('home')) });
  }
  function winFree() {
    const coins = C.freeReward(curSpec.n, curSpec.diff);
    S().coins += coins;
    curObj().free = null;
    OP.save.persist();
    OP.audio.play('coin');
    OP.ui.openWin({ mode: 'free', coins, label: 'Nice work!', next: () => OP.ui.adBreak(() => start('free')), home: () => OP.ui.show('home') });
  }
  function winDaily() {
    const d = S().daily, t = C.today(), y = C.dayKeyOffset(t.key, -1);
    d.streak = d.last === y ? d.streak + 1 : 1;
    d.last = t.key;
    d.solved = { date: t.key, time: Math.round(elapsed) };
    if (OP.cg) OP.cg.happytime(); // the day's puzzle, once a day
    d.dates.push(t.key);
    curObj().daily = null;
    OP.save.persist();
    OP.ui.openWin({ mode: 'daily', time: d.solved.time, streak: d.streak, home: () => OP.ui.show('home') });
  }

  // ---------- placement / tap ----------
  function pushHist(i, before, after) { hist.push({ i, before, after }); if (hist.length > 300) hist.shift(); }
  function applyPlacement(i, after, before) {
    pushHist(i, before == null ? board[i] : before, after);
    board[i] = after;
    OP.audio.play('fire'); // one tap sound for every cell change (Fire, Ice or empty)
    afterPlace();
    if (scene) scene.popAt(i);
    saveCur();
    checkWinOrBroken();
    if (curSpec && curSpec.guide) showGuide();
  }

  function tap(i) {
    if (adPaused || OP.ui.modalOpen() || !pz || solved) return;
    if (armed === 'check') { doCheck(i); return; }
    if (armed === 'reveal') { doReveal(i); return; }
    const st = guideStep();
    if (st && i !== st.i) { if (scene) scene.shakeCell(i); pointAtCell(st.i); return; }
    if (st && needsDouble(st)) {
      // One tap does nothing here: only a second tap within 450 ms places the piece, so the player
      // really learns the double tap. Both taps count as one move (one undo step).
      const now = performance.now();
      if (now - guideTapAt > 450) { guideTapAt = now; return; }
      guideTapAt = 0;
      applyPlacement(i, 1, board[i]);
      return;
    }
    if (pz.givens[i] >= 0) { if (scene) scene.shakeCell(i); return; }
    const before = board[i], after = before < 0 ? 0 : (before === 0 ? 1 : -1);
    applyPlacement(i, after, before);
  }

  // ---------- boosters ----------
  function updateBoosterUI() { OP.ui.setBoosters({ reveal: !!(pz && pz.n >= 6), armed, undo: hist.length > 0, off: mode === 'daily' }); if (!armed) setHover(null); syncNums(); }
  function doUndo() {
    if (!hist.length) return;
    const last = hist.pop();
    board[last.i] = last.before;
    OP.audio.play('undo');
    afterPlace(); saveCur(); checkWinOrBroken(); updateBoosterUI();
  }
  function doHint() {
    const B = S().boosters;
    // Mistakes first: a broken rule, or else any placed tile that differs from the solution, so a
    // hint never builds on a wrong piece.
    const v = OP.Puzzle.violations(pz, board);
    const wrong = [];
    for (let i = 0; i < board.length; i++) if (board[i] >= 0 && pz.givens[i] < 0 && board[i] !== pz.sol[i]) wrong.push(i);
    if (v.any || wrong.length) {
      if (v.any) flashBad(Array.from(v.cells), 1600, Array.from(v.zones));
      else flashBad(wrong, 1600);
      OP.ui.msg(v.any && !v.cells.size ? 'That zone looks wrong' : (v.any ? v.cells.size : wrong.length) > 1 ? 'Those tiles look wrong' : 'That tile looks wrong', { tone: 'bad', ms: 1600 });
      if (B.hint <= 0) { OP.ui.boosterAd('hint', pz.n >= 6, updateBoosterUI); return; }
      B.hint--; OP.save.soon(); updateBoosterUI(); OP.audio.play('hint');
      return;
    }
    if (B.hint <= 0) { OP.ui.boosterAd('hint', pz.n >= 6, updateBoosterUI); return; }
    const step = OP.Puzzle.nextStep(pz, board);
    if (!step) return;
    // Same hint still showing (nothing changed since): just show it again, free.
    const same = activeHint && activeHint.i === step.i && activeHint.v === step.v;
    if (!same) { B.hint--; OP.save.soon(); }
    OP.audio.play('hint');
    showHint(step);
    updateBoosterUI();
  }
  // A hint only points: it rings the cell and tints the cells/line that explain it, and its
  // sentence stays up for 15 s -- or until the player places that piece or asks for another hint.
  let activeHint = null, hintTimer = null;
  function showHint(step) {
    clearHint();
    activeHint = { i: step.i, v: step.v };
    fx.hint = step.i; fx.evidence = evidenceFor(step);
    if (scene) scene.applyFx();
    OP.ui.msg(stepText(step), { tone: 'hint' });
    hintTimer = setTimeout(() => clearHint(true), 15000);
  }
  function clearHint(withMsg) {
    clearTimeout(hintTimer); hintTimer = null;
    if (!activeHint) return;
    activeHint = null; fx.hint = null; fx.evidence = [];
    if (scene) scene.applyFx();
    if (withMsg) OP.ui.msg('');
  }
  function flashEvidence(cells, ms) {
    fx.evidence = cells; if (scene) scene.applyFx();
    setTimeout(() => { fx.evidence = []; if (scene) scene.applyFx(); }, ms || 1600);
  }
  // Check: reveals the correct piece on the single tapped cell (a frozen or already-correct
  // tile costs nothing).
  function doCheck(i) {
    if (pz.givens[i] >= 0) { OP.ui.msg('That one is frozen', { ms: 1400 }); armed = null; updateBoosterUI(); return; }
    if (board[i] === pz.sol[i]) { OP.ui.msg('That tile is already correct', { ms: 1400 }); armed = null; updateBoosterUI(); return; }
    const B = S().boosters;
    if (B.check <= 0) { armed = null; updateBoosterUI(); OP.ui.boosterAd('check', pz.n >= 6, updateBoosterUI); return; }
    const before = board[i];
    pushHist(i, before, pz.sol[i]);
    board[i] = pz.sol[i];
    B.check--; OP.save.soon();
    armed = null; updateBoosterUI();
    OP.audio.play('fire');
    afterPlace(); saveCur(); checkWinOrBroken();
  }
  // Reveal: fills in a whole row or column. Tapping a cell picks the line through it that has
  // more empty/wrong cells; tapping a line number picks that line. No charge if it is already right.
  function lineScore(L) { const P = OP.Puzzle.ctxOf(pz); let s = 0; P.lc[L].forEach((ci) => { if (board[ci] < 0 || board[ci] !== pz.sol[ci]) s++; }); return s; }
  function lineFor(i) { const n = pz.n, r = (i / n) | 0, c = i % n; return lineScore(r) >= lineScore(n + c) ? r : n + c; }
  function doReveal(i) { revealLine(lineFor(i)); }
  function revealLine(L) {
    if (!pz || solved || armed !== 'reveal') return;
    if (lineScore(L) === 0) { OP.ui.msg('That line is already done', { ms: 1400 }); armed = null; updateBoosterUI(); return; }
    const B = S().boosters;
    if (B.reveal <= 0) { armed = null; updateBoosterUI(); OP.ui.boosterAd('reveal', false, updateBoosterUI); return; }
    const P = OP.Puzzle.ctxOf(pz);
    P.lc[L].forEach((ci) => { if (pz.givens[ci] < 0 && board[ci] !== pz.sol[ci]) { pushHist(ci, board[ci], pz.sol[ci]); board[ci] = pz.sol[ci]; } });
    B.reveal--; OP.save.soon();
    armed = null; updateBoosterUI();
    OP.audio.play('line');
    afterPlace(); saveCur(); checkWinOrBroken();
  }
  // While Check or Reveal is armed, the cell / line under the pointer is softly highlighted.
  let hoverKey = '';
  function setHover(cells) {
    const key = cells ? cells.join(',') : '';
    if (key === hoverKey) return;
    hoverKey = key; fx.hover = cells || [];
    if (scene) scene.applyFx();
  }
  function hoverCell(i) {
    if (pz && !solved && armed === 'reveal' && hovLine != null) return; // a number badge owns the highlight
    if (!pz || solved || i == null || i < 0 || !armed) return setHover(null);
    if (armed === 'check') return setHover(pz.givens[i] >= 0 ? null : [i]); // frozen tiles can't be checked
    // Reveal: only the line numbers highlight (hoverLine); hovering the board itself shows nothing.
    // (The board's pointer-out fires *after* a number badge's pointer-over, hence the check above.)
    setHover(null);
  }
  let hovLine = null;
  function hoverLine(L) {
    hovLine = (pz && armed === 'reveal' && L != null) ? L : null;
    if (hovLine == null) return setHover(null);
    setHover(OP.Puzzle.ctxOf(pz).lc[hovLine].slice());
  }
  // Line-number badges show only while Reveal is armed, placed around the board in HUD px.
  function syncNums() {
    if (!pz || !curL || armed !== 'reveal') { hovLine = null; OP.ui.setLineNums(null); return; }
    const g = curL.g || 1;
    OP.ui.setLineNums({ n: pz.n, x: curL.x / g, y: curL.y / g, size: curL.size / g });
  }
  function booster(k) {
    if (!pz || solved || adPaused || OP.ui.modalOpen()) return;
    if (mode === 'levels' && curSpec && curSpec.level <= 2) return;
    if (guideStep()) { OP.ui.msg('Follow the hand first!', { ms: 1400, after: showGuide }); return; }
    if (k === 'undo') return doUndo();
    if (mode === 'daily') { OP.ui.msg('No boosters in the Daily', { ms: 1400 }); return; }
    if (k === 'hint') return doHint();
    // None left: the tapped booster's ad popup opens straight away (no arming first).
    if ((k === 'check' || (k === 'reveal' && pz.n >= 6)) && OP.save.d.boosters[k] <= 0) { armed = null; updateBoosterUI(); OP.ui.boosterAd(k, false, updateBoosterUI); return; }
    if (k === 'check') { armed = armed === 'check' ? null : 'check'; updateBoosterUI(); OP.audio.play('click'); return; }
    if (k === 'reveal') { if (pz.n < 6) return; armed = armed === 'reveal' ? null : 'reveal'; updateBoosterUI(); OP.audio.play('click'); return; }
  }

  // ---------- daily timer ----------
  function dailyTick() { elapsed = (Date.now() - dailyStart) / 1000; OP.ui.setTimer(elapsed); saveCur(); }
  function startDailyTimer() {
    if (dailyTimerId) return;
    dailyStart = Date.now() - elapsed * 1000;
    dailyTimerId = setInterval(dailyTick, 250);
  }
  function stopDailyTimer() { if (dailyTimerId) { clearInterval(dailyTimerId); dailyTimerId = null; } }
  // The Daily time is the player's score: it only runs while the Daily board is actually in view.
  // Leaving the tab/app stops it; coming back starts it again unless a popup or an ad is up.
  document.addEventListener('visibilitychange', () => {
    if (mode !== 'daily') return;
    if (document.hidden) { if (dailyTimerId && pz && !solved) dailyTick(); stopDailyTimer(); }
    else if (pz && !solved && !adPaused && OP.ui.current === 'game' && !OP.ui.modalOpen()) startDailyTimer();
  });

  // ---------- pause / restart / screens ----------
  function restartCurrent() {
    if (!pz) return;
    clearHint(true);
    board = Array.from(pz.givens); hist = [];
    prevGood = []; fx.bad = []; fx.badZones = []; fx.glowLines = []; fx.broken = []; fx.brokenZones = []; fx.hint = null; fx.evidence = [];
    armed = null; clearTimeout(badTimer);
    if (scene) scene.updatePieces();
    updateBoosterUI(); saveCur();
    if (mode === 'daily') startDailyTimer();
    showGuide();
  }
  function pause() {
    if (!pz) return;
    if (mode === 'levels' && curSpec && curSpec.level === 1) return; // level 1 (tutorial) has no pause
    if (mode === 'daily') stopDailyTimer();
    OP.ui.openPause({
      restart: () => restartCurrent(),
      home: () => { saveCur(); OP.ui.show('home'); },
      // Shop from the pause menu: Back returns to this game with the pause menu open again.
      shop: () => { saveCur(); OP.ui.openShop(() => { OP.ui.show('game'); pause(); }); },
      onClose: () => { if (mode === 'daily' && OP.ui.current === 'game') startDailyTimer(); },
    });
  }
  function onScreen(name) {
    if (name === 'home') OP.ui.maybeLogin();
    if (name !== 'game' && mode === 'daily') stopDailyTimer();
    if (scene && scene.sys && scene.sys.game && scene.sys.game.canvas) {
      scene.sys.game.canvas.style.display = name === 'game' ? '' : 'none';
      if (name === 'game') {
        const g = document.getElementById('game'); requestAnimationFrame(() => { g.style.opacity = '1'; });
        if (scene.L && pz) { scene.updatePieces(); updateBoosterUI(); } // a skin or boosters may have been bought in the shop
      }
    }
  }
  function refreshMarks() {
    if (!pz) return;
    clearTimeout(badTimer);
    setMarks();
    if (scene) scene.applyFx();
  }
  function clearCache() {
    mode = null; curSpec = null; pz = null; board = null; hist = []; armed = null;
    stopDailyTimer();
    if (scene) scene.updatePieces(); // pz is null now, so this just no-ops
  }
  function adPause(on) {
    adPaused = !!on;
    if (on) { if (mode === 'daily') stopDailyTimer(); }
    else if (mode === 'daily' && OP.ui.current === 'game') startDailyTimer();
  }

  // ---------- dev/debug (only ever called from the ?dev=1 panel) ----------
  function devSolve() {
    if (!pz) return;
    board = Array.from(pz.sol);
    hist = [];
    afterPlace();
    saveCur();
    checkWinOrBroken();
  }
  function devInfo() { return { mode, level: S().level, n: pz ? pz.n : null, diff: curSpec ? curSpec.diff : null, seed: curSpec ? curSpec.seed : null, rating: pz ? pz.rating : null, dev: pz ? pz.dev || null : null }; }

  // ---------- Phaser scene ----------
  class BoardScene extends Phaser.Scene {
    constructor() { super('Board'); }
    preload() {
      const seen = {};
      OP.skins.list.forEach((sk) => {
        [sk.pa, sk.pb].forEach((nm) => {
          if (!seen[nm]) { seen[nm] = 1; this.load.image('pc_' + nm, OP.skins.dataUri(nm, 200)); }
        });
      });
      this.load.image('fx_spark', 'assets/art/fx/spark.webp?v=' + OP.config.VERSION);
    }
    create() {
      this.dpr = curL ? curL.dpr : dprFor(window.innerWidth, window.innerHeight);
      this.gBg = this.add.graphics().setDepth(0);
      this.gFx = this.add.graphics().setDepth(3);
      this.cellC = []; this.n = 0; this.L = null;
      // Every animation or timer keeps the loop awake for as long as it runs (see kick()).
      const tAdd = this.tweens.add.bind(this.tweens), dCall = this.time.delayedCall.bind(this.time), eAdd = this.time.addEvent.bind(this.time);
      this.tweens.add = (c) => { kick(((c.duration || 0) * (c.yoyo ? 2 : 1)) + (c.delay || 0)); return tAdd(c); };
      this.time.delayedCall = (d, cb, a, s) => { kick(d); return dCall(d, cb, a, s); };
      this.time.addEvent = (c) => { kick((c.delay || 0) * ((c.repeat || 0) + 1)); return eAdd(c); };
      this.game.canvas.addEventListener('pointerdown', () => kick(), true);
      // The board only redraws while awake. When the browser drops the GPU context of a background tab,
      // Phaser rebuilds it on return but a sleeping loop never draws again -> blank board. Wake it then,
      // and whenever the tab comes back into view.
      this.game.canvas.addEventListener('webglcontextrestored', () => setTimeout(() => kick(600), 0));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(600); });
      this.input.on('pointerdown', (p) => this._onTap(p));
      this.input.on('pointermove', (p) => hoverCell(this.cellAt(p)));
      this.input.on('gameout', () => hoverCell(null));
      scene = this; if (curL) scene.setLayout(curL);
      kick();
    }
    update() {
      if (performance.now() > idleUntil && this.tweens.getTweens().length === 0) this.game.loop.sleep();
    }
    cellAt(p) {
      const L = this.L; if (!L || !pz) return -1;
      const dpr = this.dpr, n = pz.n;
      const pad = L.size * 0.03, cs = (L.size - 2 * pad) / n;
      const ox = L.x * dpr, oy = L.y * dpr, P = pad * dpr, CS = cs * dpr, Sz = L.size * dpr;
      const x = p.x, y = p.y;
      if (x < ox + P || y < oy + P || x > ox + Sz - P || y > oy + Sz - P) return -1;
      const c = Math.floor((x - ox - P) / CS), r = Math.floor((y - oy - P) / CS);
      if (r < 0 || r >= n || c < 0 || c >= n) return -1;
      return r * n + c;
    }
    _onTap(p) { const i = this.cellAt(p); if (i >= 0) tap(i); }
    setLayout(L) { this.L = L; if (L.dpr) this.dpr = L.dpr; this.redraw(); kick(); }
    ensureCells(n) {
      if (this.n === n) return;
      this.cellC.forEach((c) => c.destroy());
      this.cellC = [];
      for (let i = 0; i < n * n; i++) {
        const img = this.add.image(0, 0, 'pc_fire').setVisible(false);
        const cont = this.add.container(0, 0, [img]).setDepth(1);
        cont.pieceImg = img;
        this.cellC.push(cont);
      }
      this.n = n;
    }
    geom() {
      const L = this.L, n = pz.n, dpr = this.dpr;
      const pad = L.size * 0.03, cs = (L.size - 2 * pad) / n;
      return { ox: L.x * dpr, oy: L.y * dpr, P: pad * dpr, CS: cs * dpr, Sz: L.size * dpr };
    }
    // Full rebuild: board frame, zone fills, zone borders. Only needed when the layout or the
    // puzzle itself changes, never on every tap (that's updatePieces, below).
    // Zones read even in grayscale: thick 3.5 px borders between zones, thin lines inside one.
    redraw() {
      const L = this.L;
      if (!pz || !L) return;
      const n = pz.n, dpr = this.dpr;
      this.ensureCells(n);
      const g = this.geom(), ox = g.ox, oy = g.oy, P = g.P, CS = g.CS, Sz = g.Sz;
      const PZ = OP.Puzzle, zoneOf = PZ.ctxOf(pz).zoneOf, hasZones = (pz.zones || []).length > 0;
      const gb = this.gBg;
      gb.clear();
      gb.fillStyle(0x1a2030, 0.08);
      gb.fillRoundedRect(ox - 2 * dpr, oy + 4 * dpr, Sz + 4 * dpr, Sz + 4 * dpr, 18 * dpr);
      gb.fillStyle(0xffffff, 1);
      gb.fillRoundedRect(ox, oy, Sz, Sz, 16 * dpr);
      const x0 = ox + P, y0 = oy + P;
      for (let i = 0; i < n * n; i++) {
        const r = (i / n) | 0, c = i % n, cx = x0 + c * CS, cy = y0 + r * CS;
        gb.fillStyle(hasZones ? PZ.PALETTE[pz.colors[zoneOf[i]]] : 0xffffff, 1);
        gb.fillRect(cx, cy, CS, CS);
        if (pz.givens[i] >= 0) { gb.fillStyle(0x1a2030, 0.08); gb.fillRoundedRect(cx + 4 * dpr, cy + 4 * dpr, CS - 8 * dpr, CS - 8 * dpr, 7 * dpr); } // frozen tile
      }
      const same = (a, b) => hasZones && zoneOf[a] === zoneOf[b];
      const thin = Math.max(1, 1.2 * dpr), thick = 3.5 * dpr, ink = 0x3a4256;
      // Thin lines between cells of the same zone.
      gb.fillStyle(ink, 0.2);
      for (let i = 0; i < n * n; i++) {
        const r = (i / n) | 0, c = i % n, cx = x0 + c * CS, cy = y0 + r * CS;
        if (c < n - 1 && (same(i, i + 1) || !hasZones)) gb.fillRect(cx + CS - thin / 2, cy, thin, CS);
        if (r < n - 1 && (same(i, i + n) || !hasZones)) gb.fillRect(cx, cy + CS - thin / 2, CS, thin);
      }
      // Thick borders between zones and round the whole grid.
      gb.fillStyle(ink, 1);
      for (let i = 0; i < n * n; i++) {
        const r = (i / n) | 0, c = i % n, cx = x0 + c * CS, cy = y0 + r * CS;
        if (c < n - 1 && hasZones && !same(i, i + 1)) gb.fillRect(cx + CS - thick / 2, cy - thick / 2, thick, CS + thick);
        if (r < n - 1 && hasZones && !same(i, i + n)) gb.fillRect(cx - thick / 2, cy + CS - thick / 2, CS + thick, thick);
      }
      gb.lineStyle(thick, ink, 1);
      gb.strokeRect(x0, y0, n * CS, n * CS);
      this.updatePieces();
    }
    // Outline of a set of cells (its outer edges only), for zones and spotlights.
    outline(gr, cells, width, color, alpha) {
      const n = pz.n, g = this.geom(), x0 = g.ox + g.P, y0 = g.oy + g.P, CS = g.CS, set = new Set(cells), t = width;
      gr.fillStyle(color, alpha == null ? 1 : alpha);
      cells.forEach((i) => {
        const r = (i / n) | 0, c = i % n, cx = x0 + c * CS, cy = y0 + r * CS;
        if (r === 0 || !set.has(i - n)) gr.fillRect(cx - t / 2, cy - t / 2, CS + t, t);
        if (r === n - 1 || !set.has(i + n)) gr.fillRect(cx - t / 2, cy + CS - t / 2, CS + t, t);
        if (c === 0 || !set.has(i - 1)) gr.fillRect(cx - t / 2, cy - t / 2, t, CS + t);
        if (c === n - 1 || !set.has(i + 1)) gr.fillRect(cx + CS - t / 2, cy - t / 2, t, CS + t);
      });
    }
    // A broken zone: red border round the whole zone plus a "!" badge on its top-left cell.
    badZone(k) {
      const z = pz.zones[k]; if (!z) return;
      const n = pz.n, dpr = this.dpr, g = this.geom(), gr = this.gFx;
      this.outline(gr, z, 4.5 * dpr, 0xe8303a);
      const i = Math.min.apply(null, z), r = (i / n) | 0, c = i % n;
      const R = Math.max(8 * dpr, g.CS * 0.15), bx = g.ox + g.P + c * g.CS + R + 3 * dpr, by = g.oy + g.P + r * g.CS + R + 3 * dpr;
      gr.fillStyle(0xffffff, 1); gr.fillCircle(bx, by, R + 1.5 * dpr);
      gr.fillStyle(0xe8303a, 1); gr.fillCircle(bx, by, R);
      gr.fillStyle(0xffffff, 1);
      gr.fillRoundedRect(bx - R * 0.14, by - R * 0.62, R * 0.28, R * 0.78, R * 0.12);
      gr.fillCircle(bx, by + R * 0.5, R * 0.16);
    }
    // Light update: only the piece sprites (position + texture). Called on every tap/undo/hint
    // so we're not re-tessellating ~100+ rounded rects of static board frame each time.
    updatePieces() {
      const L = this.L;
      if (!pz || !L) return;
      this.ensureCells(pz.n);
      const n = pz.n, sk = skin(), g = this.geom();
      for (let i = 0; i < n * n; i++) {
        const r = (i / n) | 0, c = i % n;
        const cx = g.ox + g.P + c * g.CS, cy = g.oy + g.P + r * g.CS;
        const cont = this.cellC[i];
        cont.setPosition(cx + g.CS / 2, cy + g.CS / 2);
        const v = board ? board[i] : -1;
        if (v < 0) cont.pieceImg.setVisible(false);
        else {
          const nm = v === 0 ? sk.pa : sk.pb;
          cont.pieceImg.setTexture('pc_' + nm).setVisible(true).setDisplaySize(g.CS * 0.84, g.CS * 0.84);
        }
      }
      this.applyFx();
    }
    applyFx() {
      const L = this.L; if (!L || !pz) return;
      const n = pz.n, dpr = this.dpr, pad = L.size * 0.03, cs = (L.size - 2 * pad) / n;
      const ox = L.x * dpr, oy = L.y * dpr, P = pad * dpr, CS = cs * dpr;
      const rectFor = (i) => { const r = (i / n) | 0, c = i % n; return [ox + P + c * CS + 1, oy + P + r * CS + 1, CS - 2, CS - 2]; };
      kick(); // pieces or highlights changed: draw a frame
      this.gFx.clear();
      if (fx.focus) {
        // Tutorial spotlight: wash out every other cell and ring the focused row, column or zone.
        const keep = fx.focus;
        for (let i = 0; i < n * n; i++) if (keep.indexOf(i) < 0) { this.gFx.fillStyle(0xf3f5f9, 0.62); this.gFx.fillRect.apply(this.gFx, rectFor(i).map((v, k) => (k < 2 ? v - 1 : v + 2))); }
        this.outline(this.gFx, keep, 5 * dpr, 0xffb02e);
      }
      (fx.evidence || []).forEach((i) => {
        const r = rectFor(i);
        this.gFx.fillStyle(0x3fa4e8, 0.16); this.gFx.fillRoundedRect.apply(this.gFx, r.concat([6 * dpr]));
        this.gFx.lineStyle(2 * dpr, 0x3fa4e8, 0.6); this.gFx.strokeRoundedRect.apply(this.gFx, r.concat([6 * dpr]));
      });
      if ((fx.hover || []).length) {
        // Check / Reveal aiming: the cell or line under the pointer, tinted and ringed as one block. Strong
        // enough to read over the pastel zone colours (a 14% tint vanished on them).
        fx.hover.forEach((i) => { this.gFx.fillStyle(0x3fa4e8, 0.34); this.gFx.fillRoundedRect.apply(this.gFx, rectFor(i).concat([6 * dpr])); });
        const a = rectFor(Math.min.apply(null, fx.hover)), b = rectFor(Math.max.apply(null, fx.hover)), m = 2 * dpr;
        this.gFx.lineStyle(4.5 * dpr, 0x1f7fd0, 1);
        this.gFx.strokeRoundedRect(a[0] - m, a[1] - m, b[0] + b[2] - a[0] + 2 * m, b[1] + b[3] - a[1] + 2 * m, 9 * dpr);
      }
      // Completion glow: a finished row, column or zone.
      const groups = OP.Puzzle.ctxOf(pz).groups;
      (fx.glowLines || []).forEach((G) => { (groups[G] || []).forEach((i) => { this.gFx.lineStyle(3 * dpr, 0xffd27a, 0.95); this.gFx.strokeRoundedRect.apply(this.gFx, rectFor(i).concat([6 * dpr])); }); });
      (fx.broken || []).forEach((i) => { this.gFx.lineStyle(3 * dpr, 0xff5050, 0.85); this.gFx.strokeRoundedRect.apply(this.gFx, rectFor(i).concat([6 * dpr])); });
      (fx.bad || []).forEach((i) => { this.gFx.fillStyle(0xff5050, 0.3); this.gFx.fillRoundedRect.apply(this.gFx, rectFor(i).concat([6 * dpr])); });
      const zs = new Set((fx.badZones || []).concat(fx.brokenZones || []));
      zs.forEach((k) => this.badZone(k));
      if (fx.hint != null) { this.gFx.lineStyle(3 * dpr, 0x3fa4e8, 0.9); this.gFx.strokeRoundedRect.apply(this.gFx, rectFor(fx.hint).concat([8 * dpr])); }
    }
    popAt(i) {
      const cont = this.cellC[i]; if (!cont) return;
      const target = cont.pieceImg.scaleX || 1;
      cont.pieceImg.setScale(target * 0.4);
      this.tweens.add({ targets: cont.pieceImg, scaleX: target, scaleY: target, duration: 220, ease: 'Back.easeOut' });
    }
    shakeCell(i) {
      const cont = this.cellC[i]; if (!cont || !pz || !this.L) return;
      // Spamming taps could otherwise stack shakes: each new one read cont.x mid-animation as
      // its "resting" position, so the cell drifted further off-grid with every extra tap.
      // Kill any shake already in flight and recompute the true resting x from the board
      // geometry (never from cont.x, which may currently be mid-tween) before starting a new one.
      this.tweens.killTweensOf(cont);
      const n = pz.n, r = (i / n) | 0, c = i % n, g = this.geom();
      const x0 = g.ox + g.P + c * g.CS + g.CS / 2;
      cont.x = x0;
      this.tweens.add({ targets: cont, x: [x0 - 6 * this.dpr, x0 + 6 * this.dpr, x0 - 4 * this.dpr, x0 + 4 * this.dpr, x0], duration: 260, ease: 'Sine.easeInOut' });
      OP.audio.play('wrong', 0.5);
    }
    // Win celebration (fills the 2 s before the win popup): ring, a diagonal wave through every tile,
    // sparkle bursts and twinkles across the board. Sparkle sprite: assets/art/fx/spark.webp (Bing).
    winRipple() {
      try {
        const L = this.L; if (!L || !pz) return;
        const dpr = this.dpr, n = pz.n, g = this.geom();
        const cx = g.ox + g.Sz / 2, cy = g.oy + g.Sz / 2;
        const tint = [0xff6a45, 0x3fa4e8, 0xffc23d, 0xffffff];
        const hasSpark = this.textures.exists('fx_spark');
        const spark = (x, y, size, color, depth) => {
          if (hasSpark) return this.add.image(x, y, 'fx_spark').setDisplaySize(size, size).setTint(color).setDepth(depth || 7);
          return this.add.circle(x, y, size / 5, color, 1).setDepth(depth || 7);
        };
        // 1. Expanding gold ring.
        // Drawn once at full size and scaled up (cheap), instead of rebuilding its outline every frame.
        const R = L.size * 0.8 * dpr;
        const ring = this.add.circle(cx, cy, R, 0xffffff, 0).setStrokeStyle(5 * dpr, 0xffc23d, 1).setDepth(5).setScale(0.02);
        this.tweens.add({ targets: ring, scale: 1, alpha: 0, duration: 800, ease: 'Cubic.easeOut', onComplete: () => ring.destroy() });
        // 2. Diagonal wave: each tile hops and flashes a sparkle as the wave passes.
        for (let i = 0; i < n * n; i++) {
          const cont = this.cellC[i]; if (!cont) continue;
          const r = (i / n) | 0, c = i % n, delay = 120 + (r + c) * 55;
          this.tweens.add({ targets: cont, scale: 1.22, duration: 140, delay, yoyo: true, ease: 'Sine.easeOut', onComplete: () => cont.setScale(1) });
          this.time.delayedCall(delay + 60, () => {
            const x = g.ox + g.P + c * g.CS + g.CS / 2, y = g.oy + g.P + r * g.CS + g.CS / 2;
            const s = spark(x, y, g.CS * 0.9, (r + c) % 2 ? 0xffc23d : 0xffe9a8).setScale(0).setAlpha(0.95);
            const full = (g.CS * 0.9) / (hasSpark ? 128 : 1);
            this.tweens.add({ targets: s, scale: hasSpark ? full : 1, angle: 12, duration: 180, yoyo: true, ease: 'Sine.easeOut', onComplete: () => s.destroy() });
          });
        }
        // 3. Bursts: one from the centre now, three more around the board as the wave ends.
        const burst = (bx, by, count, reach) => {
          for (let k = 0; k < count; k++) {
            const ang = (k / count) * Math.PI * 2 + Math.random() * 0.4;
            const dist = reach * (0.5 + Math.random() * 0.5);
            const sz = (14 + Math.random() * 16) * dpr;
            const s = spark(bx, by, sz, tint[k % tint.length]);
            s.setAngle(Math.random() * 90);
            this.tweens.add({
              targets: s, x: bx + Math.cos(ang) * dist, y: by + Math.sin(ang) * dist + 20 * dpr,
              angle: s.angle + 180, alpha: 0, scale: s.scale * 0.3, duration: 700 + Math.random() * 400, ease: 'Cubic.easeOut',
              onComplete: () => s.destroy(),
            });
          }
        };
        burst(cx, cy, 20, L.size * 0.6 * dpr);
        const wave = 120 + (2 * n - 2) * 55;
        [[0.22, 0.25], [0.78, 0.3], [0.5, 0.8]].forEach((p, k) => {
          this.time.delayedCall(wave * 0.6 + k * 180, () => {
            burst(g.ox + g.Sz * p[0], g.oy + g.Sz * p[1], 10, L.size * 0.32 * dpr);
            OP.audio.play('clear', 0.35, 1.2 + k * 0.15);
          });
        });
        // 4. Twinkles scattered over the board until the popup arrives.
        this.time.addEvent({
          delay: 90, repeat: 14, callback: () => {
            const x = g.ox + Math.random() * g.Sz, y = g.oy + Math.random() * g.Sz;
            const sz = (10 + Math.random() * 18) * dpr;
            const s = spark(x, y, sz, [0xffc23d, 0xffe9a8, 0xffffff][(Math.random() * 3) | 0]);
            const sc = s.scale; s.setScale(0);
            this.tweens.add({ targets: s, scale: sc, angle: 90, duration: 260, yoyo: true, ease: 'Sine.easeInOut', onComplete: () => s.destroy() });
          },
        });
      } catch (e) { /* ignore */ }
    }
  }

  OP.game = { start, skipTutorial, isPlaying, sizeFits, tilePx, pause, booster, hoverLine, revealLine, onScreen, refreshMarks, clearCache, adPause, layout, dprFor, Scene: BoardScene, devSolve, devInfo };
})();

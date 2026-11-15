// Opposito Zones: boot. The loading screen's inline script runs this file last.
(function () {
  'use strict';
  const OP = window.OP;
  function size() { return { w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) }; }
  const sz = size();
  // Canvas resolution comes from the same function the board uses (DPR <= 2, ~8.3M px max).
  const DPR = OP.game.dprFor(sz.w, sz.h);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    transparent: true,
    scale: { mode: Phaser.Scale.NONE, width: Math.round(sz.w * DPR), height: Math.round(sz.h * DPR), zoom: 1 / DPR },
    input: { activePointers: 2 },
    scene: [OP.game.Scene],
  });

  // Relayout on the very next frame of a resize (no waiting), plus one settle pass for mobile
  // browsers whose bars finish moving a moment after the event.
  OP.phaser = game; // handy for checking the draw-on-demand loop from the console (OP.phaser.loop.running)
  let resizeF = 0, resizeT = null;
  function doResize() {
    resizeF = 0;
    if (window.OP_fit) window.OP_fit();
    const s = size(), d = OP.game.dprFor(s.w, s.h);
    try { game.scale.resize(Math.round(s.w * d), Math.round(s.h * d)); game.scale.setZoom(1 / d); } catch (e) { /* ignore */ }
    OP.game.layout(s.w, s.h);
  }
  function onResizeSoon() {
    if (!resizeF) resizeF = requestAnimationFrame(doResize);
    clearTimeout(resizeT); resizeT = setTimeout(doResize, 150);
  }
  window.addEventListener('resize', onResizeSoon);
  window.addEventListener('orientationchange', onResizeSoon);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onResizeSoon(); });

  OP.game.layout(sz.w, sz.h);
  // Until level 1 (the tutorial) is beaten, every load goes straight into it; Home (and the daily
  // reward popup that opens there) only appears from level 2 on.
  const d = OP.save.d;
  // Review links (dev only): ?dev=1&level=30 opens that level's board, ?dev=1&n=6&diff=3&seed=abc any
  // seeded board. Both play as Free Play, so level progress is untouched.
  const q = new URLSearchParams(location.search);
  if (q.get('dev') === '1' && (q.get('level') || q.get('seed'))) {
    const L = parseInt(q.get('level'), 10);
    const spec = L > 0 ? OP.config.levelSpec(L) : { n: [4, 6, 8].indexOf(+q.get('n')) >= 0 ? +q.get('n') : 6, diff: Math.min(4, Math.max(1, parseInt(q.get('diff'), 10) || 2)), seed: q.get('seed') };
    OP.game.start('free', { spec, quick: true });
  } else if (d.level === 1) OP.game.start('levels', { quick: true });
  else OP.ui.show('home'); // this alone triggers OP.game.onScreen('home'), which shows the login reward if due

  // ---------- dev mode: ?dev=1 ----------
  if (new URLSearchParams(location.search).get('dev') === '1') setupDevPanel();
  function setupDevPanel() {
    const p = document.createElement('div');
    p.id = 'devPanel';
    p.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;background:rgba(17,20,28,.92);' +
      'color:#8ef58e;font:11px/1.4 ui-monospace,Consolas,monospace;padding:8px 10px;border-radius:8px;' +
      'max-width:300px;box-shadow:0 4px 16px rgba(0,0,0,.4);';
    p.innerHTML =
      '<div style="font-weight:700;color:#fff;margin-bottom:4px;">DEV v' + OP.config.VERSION + '</div>' +
      '<div id="devInfo" style="color:#aab; margin-bottom:6px; white-space:pre-wrap;"></div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px;">' +
      '<input id="devLevel" type="number" min="1" style="width:48px;" value="' + OP.save.d.level + '">' +
      '<button id="devGo">go lvl</button></div>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap;">' +
      '<button id="devSolve">solve</button>' +
      '<button id="devCoins">+1000c</button>' +
      '<button id="devBoost">+boost</button>' +
      '<button id="devAd">skip ad</button>' +
      '<button id="devLogin">login</button>' +
      '<button id="devWipe">wipe</button>' +
      '</div>';
    document.body.appendChild(p);
    p.querySelectorAll('button').forEach((b) => { b.style.cssText = 'background:#2a3040;color:#fff;border:1px solid #444;border-radius:4px;padding:3px 6px;font:11px monospace;cursor:pointer;'; });
    const info = p.querySelector('#devInfo');
    // Proof that zones matter: solutions with the zones switched off (Medium and up must have 2+),
    // and which zone deductions the logic solver used on this board.
    const D = OP.config.DIFFS;
    setInterval(() => {
      const d = OP.game.devInfo(), x = d.dev;
      let t = 'mode:' + d.mode + ' lvl:' + d.level + ' n:' + d.n + ' diff:' + d.diff + '\nseed: ' + d.seed;
      if (x) {
        const u = x.used || {}, zu = ['zone2', 'zonefull', 'meet', 'whatifZone'].filter((k) => u[k]).map((k) => k + ' ' + u[k]);
        const rj = Object.keys(x.rej || {}).filter((k) => x.rej[k]).map((k) => k + ' ' + x.rej[k]);
        t += '\nrated: ' + D[d.rating - 1] + '  (' + x.ms + ' ms' + (x.fallback ? ', main-thread fallback' : '') + ')' +
          '\nzones: ' + x.zones + '  sizes ' + x.sizes.join(' ') + '  givens ' + x.givens +
          '\nwithout zones: ' + (x.noZone > 1 ? '2+ solutions (zones needed)' : x.noZone + ' solution (zones NOT needed)') +
          '\nzone steps: ' + (zu.join(', ') || 'none') +
          '\nall steps: ' + Object.keys(u).map((k) => k + ' ' + u[k]).join(', ') +
          '\nrejected: ' + (rj.join(', ') || 'none');
      } else if (d.n) t += '\nhand-made board';
      info.textContent = t;
    }, 500);
    p.querySelector('#devGo').onclick = () => {
      const L = Math.max(1, parseInt(p.querySelector('#devLevel').value, 10) || 1);
      OP.save.d.level = L; OP.save.d.cur.levels = null; OP.save.persist();
      OP.ui.show('home'); OP.ui.refresh('home');
    };
    p.querySelector('#devSolve').onclick = () => OP.game.devSolve();
    p.querySelector('#devCoins').onclick = () => { OP.save.d.coins += 1000; OP.save.persist(); OP.ui.refresh(OP.ui.current); };
    p.querySelector('#devBoost').onclick = () => { const b = OP.save.d.boosters; b.hint += 20; b.check += 20; b.reveal += 20; OP.save.persist(); if (OP.game.refreshMarks) OP.game.refreshMarks(); };
    p.querySelector('#devAd').onclick = () => { OP.save.d.lastAdAt = Date.now(); OP.save.persist(); };
    // Pretend a new day has started and open the Daily reward popup (after day 7, start over at day 1).
    p.querySelector('#devLogin').onclick = () => {
      const L = OP.save.d.login; if (L.day >= 7) L.day = 0; L.last = null; OP.save.persist();
      if (OP.ui.current !== 'home') OP.ui.show('home'); else OP.ui.maybeLogin();
    };
    p.querySelector('#devWipe').onclick = () => { OP.save.reset(); OP.game.clearCache(); OP.ui.show('home'); };
  }
})();

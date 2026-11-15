/* Opposito Zones puzzle engine: seeded generator, logic-only solver, difficulty rater, hints.
   Runs both on the main thread (hints, checks) and inside a Web Worker (generation).
   Cell values: -1 empty, 0 = piece A (Fire), 1 = piece B (Ice).
   Groups: 0..n-1 rows, n..2n-1 columns, 2n.. coloured zones. Balance applies to every group,
   no-three only to rows and columns.
   Tiers: 1 Easy   (pairs, sandwiches, full line, full zone, 2-cell zone)
          2 Medium (zone meets line, whole-line reasoning)
          3 Hard   (one-step "what if" with the Easy rules)
          4 Expert (one-step "what if" with the Medium rules) */
(function (root) {
  'use strict';

  // ---------- seeded RNG ----------
  function hashStr(s) {
    let h = 1779033703 ^ s.length;
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(a, rnd) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // ---------- line patterns ----------
  const PATS = {};
  function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }
  function patterns(n) {
    if (PATS[n]) return PATS[n];
    const out = [];
    for (let p = 0; p < (1 << n); p++) {
      if (popcount(p) !== n / 2) continue;
      let ok = true;
      for (let k = 0; k + 2 < n; k++) { const b = (p >> k) & 7; if (b === 0 || b === 7) { ok = false; break; } }
      if (ok) out.push(p);
    }
    return (PATS[n] = out);
  }

  const NBS = {};
  function neighbours(n) {
    if (NBS[n]) return NBS[n];
    const out = [];
    for (let i = 0; i < n * n; i++) {
      const r = (i / n) | 0, c = i % n, o = [];
      if (r > 0) o.push(i - n); if (r < n - 1) o.push(i + n); if (c > 0) o.push(i - 1); if (c < n - 1) o.push(i + 1);
      out.push(o);
    }
    return (NBS[n] = out);
  }

  // ---------- puzzle context ----------
  function ctx(n, zones) {
    zones = zones || [];
    const lc = [];
    for (let r = 0; r < n; r++) { const a = []; for (let k = 0; k < n; k++) a.push(r * n + k); lc.push(a); }
    for (let c = 0; c < n; c++) { const a = []; for (let k = 0; k < n; k++) a.push(k * n + c); lc.push(a); }
    const nLines = 2 * n, zoneOf = new Int8Array(n * n).fill(-1);
    const groups = lc.slice();
    zones.forEach((z, k) => { groups.push(z.slice()); for (const i of z) zoneOf[i] = k; });
    const half = groups.map((c) => c.length / 2);
    // Every place where a zone and a row/column share cells (for "zone meets line").
    const meets = [];
    for (let L = 0; L < nLines; L++) {
      for (let k = 0; k < zones.length; k++) {
        const I = lc[L].filter((i) => zoneOf[i] === k);
        if (!I.length) continue;
        meets.push({ L, z: k, I, A: lc[L].filter((i) => zoneOf[i] !== k), B: zones[k].filter((i) => lc[L].indexOf(i) < 0) });
      }
    }
    return { n, h: n / 2, full: (1 << n) - 1, lc, groups, nLines, half, zones, zoneOf, meets, pats: patterns(n) };
  }

  function lineKV(g, cells) {
    let K = 0, V = 0;
    for (let k = 0; k < cells.length; k++) { const v = g[cells[k]]; if (v >= 0) { K |= 1 << k; if (v) V |= 1 << k; } }
    return [K, V];
  }

  // Why the last contradiction happened: { type: 'three'|'over'|'line', G, p }.
  let lastFail = null;

  // ---------- Tier 1: basic rules ----------
  // mode 'apply': fills every deduction it finds, returns -1 contradiction / 0 nothing / 1 changed.
  // mode 'list' : returns an array of deductions (or null on contradiction) without changing g.
  function t1(g, P, mode, stats) {
    const list = mode === 'list' ? [] : null;
    let changed = 0;
    const put = (i, v, d) => {
      if (list) { d.i = i; d.v = v; d.tier = 1; list.push(d); return; }
      if (g[i] < 0) { g[i] = v; changed = 1; if (stats) stats[d.kind] = (stats[d.kind] || 0) + 1; }
    };
    const n = P.n;
    for (let L = 0; L < P.nLines; L++) {
      const c = P.lc[L];
      for (let k = 0; k + 2 < n; k++) {
        const a = g[c[k]], b = g[c[k + 1]], d = g[c[k + 2]];
        if (a >= 0 && a === b && b === d) { lastFail = { type: 'three', G: L, p: a }; return list ? null : -1; }
        if (a >= 0 && a === b && d < 0) put(c[k + 2], 1 - a, { kind: 'pair', p: a, G: L, from: [c[k], c[k + 1]] });
        if (b >= 0 && b === d && a < 0) put(c[k], 1 - b, { kind: 'pair', p: b, G: L, from: [c[k + 1], c[k + 2]] });
        if (a >= 0 && a === d && b < 0) put(c[k + 1], 1 - a, { kind: 'sand', p: a, G: L, from: [c[k], c[k + 2]] });
      }
    }
    for (let G = 0; G < P.groups.length; G++) {
      const c = P.groups[G], h = P.half[G], m = c.length;
      let ca = 0, cb = 0;
      for (let k = 0; k < m; k++) { const v = g[c[k]]; if (v === 0) ca++; else if (v === 1) cb++; }
      if (ca > h || cb > h) { lastFail = { type: 'over', G, p: ca > h ? 0 : 1 }; return list ? null : -1; }
      const kind = G < P.nLines ? 'count' : (m === 2 ? 'zone2' : 'zonefull');
      if (ca === h && cb < h) { for (let k = 0; k < m; k++) if (g[c[k]] < 0) put(c[k], 1, { kind, p: 0, G }); }
      else if (cb === h && ca < h) { for (let k = 0; k < m; k++) if (g[c[k]] < 0) put(c[k], 0, { kind, p: 1, G }); }
    }
    return list ? list : changed;
  }

  function propagate1(g, P, stats) {
    for (;;) {
      const r = t1(g, P, 'apply', stats);
      if (r < 0) return false;
      if (!r) return true;
    }
  }

  // ---------- Tier 2a: zone meets line ----------
  // A zone and a row/column share some cells. If one of them has too few empty cells outside the
  // shared part, it must put some of a piece inside it. When that already covers everything the
  // other group still needs of that piece, the rest of the other group is the opposite piece.
  // sub 1: the zone forces the line; sub 2: the line forces the zone.
  function meet(g, P, mode, stats) {
    for (const M of P.meets) {
      let eI = 0; for (const i of M.I) if (g[i] < 0) eI++;
      if (!eI) continue;
      const eA = M.A.filter((i) => g[i] < 0), eB = M.B.filter((i) => g[i] < 0);
      if (!eA.length && !eB.length) continue;
      const A = P.lc[M.L], B = P.zones[M.z];
      for (let v = 0; v < 2; v++) {
        let needA = P.h, needB = B.length / 2;
        for (const i of A) if (g[i] === v) needA--;
        for (const i of B) if (g[i] === v) needB--;
        const loA = needA - eA.length, loB = needB - eB.length;
        let sub = 0, cells = null, k = 0;
        if (loB > 0 && loB >= needA && eA.length) { sub = 1; cells = eA; k = loB; }
        else if (loA > 0 && loA >= needB && eB.length) { sub = 2; cells = eB; k = loA; }
        if (!sub) continue;
        if (mode === 'list') return { kind: 'meet', sub, G: M.L, z: M.z, p: v, k, v: 1 - v, cells, i: cells[0], tier: 2 };
        for (const i of cells) g[i] = 1 - v;
        if (stats) stats.meet = (stats.meet || 0) + 1;
        return 1; // let the Easy rules run again before looking further
      }
    }
    return mode === 'list' ? null : 0;
  }

  // ---------- Tier 2b: whole-line reasoning ----------
  function t2(g, P, mode, stats) {
    const list = mode === 'list' ? [] : null;
    let changed = 0;
    const n = P.n, full = P.full;
    for (let L = 0; L < P.nLines; L++) {
      const c = P.lc[L];
      const [K, V] = lineKV(g, c);
      if (K === full) continue;
      let and = full, or = 0, cnt = 0;
      for (const p of P.pats) { if ((p & K) !== V) continue; and &= p; or |= p; cnt++; }
      if (!cnt) { lastFail = { type: 'line', G: L }; return list ? null : -1; }
      const f1 = and & ~K & full, f0 = ~or & ~K & full;
      if (!(f1 | f0)) continue;
      for (let k = 0; k < n; k++) {
        const bit = 1 << k;
        if (!((f1 | f0) & bit)) continue;
        const v = (f1 & bit) ? 1 : 0;
        if (list) list.push({ kind: 'line', i: c[k], v, G: L, tier: 2 });
        else if (g[c[k]] < 0) { g[c[k]] = v; changed = 1; if (stats) stats.line = (stats.line || 0) + 1; }
      }
      if (list && list.length) return list; // one line at a time is plenty for hints
    }
    return list ? list : changed;
  }

  function propagate2(g, P, stats) {
    for (;;) {
      if (!propagate1(g, P, stats)) return false;
      if (meet(g, P, 'apply', stats)) continue;
      const r = t2(g, P, 'apply', stats);
      if (r < 0) return false;
      if (!r) return true;
    }
  }

  // ---------- Tiers 3 & 4: one-step "what if" ----------
  // The solution is always known, so only the wrong value is tried: if it leads to a
  // contradiction, the right value is proven. lvl 1 = Easy propagation (Hard), 2 = Medium (Expert).
  function trial(g, P, sol, lvl, mode, stats) {
    let changed = 0, best = null;
    for (let i = 0; i < g.length; i++) {
      if (g[i] >= 0) continue;
      const h = Int8Array.from(g);
      h[i] = 1 - sol[i];
      const ok = lvl === 1 ? propagate1(h, P, null) : propagate2(h, P, null);
      if (ok) continue;
      if (mode === 'first') {
        // The hint shows the what-if that collapses fastest: it is the easiest one to follow.
        let steps = 0; for (let k = 0; k < h.length; k++) if (h[k] >= 0 && g[k] < 0) steps++;
        if (!best || steps < best.steps) best = { kind: 'trial', i, v: sol[i], tier: lvl + 2, steps, fail: lastFail };
        continue;
      }
      g[i] = sol[i]; changed = 1;
      if (stats) {
        stats.whatif = (stats.whatif || 0) + 1;
        if (lastFail && lastFail.type === 'over' && lastFail.G >= P.nLines) stats.whatifZone = (stats.whatifZone || 0) + 1;
      }
    }
    return mode === 'first' ? best : changed;
  }

  function isFull(g) { for (let i = 0; i < g.length; i++) if (g[i] < 0) return false; return true; }

  // Logic-only solve. Returns { ok, tier, g, stats }.
  function solve(P, g0, sol, maxTier) {
    const g = Int8Array.from(g0), stats = {};
    let tier = 1;
    for (;;) {
      if (!propagate1(g, P, stats)) return { ok: false, tier, g, stats };
      if (isFull(g)) return { ok: true, tier, g, stats };
      if (maxTier >= 2) {
        if (meet(g, P, 'apply', stats)) { tier = Math.max(tier, 2); continue; }
        const r = t2(g, P, 'apply', stats);
        if (r < 0) return { ok: false, tier, g, stats };
        if (r) { tier = Math.max(tier, 2); continue; }
      }
      if (maxTier >= 3 && trial(g, P, sol, 1, 'apply', stats)) { tier = Math.max(tier, 3); continue; }
      if (maxTier >= 4 && trial(g, P, sol, 2, 'apply', stats)) { tier = 4; continue; }
      return { ok: false, tier, g, stats };
    }
  }

  // Brute-force solution counter (stops at cap): double-checks uniqueness, and with zones
  // switched off proves the zones are needed.
  function countSolutions(P, g0, cap) {
    const g = Int8Array.from(g0);
    if (!propagate1(g, P, null)) return 0;
    let i = 0; while (i < g.length && g[i] >= 0) i++;
    if (i === g.length) return 1;
    let total = 0;
    for (let v = 0; v < 2 && total < cap; v++) { g[i] = v; total += countSolutions(P, g, cap - total); }
    return total;
  }

  // ---------- full solution ----------
  // Rows are kept distinct from each other, and so are columns: not a rule the player has to
  // reason about, just how every solution is built.
  function genSolution(n, rnd) {
    const pats = patterns(n), h = n / 2, full = (1 << n) - 1;
    for (let restart = 0; restart < 200; restart++) {
      const rows = [], ones = new Array(n).fill(0);
      let budget = 4000;
      const rec = (r) => {
        if (r === n) {
          const cols = new Set();
          for (let c = 0; c < n; c++) { let v = 0; for (let k = 0; k < n; k++) if ((rows[k] >> c) & 1) v |= 1 << k; if (cols.has(v)) return false; cols.add(v); }
          return true;
        }
        if (--budget < 0) return false;
        const order = shuffle(pats.slice(), rnd), left = n - 1 - r;
        for (const p of order) {
          if (rows.indexOf(p) >= 0) continue;
          if (r >= 2) {
            const a = rows[r - 1], b = rows[r - 2];
            if (a & b & p) continue;
            if (~(a | b | p) & full) continue;
          }
          let ok = true;
          for (let c = 0; c < n; c++) {
            const o = ones[c] + ((p >> c) & 1), z = r + 1 - o;
            if (o > h || z > h || o + left < h || z + left < h) { ok = false; break; }
          }
          if (!ok) continue;
          rows.push(p); for (let c = 0; c < n; c++) ones[c] += (p >> c) & 1;
          if (rec(r + 1)) return true;
          rows.pop(); for (let c = 0; c < n; c++) ones[c] -= (p >> c) & 1;
          if (budget < 0) return false;
        }
        return false;
      };
      if (rec(0)) {
        const g = new Int8Array(n * n);
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) g[r * n + c] = (rows[r] >> c) & 1;
        return g;
      }
    }
    throw new Error('no solution');
  }

  // ---------- zones ----------
  // Per size and difficulty: allowed zone count, flood-fill size weights, allowed number of
  // 2-cell zones. Fewer, bigger zones make easier boards; more, smaller ones harder boards.
  const ZCFG = {
    4: {
      1: { zones: [3, 5], w: [[2, 2], [4, 5], [6, 2]], two: [0, 3] },
      2: { zones: [4, 5], w: [[2, 3], [4, 5], [6, 1]], two: [1, 3] },
    },
    6: {
      1: { zones: [6, 7], w: [[2, 1], [4, 3], [6, 8]], two: [0, 2] },
      2: { zones: [7, 9], w: [[2, 2], [4, 5], [6, 3]], two: [1, 4] },
      3: { zones: [8, 10], w: [[2, 3], [4, 5], [6, 2]], two: [1, 5] },
      4: { zones: [9, 10], w: [[2, 4], [4, 5], [6, 1]], two: [2, 6] },
    },
  };
  function zcfg(n, d) { const t = ZCFG[n] || ZCFG[6]; return t[d] || t[Math.max.apply(null, Object.keys(t).map(Number))]; }
  function pickW(w, rnd) {
    let t = 0; for (const x of w) t += x[1];
    let r = rnd() * t;
    for (const x of w) { r -= x[1]; if (r < 0) return x[0]; }
    return w[w.length - 1][0];
  }

  // Random flood fill over the cells where zo[i] === free. Each zone grows from a seed until it is
  // at least its target size AND balanced (so also even), never past 6 cells. A zone that gets
  // stuck gives its cells back as leftovers (marked -2).
  function flood(n, sol, rnd, w, zo, zones, free) {
    const NB = neighbours(n), NN = n * n, left = [];
    for (;;) {
      // Seed on the free cell with the fewest free neighbours (random among ties): strands fewest cells.
      let best = [], bestN = 9;
      for (let i = 0; i < NN; i++) {
        if (zo[i] !== free) continue;
        let f = 0; for (const b of NB[i]) if (zo[b] === free) f++;
        if (f < bestN) { bestN = f; best = [i]; } else if (f === bestN) best.push(i);
      }
      if (!best.length) break;
      const s = best[Math.floor(rnd() * best.length)];
      const target = pickW(w, rnd), id = zones.length, cells = [s];
      zo[s] = id;
      let bal = sol[s] ? 1 : -1, ok = false;
      for (;;) {
        if (cells.length >= target && bal === 0) { ok = true; break; }
        if (cells.length >= 6) break;
        const fr = [];
        for (const c of cells) for (const b of NB[c]) if (zo[b] === free && fr.indexOf(b) < 0) fr.push(b);
        if (!fr.length) break;
        let pool = fr;
        if (bal !== 0 && rnd() < 0.75) { const want = bal > 0 ? 0 : 1, f2 = fr.filter((b) => sol[b] === want); if (f2.length) pool = f2; }
        const b = pool[Math.floor(rnd() * pool.length)];
        cells.push(b); zo[b] = id; bal += sol[b] ? 1 : -1;
      }
      if (ok) zones.push(cells); else for (const c of cells) { zo[c] = -2; left.push(c); }
    }
    return left;
  }

  function isStraightLine(n, z) {
    if (z.length !== n) return false;
    const r0 = (z[0] / n) | 0, c0 = z[0] % n;
    return z.every((i) => ((i / n) | 0) === r0) || z.every((i) => i % n === c0);
  }

  function genZones(n, sol, rnd, cfg, rej) {
    const NB = neighbours(n), NN = n * n;
    for (let t = 0; t < 400; t++) {
      const zo = new Int8Array(NN).fill(-1), zones = [];
      const left = flood(n, sol, rnd, cfg.w, zo, zones, -1);
      // Stranded leftovers: touching leftover cells form a cluster. A balanced cluster of at most
      // 6 cells becomes a zone of its own; a bigger balanced cluster is re-filled locally a few
      // times. An unbalanced cluster can never be fixed (merging it into a balanced neighbour
      // keeps it unbalanced), so the whole zoning starts over.
      let bad = false;
      const seen = new Set();
      for (const s of left) {
        if (seen.has(s) || bad) continue;
        const comp = [s]; seen.add(s);
        for (let q = 0; q < comp.length; q++) for (const b of NB[comp[q]]) if (zo[b] === -2 && !seen.has(b)) { seen.add(b); comp.push(b); }
        let bal = 0; for (const c of comp) bal += sol[c] ? 1 : -1;
        if (bal !== 0) { bad = true; break; }
        if (comp.length <= 6) { for (const c of comp) zo[c] = zones.length; zones.push(comp); if (rej) rej.leftoverMerged++; continue; }
        let fixed = false;
        for (let k = 0; k < 6 && !fixed; k++) {
          const zo2 = Int8Array.from(zo), z2 = zones.slice();
          for (const c of comp) zo2[c] = -3;
          if (!flood(n, sol, rnd, cfg.w, zo2, z2, -3).length) { zo.set(zo2); zones.length = 0; for (const z of z2) zones.push(z); fixed = true; }
        }
        if (!fixed) bad = true; else if (rej) rej.leftoverMerged++;
      }
      if (bad) { if (rej) rej.stranded++; continue; }
      if (zones.some((z) => isStraightLine(n, z))) { if (rej) rej.fullLine++; continue; }
      if (zones.length < cfg.zones[0] || zones.length > cfg.zones[1]) { if (rej) rej.zoneCount++; continue; }
      const two = zones.filter((z) => z.length === 2).length;
      if (two < cfg.two[0] || two > cfg.two[1] || two === zones.length) { if (rej) rej.sizeMix++; continue; }
      for (const z of zones) z.sort((a, b) => a - b);
      zones.sort((a, b) => a[0] - b[0]);
      return zones;
    }
    return null;
  }

  // Soft pastel fills (never strong orange or blue: those are the pieces). No two touching
  // zones share a colour; colours repeat only when there are more zones than colours.
  const PALETTE = [0xD9CFF2, 0xC4ECD9, 0xF1E4BE, 0xF7CDD8, 0xCCDBB6, 0xEEEAB4, 0xE5CBE3, 0xDCD8CE];
  const PALETTE_NAMES = ['lilac', 'mint', 'sand', 'rose', 'sage', 'lemon', 'mauve', 'stone'];
  function colourZones(n, zones, rnd) {
    const NB = neighbours(n), zo = new Int8Array(n * n), Z = zones.length;
    zones.forEach((z, k) => { for (const i of z) zo[i] = k; });
    const adj = zones.map(() => new Set());
    for (let i = 0; i < n * n; i++) for (const b of NB[i]) if (zo[b] !== zo[i]) adj[zo[i]].add(zo[b]);
    const pal = shuffle(PALETTE.map((_, k) => k), rnd), col = new Array(Z).fill(-1), used = new Array(PALETTE.length).fill(0);
    const rec = (k) => {
      if (k === Z) return true;
      const cand = pal.filter((c) => { for (const a of adj[k]) if (col[a] === c) return false; return true; }).sort((a, b) => used[a] - used[b]);
      for (const c of cand) { col[k] = c; used[c]++; if (rec(k + 1)) return true; used[c]--; col[k] = -1; }
      return false;
    };
    rec(0);
    return col;
  }

  // ---------- generator ----------
  function newRej() { return { stranded: 0, fullLine: 0, zoneCount: 0, sizeMix: 0, leftoverMerged: 0, zoningFailed: 0, offTarget: 0, needsGuess: 0, noZoneUnique: 0 }; }

  // opts: { n, diff (1..4), seed, extra, attempts }. The same options always give the same board.
  // Medium and harder boards must NOT have a unique solution once the zones are switched off.
  function generate(opts) {
    const n = opts.n, target = opts.diff, cfg = zcfg(n, target), t0 = now(), base = String(opts.seed);
    const maxAttempts = opts.attempts || [0, 40, 40, 60, 160][target];
    const rej = newRej(), natural = [0, 0, 0, 0, 0];
    let best = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rnd = mulberry32(hashStr(base + '#' + attempt));
      const sol = genSolution(n, rnd);
      const zones = genZones(n, sol, rnd, cfg, rej);
      if (!zones) { rej.zoningFailed++; continue; }
      const P = ctx(n, zones);
      const g = Int8Array.from(sol);
      const order = shuffle([...Array(n * n).keys()], rnd);
      // Remove pieces in random order; a removal stays only while the logic solver (capped at the
      // target difficulty) still solves the board, which also proves the solution is unique.
      for (const t of target > 1 ? [1, target] : [1]) {
        for (const i of order) {
          if (g[i] < 0) continue;
          const v = g[i]; g[i] = -1;
          if (!solve(P, g, sol, t).ok) g[i] = v;
        }
      }
      // Easier boards: put a few solved cells back as givens.
      if (opts.extra) { const em = order.filter((i) => g[i] < 0); for (let k = 0; k < opts.extra && k < em.length; k++) g[em[k]] = sol[em[k]]; }
      const res = solve(P, g, sol, 4);
      if (!res.ok) { rej.needsGuess++; continue; }
      natural[res.tier]++;
      if (countSolutions(P, g, 2) !== 1) { rej.needsGuess++; continue; }
      const noZone = countSolutions(ctx(n, []), g, 2);
      if (target >= 2 && noZone === 1) { rej.noZoneUnique++; continue; }
      let givens = 0; for (let i = 0; i < n * n; i++) if (g[i] >= 0) givens++;
      const out = {
        n, sol: Array.from(sol), givens: Array.from(g), zones, colors: colourZones(n, zones, rnd),
        rating: res.tier, diff: target, seed: base, attempt,
        dev: { givens, used: res.stats, noZone, zones: zones.length, sizes: zones.map((z) => z.length) },
      };
      if (res.tier === target) { best = out; break; }
      rej.offTarget++;
      if (!best || Math.abs(res.tier - target) < Math.abs(best.rating - target) ||
          (Math.abs(res.tier - target) === Math.abs(best.rating - target) && res.tier > best.rating)) best = out;
    }
    if (!best) return generate(Object.assign({}, opts, { seed: base + '*' })); // never seen in testing
    best.dev.rej = rej; best.dev.natural = natural; best.dev.ms = Math.round((now() - t0) * 10) / 10;
    return best;
  }

  // count seeds per difficulty for one size; one row per board (benchmark for the report).
  function bench(n, diffs, count, prefix) {
    const rows = [];
    for (const d of diffs) for (let s = 0; s < count; s++) {
      const pz = generate({ n, diff: d, seed: prefix + s });
      rows.push({ n, seed: pz.seed, diff: d, rating: pz.rating, ms: pz.dev.ms, attempt: pz.attempt, givens: pz.dev.givens, zones: pz.dev.zones, noZone: pz.dev.noZone, used: pz.dev.used, rej: pz.dev.rej, natural: pz.dev.natural });
    }
    return rows;
  }

  // ---------- player-facing helpers (main thread) ----------
  let lastPz = null, lastP = null;
  function ctxOf(pz) { if (pz !== lastPz) { lastPz = pz; lastP = ctx(pz.n, pz.zones); } return lastP; }
  function groupType(P, G) { return G < P.n ? 'row' : G < P.nLines ? 'column' : 'zone'; }

  // Next logical step from the player's board (assumed to have no wrong cells).
  // Returns { kind, tier, i (cell to play), v, p, gt (row|column|zone), k, sub, wrong, ev (cells to highlight) }.
  function nextStep(pz, board) {
    const P = ctxOf(pz), g = Int8Array.from(board.map((v) => (v == null ? -1 : v)));
    const l1 = t1(g, P, 'list');
    if (l1 && l1.length) {
      let d = null;
      for (const kind of ['pair', 'sand', 'zone2', 'zonefull', 'count']) { d = l1.find((x) => x.kind === kind); if (d) break; }
      if (d.kind === 'pair' || d.kind === 'sand') return { kind: d.kind, tier: 1, i: d.i, v: d.v, p: d.p, ev: d.from.slice() };
      const grp = P.groups[d.G];
      return { kind: d.kind, tier: 1, i: d.i, v: d.v, p: d.p, gt: groupType(P, d.G), k: P.half[d.G], ev: grp.filter((c) => c !== d.i) };
    }
    const m = meet(g, P, 'list');
    if (m) return { kind: 'meet', tier: 2, i: m.i, v: m.v, p: m.p, k: m.k, sub: m.sub, gt: groupType(P, m.G), ev: P.lc[m.G].concat(P.zones[m.z].filter((c) => P.lc[m.G].indexOf(c) < 0)).filter((c) => c !== m.i) };
    const l2 = t2(g, P, 'list');
    if (l2 && l2.length) { const d = l2[0]; return { kind: 'line', tier: 2, i: d.i, v: d.v, gt: groupType(P, d.G), ev: P.lc[d.G].filter((c) => c !== d.i) }; }
    const sol = Int8Array.from(pz.sol);
    const w = trial(Int8Array.from(g), P, sol, 1, 'first') || trial(Int8Array.from(g), P, sol, 2, 'first');
    if (w) {
      const f = w.fail || { type: 'line', G: 0 };
      return { kind: 'trial', tier: w.tier, i: w.i, v: w.v, wrong: 1 - w.v, why: f.type, p: f.p, gt: groupType(P, f.G), ev: P.groups[f.G].filter((c) => c !== w.i) };
    }
    for (let i = 0; i < g.length; i++) if (g[i] < 0) return { kind: 'reveal', tier: 4, i, v: pz.sol[i], ev: [] };
    return null;
  }

  // What breaks a rule right now: { cells (player tiles to mark), lines, zones (zone indexes) }.
  // Frozen givens are always right, so they are never marked.
  function violations(pz, board) {
    const P = ctxOf(pz), n = P.n, g = board.map((v) => (v == null ? -1 : v));
    const cells = new Set(), lines = new Set(), zones = new Set();
    for (let L = 0; L < P.nLines; L++) {
      const c = P.lc[L];
      for (let k = 0; k + 2 < n; k++) {
        const a = g[c[k]];
        if (a >= 0 && a === g[c[k + 1]] && a === g[c[k + 2]]) { cells.add(c[k]); cells.add(c[k + 1]); cells.add(c[k + 2]); lines.add(L); }
      }
    }
    for (let G = 0; G < P.groups.length; G++) {
      const c = P.groups[G], cnt = [0, 0];
      for (const i of c) if (g[i] >= 0) cnt[g[i]]++;
      for (let p = 0; p < 2; p++) if (cnt[p] > P.half[G]) {
        if (G < P.nLines) { lines.add(G); for (const i of c) if (g[i] === p) cells.add(i); }
        else zones.add(G - P.nLines); // a zone is marked as a whole: red border plus an icon
      }
    }
    if (pz.givens) for (const c of Array.from(cells)) if (pz.givens[c] >= 0) cells.delete(c);
    return { cells, lines, zones, any: cells.size > 0 || zones.size > 0 };
  }

  // Groups (rows, columns, zones) that are complete and break no rule, for the completion glow.
  function goodLines(pz, board) {
    const P = ctxOf(pz), v = violations(pz, board), out = [];
    for (let G = 0; G < P.groups.length; G++) {
      if (G < P.nLines ? v.lines.has(G) : v.zones.has(G - P.nLines)) continue;
      if (P.groups[G].every((i) => board[i] != null && board[i] >= 0)) out.push(G);
    }
    return out;
  }

  const API = { hashStr, mulberry32, shuffle, patterns, ctx, ctxOf, solve, countSolutions, generate, bench, nextStep, violations, goodLines, genSolution, colourZones, PALETTE, PALETTE_NAMES };

  // ---------- worker entry ----------
  if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof importScripts === 'function') {
    self.onmessage = (e) => {
      const { id, opts, bench: b } = e.data;
      try {
        if (b) self.postMessage({ id, rows: bench(b.n, b.diffs, b.count, b.prefix) });
        else self.postMessage({ id, puzzle: generate(opts) });
      } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
    };
  } else {
    root.OP = root.OP || {};
    root.OP.Puzzle = API;
  }
})(typeof self !== 'undefined' ? self : this);

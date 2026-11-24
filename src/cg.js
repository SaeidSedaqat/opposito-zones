// Opposito Zones: CrazyGames SDK v3 wrapper. The loader (index.html) loads and initialises the SDK
// everywhere except github.io and leaves it in window.OP_CG.sdk only when its environment is
// 'crazygames' or 'local' (localhost). Everywhere else every call here is a silent no-op.
(function () {
  'use strict';
  const OP = window.OP;
  const sdk = (window.OP_CG && window.OP_CG.sdk) || null;
  function call(f) { if (!sdk) return; try { const r = f(sdk); if (r && r.catch) r.catch(() => {}); } catch (e) { /* never let the SDK break the game */ } }

  // `want` is what the game reports; it only reaches the SDK once loading has been reported done
  // (the first board can be up behind the loading screen, and loading stop must come first).
  let playing = false, want = false, loaded = false;
  function flush() {
    const on = loaded && want;
    if (on === playing) return;
    playing = on;
    call((s) => (on ? s.game.gameplayStart() : s.game.gameplayStop()));
  }
  OP.cg = {
    on: !!sdk,
    sdk,
    // Gameplay start/stop: deduplicated, so callers can simply report the current state as often as they like.
    setPlaying(on) { want = !!on; flush(); },
    loadingStop() { if (loaded) return; loaded = true; call((s) => s.game.loadingStop()); flush(); },
    // Site-wide celebration: kept for rare moments only (CrazyGames asks for it to stay special).
    happytime() { call((s) => s.game.happytime()); },
    // CrazyGames' own mute setting wins over the in-game Sound/Music toggles.
    muted() { try { return !!(sdk && sdk.game.settings && sdk.game.settings.muteAudio); } catch (e) { return false; } },
    onSettings(cb) { call((s) => s.game.addSettingsChangeListener(cb)); },
  };
})();

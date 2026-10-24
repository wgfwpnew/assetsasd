/* retrobowl.me 2026-09-22: replaces patch/poki-sdk.js (a queue shim that loaded the real Poki
   SDK core v2.263.0, whose init() failed off-domain with a TypeError and which could leave a
   GameMaker ad callback waiting forever). Every SDK call now settles immediately. */
(function () {
  var noop = function () {}

  /* Why the boost paid out wrongly twice in one day is hard to tell from the game
     alone: every branch ends in the same coin. So every decision says what it did.
     Open the frame with ?rbdebug=1 (or set localStorage 'rb-debug' = '1') on the
     device that sees the bug and the chain is printed on screen, in order. */
  var DEBUG = false
  try { DEBUG = /[?&]rbdebug=1/.test(location.search) || localStorage.getItem('rb-debug') === '1' } catch (e) {}
  function rbLog (msg) {
    try { console.log('[rb-reward] ' + msg) } catch (e) {}
    if (!DEBUG) return
    var box = document.getElementById('rb-debug-box')
    if (!box) {
      box = document.createElement('div')
      box.id = 'rb-debug-box'
      box.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:2147483646;max-width:80vw;' +
        'padding:6px 9px;border-radius:8px;background:rgba(0,0,0,.82);color:#7ee787;' +
        'font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none'
      document.body.appendChild(box)
    }
    var line = document.createElement('div')
    line.textContent = new Date().toISOString().slice(11, 19) + '  ' + msg
    box.appendChild(line)
    while (box.childNodes.length > 10) box.removeChild(box.firstChild)
  }

  /* Rewarded-ad broker: keeps one preloaded H5 rewarded ad in hand at all times.
     Same design as the wrapper's lib/rewarded.ts, written for the game frame. */
  var R = (function () {
    var show = null, inFlight = false, waiter = null, timer = null, misses = 0
    var GRACE = 2500, SHOWN = 60000
    window.__rbReward = { requests: 0, preloads: 0, viewed: 0, dismissed: 0, noad: 0 }

    function available () { return typeof window.adBreak === 'function' && !!window.__rbAfg }
    function arm (ms, outcome) { clearTimeout(timer); timer = setTimeout(function () { settle(outcome) }, ms) }
    function settle (outcome) {
      clearTimeout(timer); timer = null
      var w = waiter; if (!w) return
      waiter = null
      window.__rbReward[outcome] += 1
      try { w(outcome) } catch (e) {}
    }
    function preload () {
      if (!available() || inFlight || show) return
      inFlight = true
      var sawReward = false
      try {
        window.adBreak({
          type: 'reward',
          name: 'coin-boost',
          beforeReward: function (showFn) {
            sawReward = true; misses = 0; window.__rbReward.preloads += 1
            if (waiter) { arm(SHOWN, 'noad'); try { showFn() } catch (e) { settle('noad') } }
            else show = showFn
          },
          adViewed:    function () { show = null; settle('viewed') },
          adDismissed: function () { show = null; settle('dismissed') },
          adBreakDone: function () {
            inFlight = false; show = null
            settle('noad')                       // only bites when nothing was shown
            misses = sawReward ? 0 : misses + 1
            if (misses < 4) setTimeout(preload, misses ? 30000 : 5000)
          }
        })
      } catch (e) { inFlight = false }
    }
    function request (cb) {
      window.__rbReward.requests += 1
      waiter = cb
      if (show) { var f = show; show = null; arm(SHOWN, 'noad'); try { f() } catch (e) { settle('noad') } ; return }
      preload(); arm(GRACE, 'noad')
    }
    // start warming as soon as the ads script is up; retry while it is still loading
    var tries = 0
    ;(function warm () { if (available()) return preload(); if (++tries < 40) setTimeout(warm, 1000) })()
    return { available: available, request: request, preload: preload }
  })()
  /* Fullscreen interstitial broker. Used as the fallback for CoinBoost when Google has
     no rewarded ad to give us: the player still watches a full-screen ad, so the boost is
     still earned, instead of being handed out for nothing. */
  var MIN_AD_MS = 3000        // shorter than this and nobody watched anything
  var I = (function () {
    var notFirst = false
    window.__rbBreak = { requests: 0, shown: 0, noad: 0 }
    function show (cb) {
      if (typeof window.adBreak !== 'function' || !window.__rbAfg) return cb(false)
      window.__rbBreak.requests += 1
      var done = false, opened = false, timer = null, openedAt = 0
      function watched () { return opened && (Date.now() - openedAt) >= MIN_AD_MS }
      function settle (shown) {
        if (done) return
        done = true
        clearTimeout(timer)
        window.__rbBreak[shown ? 'shown' : 'noad'] += 1
        rbLog('interstitial ' + (shown ? 'watched' : 'no ad'))
        try { cb(shown) } catch (e) {}
      }
      function arm (ms, shown) { clearTimeout(timer); timer = setTimeout(function () { settle(shown) }, ms) }
      arm(6000, false)                        // nothing reported back = no ad
      try {
        window.adBreak({
          type: notFirst ? 'next' : 'start',
          name: 'coin-boost-break',
          beforeAd: function () { opened = true; openedAt = Date.now(); arm(60000, true) },
          // "beforeAd fired" is not "the player watched an ad": Google opens the
          // break and can close it again in the same tick when the creative fails,
          // and this path was paying the boost for that. Pay only for a break that
          // was really on screen for MIN_AD_MS.
          afterAd: function () { settle(watched()) },
          adBreakDone: function () { settle(watched()) }
        })
        notFirst = true
      } catch (e) { settle(false) }
    }
    return { show: show }
  })()

  /* House rewarded fallback — owner, 2026-09-22: "retrobowl.me giờ reward không chạy luôn r".
     Requiring a *watched* ad is right, but Google's rewarded and interstitial breaks come back
     empty often enough (thin H5 fill, frequency caps) that the CoinBoost was simply dead. So when
     both come back with nothing we show what we do have: a real AdSense display unit, fullscreen
     over the game, with a countdown. The player watches it and the boost is paid when the
     countdown ends — never when they press Yes. Closing it early pays nothing. */
  var HOUSE_SECONDS = 5
  var FILL_WAIT_MS = 4000      // how long an AdSense unit gets to render before we give up on it
  function houseReward (cb) {
    if (document.getElementById('rb-house-ad')) return cb(false)
    var done = false
    function finish (paid) {
      if (done) return
      done = true
      clearInterval(tick); clearInterval(poll)
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap)
      window.__rbReward.house = (window.__rbReward.house || 0) + (paid ? 1 : 0)
      try { cb(paid) } catch (e) {}
    }

    var wrap = document.createElement('div')
    wrap.id = 'rb-house-ad'
    wrap.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:rgba(10,10,10,.94);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;' +
      'font:500 13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#f4f1ea'

    var label = document.createElement('div')
    label.textContent = 'Advertisement'
    label.style.cssText = 'letter-spacing:.14em;text-transform:uppercase;font-size:10px;opacity:.6'

    var slot = document.createElement('ins')
    slot.className = 'adsbygoogle'
    slot.style.cssText = 'display:inline-block;width:336px;max-width:92vw;height:280px;background:#1b1b1b'
    slot.setAttribute('data-ad-client', 'ca-pub-6875580793823494')
    slot.setAttribute('data-ad-slot', '6604073340')

    var note = document.createElement('div')
    note.style.cssText = 'opacity:.85'

    var close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    close.style.cssText = 'margin-top:2px;padding:7px 18px;border:0;border-radius:999px;background:#2a2a2a;color:#cfcac0;font:inherit;cursor:pointer'
    close.onclick = function () { finish(false) }

    wrap.appendChild(label); wrap.appendChild(slot); wrap.appendChild(note); wrap.appendChild(close)
    document.body.appendChild(wrap)
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}) } catch (e) {}

    // Wait for the unit to actually render before the countdown starts. An
    // unfilled slot is a blank rectangle: counting down over it and paying anyway
    // is the same free coin as before, with a five-second pause in front of it
    // (owner, 2026-09-22: "chưa bấm đã nhận coin, bấm thì k thấy gì").
    var left = HOUSE_SECONDS
    var tick = null
    var waited = 0
    note.textContent = 'Loading ad\u2026'
    function filled () {
      if (slot.getAttribute('data-ad-status') === 'filled') return true
      var f = slot.querySelector('iframe')
      return !!(f && f.getBoundingClientRect().height > 50)
    }
    function countdown () {
      note.textContent = 'Your reward in ' + left + 's'
      tick = setInterval(function () {
        left -= 1
        if (left > 0) { note.textContent = 'Your reward in ' + left + 's'; return }
        rbLog('house ad watched -> reward')
        finish(true)
      }, 1000)
    }
    var poll = setInterval(function () {
      waited += 250
      if (filled()) { clearInterval(poll); countdown(); return }
      if (slot.getAttribute('data-ad-status') === 'unfilled' || waited >= FILL_WAIT_MS) {
        clearInterval(poll)
        rbLog('house ad unfilled -> no reward')
        note.textContent = 'No ad available right now \u2014 try again in a moment.'
        close.textContent = 'OK'
        setTimeout(function () { finish(false) }, 2200)
      }
    }, 250)
  }

  var resolved = function (v) { return function () { return Promise.resolve(v) } }
  var sdk = {
    init: resolved(),
    initWithVideoHB: resolved(),
    commercialBreak: resolved(),
    // "Watch an ad" (CoinBoost after a match). Three steps, in this order:
    //   1. the preloaded Google rewarded ad — watched to the end pays, closed early does not;
    //   2. no rewarded fill -> a fullscreen interstitial, which pays if it actually opened;
    //   3. still nothing -> our own fullscreen AdSense unit with a 5 s countdown (houseReward).
    // What never happens any more is the old behaviour the owner caught twice on 2026-09-22:
    // paying the boost the instant Yes was pressed ("chưa chạy xong reward đã nhận được coin"),
    // which is what `resolve(true)` on a 'noad' amounts to — and then, once that was closed off,
    // paying nothing at all because Google had no ad to give ("reward không chạy luôn").
    rewardedBreak: function () {
      return new Promise(function (resolve) {
        function pay (v, why) { rbLog('CoinBoost -> ' + (v ? 'PAID' : 'not paid') + ' (' + why + ')'); resolve(v) }
        rbLog('CoinBoost requested')
        if (!R.available()) return pay(false, 'H5 ads not available in this frame')
        R.request(function (outcome) {
          rbLog('google rewarded: ' + outcome)
          if (outcome === 'viewed') return pay(true, 'rewarded ad watched')
          if (outcome === 'dismissed') return pay(false, 'closed early')
          I.show(function (shown) {
            if (shown) return pay(true, 'interstitial watched')
            houseReward(function (paid) { pay(paid, paid ? 'house ad watched' : 'no ad anywhere') })
          })
        })
      })
    },
    getLeaderboard: resolved([]),
    shareableURL: function () { return Promise.resolve(location.href) },
    getSharableURL: function () { return Promise.resolve(location.href) },
    getURLParam: function (p) { try { return new URLSearchParams(location.search).get(p) || '' } catch (e) { return '' } },
    isAdBlocked: function () { return false },
    isAdEnabled: function () { return true },
    displayAd: function () { return true },
    destroyAd: noop,
    getSWPath: function () { return '' }
  }
  ;['disableProgrammatic','gameLoadingStart','gameLoadingFinished','gameInteractive','roundStart','roundEnd','muteAd',
    'setDebug','gameplayStart','gameplayStop','gameLoadingProgress','happyTime','setPlayerAge','togglePlayerAdvertisingConsent',
    'logError','sendHighscore','customEvent','setCoreConfig','setDebugTouchOverlayController'].forEach(function (k) { sdk[k] = noop })
  window.PokiSDK = new Proxy(sdk, { get: function (t, p) {
    if (p in t) return t[p]
    if (typeof p !== 'string') return undefined
    return p.indexOf('is') === 0 ? function () { return false } : resolved()
  } })
})()

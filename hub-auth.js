/* hub-auth.js (8 Nov 2026; team mode and form mode 10 Nov 2026)
 *
 * Include ONCE in a page, before the page's own scripts.
 *
 * Client hub (and that client's own forms):
 *   <script src="hub-auth.js" data-client="cookaborough"></script>
 * Fetches that client's token from /api/hub-token/<client> and adds it as
 * X-Client-Token to every fetch the page makes to sabel-webhook /api/tracker.
 * Forms the hub shows in a frame are loaded from this site, the shared ones
 * from the client's own address /c/<client>/<Form>.
 *
 * Internal Sabel page:
 *   <script src="hub-auth.js" data-team></script>
 * Fetches the team passcode from /api/team-token (answers Sabel sign-ins
 * only) and adds it as X-Team-Token on sabel-webhook /api/tracker, /api/notion,
 * /api/motion and /api/feedback, so the page can read locked keys and the
 * team-only endpoints.
 *
 * Form shared by every client (readiness check, migration intake, kick-off):
 *   <script src="hub-auth.js" data-form></script>
 * One client's own form page:
 *   <script src="hub-auth.js" data-form data-client="smokeball"></script>
 * Opened at /c/<client>/<Form> either behaves as that client's page. Opened at
 * its plain address (staff only) it behaves as an internal page.
 *
 * The token endpoints are on the same origin and only answer after Cloudflare
 * Access sign-in. The page's own code is untouched.
 *
 * Served from anywhere else (an old GitHub Pages copy, a file on disk) the
 * token fetch fails, nothing is added, and a LOCKED key answers 401, which
 * the page already reports as "cannot reach its saved data".
 */
(function () {
  var s = document.currentScript;
  var client = s && s.getAttribute('data-client');
  var team = !!(s && s.hasAttribute('data-team'));
  var form = !!(s && s.hasAttribute('data-form'));
  if ((!client && !team && !form) || typeof window.fetch !== 'function') return;

  var HUBS = 'hubs.sabelcustomersuccess.com';
  var SLUG = /^[a-z0-9-]{1,40}$/;
  var SHARED = ['SabelReadinessCheck', 'SabelMigrationIntake', 'SabelKickoff'];
  // Same rule the forms use to turn ?client= into the slug in their storage key.
  function slugify(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

  var HOST = 'sabel-webhook.vercel.app';
  function isWebhook(url, paths) {
    var u;
    try { u = new URL(url, location.href); } catch (e) { return false; }
    return u.protocol === 'https:' && u.hostname === HOST && u.port === '' &&
      u.username === '' && u.password === '' && paths.test(u.pathname);
  }

  function isSharedKey(url) {
    try { return new URL(url, location.href).searchParams.get('key') === 'readiness-inputs-v1'; } catch (e) { return false; }
  }

  // Old GitHub Pages copy: send the visitor to the live page. Same file name,
  // same query and hash, so bookmarks and deep links keep working. Only pages
  // that carry this include redirect, so pages not yet moved are untouched.
  if (/\.github\.io$/i.test(location.hostname)) {
    var file = location.pathname.split('/').pop() || '';
    var go = function (where) { location.replace('https://' + HUBS + where + file + location.search + location.hash); };
    if (!form) { go('/'); return; }
    // A shared form serves clients who have moved and clients who have not, so
    // it cannot forward everyone. It forwards only once this client's saved
    // answers are LOCKED (sabel-webhook answers 401), which is exactly when the
    // old copy stops working: then to the client's own address, from ?client=.
    // A client's own form page names its client in the include instead.
    var want = client || '';
    if (!want) { try { want = slugify(new URLSearchParams(location.search).get('client')); } catch (e) {} }
    var plainFetch = window.fetch, gone = false;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var p = plainFetch.call(this, input, init);
      if (!isWebhook(url, /^\/api\/tracker$/)) return p;
      // readiness-inputs-v1 is shared by every client and becomes staff only.
      // Its 401 says nothing about THIS client having moved, so it never forwards.
      if (isSharedKey(url)) return p;
      return p.then(function (r) {
        if (r.status === 401 && !gone) { gone = true; go(SLUG.test(want) ? '/c/' + want + '/' : '/'); }
        return r;
      });
    };
    return;
  }

  if (form) {
    var m = /^\/c\/([a-z0-9-]{1,40})\//.exec(location.pathname);
    if (m) client = m[1]; else { team = true; client = null; }
  }
  if (client && !SLUG.test(client)) return;

  // Team mode also covers the other team-only endpoints (client contracts,
  // completed tasks, feedback reads). A client token only ever goes to tracker.
  //
  // The address is PARSED and each part compared exactly. A pattern match on
  // the whole string would also hit another site that merely carries our
  // address in its query string or path, and send the token there.
  var PATHS = team ? /^\/api\/(tracker|notion|motion|feedback)$/ : /^\/api\/tracker$/;
  var API = { test: function (url) { return isWebhook(url, PATHS); } };
  var HEADER = team ? 'X-Team-Token' : 'X-Client-Token';
  // From the site root, so it is the same address from /c/<client>/<Form>.
  var SOURCE = team ? '/api/team-token' : '/api/hub-token/' + encodeURIComponent(client);
  var origFetch = window.fetch;
  var token = null;
  var ready = origFetch(SOURCE, { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { token = (j && j.ok && j.token) || null; })
    .catch(function () { token = null; });

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!API.test(url)) return origFetch.call(this, input, init);
    var self = this;
    return ready.then(function () {
      if (!token) return origFetch.call(self, input, init);
      init = init ? Object.assign({}, init) : {};
      var h = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
      // A page that already sends its own team passcode keeps it.
      if (!(team && h.get(HEADER))) h.set(HEADER, token);
      init.headers = h;
      return origFetch.call(self, input, init);
    });
  };

  // A client hub shows forms in a frame, from links saved when the forms lived
  // on github.io. Load them from the client's own address on this site
  // instead, /c/<client>/<Form>, which their sign-in covers: the shared forms
  // and the client's own form pages. Anything else is left alone.
  function formAddress(src) {
    var u;
    try { u = new URL(src, location.href); } catch (e) { return src; }
    var old = /\.github\.io$/i.test(u.hostname);
    if (!old && u.origin !== location.origin) return src;
    var p = (old ? /^\/Intake-forms\/([A-Za-z0-9_]+)(?:\.html)?$/ : /^\/([A-Za-z0-9_]+)(?:\.html)?$/).exec(u.pathname);
    if (!p) return src;
    if (SHARED.indexOf(p[1]) < 0 && !/^Sabel(MigrationIntake|Kickoff)_[A-Za-z0-9]+$/.test(p[1])) return src;
    return location.origin + '/c/' + client + '/' + p[1] + u.search + u.hash;
  }
  // Only once this client's own address answers for this visitor. A hub that
  // was onboarded before /c/<client>/ existed keeps its old form links until
  // onboard-hub is run for it again, instead of showing a refusal in the frame.
  var formsReady = Promise.resolve(false);
  if (client && !form && typeof HTMLIFrameElement !== 'undefined') {
    var d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (d && d.set && d.configurable) {
      formsReady = origFetch('/c/' + encodeURIComponent(client) + '/hub-auth.js', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
        .then(function (r) { return r.status === 200; })
        .catch(function () { return false; });
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) {
          var frame = this, given = String(v), to = formAddress(given);
          if (to === given) { d.set.call(frame, given); return; }
          formsReady.then(function (ok) { d.set.call(frame, ok ? to : given); });
        }
      });
    }
  }

  window.__hubAuth = { client: client, team: team, ready: ready, formsReady: formsReady, hasToken: function () { return !!token; } };
})();

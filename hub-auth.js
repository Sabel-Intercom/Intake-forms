/* hub-auth.js (8 Nov 2026, team mode 10 Nov 2026)
 *
 * Include ONCE in a page's <head>, before the page's own scripts.
 *
 * Client hub (and that client's own forms):
 *   <script src="hub-auth.js" data-client="cookaborough"></script>
 * Fetches that client's token from /api/hub-token/<client> and adds it as
 * X-Client-Token to every fetch the page makes to sabel-webhook /api/tracker.
 *
 * Internal Sabel page:
 *   <script src="hub-auth.js" data-team></script>
 * Fetches the team passcode from /api/team-token (answers Sabel sign-ins
 * only) and adds it as X-Team-Token on sabel-webhook /api/tracker, /api/notion,
 * /api/motion and /api/feedback, so the page can read locked keys and the
 * team-only endpoints.
 *
 * Both endpoints are on the same origin and only answer after Cloudflare
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
  if ((!client && !team) || typeof window.fetch !== 'function') return;

  // Old GitHub Pages copy: send the visitor to the live page. Same file name,
  // same query and hash, so bookmarks and deep links keep working. Only pages
  // that carry this include redirect, so pages not yet moved are untouched.
  var HUBS = 'hubs.sabelcustomersuccess.com';
  if (/\.github\.io$/i.test(location.hostname)) {
    var file = location.pathname.split('/').pop() || '';
    location.replace('https://' + HUBS + '/' + file + location.search + location.hash);
    return;
  }

  // Team mode also covers the other team-only endpoints (client contracts,
  // completed tasks, feedback reads). A client token only ever goes to tracker.
  var API = team
    ? /sabel-webhook\.vercel\.app\/api\/(tracker|notion|motion|feedback)(\?|$)/
    : /sabel-webhook\.vercel\.app\/api\/tracker(\?|$)/;
  var HEADER = team ? 'X-Team-Token' : 'X-Client-Token';
  var SOURCE = team ? 'api/team-token' : 'api/hub-token/' + encodeURIComponent(client);
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
  window.__hubAuth = { client: client, team: team, ready: ready, hasToken: function () { return !!token; } };
})();

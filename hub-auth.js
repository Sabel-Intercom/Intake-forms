/* hub-auth.js (8 Nov 2026)
 *
 * Include ONCE in a client hub's <head>, before the hub's own scripts:
 *   <script src="hub-auth.js" data-client="cookaborough"></script>
 *
 * Fetches that client's token from /api/hub-token/<client> on the same
 * origin (only answers after Cloudflare Access sign-in) and adds it as
 * X-Client-Token to every fetch the page makes to sabel-webhook
 * /api/tracker. The hub's own code is untouched.
 *
 * Served from anywhere else (an old GitHub Pages copy, a file on disk) the
 * token fetch fails, nothing is added, and a LOCKED key answers 401, which
 * the hub already reports as "cannot reach its saved data".
 */
(function () {
  var s = document.currentScript;
  var client = s && s.getAttribute('data-client');
  if (!client || typeof window.fetch !== 'function') return;

  // Old GitHub Pages copy: send the visitor to the live hub. Same file name,
  // same query and hash, so bookmarks and deep links keep working. Only hubs
  // that carry this include redirect, so clients not yet moved are untouched.
  var HUBS = 'hubs.sabelcustomersuccess.com';
  if (/\.github\.io$/i.test(location.hostname)) {
    var file = location.pathname.split('/').pop() || '';
    location.replace('https://' + HUBS + '/' + file + location.search + location.hash);
    return;
  }

  var API = /sabel-webhook\.vercel\.app\/api\/tracker(\?|$)/;
  var origFetch = window.fetch;
  var token = null;
  var ready = origFetch('api/hub-token/' + encodeURIComponent(client), { credentials: 'same-origin', cache: 'no-store' })
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
      h.set('X-Client-Token', token);
      init.headers = h;
      return origFetch.call(self, input, init);
    });
  };
  window.__hubAuth = { client: client, ready: ready, hasToken: function () { return !!token; } };
})();

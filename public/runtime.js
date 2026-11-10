// Gives the dashboard page the same window.claude.use(...) features it had on
// claude.ai, backed by this app's own server:
//   db         shared records with live updates      -> /api/docs, /api/collections, /api/live
//   user       who is signed in, names, people search -> /api/me, /api/people
//   assets     file uploads                          -> /api/assets, /_blob/<id>
//   downloads  save a file to the viewer's computer  -> handled in the browser
//   sample     AI panel detection and proof check    -> /api/ai
(function () {
  "use strict";

  function apiError(code, status) {
    var e = new Error(code || "request_failed");
    e.code = code || "request_failed";
    e.status = status;
    return e;
  }
  async function call(method, url, body, opts) {
    opts = opts || {};
    var init = { method: method, credentials: "same-origin", headers: {}, signal: opts.signal };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (e && e.name === "AbortError") throw apiError("cancelled");
      throw apiError("network_error");
    }
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw apiError(data && data.code, res.status);
    return data;
  }
  var enc = function (p) { return String(p).split("/").map(encodeURIComponent).join("/"); };

  // ---------------- live connection ----------------
  var ws = null, wsReady = null, subs = new Map(), nextSid = 1, retry = 0;
  function connect() {
    if (wsReady) return wsReady;
    wsReady = new Promise(function (resolve) {
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(proto + "//" + location.host + "/api/live");
      ws.onopen = function () {
        retry = 0;
        subs.forEach(function (s, sid) { ws.send(JSON.stringify(Object.assign({ t: "sub", sid: sid }, s.req))); });
        resolve(ws);
      };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        var s = subs.get(m.sid); if (!s) return;
        if (m.t === "err") { if (s.onErr) s.onErr(apiError(m.code)); return; }
        s.onMsg(m);
      };
      ws.onclose = function () {
        wsReady = null;
        if (!subs.size) return;
        retry = Math.min(retry + 1, 6);
        setTimeout(connect, 500 * Math.pow(2, retry));
      };
    });
    return wsReady;
  }
  function listen(req, onMsg, onErr) {
    var sid = "s" + nextSid++;
    subs.set(sid, { req: req, onMsg: onMsg, onErr: onErr });
    connect().then(function (sock) {
      if (subs.has(sid) && sock.readyState === 1) sock.send(JSON.stringify(Object.assign({ t: "sub", sid: sid }, req)));
    });
    return function unsubscribe() {
      subs.delete(sid);
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "unsub", sid: sid }));
    };
  }

  // ---------------- db ----------------
  function docSnap(id, exists, data) {
    return { id: id, exists: !!exists, data: function () { return exists ? data : undefined; } };
  }
  function querySnap(rows) {
    var docs = rows.map(function (r) { return docSnap(r.id, true, r.data); });
    return { docs: docs, size: docs.length, empty: !docs.length, forEach: function (f) { docs.forEach(f); } };
  }

  function DocRef(path) {
    var id = path.split("/").pop();
    return {
      id: id,
      path: path,
      collection: function (sub) { return Query(path + "/" + sub, {}); },
      get: function () { return call("GET", "/api/docs/" + enc(path)).then(function (r) { return docSnap(r.id, r.exists, r.data); }); },
      set: function (data) { return call("PUT", "/api/docs/" + enc(path), data).then(function () {}); },
      update: function (patch) { return call("PATCH", "/api/docs/" + enc(path), patch).then(function () {}); },
      delete: function () { return call("DELETE", "/api/docs/" + enc(path)).then(function () {}); },
      onSnapshot: function (next, error) {
        return listen({ kind: "doc", path: path }, function (m) { next(docSnap(m.id, m.exists, m.data)); }, error);
      },
    };
  }

  function Query(path, q) {
    function qs() {
      var p = new URLSearchParams();
      if (q.orderBy) { p.set("orderBy", q.orderBy); p.set("dir", q.dir || "asc"); }
      if (q.limit) p.set("limit", q.limit);
      var s = p.toString();
      return s ? "?" + s : "";
    }
    return {
      path: path,
      doc: function (id) { return DocRef(path + "/" + id); },
      add: function (data) {
        return call("POST", "/api/collections/" + enc(path), data).then(function (r) { return DocRef(path + "/" + r.id); });
      },
      orderBy: function (field, dir) { return Query(path, Object.assign({}, q, { orderBy: field, dir: dir === "desc" ? "desc" : "asc" })); },
      limit: function (n) { return Query(path, Object.assign({}, q, { limit: n })); },
      get: function () { return call("GET", "/api/collections/" + enc(path) + qs()).then(querySnap); },
      onSnapshot: function (next, error) {
        return listen(
          { kind: "col", path: path, orderBy: q.orderBy, dir: q.dir, limit: q.limit },
          function (m) { next(querySnap(m.docs)); },
          error
        );
      },
    };
  }

  var dbApi = {
    collection: function (path) { return Query(String(path), {}); },
    doc: function (path) { return DocRef(String(path)); },
  };

  // ---------------- user ----------------
  var mePromise = null;
  function me() { return mePromise || (mePromise = call("GET", "/api/me")); }
  var userApi = {
    id: function () { return me().then(function (m) { return m.id; }); },
    isOwner: function () { return me().then(function (m) { return !!m.isOwner; }); },
    canEdit: function () { return me().then(function (m) { return !!m.isEditor; }); },
    can: function (what) {
      return me().then(function (m) { return what === "data.write" ? !!m.canWrite : true; });
    },
    profiles: function (ids) { return call("POST", "/api/people/profiles", { ids: ids || [] }); },
    search: function (q) { return call("GET", "/api/people/search?q=" + encodeURIComponent(q || "")); },
  };

  // ---------------- assets ----------------
  var assetsApi = {
    upload: async function (file) {
      var res;
      try {
        res = await fetch("/api/assets", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Filename": encodeURIComponent(file.name || "file"),
          },
          body: file,
        });
      } catch (e) { throw apiError("network_error"); }
      var data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok) throw apiError(data && data.code, res.status);
      return data; // { id, name, contentType, sizeBytes, url }
    },
  };

  // ---------------- downloads ----------------
  var downloadsApi = {
    save: async function (opts) {
      var blob = opts.data instanceof Blob ? opts.data : new Blob([opts.data], { type: opts.type || "application/octet-stream" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = opts.filename || "download";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return { ok: true };
    },
  };

  // ---------------- sample (AI) ----------------
  var sampleApi = {
    limits: function () { return call("GET", "/api/ai/limits"); },
    json: async function (prompt, opts) {
      opts = opts || {};
      var fd = new FormData();
      fd.append("prompt", prompt);
      fd.append("tier", opts.modelTier === "complex" ? "complex" : "default");
      (opts.images || []).forEach(function (img, i) {
        fd.append("images", img, (img && img.name) || "image-" + i + ".jpg");
      });
      var r = await call("POST", "/api/ai/json", fd, { signal: opts.signal });
      return r.result;
    },
  };

  var features = { db: dbApi, user: userApi, assets: assetsApi, downloads: downloadsApi };

  window.claude = {
    use: async function (name) {
      if (name === "sample") {
        var lim = await sampleApi.limits().catch(function () { return null; });
        if (!lim) throw apiError("capability_disabled");
        return sampleApi;
      }
      if (name === "db") await me(); // fails fast if not signed in
      if (!features[name]) throw apiError("capability_disabled");
      return features[name];
    },
  };
})();

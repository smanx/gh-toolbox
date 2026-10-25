// ==UserScript==
// @name         ONE 本地下载转发（aria2 / MediaGo）
// @namespace    qoder.one.local.dispatch
// @version      1.0.0
// @description  one-detail-fetcher.user.js 的伴生脚本：主脚本是 @grant none（拦 App 请求靠的就是它），够不到 127.0.0.1 上的 aria2 / MediaGo；这个脚本带 GM_xmlhttpRequest，专门替它把 JSON-RPC / HTTP 发出去，再把结果写回 <html> 上的属性。没有界面、没有存储。
// @match        https://j7tu.com/*
// @match        http://j7tu.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * 为什么要有这个脚本（而不是把功能塞进 one-detail-fetcher.user.js）
 * ------------------------------------------------------------------
 * one-detail-fetcher 是 @grant none —— 它跑在页面主世界，靠直接改写
 * XMLHttpRequest.prototype / window.fetch 拦 App 自己发的那次 detail 请求。
 * 那是它全部价值所在，而这个能力只在 @grant none 下成立：一加 @grant，
 * Tampermonkey 就把脚本放进沙箱（isolated world），改写到的只是沙箱自己
 * 那一份 XHR，App 的请求一次也拦不到（v2.0.0 就栽在这）。
 *
 * 可本地 aria2（默认 127.0.0.1:6800）与 MediaGo（默认 127.0.0.1:9900）
 * 都不带 CORS 头，https 页面里的 fetch 打过去会被 CORS / 私有网络策略挡住 ——
 * 读不到结果，很多时候连发都发不出去。能打通的只有 GM_xmlhttpRequest
 * （由扩展后台代发，绕开同源策略），而它必须 @grant。
 *
 * 所以拆成两个脚本：
 *   one-detail-fetcher.user.js  留在 @grant none，取数/拦截一行不改；
 *   本脚本（伴生）              只要 GM_xmlhttpRequest，没有界面、没有存储，
 *                               专门替主脚本把请求发到本地服务。
 *
 * 两个世界怎么说话
 * ------------------------------------------------------------------
 * 主脚本在页面主世界，本脚本在沙箱；两边共用 DOM，所以用 <html> 上的属性
 * 传话 —— 和主脚本里「自动替换 token」用的 data-oneqz-repl 同一套做法。
 * 只用字符串，不跨世界传对象（Firefox 对 CustomEvent.detail 跨 realm 会报
 * Permission denied，属性字符串不会有这个问题）：
 *
 *   主 → 伴生   <html data-oneqz-local>       = { q: [ { id, op, payload } ] }
 *   伴生 → 主   <html data-oneqz-local-res>   = { q: [ { id, ok, data|error } ] }
 *   伴生就绪    <html data-oneqz-local-ready> = { v, at }
 *
 * 为什么是数组而不是「一个请求一个值」：MutationObserver 只会在回调里看到属性的
 * 最终值，两次写落在同一个微任务批次里，前一次会被后一次盖掉（表现为没回应、然后
 * 25 秒后超时）。所以两边都把「待处理的东西」放在自己的队列属性里，各写各的、
 * 谁也不改对方的属性，就不会丢。请求带唯一 id，回应按 id 认领。
 * 队列各留最近若干条，回应凑齐后主脚本会把它从自己的队列里摘掉。
 * 两边各自盯属性（MutationObserver），也都在启动时先读一次现值（谁先起来不确定）。
 *
 * 安全边界（这条必须说清）
 * ------------------------------------------------------------------
 * 页面主世界的脚本没法对页面保密：属性就写在页面的 DOM 上，j7tu.com 自己的
 * JS 也看得见、也能往里塞请求。所以本脚本做不到「只有主脚本能用」，它只能
 * 把口子收窄：
 *   1) 只发往 loopback（127.0.0.1 / localhost / [::1] / 0.0.0.0）与私网地址
 *      （10/8、172.16/12、192.168/16、169.254/16）—— 不能拿它当访问公网
 *      或任意内网主机的代理。域名一律拒绝（内网主机名认不准，认不准就不放）；
 *   2) 只认白名单里的操作：aria2 那几个 JSON-RPC 方法 + MediaGo 的
 *      /api/downloads 系列路径；
 *   3) 单条请求体上限 256 KB。
 * 最坏情况因此是「这个站点的 JS 也能往你自己的 aria2 / MediaGo 里塞任务、
 * 看任务列表」—— 它本来就在同一台机器上和你一起用这两个服务 —— 但拿不到
 * 更多的东西。
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var REQ_ATTR = "data-oneqz-local";
  var RES_ATTR = "data-oneqz-local-res";
  var READY_ATTR = "data-oneqz-local-ready";
  var MAX_REQ = 256 * 1024;      // 单条请求体上限：链接 + 请求头，正常几百字节
  var MAX_SEEN = 100;            // 记住多少个已处理的请求 id（防重放/防重复处理）

  /* aria2 只认这几个方法：主脚本用得到的是 getVersion（测连接）与 addUri /
     tellStatus（下发与看进度），其余留着给以后的面板操作。白名单的意义是
     「页面上的别的东西塞请求进来也做不了更多」。 */
  var ARIA_METHODS = {
    "aria2.getVersion": 1, "aria2.getGlobalStat": 1,
    "aria2.addUri": 1, "aria2.tellStatus": 1,
    "aria2.tellActive": 1, "aria2.tellWaiting": 1, "aria2.tellStopped": 1,
    "aria2.pause": 1, "aria2.unpause": 1, "aria2.remove": 1, "aria2.forceRemove": 1,
    "aria2.purgeDownloadResult": 1
  };
  /* MediaGo：任务列表、单个任务（查进度）、停止、批量创建。查询串只放参数，不参与路径匹配 */
  var MG_PATH = /^\/api\/downloads(?:\/[^/?#]+(?:\/stop)?)?(?:\?[^#]*)?$/;

  var html = null;
  var seq = 0;
  var chain = Promise.resolve();
  var seen = {};
  var out = [];                  // 待写回的回应队列（主人读走之前一直留着）
  var STAT = { got: 0, ok: 0, bad: 0 };

  /* ---------- 小工具 ---------- */
  function parse(t) { try { return JSON.parse(t); } catch (e) { return null; } }
  function msgOf(e) { return String((e && e.message) || e); }
  function hostOf(u) {
    try { var p = new URL(String(u)); return p.host || p.hostname; }
    catch (e) { return String(u || "").slice(0, 60); }
  }
  function setAttr(name, value) {
    try { if (html) html.setAttribute(name, value); } catch (e) {}
  }
  function enqueue(fn) {
    /* Promise.resolve().then(fn) 而不是直接 fn()：白名单/URL 校验是同步 throw，
       直接在 then 里调用会让链条变成 rejected 且「回应」永远不写 —— 请求方就会等到超时。 */
    chain = chain.then(function () { return Promise.resolve().then(fn); },
                       function () { return Promise.resolve().then(fn); })
                 .catch(function () { /* 各自已经在 run() 里写过回应，链条不许再翻红 */ });
    return chain;
  }

  /* ---------- 只放行本机 / 私网 ---------- */
  function privateHost(host) {
    var h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
    if (!h) return false;
    if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
    if (/\.localhost$/.test(h)) return true;
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return false;                       // 域名一律拒绝：解析到哪台机器我们看不见
    var a = +m[1], b = +m[2];
    if (m[1] === "127" || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;    // link-local
    return false;
  }
  function localUrl(raw) {
    var u;
    try { u = new URL(String(raw || "")); } catch (e) { throw new Error("地址不合法：" + String(raw || "").slice(0, 80)); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http/https：" + u.protocol);
    if (!privateHost(u.hostname)) {
      throw new Error("只允许本机或局域网地址（127.0.0.1 / localhost / 10.x / 172.16-31.x / 192.168.x），拒绝 " + u.hostname);
    }
    return u;
  }

  /* ---------- 发请求：只走 GM_xmlhttpRequest ---------- */
  function request(opts) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest 不可用：这个脚本必须以带 @grant 的方式安装，别把头部改成 @grant none"));
        return;
      }
      var o = {
        method: opts.method || "GET",
        url: opts.url,
        headers: opts.headers || {},
        timeout: opts.timeout || 20000,
        onload: function (r) { resolve({ status: r.status, text: r.responseText || "" }); },
        onerror: function () { reject(new Error("连不上 " + hostOf(opts.url) + "（服务没启动 / 端口不对 / 地址写错）")); },
        ontimeout: function () { reject(new Error("请求超时：" + hostOf(opts.url))); }
      };
      if (opts.data !== undefined) o.data = opts.data;
      try { GM_xmlhttpRequest(o); } catch (e) { reject(e); }
    });
  }

  /* ---------- aria2 JSON-RPC ---------- */
  function aria2Call(p) {
    var method = String((p && p.method) || "");
    if (!ARIA_METHODS[method]) throw new Error("不允许的 aria2 方法：" + method);
    var u = localUrl(p.rpc);
    var params = Array.isArray(p.params) ? p.params : [];
    var secret = String(p.secret || "");
    var payload = {
      jsonrpc: "2.0",
      id: "oneqz-" + Date.now() + "-" + (++seq),
      method: method,
      params: secret ? ["token:" + secret].concat(params) : params
    };
    return request({
      method: "POST", url: u.href,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(payload),
      timeout: 20000
    }).then(function (r) {
      var j = parse(r.text);
      if (!j) throw new Error("aria2 返回非 JSON（HTTP " + r.status + "）：" + String(r.text || "").slice(0, 120));
      if (j.error) throw new Error("aria2：" + (j.error.message || "错误") + "（code " + j.error.code + "）");
      return j.result;
    });
  }

  /* ---------- MediaGo HTTP ---------- */
  function mediagoCall(p) {
    var path = String((p && p.path) || "");
    if (!MG_PATH.test(path)) throw new Error("不允许的 MediaGo 路径：" + path);
    var url = String((p && p.base) || "").replace(/\/+$/, "") + path;
    var u = localUrl(url);
    /* URL 解析会把 ".." 归一化掉，所以拼完之后再确认一次真的还在 /api/downloads 下面
       （否则 ../../ 之类能溜到服务的别处去） */
    if (!/^\/api\/downloads(?:$|[/?])/.test(u.pathname + (u.search || ""))) {
      throw new Error("不允许的 MediaGo 路径（归一化后跑出了 /api/downloads）：" + u.pathname);
    }
    var headers = { Accept: "application/json" };
    var body;
    if (p.body !== undefined && p.body !== null) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(p.body);
    }
    if (p.key) headers.Authorization = "Bearer " + String(p.key);
    var method = String(p.method || (body ? "POST" : "GET")).toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error("只允许 GET/POST");
    return request({ method: method, url: u.href, headers: headers, data: body, timeout: 20000 })
      .then(function (r) {
        var j = parse(r.text);
        if (!j) throw new Error("MediaGo 返回非 JSON（HTTP " + r.status + "）：" + String(r.text || "").slice(0, 120));
        if (j.success === false) {
          throw new Error((j.message || "MediaGo 返回错误") + (j.code ? "（code " + j.code + "）" : ""));
        }
        if (r.status >= 400) throw new Error("HTTP " + r.status + (j.message ? "：" + j.message : ""));
        return Object.prototype.hasOwnProperty.call(j, "data") ? j.data : j;
      });
  }

  /* ---------- 回应 ---------- */
  /* 回应只由本脚本写 RES_ATTR，主脚本只读不写 —— 各写各的属性，谁也不覆盖谁。
     out 是追加式的（最多留 20 条），所以主脚本晚读也不会丢；它按 id 认领自己那条。 */
  function reply(id, ok, data, error) {
    STAT.got++;
    if (ok) STAT.ok++; else STAT.bad++;
    var o = { id: id, ok: !!ok, v: VERSION, at: Date.now() };
    if (ok) o.data = data; else o.error = String(error || "未知错误");
    out.push(o);
    if (out.length > 20) out.splice(0, out.length - 20);
    setAttr(RES_ATTR, JSON.stringify({ q: out }));
  }

  function handle(raw) {
    var msg = parse(raw);
    var q = msg && (msg.q || (msg.id ? [msg] : null));
    if (!q || !q.length) return null;
    /* 队列里可能有主脚本还没摘掉的旧请求：按 id 去重，处理过的就不再处理 */
    var todo = [];
    for (var i = 0; i < q.length; i++) {
      var it = q[i];
      if (!it || !it.id || !it.op) continue;
      if (seen[it.id]) continue;
      seen[it.id] = 1;
      var ids = Object.keys(seen);
      if (ids.length > MAX_SEEN) delete seen[ids[0]];
      if (String(JSON.stringify(it)).length > MAX_REQ) { reply(it.id, false, null, "请求体太大（上限 256KB）"); continue; }
      todo.push(it);
    }
    todo.forEach(run);
    return null;
  }

  function run(msg) {
    var op = String(msg.op), p = msg.payload || {};
    if (op === "ping") { reply(msg.id, true, { v: VERSION }); return; }
    if (op === "aria2.call") { callAndReply(aria2Call, p, msg.id); return; }
    if (op === "mediago.call") { callAndReply(mediagoCall, p, msg.id); return; }
    reply(msg.id, false, null, "不认识的 op：" + op);
  }

  /* 一条请求必有且只有一条回应：校验是同步 throw（方法不在白名单、地址不是本机、
     路径越界），所以必须放进 Promise.resolve().then 里接住 —— 否则那条请求永远收不到回应，
     对面只能等到 25 秒超时，还看不出到底哪一步错了。 */
  function callAndReply(fn, payload, id) {
    enqueue(function () {
      return Promise.resolve().then(function () { return fn(payload); })
        .then(function (d) { reply(id, true, d); },
              function (e) { reply(id, false, null, msgOf(e)); });
    });
  }

  /* ---------- 盯属性 ---------- */
  function start() {
    html = document.documentElement;
    /* 先挂就绪标记：主脚本据此知道「伴生脚本在」，不用等一次超时才发现没装 */
    setAttr(READY_ATTR, JSON.stringify({ v: VERSION, at: Date.now() }));
    /* 抹掉上一次留下的回应，免得主脚本把旧结论当成本次的（主脚本按 id 认领，双保险） */
    try { html.removeAttribute(RES_ATTR); } catch (e) {}
    out = [];

    if (typeof MutationObserver === "function") {
      var mo = new MutationObserver(function (recs) {
        for (var i = 0; i < recs.length; i++) {
          if (recs[i].attributeName !== REQ_ATTR) continue;
          var raw = html.getAttribute(REQ_ATTR);
          if (raw) handle(raw);
        }
      });
      try { mo.observe(html, { attributes: true, attributeFilter: [REQ_ATTR] }); } catch (e) {}
    }
    /* 观察器装好之前主脚本可能已经把请求写上去了（两边都是 document-start） */
    var pending = html.getAttribute(REQ_ATTR);
    if (pending) handle(pending);
  }

  if (document.documentElement) start();
  else {
    var n = 0;
    var iv = setInterval(function () {
      if (document.documentElement) { clearInterval(iv); start(); }
      else if (++n > 600) clearInterval(iv);
    }, 10);
  }

  /* 页面上什么都不显示：这个脚本的全部输出都在 <html> 的属性里。
     想看它活着没有，在控制台看 document.documentElement.dataset.oneqzLocalReady。 */
})();

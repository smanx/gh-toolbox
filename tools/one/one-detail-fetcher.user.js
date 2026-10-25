// ==UserScript==
// @name         ONE 详情页 · 模块 token 取数器
// @namespace    qoder.one.detail.fetcher
// @version      2.18.0
// @description  不依赖 URL：拦截页面自己发出的 /v2.5/article/detail（真实传输是 XHR），解密请求体还原文章 id 与 dn，再用 one 模块 token 重取一次详情；按「正片/预告 × MP4/M3U8」四格铺链接（可点、可选中复制），缺哪格就写清为什么缺，并对比两种身份。设置里可开「自动替换页面的 token」（默认关，开关会被记住）：开着时 App 自己发出的请求出门前就换成所选 token，页面直接看到替换身份的结果。拿到链接后点「⬇」先填一张单子（选哪条链接、发到哪、文件名、请求头——UA 与来源已铺进那一栏、改栏里的字就按改后的发，M3U8 还问要不要转成 MP4，勾一下就把产物自动传到 Hugging Face 数据集、上传目录可改且会被记住），确认后可以同时投给：本仓库的 Actions（MP4 → aria2.yml，M3U8 → m3u8.yml）、本地/局域网 aria2（JSON-RPC）、MediaGo（HTTP API）—— 后两个由伴生脚本 one-local-dispatch.user.js 代发
// @match        https://j7tu.com/*
// @match        http://j7tu.com/*
// @grant        none
// @connect      api.github.com
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * 为什么 v1 拿不到 id：详情页路由是 #/videoDetail，id 走 go_router 的 extra（内存参数），
 * 既不落在 URL 上，也不落在 localStorage 上。网页里唯一可靠的 id 来源是 App 自己发出的
 * 那次请求体：POST /v2.5/article/detail，body = base64( AES-128-CBC( "id=<文章id>&dn=<ts域名>" ) )。
 * 所以本脚本在 document-start 装上 XHR/fetch 钩子，解密请求体得到 id，
 * 顺带记下 App 用的真实请求头（token / user-key / uuid）和它自己的响应。
 *
 * 协议（与 one 模块 libapp.so 内常量逐字节相同）
 *   body   = base64( AES-128-CBC/PKCS7( "id=<articleId>&dn=<url 编码后的 ts 域名>" ) )
 *   resp   = base64( 同一把 KEY/IV 解密 )  —— 请求与响应用同一套密钥
 *   sign   = md5( md5("0.0.0.0.<platform>.<ts>.<user-key>.<uuid>") + SALT )
 *   user-key 必须「存在」但值不参与内容判定；detail 的门控只看 token
 *
 * 两种流、两套域名（v2.11 补全两条链接，v2.12 改成 正片/预告 × MP4/M3U8 四格）：
 *   MP4   detail 给根相对路径 /one/compress/decry/vd/.../x.mp4，拼「媒体域名池」
 *         （bootstrap 的 domain.video；one 模块 prefs 的 flutter.one_video
 *         = https://z4bey8.bx7qxb.com 是同池镜像）才 206 video/mp4；拼到 dn 上 404。
 *   M3U8  detail 给 /api/video/getM3u8.m3u8?params=...，拼「api 域」（main.dart.js tP():164735
 *         的 $.cV().r）；清单里 *.ts 分片的域名 = 请求体里的 dn，服务端原样回显，
 *         dn 取自 bootstrap 的 domain.flutter_ts_domain 首项（lc():41116）。
 *   ⇒ 想拿到 video_hls，请求体必须带 dn：只发 id= 时服务端只给 MP4（实测矩阵）。
 *   ⇒ 清单只有一个槽位：data 里的媒体字段只有 video_file / preview_video / video_hls /
 *      video_hls_h265 / audio_hls，没有 preview_hls 之类的东西。video_hls 跟着 video_file 走，
 *      解锁态是正片清单、锁定态就是预告清单（id=63737：网页态 48 秒 5 片，模块态 168.8 分钟 1013 片）。
 *
 * 自动替换页面的 token（v2.13，设置里的复选框，默认关，开关本身存 store 会被记住）：
 *   开着时，App 自己发出的 WATCH 请求在 send 之前被换成「one 模块」那一档的身份：
 *   token / uuid / user-key / sign / ip 五个头一起重算（sign 用页面自己那次的时间戳，所以不需要额外时钟），
 *   于是页面拿到的 detail 就是替换身份的结果，不需要点按钮。
 *   坑：XHR 第二次 setRequestHeader 同名头是「追加逗号」而不是覆盖，所以做法是
 *   在 setRequestHeader 阶段把这五个头扣下不传给原生，等 send() 前一次性写我们算好的。
 *   隔离世界（带 @grant 的旧式安装）里沙箱读不到 DOM 之外，主世界钩子也读不到 GM_*，
 *   所以开关与身份写在 <html data-oneqz-repl="…"> 上做过桥；关掉就摘掉属性。
 *   /purchase /buy /pay /coin /recharge /order /vip /sign_in 永远不替换。
 *   两个必须记住的实现约束（都各踩过一次，离线用例盯着）：
 *     1) 下发给主世界的 md5 只能是「自包含工厂 + 立即调用」那一串（oneqzMd5Factory），
 *        搬 MD5.toString() 会丢掉它闭包里的 rl/add/S/K，主世界里一调就 ReferenceError。
 *     2) 换头失败时必须把扣下的页面原头还回去，并且回一条 replerr 到面板；
 *        静默吞掉的话面板写着「已开」、页面却拿到缺 token 的请求，两头都骗人。
 *   CAP 里存的永远是「页面自己那次」的头，替换出去的身份不反过来污染判读。
 *
 * 一键交给 GitHub Actions（v2.14 加触发，v2.15 改成先填单子，v2.16 加抱抱脸上传，v2.17 把 UA/来源铺进那一栏）：
 *   面板上「⬇」
 *   先在面板里铺一张一次性表单 —— 下哪一条（正片/预告 × MP4/M3U8）、文件名 save_name、
 *   请求头 headers（已按当前页面铺好 UA 与来源）、选 M3U8 时多一个「转成 MP4」的勾（默认勾上）、
 *   一个「☁ 传到 HF」的勾 + 一张可改的「上传目录 hf_path」（默认值在 ⚙，勾和目录都会被记住）——
 *   点「✓ 确认触发」才真发；这些都是每次可能不一样的东西，所以不进 ⚙，⚙ 只当默认值。
 *   发出去以后投给本仓库的 workflow：MP4 是直链单文件 → .github/workflows/aria2.yml（多连接分片），
 *   M3U8 是清单 → .github/workflows/m3u8.yml（N_m3u8DL-RE 拉分片+解密+合成），
 *   调用方式与 tools/m3u8、tools/ytdlp 那两个 dispatch 脚本一致：
 *   POST /repos/<owner>/<repo>/actions/workflows/<wf>/dispatches，成功是 204 且没有响应体，
 *   所以要再去 runs 列表按 created_at 认出自己刚触发的那一次，然后每 5 秒刷状态。
 *   四个只有这里会踩的点：
 *     1) inputs 只能发 yml 里声明过的 key（urls/save_name/headers/hf_upload/hf_repo/hf_path 两个 yml 都声明了，
 *        mux_format 只有 m3u8.yml 认，发给 aria2.yml 就是 HTTP 422 "Unexpected inputs"）；
 *     2) 文件名两边规则相反：aria2 是 `-o <save_name>` 原样落盘 → MP4 没后缀会自动补 .mp4；
 *        N_m3u8DL-RE 的 --save-name 不能带后缀（它按 mux_format 补）→ M3U8 发出去前把后缀剥掉；
 *     3) 默认 @grant none 意味着没有 GM_xmlhttpRequest，只能用页面的 fetch 打 api.github.com
 *        （它回 Access-Control-Allow-Origin: *，带自定义头的 POST 走 OPTIONS 预检，实测通）；
 *        正因为请求发在页面这一侧，Token 也存在 j7tu.com 的 localStorage 里，
 *        所以只该填一个「仅这一个仓库 + Actions: write」的 fine-grained token。
 *     4) 抱抱脸的 token 绝不进这张单子：两个 workflow 只从仓库 Secret（ARIA2_HF_TOKEN / M3U8_HF_TOKEN）
 *        读它，脚本这边只发 hf_upload/hf_repo/hf_path 三个非敏感 key；hf_repo 留空就用 Secret 里的
 *        ARIA2_HF_REPO / M3U8_HF_REPO 兜底，仓库不存在时服务端按 private=true 建（dataset 类型）。
 *   headers 这边是「下载时」给媒体服务器的请求头。UA（浏览器自己那串）与 Referer（来源 = 本站 origin）
 *   不是后台偷偷补的：开单子时就把这两条写进 headers 那一栏，栏里是什么就发什么 ——
 *   删掉一条就不带一条，整栏清空就是这次不带自定义头（面板会为此单独提醒一句，媒体域对空 UA 的直连会限速或拒绝）。
 *   ⚙ 里那栏只存「额外要带的」，因为 ⚙ 要落 localStorage，把此刻的 UA 存进去迟早过期；
 *   单子是每次现开的，铺进去的两条永远跟着当前页面。
 *   M3U8 那条链接里的 params 是按次生成的，runner 排队+启动要几十秒到几分钟，过期就重取详情再触发。
 *
 * 三个出口（v2.18 加本地 aria2 / MediaGo）：
 *   单子上「发送到哪」是一排勾，可以只勾一个，也可以一次全勾：
 *     · GitHub Actions  → 上面那两个 yml（跑在你自己的仓库上，产物在 artifacts / HF）
 *     · 本地 aria2      → aria2 JSON-RPC（addUri + tellStatus 轮询进度）
 *     · MediaGo         → MediaGo HTTP API（POST /api/downloads + GET 轮询）
 *   后两个打在 127.0.0.1 / 局域网地址上，而本脚本是 @grant none（跑在页面主世界，
 *   拦 App 请求靠的就是它）—— 页面里的 fetch 打本地端口会被 CORS 与私有网络策略挡住，
 *   读不到结果。能打通的只有 GM_xmlhttpRequest，而它必须 @grant，一加 @grant 脚本就
 *   进沙箱、拦不到 App。所以拆成两个脚本：本脚本一行 @grant 都不加，本地那两个出口
 *   交给伴生脚本 tools/one/one-local-dispatch.user.js（带 GM_xmlhttpRequest，无界面、
 *   无存储）代发，两边用 <html> 上的属性传话（和「自动替换」用的 data-oneqz-repl
 *   同一套跨世界桥法，只用字符串，不跨 realm 传对象）。
 *   没装伴生脚本时这两个勾不会骗人：面板直接说「没检测到转发脚本」，只发 GitHub。
 *   ⚙ 里 aria2/MediaGo 那几栏是本机默认值（RPC 地址、密钥、MediaGo 地址、API Key、
 *   下载目录），单子上可以改，改过就记住 —— 和 HF 那几栏同一个待遇。
 */
(function () {
  "use strict";

  var KEY = "l*bv%Ziq000Biaog";
  var IV = "8597506002939249";
  var SALT = "m4n2hjPeYWkD6tFpqKF^3HO^h24P@idT";
  var PLATFORM = "3";
  var APP_VERSION = "2.6.4";
  var API_SEEDS = ["https://api.em1oifd0.com", "https://api.61c76a0.com",
                   "https://api.3459381.com", "https://api.j7y675.com"];
  /* 播放域名兜底种子：bootstrap 的 domain.video 池成员 + 模块 prefs 的 flutter.one_video。
     同一路径在每个成员上都是同一个文件，谁活着用谁；池会换，所以在面板里可改。 */
  var PLAY_SEEDS = ["https://z4bey8.bx7qxb.com", "https://46e9nz.mfpt8g.com",
                    "https://f86xxm.upmf83.com", "https://eruj5e.fwn9vj.com"];
  var DETAIL = "/v2.5/article/detail";
  /* 详情页会陆续发出的接口：请求体里都带文章 id（comment/list 用 article_id，其余用 id）。
     App 只在「从列表点卡片」那一刻发 /v2.5/article/detail；刷新/直开时它一个都不发。
     多盯几个，只要任意一个经过钩子就能还原出 id，拿到 id 后我们自己再发 detail 就行。 */
  var WATCH = [DETAIL, "/v2.5/comment/list", "/v2.5/article/like", "/v2.5/article/download", "/v2.5/panda/url"];
  var SCRIPT_VERSION = "2.18.0";   // 面板里会打出来，免得再拿旧版截图对新代码

  /* one 模块身份：/box/api/splash 下发的共享凭证，iss=4406487，昵称 176*****801。
     它随模块启动由宿主注入，浏览器侧取不到（splash 走 http://ip:6868 且校验 time+uuid 绑定对），
     所以这里内置；exp 到期后在面板里换掉即可。 */
  var MODULE_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOjQ0MDY0ODcsImlzX3Zpc2l0b3IiOjAsInV1aWQiOiJmMTkxMzY2NC05NTA0LTMwYmItYjg2MC1jMGIyZjlhMDEzYjMiLCJuaWNrbmFtZSI6IjE3NioqKioqODAxIiwiaXAiOiIzOC40Ni4xMC4yIiwiaWF0IjoxNzkyNTY4OTk4LCJleHAiOjE3OTMxNzczOTgsIm5iZiI6MTc5MjU2ODk5OCwic3ViIjoiMDMyNWFwaS5zYW50aXl1LmNvbSIsImp0aSI6ImZjYTQzZjcwYzUxYTA1NmY2YjYwYzc3ZTU0MTJjMGZlIn0.Ru8OUWzgUNK_VTc1slyohxryI3TrHWlUCFJXx9YcP14";
  var MODULE_UUID = "ef0c6210-88cf-11f1-99ae-b94f32dc13b9";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var store = {
    get: function (k, d) { try { return typeof GM_getValue === "function" ? GM_getValue(k, d) : (localStorage.getItem("uf_" + k) || d); } catch (e) { return d; } },
    set: function (k, v) { try { if (typeof GM_setValue === "function") { GM_setValue(k, v); return; } } catch (e) {} try { localStorage.setItem("uf_" + k, v); } catch (e) {} }
  };
  function safeJson(t) { try { return JSON.parse(t); } catch (e) { return null; } }

  /* ---------- md5 ---------- */
  /* md5 要能被整段序列化进页面主世界（自动替换时要在那边重算 sign），所以写成自包含工厂：
     只搬 return 出来的那个函数不行 —— 它闭包引用了 rl/add/S/K，跨世界就没有这些名字了。 */
  function oneqzMd5Factory() {
    function rl(x, c) { return (x << c) | (x >>> (32 - c)); }
    function add(a, b) { return (a + b) | 0; }
    var S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5, 9,14,20,5, 9,14,20,5, 9,14,20,5, 9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    var K = [];
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    return function (str) {
      var bytes = new TextEncoder().encode(str);
      var n = bytes.length;
      var withPad = new Uint8Array((((n + 8) >> 6) + 1) << 6);
      withPad.set(bytes); withPad[n] = 0x80;
      var bitLen = n * 8;
      var dv = new DataView(withPad.buffer);
      dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
      dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);
      var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
      for (var off = 0; off < withPad.length; off += 64) {
        var M = new Array(16);
        for (var j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
        var A = a0, B = b0, C = c0, D = d0;
        for (var i2 = 0; i2 < 64; i2++) {
          var F, g;
          if (i2 < 16) { F = (B & C) | (~B & D); g = i2; }
          else if (i2 < 32) { F = (D & B) | (~D & C); g = (5 * i2 + 1) % 16; }
          else if (i2 < 48) { F = B ^ C ^ D; g = (3 * i2 + 5) % 16; }
          else { F = C ^ (B | ~D); g = (7 * i2) % 16; }
          F = add(add(add(add(A, F), K[i2]), M[g]), 0);
          A = D; D = C; C = B;
          B = add(B, rl(F, S[i2]));
        }
        a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
      }
      var out = "", words = [a0, b0, c0, d0];
      for (var w = 0; w < 4; w++) {
        for (var k = 0; k < 4; k++) {
          var octet = (words[w] >> (8 * k)) & 0xff;
          out += (octet < 16 ? "0" : "") + octet.toString(16);
        }
      }
      return out;
    };
  }
  var MD5 = oneqzMd5Factory();

  /* ---------- AES-128-CBC ---------- */
  var aesKey = null, aesIV = null;
  function ensureAes() {
    if (aesKey) return Promise.resolve();
    var enc = new TextEncoder();
    aesIV = enc.encode(IV); // IV 必须是裸字节，不能用 importKey 导成 CryptoKey
    return crypto.subtle.importKey("raw", enc.encode(KEY), { name: "AES-CBC" }, false, ["encrypt", "decrypt"])
      .then(function (k) { aesKey = k; });
  }
  var b64 = {
    enc: function (buf) { var s = "", u = new Uint8Array(buf); for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); },
    dec: function (str) { var s = atob(str.replace(/\s+/g, "")), u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  };
  function encryptParams(text) {
    return ensureAes().then(function () {
      return crypto.subtle.encrypt({ name: "AES-CBC", iv: aesIV }, aesKey, new TextEncoder().encode(text));
    }).then(function (buf) { return b64.enc(buf); });
  }
  function tryDecrypt(b64text) {
    var t = String(b64text == null ? "" : b64text).trim();
    if (!t) return Promise.reject(new Error("空响应"));
    return ensureAes().then(function () {
      return crypto.subtle.decrypt({ name: "AES-CBC", iv: aesIV }, aesKey, b64.dec(t));
    }).then(function (buf) { return new TextDecoder("utf-8").decode(buf); });
  }

  /* ---------- 拦截 App 自己的 detail 请求 ----------
   * 关键：带 @grant 的脚本跑在 Tampermonkey 的隔离世界（isolated world），
   * 在这里 patch window.fetch / XMLHttpRequest.prototype 只影响沙箱自己那一份，
   * App（主世界）发的请求一次也拦不到 —— v2.0.0 最初就栽在这。
   * 所以钩子代码要注入成 <script> 在页面主世界执行，抓到密文头/体后用 postMessage
   * 丢回沙箱，由沙箱这边（有 GM_*、有面板）解密并展示。站点没有 CSP，注入可用。 */
  var CAP = { id: null, headers: null, body: null, response: null, route: null, at: 0,
              dn: null, apiHost: "", playHost: "", playFrom: "", resId: null };
  /* 钩子活着与否不能靠「面板没反应」猜：把经过钩子的每一次 App 请求都记一笔，
     面板/诊断里能直接看到「拦到了几个、哪些接口、哪个解出了 id」。 */
  var STAT = { seen: 0, plain: 0, ids: 0, repl: 0, last: [] };
  var RAW_FETCH = null;   // 沙箱内直接装钩子时的兜底：本脚本自己的请求走原生 fetch
  var HOOK = { mode: null, world: "unknown", relay: false, error: "" };   // direct=同世界直接拦到 / local=隔离世界靠注入回传 / relay=注入已 ack
  var NONCE = "oneqz" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var capListeners = [];
  function onCapture(fn) { capListeners.push(fn); }
  function emit(kind) { for (var i = 0; i < capListeners.length; i++) { try { capListeners[i](kind); } catch (e) {} } }

  function isDetailUrl(u) { return typeof u === "string" && u.indexOf(DETAIL) >= 0; }
  function isWatched(u) { return typeof u === "string" && WATCH.some(function (p) { return u.indexOf(p) >= 0; }); }
  function idFromBody(plain) {
    var m = /(?:^|[&;])(?:article_)?id=(\d+)/.exec(String(plain || ""));
    return m ? m[1] : null;
  }
  function epOf(u) { return String(u || "").replace(/^https?:\/\/[^/]*/, "").split("?")[0] || "?"; }
  /* 详情一次同时给两种流的根相对路径，域名要自己拼：
     · video_file  /one/compress/decry/vd/...h265/mp4/...mp4  → 拼「媒体池」域（页面在播的域 > 手填 > 种子）
     · video_hls   /api/video/getM3u8.m3u8?params=...         → 拼「api 域」，清单里的 *.ts 分片域名
       就是请求体里那个 dn（服务端把 dn 原样写进清单；main.dart.js lc():41116 取 bootstrap 的
       domain.flutter_ts_domain 的第一个）。所以 dn 不是 mp4 的域，但确实是 HLS 分片的域。
     video_hls 只有请求体带了 dn 才会返回 —— 不带 dn 服务端只给 mp4。 */
  function dnFromPlain(plain) {
    var m = /(?:^|[&;])dn=([^&;]+)/.exec(String(plain || ""));
    if (!m) return null;
    var v = m[1];
    try { v = decodeURIComponent(v); } catch (e) {}
    return /^https?:\/\/[^/]+/.test(v) ? v.replace(/\/+$/, "") : null;
  }
  function trimSlash(h) { return String(h == null ? "" : h).replace(/\/+$/, ""); }
  /* performance 的资源计时里包含媒体元素自己发起的请求，比任何推测都准：这就是本页此刻在放的域。 */
  function playHostFromPage() {
    var list;
    try { list = performance.getEntriesByType("resource") || []; } catch (e) { return ""; }
    var here = trimSlash(typeof location === "undefined" ? "" : location.origin);
    for (var i = list.length - 1; i >= 0; i--) {
      var m = /^(https?:\/\/[^/]+)\/one\/[^\s]*\.(?:mp4|m3u8|ts)(?:\?|$)/i.exec(String(list[i] && list[i].name || ""));
      if (m && trimSlash(m[1]) !== here) return trimSlash(m[1]);
    }
    return "";
  }
  function refreshPlayHost() {
    var live = playHostFromPage();
    if (live) { CAP.playHost = live; CAP.playFrom = "页面正在播的那次请求"; }
    return CAP.playHost;
  }
  function playHost() {
    var saved = trimSlash(store.get("one_play_host", ""));
    if (/^https?:\/\//.test(saved)) return saved;
    return refreshPlayHost() || PLAY_SEEDS[0];
  }
  function videoUrl(path, host) {
    var p = String(path || "");
    if (!p) return "";
    if (/^https?:\/\//.test(p)) return p;
    var base = trimSlash(host || playHost());
    return base + (p.charAt(0) === "/" ? p : "/" + p);
  }
  /* 同一个文件在媒体池每个成员上都在（逐 host 发 Range: bytes=0-0，Content-Range 总长一致），
     所以给完主链接再并列几个镜像，哪个通用哪个。 */
  function mirrorUrls(path) {
    var out = [], h = trimSlash(playHost());
    for (var i = 0; i < PLAY_SEEDS.length; i++) {
      if (trimSlash(PLAY_SEEDS[i]) !== h) out.push(videoUrl(path, PLAY_SEEDS[i]));
    }
    return out;
  }
  /* video_hls 挂在 api 域上（main.dart.js tP():164735 就是 $.cV().r + video_hls，
     $.cV().r 是本次 detail 用的那个 api 域），不是媒体域。已经是绝对地址就原样用。 */
  function hlsUrl(d) {
    var p = String((d && d.video_hls) || "");
    if (!p) return "";
    if (/^https?:\/\//.test(p)) return p;
    var base = trimSlash(CAP.apiHost || hostFromAppUrl() || apiHosts()[0] || "");
    return base ? base + (p.charAt(0) === "/" ? p : "/" + p) : p;
  }
  function noteStat(plainOk, id) {
    STAT.last.push({ ep: epOf(CAP.urlFull), ok: plainOk, id: id || "", at: CAP.at });
    if (STAT.last.length > 8) STAT.last.shift();
  }
  function noteCapture(headers, body, url, hash) {
    if (dup(headers, body, url)) return;
    STAT.seen++;
    var fromDetail = url && url.indexOf(DETAIL) >= 0;
    CAP.headers = headers || null;
    CAP.body = body || null;
    CAP.urlFull = url || "";
    CAP.route = hash || location.hash || "";
    CAP.at = Date.now();
    if (!body) { noteStat(false, ""); if (fromDetail) CAP.response = null; emit("body-empty"); return; }
    tryDecrypt(body).then(function (plain) {
      STAT.plain++;
      var id = idFromBody(plain);
      noteStat(true, id);
      if (!id) { if (fromDetail) CAP.response = null; emit("body-noid"); return; }
      STAT.ids++;
      var changed = CAP.id !== id;
      CAP.id = id;
      CAP.plain = plain;
      var dn = dnFromPlain(plain);
      if (dn) CAP.dn = dn;   // 只是 ts 探活域，记录它是为了说明「拼链接为什么不用它」
      CAP.idFrom = fromDetail ? "detail" : (url || "").replace(/^.*\/v2\.5\//, "").split("?")[0];
      if (changed || !fromDetail) CAP.response = null;
      emit(changed ? "id" : "id-same");
    }, function () { noteStat(false, ""); if (fromDetail) CAP.response = null; emit("body-bad"); });
  }
  function noteResponse(text, url) {
    if (url && url.indexOf(DETAIL) < 0) return;      // 只收 detail 的响应，comment/list 之类不参与门控判读
    var t = String(text == null ? "" : text).trim();
    if (!t) { emit("resp-bad"); return; }
    if (/^[\{\[]/.test(t)) {                 // 明文错误 / 空壳，直接 parse，不用套密钥
      var j0 = safeJson(t);
      if (j0) { CAP.response = j0; emit("resp"); return; }
    }
    tryDecrypt(t).then(function (plain) {
      var json = safeJson(plain);
      if (!json) { CAP.respBad = "解密后不是 JSON：" + plain.slice(0, 60); emit("resp-bad"); return; }
      CAP.response = json;
      emit("resp");
    }, function (e) {
      CAP.respBad = "解密失败(" + String(t).slice(0, 48) + "…)";
      emit("resp-bad");
    });
  }

  /* App（Flutter web 的 http 包）把请求体当二进制发：xhr.send(Uint8Array)，不是字符串。
   * 早先按 String(body) 处理，得到的是 "[object Uint8Array]"，所以「拦到了但解不开」。
   * 这个解码器必须两个世界共用同一份实现，注入时把它的源码一起带过去。 */
  function bodyToText(b) {
    if (b == null) return "";
    if (typeof b === "string") return b;
    try {
      if (typeof URLSearchParams === "function" && b instanceof URLSearchParams) return String(b);
      if (typeof FormData === "function" && b instanceof FormData) {
        var p = []; b.forEach(function (v, k) { p.push(k + "=" + (typeof v === "string" ? v : "[file]")); });
        return p.join("&");
      }
      if (typeof ArrayBuffer === "function") {
        var u8 = null;
        if (b instanceof Uint8Array) u8 = b;
        else if (b instanceof ArrayBuffer) u8 = new Uint8Array(b);
        else if (b.buffer instanceof ArrayBuffer && typeof b.byteLength === "number")
          u8 = new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
        if (u8) return new TextDecoder("utf-8").decode(u8);
      }
    } catch (e) {}
    try { return String(b); } catch (e) { return ""; }
  }

  /* App 用 dart:html 的 HttpRequest 收响应，responseType 未必是 ""：
   * 直接读 responseText 会抛 InvalidStateError，所以按 responseText → response(二进制) 依次兜底。 */
  function readXhrBody(x) {
    var t = "";
    try { if (x.responseType === "" || x.responseType === "text") t = x.responseText || ""; } catch (e) {}
    if (t) return t;
    try { var r = x.response; if (typeof r === "string" && r) return r; if (r) return bodyToText(r); } catch (e) {}
    return "";
  }

  /* 这一段会被 toString() 后注入到页面主世界执行：只收集，不加解密（AES 密钥留在沙箱）。
     R 是「自动替换」那一档需要的东西：md5 源码 + SALT + DOM 桥属性名。md5/SALT 只用于算 sign，
     不涉及 AES；页面里本来就有能算同一签名的 Dart 代码，藏不藏没有差别，但 AES 密钥绝不下发。 */
  function oneqzMainHook(WATCH, nonce, decoderSrc, R) {
    var bodyToText = eval("(" + decoderSrc + ")");
    var MD5 = null;
    /* 自包含工厂的调用式，跨世界也能跑；拿到不是函数就当没有，宁可退回「只收集」 */
    try { if (R && R.md5Src) { var mf = eval(R.md5Src); if (typeof mf === "function") MD5 = mf; } } catch (e) { MD5 = null; }
    function post(o) { o.oneqz = nonce; try { window.postMessage(o, "*"); } catch (e) {} }
    /* 算 sign 的东西没到位，自动替换这一整条路就是哑的：装好钩子立刻说一声，别等面板写着「已开」 */
    if (R && R.md5Src && !MD5) post({ kind: "replerr", url: "hook", err: "md5 在主世界求值失败，自动替换不可用（页面身份原样发）" });
    var PAUSE_KEY = "__oneqz_pause";       // 沙箱发自己的请求时置位，避免把自己的请求当成 App 的
    function isd(u) { return typeof u === "string" && WATCH.some(function (p) { return u.indexOf(p) >= 0; }); }
    function paused() {
      try { var p = window[PAUSE_KEY]; return p && Date.now() - p < 8000; } catch (e) { return false; }
    }
    /* 沙箱把开关与身份写在 <html> 的属性上（两个世界都看得见 DOM），关掉时属性被摘掉就是没开。 */
    function specNow(u) {
      if (!R || !MD5) return null;
      try {
        var el = document.documentElement;
        if (!el || !el.getAttribute) return null;
        var raw = el.getAttribute(R.attr);
        if (!raw) return null;
        for (var i = 0; R.no && i < R.no.length; i++) { if (String(u).indexOf(R.no[i]) >= 0) return null; }
        var o = JSON.parse(raw);
        return o && o.t ? { token: o.t, uuid: o.u || "", userKey: o.k || "" } : null;
      } catch (e) { return null; }
    }
    function replHeads(h, spec) {
      var ts = h.timestamp || String(Math.floor(Date.now() / 1000));
      var pf = h.platform || R.platform;
      var uk = spec.userKey || "";
      return { token: spec.token, uuid: spec.uuid, "user-key": uk, ip: "0.0.0.0",
               sign: MD5(MD5("0.0.0.0." + pf + "." + ts + "." + uk + "." + spec.uuid) + R.salt) };
    }
    function bumpLayers() { try { window.__oneqz_layers = (window.__oneqz_layers || 0) + 1; } catch (e) {} }
    var XO = XMLHttpRequest.prototype.open;
    var XS = XMLHttpRequest.prototype.send;
    var XH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__qz = isd(u) && !paused() ? { url: String(u), h: {}, spec: specNow(String(u)) } : null;
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      var t = this.__qz;
      if (t) {
        var kk = String(k).toLowerCase();
        t.h[kk] = String(v);
        if (t.spec && R.keys[kk]) return;        // 扣下页面的身份头，send 前换成模块的（XHR 同名是追加，不能盖）
      }
      return XH.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var t = this.__qz;
      if (t) {
        if (t.spec) {
          var rh = null, why = "";
          try { rh = replHeads(t.h, t.spec); } catch (e2) { why = String((e2 && e2.message) || e2); }
          if (rh) {
            try {
              Object.keys(rh).forEach(function (k2) { XH.call(this, k2, rh[k2]); }, this);
              post({ kind: "repl", url: t.url });
            } catch (e3) { post({ kind: "replerr", url: t.url, err: "写头失败：" + String((e3 && e3.message) || e3) }); }
          } else {
            /* sign 没算出来：把扣下的那几个页面原头还回去。替换没做成却让请求缺 token，等于把页面搞坏。 */
            post({ kind: "replerr", url: t.url, err: "sign 重算失败：" + why + "（这次用页面自己的身份）" });
            try { Object.keys(t.h).forEach(function (k2) { if (R.keys[k2]) XH.call(this, k2, t.h[k2]); }, this); } catch (e4) {}
          }
        }
        var b; try { b = bodyToText(body); } catch (e) { b = ""; }
        post({ kind: "req", url: t.url, hash: location.hash, heads: t.h, body: b });
        var self = this;
        this.addEventListener("load", function () {
          try {
            var tx = "";
            try { if (self.responseType === "" || self.responseType === "text") tx = self.responseText || ""; } catch (e) {}
            if (!tx) { try { var rr = self.response; tx = typeof rr === "string" ? (rr || "") : (rr ? bodyToText(rr) : ""); } catch (e) {} }
            if (tx) post({ kind: "resp", url: t.url, text: String(tx).slice(0, 400000) });
          } catch (e) {}
        });
      }
      return XS.apply(this, arguments);
    };
    if (typeof window.fetch === "function") {
      var OF = window.fetch;
      window.fetch = function (input, init) {
        var url = "";
        try { url = typeof input === "string" ? input : ((input && input.url) || ""); } catch (e) {}
        var r = OF.apply(this, arguments);
        if (!isd(url) || paused()) return r;
        var heads = {};
        try {
          var src = (init && init.headers) || (input && input.headers) || null;
          if (src && typeof src.forEach === "function") src.forEach(function (v, k) { heads[String(k).toLowerCase()] = String(v); });
          else if (src) Object.keys(src).forEach(function (k) { heads[k.toLowerCase()] = String(src[k]); });
        } catch (e) {}
        var body = "";
        try { body = bodyToText(init && init.body); } catch (e) {}
        post({ kind: "req", url: url, hash: location.hash, heads: heads, body: body });
        return r.then(function (res) {
          try {
            res.clone().text().then(function (tx) {
              post({ kind: "resp", url: url, text: String(tx || "").slice(0, 400000) });
            }, function () {});
          } catch (e) {}
          return res;
        });
      };
    }
    window.__oneqz_hooked = true;
    bumpLayers();
    post({ kind: "ack", via: "main" });
  }

  /* 沙箱与主世界同一个世界时（@grant none 的正常情形）直接就地装钩子 */
  function isPaused() {
    try { var p = window.__oneqz_pause; return p && Date.now() - p < 8000; } catch (e) { return false; }
  }
  function installHooksLocal() {
    if (typeof window.fetch === "function") RAW_FETCH = window.fetch;
    var XO = XMLHttpRequest.prototype.open;
    var XS = XMLHttpRequest.prototype.send;
    var XH = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) {
      var w = isWatched(u) && !isPaused();
      this.__oneqz = w ? { method: m, url: String(u), heads: {},
                           spec: replaceableUrl(u) ? replaceSpec() : null } : null;
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      var t = this.__oneqz;
      if (t) {
        var kk = String(k).toLowerCase();
        t.heads[kk] = String(v);
        if (t.spec && REPL_HEADS[kk]) return;      // 扣下页面的身份头，send 前换成模块的
      }
      return XH.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var tag = this.__oneqz;
      if (tag) {
        if (tag.spec) {
          var rh = null, why = "";
          try { rh = replHeads(tag.heads, tag.spec); } catch (e2) { why = String((e2 && e2.message) || e2); }
          if (rh) {
            try {
              Object.keys(rh).forEach(function (k2) { XH.call(this, k2, rh[k2]); }, this);
              noteReplaced(tag.url, tag.spec);
            } catch (e3) { noteReplaceFailed("写头失败：" + String((e3 && e3.message) || e3)); }
          } else {
            noteReplaceFailed("sign 重算失败：" + why + "（这次用页面自己的身份）");
            try { Object.keys(tag.heads).forEach(function (k2) { if (REPL_HEADS[k2]) XH.call(this, k2, tag.heads[k2]); }, this); } catch (e4) {}
          }
        }
        noteCapture(tag.heads, bodyToText(body), tag.url);
        var self = this;
        this.addEventListener("load", function () {
          var tx = readXhrBody(self);
          if (tx) noteResponse(tx, tag.url);
        });
      }
      return XS.apply(this, arguments);
    };
    if (RAW_FETCH) {
      var OF = RAW_FETCH;
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (!isWatched(url) || isPaused()) return OF.apply(this, arguments);
        var args = Array.prototype.slice.call(arguments);
        try {
          var heads = {};
          var src = (init && init.headers) || (input && input.headers) || null;
          if (src) {
            if (typeof src.forEach === "function") src.forEach(function (v, k) { heads[String(k).toLowerCase()] = String(v); });
            else Object.keys(src).forEach(function (k) { heads[k.toLowerCase()] = String(src[k]); });
          }
          /* 只在 (字符串 url, init) 形态上换：传 Request 对象时改 init 会把它的 body 丢掉。App 走的是 XHR，这条是兜底。 */
          var spec = typeof input === "string" && replaceableUrl(url) ? replaceSpec() : null;
          if (spec) {
            /* heads 保持「页面原本那次」的身份，换出去的写进新的 merged —— CAP 会被 identity("page") 用 */
            var rh = replHeads(heads, spec), merged = {};
            Object.keys(heads).forEach(function (k) { if (!REPL_HEADS[k]) merged[k] = heads[k]; });
            Object.keys(rh).forEach(function (k) { merged[k] = rh[k]; });
            var ni = {};
            if (init) Object.keys(init).forEach(function (k) { if (k !== "headers") ni[k] = init[k]; });
            ni.headers = merged;
            args = [input, ni];
            noteReplaced(url, spec);
          }
        } catch (e) {}
        var r = OF.apply(this, args);
        var body = "";
        try { body = bodyToText(init && init.body); } catch (e) {}
        noteCapture(heads, body, url);
        return r.then(function (res) {
          try { res.clone().text().then(function (t) { noteResponse(t, url); }, function () {}); } catch (e) {}
          return res;
        });
      };
    }
    HOOK.mode = WORLD === "main" ? "direct" : "local";
    HOOK.world = WORLD;
    try { window.__oneqz_layers = (window.__oneqz_layers || 0) + 1; } catch (e) {}
    emit("hook");
  }

  function onMessage(ev) {
    var d = ev && ev.data;
    if (!d || d.oneqz !== NONCE) return;          // 只认自己那次注入，页面上别的东西仿不了
    if (d.kind === "ack") { HOOK.relay = true; emit("hook"); return; }
    if (d.kind === "req") noteCapture(d.heads, d.body, d.url, d.hash);
    else if (d.kind === "resp") noteResponse(d.text, d.url);
    else if (d.kind === "repl") noteReplaced(d.url, { label: "one 模块（页面侧钩子换的）" });
    else if (d.kind === "replerr") noteReplaceFailed(d.err + " @ " + epOf(d.url));
  }

  /* 刚记下哪一次请求，用来去重：同世界时本地钩子和注入钩子会各命中一次 */
  var lastSeen = { key: "", at: 0 };
  function dup(headers, body, url) {
    var key = String(url) + "|" + String(body);
    var now = Date.now();
    if (key === lastSeen.key && now - lastSeen.at < 1500) return true;
    lastSeen.key = key; lastSeen.at = now;
    return false;
  }

  function injectMain() {
    var src;
    try {
      src = "(" + oneqzMainHook.toString() + ")(" + JSON.stringify(WATCH) + "," + JSON.stringify(NONCE) +
            "," + JSON.stringify(bodyToText.toString()) + "," + JSON.stringify(replArg()) + ");";
    } catch (e) { HOOK.error = String(e && e.message || e); return false; }
    if (!src || src.length < 400) { HOOK.error = "钩子源码序列化异常"; return false; }
    function go() {
      try {
        var s = document.createElement("script");
        s.setAttribute("nonce", NONCE);            // 站点没有 CSP；留 nonce 只是习惯性写法，不影响注入
        s.textContent = src;
        (document.documentElement || document).appendChild(s);
        if (s.parentNode) s.parentNode.removeChild(s);
        return true;
      } catch (e) { HOOK.error = String(e && e.message || e); return false; }
    }
    if (document.documentElement) return go();
    /* document-start 时可能还没有 <html>：轮询到它出现（最多 ~3s） */
    var n = 0;
    var iv = setInterval(function () {
      if (document.documentElement) { clearInterval(iv); go(); }
      else if (++n > 300) clearInterval(iv);
    }, 10);
    return true;
  }

  /* 判定脚本自己跑在哪个世界。
   * 原理：window.eval 永远在「页面主世界」执行。把主世界造出来的函数拿回来比原型链，
   * 同世界时原型相等，隔离世界时跨世界对象的 prototype 是另一套 Object.prototype，不相等。
   * 这个判定不依赖站点 CSP、不依赖管理器实现，也不需要任何 GM_* 权限。 */
  function detectWorld() {
    try {
      if (typeof window.eval !== "function") return "isolated";
      var f = window.eval("(function(){return function(){};})");
      if (typeof f !== "function") return "isolated";
      return Object.getPrototypeOf(f) === Object.getPrototypeOf(function () {}) ? "main" : "isolated";
    } catch (e) {
      return "main";        // 判不了就按主世界走（注入/本地都一样装）
    }
  }

  var WORLD = "unknown";

  function installHooks() {
    window.addEventListener("message", onMessage, false);
    lclArm();                        // 本地转发的回应通道：越早挂越好，发送时才不会漏掉最早那条回应
    WORLD = detectWorld();
    /* 主世界（@grant none 的正常情形）：直接 patch 页面的 fetch/XHR 就能拦到 App，
       不需要注入、不需要回传，也不受 CSP 影响。隔离世界才需要注入+postMessage 那条路。 */
    installHooksLocal();
    if (WORLD === "isolated") { HOOK.error = ""; injectMain(); }
    else { HOOK.relay = false; }
    setTimeout(function () { emit("hook"); }, 1200);
  }

  /* 自己发请求时让主世界钩子静默：同世界时 __oneqz_pause 可见，隔离世界时它无效但也不会自拦 */
  function rawCall(url, opts) {
    try { window.__oneqz_pause = Date.now(); } catch (e) {}
    var call = RAW_FETCH || window.fetch;
    function unPause() { try { window.__oneqz_pause = 0; } catch (e) {} }
    return call(url, opts).then(function (r) {
      return r.text().then(function (t) { unPause(); return t; }, function (e) { unPause(); throw e; });
    }, function (e) { unPause(); throw e; });
  }

  function clearCapture(reason) {
    CAP.id = null; CAP.headers = null; CAP.body = null; CAP.plain = null; CAP.response = null; CAP.at = 0;
    CAP.resId = null;   // 「用模块 token 重取」那份跟着一起作废，否则换卡片后 ⬇ 会拿上一篇的链接去触发下载
    emit(reason || "route");
  }

  /* ---------- 身份 ---------- */
  function pageUser() {
    try {
      var raw = localStorage.getItem("user_profile");
      if (!raw) return null;
      var env = JSON.parse(raw);
      return (env && env.user) || null;
    } catch (e) { return null; }
  }
  function uuidFromPage() {
    try {
      var v = JSON.parse(localStorage.getItem("flutter.device_uuid") || "null");
      if (v && /^[0-9a-f-]{36}$/i.test(v)) return v.toLowerCase();
    } catch (e) {}
    var m = (localStorage.getItem("user_profile") || "").match(/"uuid":"([0-9a-f]{8}-[0-9a-f-]{27})"/i);
    return m ? m[1] : MODULE_UUID;
  }
  /* App 自己刚发过的那次请求 = 网页当前登录态的最真实快照（token 可能比 localStorage 新） */
  function appHeaders() {
    var h = CAP.headers || {};
    return { token: h.token || "", userKey: h["user-key"] || "", uuid: h.uuid || "", ts: h.timestamp || "" };
  }
  function identity(mode) {
    if (mode === "page") {
      var u = pageUser();
      var app = appHeaders();
      var mobile = (u && u.mobile) || "";
      var uk = app.userKey || (mobile && String(u && u.is_visitor) !== "1" ? MD5(mobile) : "");
      return { label: "网页登录态 uid=" + ((u && u.id) || "?"),
               token: app.token || (u && u.token) || MODULE_TOKEN, userKey: uk, uuid: app.uuid || uuidFromPage() };
    }
    if (mode === "app") {
      var a = appHeaders();
      if (!a.token) return null;
      return { label: "网页 App 那次原样（拦截到的头）", token: a.token, userKey: a.userKey, uuid: a.uuid };
    }
    return { label: "one 模块 uid=4406487", token: store.get("one_token", MODULE_TOKEN), userKey: "", uuid: MODULE_UUID };
  }

  /* ---------- 自动替换页面的 token（默认关，设置里可开，开关本身会被记住） ----------
     开启后，App 自己发出的 WATCH 请求在离开钩子之前就被换成「one 模块」那一档的身份
     （设置里 token 输入框换过就用换过的那个），于是页面本身拿到的就是替换身份的详情，
     不用点按钮。付费/扣币类接口一律不碰。
     实现要点：XHR 对同名头再次 setRequestHeader 是「追加逗号」而不是覆盖
     （规范里 author request headers 是拼接的），所以不能等 send() 时直接盖——会拼成
     "页面token, 模块token"。做法是在 setRequestHeader 阶段把这几个身份头扣下不传给原生，
     等 send() 调原生 send 之前一次性写我们算好的值。 */
  var REPL_ATTR = "data-oneqz-repl";
  var REPL_HEADS = { token: 1, uuid: 1, "user-key": 1, sign: 1, ip: 1 };
  var NO_REPLACE = ["/purchase", "/buy", "/pay", "/coin", "/recharge", "/order", "/vip", "/sign_in"];
  function autoOn() { return String(store.get("one_auto", "0")) === "1"; }
  function replaceableUrl(u) {
    var s = String(u || "");
    return isWatched(s) && !NO_REPLACE.some(function (p) { return s.indexOf(p) >= 0; });
  }
  function replaceSpec() {
    if (!autoOn()) return null;
    var id = identity("module");
    return id && id.token ? { token: id.token, uuid: id.uuid, userKey: id.userKey, label: id.label } : null;
  }
  /* sign 里那串是 ip.platform.ts.user-key.uuid；ip 头我们固定写 0.0.0.0，所以式子里也是它。
     只返回 REPL_HEADS 里那五个：其余头是页面自己设的，我们再 setRequestHeader 一次就变成追加。 */
  function replHeads(heads, spec) {
    var h = heads || {};
    var ts = h.timestamp || String(Math.floor(Date.now() / 1000));
    var pf = h.platform || PLATFORM;
    var uk = spec.userKey || "";
    return { token: spec.token, uuid: spec.uuid, "user-key": uk, ip: "0.0.0.0",
             sign: MD5(MD5("0.0.0.0." + pf + "." + ts + "." + uk + "." + spec.uuid) + SALT) };
  }
  /* 隔离世界里注入进主世界的钩子读不到 GM_*，开关与身份用 DOM 属性过桥；关掉就摘掉。 */
  function armReplace() {
    var spec = replaceSpec();
    try {
      var el = document.documentElement;
      if (!el) return spec;
      if (!spec) el.removeAttribute(REPL_ATTR);
      else el.setAttribute(REPL_ATTR, JSON.stringify({ t: spec.token, u: spec.uuid, k: spec.userKey || "" }));
    } catch (e) {}
    return spec;
  }
  function noteReplaced(url, spec) {
    STAT.repl++;
    if (isDetailUrl(url)) log("自动替换   " + epOf(url) + " 的身份 → " + spec.label + "（token/uuid/user-key/sign/ip 五个头重算）", "dim");
    emit("repl");
  }
  /* 替换失败必须说出口：静默吞掉的话，页面拿到的还是它自己那档身份，面板却写着「已开」——
     这一版就是因为把 md5 闭包搬不过去而整条路径哑掉，靠这条才看得见。 */
  function noteReplaceFailed(err) {
    STAT.replErr = (STAT.replErr || 0) + 1;
    log("自动替换失败：" + String(err).slice(0, 120) + " —— 这次原样用页面自己的身份发出去了", "bad");
    emit("repl");
  }
  /* 注入给主世界钩子的那份参数：md5 工厂的调用式 + SALT + DOM 桥。开关没开时属性不存在，钩子就不会换。
     md5Src 必须是「整段自包含」的表达式（工厂源码 + 立即调用），只搬 MD5.toString() 会丢掉它闭包的 rl/add/S/K。 */
  function replArg() {
    return { md5Src: "(" + oneqzMd5Factory.toString() + ")()", salt: SALT, attr: REPL_ATTR,
             keys: REPL_HEADS, no: NO_REPLACE, platform: PLATFORM };
  }

  /* ---------- 请求 ---------- */
  function apiHosts() {
    var cur = "";
    try { cur = localStorage.getItem("current_domain") || ""; } catch (e) {}
    var saved = store.get("one_host", "");
    var list = [];
    [saved, cur].concat(API_SEEDS).forEach(function (h) {
      h = (h || "").replace(/\/+$/, "");
      if (/^https?:\/\//.test(h) && list.indexOf(h) < 0) list.push(h);
    });
    return list;
  }
  function hostFromAppUrl() {
    var u = CAP.urlFull || "";
    var m = /^(https?:\/\/[^/]+)/.exec(u);
    return m ? m[1] : "";
  }
  function fetchDetail(articleId, ident, host) {
    var ts = Math.floor(Date.now() / 1000);
    // 签名原文 = "<ip>.<platform>.<ts>.<user-key>.<uuid>"，ip 固定 "0.0.0.0"
    var base = "0.0.0.0." + PLATFORM + "." + ts + "." + ident.userKey + "." + ident.uuid;
    var sign = MD5(MD5(base) + SALT);
    return encryptParams("id=" + articleId + (CAP.dn ? "&dn=" + encodeURIComponent(CAP.dn) : "")).then(function (body) {
      // rawCall 会置位 __oneqz_pause：即使钩子装在同一个世界，也不会把「模块 token 那次」
      // 反过来写进 CAP 污染 App 身份
      return rawCall(host + DETAIL, {
        method: "POST",
        body: body,
        headers: {
          "platform": PLATFORM,
          "uuid": ident.uuid,
          "timestamp": String(ts),
          "token": ident.token,
          "app-version": APP_VERSION,
          "sign": sign,
          "user-key": ident.userKey,
          "ip": "0.0.0.0",
          "content-type": "application/x-www-form-urlencoded"
        }
      });
    }).then(function (text) {
      var t = (text || "").trim();
      if (/^\{/.test(t)) return safeJson(t) || (function () { throw new Error("响应不是 JSON"); })();
      return tryDecrypt(t).then(JSON.parse);                     // 正常：加密响应
    });
  }
  function getDetail(articleId, ident, log) {
    var prefer = hostFromAppUrl();
    var hosts = (prefer ? [prefer] : []).concat(apiHosts()).filter(function (h, i, arr) { return h && arr.indexOf(h) === i; });
    var i = 0;
    function next() {
      if (i >= hosts.length) return Promise.reject(new Error("所有 api 域都失败"));
      var h = hosts[i++];
      log("  尝试 " + h + " …");
      return fetchDetail(articleId, ident, h).then(function (json) {
        CAP.apiHost = h;          // video_hls 要拼回同一个 api 域
        return json;
      }).catch(function (e) {
        log("  × " + String(e && e.message || e).slice(0, 90));
        return next();
      });
    }
    return next();
  }

  /* ---------- 判读 ---------- */
  function mb(v) {
    if (v == null || v === "") return "-";
    var n = Number(v);
    if (!isFinite(n) || n === 0) return String(v);      // 服务端已格式化成 "887MB" 这类字符串
    if (n > 1024 * 1024) return (n / 1048576).toFixed(1) + " MB";
    if (n > 1024) return (n / 1024).toFixed(1) + " KB";
    return n + " B";
  }
  /* 一次详情固定铺四格：正片/预告 × MP4/M3U8，有链接就是一条能点能复制的完整地址，
     没有就写清是哪一端没给。之所以经常缺「预告 M3U8」：接口只有一个清单槽位
     video_hls（video_hls_h265 是同一条正片的另一种编码，audio_hls 是音频的），
     它跟着 video_file 走 —— 解锁态给的是正片清单，锁定态给的就是预告清单。
     实测 id=63737：网页态（锁定）清单 48 秒/5 片，模块态（已购）168.8 分钟/1013 片。 */
  function summarize(d, log) {
    var pf = d.preview_video, vf = d.video_file;
    var locked = pf && vf === pf;
    var host = playHost();
    var hl = hlsUrl(d);
    var noHls = CAP.dn ? "已带 dn=" + CAP.dn + " 仍回空 —— 这个身份/条目只有 MP4"
                       : "请求体里没有 dn —— 不带 dn 服务端只给 MP4，给了 dn 才给 video_hls";
    function row(who, fmt, url, why) {
      if (url) log("   " + who + " · " + fmt + "   " + url);
      else log("   " + who + " · " + fmt + "   —— " + why, "dim");
    }
    log("标题      " + d.title + "   (model_id=" + d.model_id + ")");
    log("门控      buy=" + d.buy + "   coin=" + d.coin + "   原价=" + d.original_coin + "   限免=" + d.is_limit_free);
    log(locked ? "→ 锁定：video_file 与 preview_video 是同一个路径，服务端把正片换成了预告"
               : (pf ? "→ 解锁：video_file 与 preview_video 是两个不同文件"
                     : "→ 这个条目只有正片：preview_video 是空的，正片/预告两格里预告自然没链接"),
        locked ? "bad" : (pf ? "ok" : "dim"));
    if (locked) {
      row("正片", "MP4", "", "未解锁，服务端这次没返回正片文件");
      row("正片", "M3U8", "", "同上");
      row("预告", "MP4", videoUrl(pf, host), "锁定态服务端给的就是 preview_video");
      row("预告", "M3U8", hl, noHls);
    } else {
      row("正片", "MP4", videoUrl(vf, host), "服务端没给 video_file");
      row("正片", "M3U8", hl, noHls);
      row("预告", "MP4", videoUrl(pf, host), "服务端没给 preview_video —— 这个条目没有单独的预告文件");
      row("预告", "M3U8", "", "接口没有「预告清单」这个字段：video_hls 只有一个槽位，此刻装的是正片");
    }
    if (d.video_hls_h265) row(locked ? "预告" : "正片", "M3U8·h265", hlsUrl({ video_hls: d.video_hls_h265 }), "");
    log("   域名分工：MP4 拼媒体池域，M3U8 拼 api 域；清单里的 *.ts 分片域名 = 请求体里的 dn " +
        (locked ? "（锁定态这条清单就是上面那段预告）" : "（正片的清单）"), "dim");
    log("   播放域名 " + host + (CAP.playFrom ? "  （" + CAP.playFrom + "）" : "  （种子：媒体池成员，可在配置里改）"), "dim");
    log("   ts 域名(dn) " + (CAP.dn || "未拦到") + "   ← 只影响 M3U8 分片落在哪个域，mp4 不用它", "dim", true);
    if (!locked && vf) {
      var ms = mirrorUrls(vf);
      if (ms.length) log("   同一文件的其他镜像 " + ms.slice(0, 2).join("   "), "dim");
    }
    // size 是服务端声明的元数据，锁定态下同样显示正片标称大小，不能拿来当「拿到正片」的证据
    log("标称 size " + mb(d.size) + "（服务端元数据，与锁定状态无关，判据只看上面两个路径）", "dim");
    if (Array.isArray(d.episode) && d.episode.length) {
      var un = d.episode.filter(function (e) { return Number(e.unlocked) === 1; }).length;
      log("分集      " + d.episode.length + " 集，unlocked=" + un +
          "   free_episode_count=" + d.free_episode_count + "  unlock_remain=" + d.unlock_remain_episodes);
    }
    if (d.token) log("detail.token  " + d.token + "（客户端解析后丢弃，不参与取流）", "dim");
    if (d.notice_msg) log("服务端提示    " + d.notice_msg);
  }
  function summarizeInto(d, log, tag) {
    if (!d || !d.data) { log(tag + "：没有 data", "bad"); return; }
    log("── " + tag + " ──", "dim");
    summarize(d.data, log);
  }

  /* ---------- 下载触发（交给本仓库的 GitHub Actions） ----------
     拿到链接以后分两条路：MP4 是直链单文件 → aria2.yml（多连接分片）；
     M3U8 是清单 → m3u8.yml（N_m3u8DL-RE 拉分片、解密、合成）。
     调用方式照抄 tools/m3u8/m3u8-dispatch.user.js：POST /actions/workflows/<wf>/dispatches，
     204 成功且没有响应体，所以运行要再去 runs 列表里按 created_at 认。
     inputs 只发这两个 yml 里声明过的 key（urls / save_name / headers，外加只有 m3u8.yml 认的
     mux_format）—— 多一个没声明的 key 就是 HTTP 422 "Unexpected inputs"，其余参数一律用 yml 默认值。 */
  var GH_API = "https://api.github.com";
  var GH_WF = { MP4: "aria2.yml", M3U8: "m3u8.yml" };
  var GH_REPO = "owner/gh-toolbox";
  var GH_REF = "main";
  var GH_FIND_MS = 60000;      // dispatches 只回 204，runner 起来前列表里没有这条运行，最多等这么久
  var GH_RUN_MS = 600000;      // 单个下载的轮询上限（runner 排队 + 下载常常要几分钟）
  var GH_FIND_GAP = 3000;
  var GH_RUN_GAP = 5000;
  var ghJob = 0;               // 代次号：再点一次按钮就让上一次的轮询闭嘴，不用等它超时

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function ghRepoPath(v) {
    var s = String(v == null ? "" : v).trim()
      .replace(/^https?:\/\/[^/]*github\.com\//i, "")
      .replace(/^ssh:\/\/git@/i, "").replace(/^git@[^:]+:/i, "")
      .replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    var seg = s.split("/").filter(Boolean);
    return seg.length >= 2 ? seg[0] + "/" + seg[1] : "";
  }

  function ghCfg() {
    return {
      repo: ghRepoPath(store.get("one_gh_repo", GH_REPO)) || GH_REPO,
      ref: trimSlash(store.get("one_gh_ref", GH_REF) || GH_REF),
      token: String(store.get("one_gh_token", "") || "").trim(),
      fmt: String(store.get("one_gh_fmt", "auto") || "auto"),
      headers: String(store.get("one_gh_headers", "") || "").trim()
    };
  }

  /* 抱抱脸那三个 key（hf_upload / hf_repo / hf_path）两个 yml 都声明过，投给哪条 workflow 都收得下。
     HF token 不在这里也不在任何地方：两个 workflow 只从仓库 Secret（ARIA2_HF_TOKEN / M3U8_HF_TOKEN）读它，
     页面这一侧碰不到、也不该碰到 —— 单子里能填的只有「传到哪」，没有「拿什么身份传」。 */
  function ghHfCfg() {
    return {
      repo: ghHfRepo(store.get("one_gh_hf_repo", "")),
      path: ghHfPath(store.get("one_gh_hf_path", "")),
      on: store.get("one_gh_hf", "0") === "1"        // 单子里那个勾的默认值，勾过一次就记住
    };
  }
  /* 数据集仓库 ID 就是「用户名/数据集名」两段；直接粘 huggingface.co 的链接也要认 */
  function ghHfRepo(v) {
    var s = String(v == null ? "" : v).trim()
      .replace(/^https?:\/\/[^/]*huggingface\.co\//i, "")
      .replace(/^(datasets|models|spaces)\//i, "")
      .replace(/^\/+|\/+$/g, "");
    var seg = s.split("/").filter(Boolean);
    return seg.length >= 2 ? seg[0] + "/" + seg[1] : "";
  }
  /* 仓库内的子目录：服务端拿它当 upload_folder 的 path_in_repo，先把首尾斜杠和空的、. 与 .. 这些
     没意义的段去掉。留空 = 仓库根目录，那时干脆不发这个 key，用 yml 里 default: "" 的那份。 */
  function ghHfPath(v) {
    return String(v == null ? "" : v).trim().split("/")
      .filter(function (s) { return s && s !== "." && s !== ".."; }).join("/");
  }

  /* 下载时要带的请求头。UA 与来源不是「后台默默补」：开单子时就把它们写进那一栏，
     栏里是什么就发什么 —— 删掉一条就不带一条，整栏清空就是这次不带任何自定义头。
     ⚙ 里那栏仍只存「额外要带的」：⚙ 的值要落 localStorage，把此刻的 UA 存进去迟早过期；
     单子是每次现开的，铺进去的 UA 与来源就永远跟着当前页面走。 */
  var GH_HDR_ALIAS = { "user-agent": "User-Agent", "ua": "User-Agent",
                       "referer": "Referer", "referrer": "Referer" };
  function ghAutoHeaders() {
    var o = {};
    var ua = "";
    try { ua = String((typeof navigator !== "undefined" && navigator.userAgent) || ""); } catch (e) {}
    var origin = "";
    try { origin = String((typeof location !== "undefined" && location.origin) || ""); } catch (e) {}
    if (ua.trim()) o["User-Agent"] = ua.trim();
    if (origin) o["Referer"] = trimSlash(origin) + "/";
    return o;
  }
  /* 认不出这一栏（不是 JSON 对象）时回 null，由调用方决定退路，别在这里猜用户想发什么 */
  function ghHeaderSet(raw, base) {
    var j = safeJson(String(raw == null ? "" : raw).trim());
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    var out = base || {};
    Object.keys(j).forEach(function (k) {
      var name = GH_HDR_ALIAS[String(k).toLowerCase()] || String(k);
      var val = String(j[k] == null ? "" : j[k]).trim();
      if (!val) { delete out[name]; return; }
      out[name] = val;
    });
    return out;
  }
  function ghJsonOf(set) { return Object.keys(set).length ? JSON.stringify(set) : ""; }
  /* 没走单子（或 ⚙ 里那条自己用）：自动两条打底，写的同名头覆盖它，显式空串 = 这条不要 */
  function ghMergeHeaders(userRaw) { return ghHeaderSet(userRaw, ghAutoHeaders()) || ghAutoHeaders(); }
  function ghHeadersJson(userRaw) { return ghJsonOf(ghMergeHeaders(userRaw)); }
  /* 单子上那一栏：它铺出来时就含 UA 与来源，所以按字面走，不再往回补用户删掉的那条 */
  function ghFormHeadersJson(formRaw) {
    var s = String(formRaw == null ? "" : formRaw).trim();
    if (!s) return "";
    return ghJsonOf(ghHeaderSet(s, {}) || ghAutoHeaders());
  }

  /* 文件名两边规则相反，别想当然：
     aria2 那条是 `aria2c -o <save_name>` 原样落盘，不给后缀就会得到一个没有扩展名的文件 → MP4 自动补 .mp4；
     N_m3u8DL-RE 的 `--save-name` 反过来不能带后缀（它按 mux_format 自己补 .mp4/.mkv），
     传 "x.mp4" 会得到 "x.mp4.mp4" → M3U8 把后缀剥掉再发。用户自己写了别的后缀（如 .mkv）就尊重它。 */
  var GH_EXTS = "mp4|mkv|ts|webm|mov|m4v|m4a|aac|mp3|flac|zip";
  function ghSplitExt(name) {
    var s = String(name || "").trim();
    var m = new RegExp("\\.(" + GH_EXTS + ")$", "i").exec(s);
    return m ? { stem: s.slice(0, s.length - m[0].length), ext: m[1].toLowerCase() } : { stem: s, ext: "" };
  }
  function ghName(name, fmt) {
    var p = ghSplitExt(name);
    if (!p.stem) return "";
    return fmt === "M3U8" ? p.stem : p.stem + "." + (p.ext || "mp4");
  }
  function sanitizeFileName(name) {
    return String(name || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ").trim().slice(0, 120);
  }
  /* 默认文件名 = 详情标题（预告那条加「 预告」后缀），已经 sanitize 过 */
  function ghDefaultStem(item, title) {
    var base = sanitizeFileName(title) || ("one-" + (CAP.id || Date.now()));
    return item && item.who === "预告" ? base + " 预告" : base;
  }

  /* 可下载候选，排序即优先级，判定规则与 summarize 那四格逐字一致：
     锁定态服务端把 video_file 换成了 preview_video，所以只有「预告」两条；
     清单只有一个槽位（video_hls 跟着 video_file 走），别把它同时算成正片和预告。 */
  function downloadPlan(d) {
    var pf = d.preview_video, vf = d.video_file;
    var locked = !!(pf && vf === pf);
    var host = playHost();
    var hl = hlsUrl(d);
    var out = [];
    function push(who, fmt, url) { if (url) out.push({ who: who, fmt: fmt, url: url }); }
    if (locked) {
      push("预告", "MP4", videoUrl(pf, host));
      push("预告", "M3U8", hl);
    } else {
      push("正片", "MP4", videoUrl(vf, host));
      push("正片", "M3U8", hl);
      push("预告", "MP4", videoUrl(pf, host));
    }
    return out;
  }

  function ghPick(plan, fmt) {
    var want = fmt === "mp4" ? ["MP4"] : fmt === "hls" ? ["M3U8"] : ["MP4", "M3U8"];
    for (var i = 0; i < want.length; i++) {
      for (var j = 0; j < plan.length; j++) { if (plan[j].fmt === want[i]) return plan[j]; }
    }
    return null;
  }

  /* @grant none（默认、也是唯一验证过的安装形态）下没有 GM_xmlhttpRequest，只能用页面的 fetch：
     api.github.com 回 Access-Control-Allow-Origin: *，带自定义头的 POST 会先走 OPTIONS 预检，实测通。
     走 RAW_FETCH 并置 __oneqz_pause，免得自己发的请求被自己的钩子当成 App 的那次污染 CAP。 */
  function ghFetch(method, path, body) {
    var cfg = ghCfg();
    if (!cfg.token) {
      return Promise.reject(new Error("还没填 GitHub Token：⚙ 里粘一个（只需 Actions: write；" +
        "@grant none 时它存在本页 localStorage，请用只授权这一个仓库的 fine-grained token）"));
    }
    var hs = { "Authorization": "Bearer " + cfg.token,
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28" };
    if (body !== undefined) hs["Content-Type"] = "application/json";
    var url = GH_API + path;
    var data = body === undefined ? undefined : JSON.stringify(body);
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise(function (res, rej) {
        GM_xmlhttpRequest({ method: method, url: url, headers: hs, data: data,
          onload: function (r) { res({ status: r.status, text: r.responseText || "" }); },
          onerror: function () { rej(new Error("网络错误：访问不了 api.github.com")); } });
      });
    }
    var call = (typeof RAW_FETCH === "function" ? RAW_FETCH : window.fetch);
    if (typeof call !== "function") return Promise.reject(new Error("这个环境既没有 GM_xmlhttpRequest 也没有 fetch"));
    try { window.__oneqz_pause = Date.now(); } catch (e) {}
    function done() { try { window.__oneqz_pause = 0; } catch (e) {} }
    return call(url, { method: method, headers: hs, body: data }).then(function (r) {
      return r.text().then(function (t) { done(); return { status: r.status, text: t }; },
                             function (e) { done(); throw e; });
    }, function (e) {
      done();
      throw new Error("请求 api.github.com 失败：" + String((e && e.message) || e) +
        "（跨域被页面挡了才需要改成带 GM_xmlhttpRequest 的安装方式）");
    });
  }

  function ghErr(status, text) {
    var j = safeJson(text);
    var m = (j && j.message) || String(text || "").slice(0, 200) || "（无响应体）";
    if (status === 401) return "HTTP 401：" + m + " —— Token 无效/过期，或没有 Actions 权限";
    if (status === 403) return "HTTP 403：" + m + " —— 常见是仓库私有且 Token 没覆盖它，或触发了防滥用限制";
    if (status === 404) return "HTTP 404：" + m + " —— Token 看不到这个仓库，或 owner/repo、workflow 文件名写错";
    if (status === 422) return "HTTP 422：" + m + " —— 该分支上的 workflow 没声明这次发的 inputs（改过 yml 没推？ref 指错？）";
    return "HTTP " + status + "：" + m;
  }

  /* sel = 表单里那一单的选项（{item, name, headers, mux, autoExt, hf, hfPath}），不传就按 ⚙ 的默认值自己挑一条。
     autoExt 只影响面板措辞：框里那截 .mp4 是表单补的（true）还是用户自己打的（false）。
     mux_format 只有 m3u8.yml 声明了，aria2.yml 没有这个 key —— 发过去就是 422，所以只在 M3U8 那条带上；
     hf_* 三个两条 yml 都声明了，所以哪条都能带，但只在勾了「传到 HF」时发（不勾就沿用 yml 的 default: false）。
     headers 分两条路：单子上那一栏（sel.headers 是字符串）按字面发 —— 它铺出来时就含 UA 与来源，
     删掉的就真不带；没有单子可填时（sel.headers 没给）才退回「⚙ 里那些 + 自动两条」。 */
  function ghInputs(item, title, sel) {
    var cfg = ghCfg(), hf = ghHfCfg();
    sel = sel || {};
    var stem = sel.name === undefined || sel.name === null || String(sel.name).trim() === ""
      ? ghDefaultStem(item, title) : String(sel.name);
    var inputs = { urls: item.url, save_name: ghName(sanitizeFileName(stem), item.fmt) };
    var hj = sel.headers === undefined ? ghHeadersJson(cfg.headers) : ghFormHeadersJson(sel.headers);
    if (hj) inputs.headers = hj;
    if (item.fmt === "M3U8") inputs.mux_format = sel.mux === false ? "none" : "mp4";
    if (sel.hf === undefined ? hf.on : sel.hf) {
      inputs.hf_upload = true;
      var repo = ghHfRepo(sel.hfRepo === undefined ? hf.repo : sel.hfRepo);
      if (repo) inputs.hf_repo = repo;
      var dir = ghHfPath(sel.hfPath === undefined ? hf.path : sel.hfPath);
      if (dir) inputs.hf_path = dir;
    }
    return inputs;
  }

  /* 面板上那行「传到哪」的说明：勾了才写目标，没勾就写清产物只在 artifacts 里。
     措辞跟着 inputs 走 —— inputs 就是实际发出去的那份，说出去的话不会和 body 不一致。 */
  function ghHfNote(inputs) {
    if (inputs.hf_upload !== true) return "没勾：产物只留在那次运行的 artifacts 里";
    if (!inputs.hf_repo) return "true → hf_repo 留空，用仓库 Secret ARIA2_HF_REPO / M3U8_HF_REPO 兜底；" +
      "Secret 里也没有的话，服务端会记下「没配仓库 ID」并跳过上传（下载本身不受影响）。HF token 只在 Secret 里，脚本不碰";
    return "true → https://huggingface.co/datasets/" + inputs.hf_repo + "/" +
      (inputs.hf_path || "（仓库根目录）") + "。HF token 只在 Secret 里，脚本不碰；" +
      "仓库不存在时服务端按 dataset 类型新建，默认 private（Secret <tool>_HF_PRIVATE 可改）";
  }

  function ghRunText(run) {
    if (run.status === "completed") {
      return run.conclusion === "success" ? "完成 success" : "结束 " + (run.conclusion || "?");
    }
    var zh = { queued: "排队中", in_progress: "进行中", waiting: "等待中",
               action_required: "要人去 Actions 点 Run job（私有仓库额度用完后会卡在这）" };
    return (zh[run.status] || run.status || "?") + " " + run.status;
  }

  function watchRun(my, cfg, wf, triggeredAt) {
    function cancelled() { return my !== ghJob; }
    function giveUp(left) {
      if (cancelled()) { log("（已经又点了一次下载，这次的轮询停掉）", "dim"); return true; }
      return left <= 0;
    }
    function findRun(left) {
      if (giveUp(left)) {
        log("已触发，但 " + Math.round(GH_FIND_MS / 1000) + " 秒内没在 runs 列表里认出新运行（runner 还在排队），" +
            "去 " + cfg.repo + " 的 Actions 页面看", "bad");
        return Promise.resolve(null);
      }
      return ghFetch("GET", "/repos/" + cfg.repo + "/actions/workflows/" + encodeURIComponent(wf) +
                     "/runs?per_page=5&event=workflow_dispatch").then(function (r) {
        if (r.status !== 200) throw new Error(ghErr(r.status, r.text));
        var runs = (safeJson(r.text) || {}).workflow_runs || [];
        for (var i = 0; i < runs.length; i++) {
          if (new Date(runs[i].created_at).getTime() >= triggeredAt - 30000) return runs[i];
        }
        return sleep(GH_FIND_GAP).then(function () { return findRun(left - GH_FIND_GAP); });
      });
    }
    function poll(run, left) {
      if (cancelled()) { log("（已经又点了一次下载，这次的轮询停掉）", "dim"); return Promise.resolve(run); }
      var over = run.status === "completed";
      var good = run.conclusion === "success";
      log("   运行 #" + (run.run_number || "") + "  " + ghRunText(run) + "   " + (run.html_url || ""),
          over ? (good ? "ok" : "bad") : "dim");
      if (over) {
        log(good ? "✓ " + wf + " 下载完成（产物在 Actions 那次运行的 artifacts 里，除非勾了 hf_upload）"
                 : "× " + wf + " 结束但没成功：" + (run.conclusion || "?") + "，点开上面那条看日志", good ? "ok" : "bad");
        return Promise.resolve(run);
      }
      if (left <= 0) {
        log("本机轮询到 " + Math.round(GH_RUN_MS / 1000) + " 秒结束，运行大概率还在跑，用上面那条链接看", "dim");
        return Promise.resolve(run);
      }
      return sleep(GH_RUN_GAP).then(function () {
        return ghFetch("GET", "/repos/" + cfg.repo + "/actions/runs/" + run.id).then(function (r) {
          if (r.status !== 200) throw new Error(ghErr(r.status, r.text));
          return poll(safeJson(r.text) || run, left - GH_RUN_GAP);
        });
      });
    }
    return findRun(GH_FIND_MS).then(function (run) {
      if (!run) return null;
      log("   认出 " + wf + " #" + (run.run_number || "") + "（" + (run.head_branch || cfg.ref) + "），每 " +
          GH_RUN_GAP / 1000 + " 秒刷一次状态", "dim");
      return poll(run, GH_RUN_MS);
    }).catch(function (e) { log("× 查运行状态失败：" + String(e && e.message || e), "bad"); });
  }

  /* 真正发触发的那一步。res = 用哪份详情（见 detailSource），sel = ⬇ 表单里那一单的选项；
     不传 sel 就按 ⚙ 的默认值自己挑一条（离线用例和「没表单直接调」都走这条）。 */
  function sendToAction(res, sel) {
    var src = res && res.data ? res.data : null;
    if (!src) {
      log("还没有可用的详情：先在详情页点进卡片拦到 id，按「用模块 token 重取」（或把自动替换打开）再发下载。", "bad");
      return Promise.resolve(null);
    }
    var plan = downloadPlan(src);
    if (!plan.length) { log("这次详情里一个可下载链接都没有（正片/预告、MP4/M3U8 全空）。", "bad"); return Promise.resolve(null); }
    var cfg = ghCfg();
    sel = sel || {};
    var item = sel.item && sel.item.url ? sel.item : ghPick(plan, cfg.fmt);
    if (!item) {
      log("格式选的是「" + (cfg.fmt === "mp4" ? "仅 MP4" : "仅 M3U8") + "」，这次只有 " +
          plan.map(function (p) { return p.who + " " + p.fmt; }).join(" / ") + " —— 换格式，或换身份重取详情。", "bad");
      return Promise.resolve(null);
    }
    if (!cfg.token) {
      log("还没填 GitHub Token（⚙ 里那一栏），填好会自动保存 —— 或者这张单子只发本地 aria2 / MediaGo。", "bad");
      return Promise.resolve(null);
    }
    var wf = GH_WF[item.fmt];
    log("── 发到 GitHub 下载 ──", "dim");
    log("   用的详情   " + ((res.from || "?") + "，标题 " + (src.title || "（无）")), "dim");
    log("   这次可选 " + plan.map(function (p) { return p.who + " " + p.fmt; }).join(" / ") +
        "   选了 " + item.who + " " + item.fmt +
        (sel.item ? "（面板上选的）" : "（格式设置：" + cfg.fmt + "）"), "dim");
    if (item.who === "预告") log("   注意：下的是预告 —— 这个身份没解锁正片，服务端只回了 preview。", "dim");
    if (item.fmt === "M3U8") {
      var age = Math.round((Date.now() - (CAP.at || 0)) / 1000);
      log("   M3U8 那条链接里的 params 是这次详情临时生成的，runner 排队+启动要几十秒到几分钟；" +
          "过期就重新取一次详情再点（这次详情距今已 " + age + " 秒）", "dim");
    }
    var my = ++ghJob;
    var inputs = ghInputs(item, src.title, sel);
    var triggeredAt = Date.now();
    log("   POST " + cfg.repo + " / " + wf + "  ref=" + cfg.ref, "dim");
    log("   urls       " + item.url);
    log("   save_name  " + inputs.save_name +
        (item.fmt === "M3U8" ? "（不带后缀，RE 按 mux_format 补）"
         : !ghSplitExt(sel.name).ext || sel.autoExt ? "（单子上没写后缀，aria2 是 -o 原样落盘，自动补成 .mp4）"
                                                    : "（就按单子上这个名字落盘）"), "dim");
    if (inputs.mux_format) log("   mux_format " + inputs.mux_format +
        (inputs.mux_format === "none" ? "（不混流，产出分轨原文件）" : "（下载完合成转封装成 MP4）"), "dim");
    /* 这行的措辞必须由「真正发出去的那份 + 栏里原话」推出来，不能照抄默认话术：
       栏里写成 JSON 才叫「写什么发什么」，写坏了是退回自动那两条，清空是一个都不带 —— 三种都得说准。 */
    var hdrNote;
    if (sel.headers === undefined) hdrNote = "（没走单子：⚙ 里那些 + 脚本按当前页面补的 UA 与来源）";
    else if (!inputs.headers) hdrNote = "（这一栏没写出任何要发的头）";
    else hdrNote = ghHeaderSet(sel.headers) ? "（就是单子上那一栏，栏里写什么发什么）"
                                           : "（那一栏没写成 JSON 对象，退回自动补的 UA 与来源）";
    log("   headers    " + (inputs.headers || "（不带）") + hdrNote, "dim");
    if (sel.headers !== undefined && !inputs.headers)
      log("   这一栏没写出任何要发的头（清空或全是空值都一样）：这次一个自定义头都不带。" +
          "媒体域对没有 UA/来源的直连常会拒绝，运行失败就先回来把两条补上。", "bad");
    log("   hf_upload  " + ghHfNote(inputs), "dim");
    return ghFetch("POST", "/repos/" + cfg.repo + "/actions/workflows/" + encodeURIComponent(wf) + "/dispatches",
                   { ref: cfg.ref, inputs: inputs }).then(function (r) {
      if (r.status !== 204) throw new Error(ghErr(r.status, r.text));
      log("✓ 已触发（HTTP 204，GitHub 这个接口不返回运行 id，下面按时间认）", "ok");
      return watchRun(my, cfg, wf, triggeredAt);
    }).catch(function (e) { log("× 触发失败：" + String(e && e.message || e), "bad"); });
  }

  /* ---------- 本地出口：aria2 / MediaGo（v2.18） ----------
     这两个出口打在 127.0.0.1 或局域网地址上，而本脚本是 @grant none（跑在页面主世界）：
     页面里的 fetch 打本地端口会被 CORS 与私有网络策略挡住，读不到结果。能打通的只有
     GM_xmlhttpRequest，而它必须 @grant，一加 @grant 脚本就进沙箱、拦不到 App ——
     所以本地请求交给伴生脚本 tools/one/one-local-dispatch.user.js 代发。

     两边共用 DOM，就用 <html> 上的属性传话（和「自动替换」用的 data-oneqz-repl 同一套
     做法，只用字符串，不跨 realm 传对象）：
       主 → 伴生  data-oneqz-local      = { q: [ { id, op, payload } ] }
       伴生 → 主  data-oneqz-local-res  = { q: [ { id, ok, data|error } ] }
       伴生就绪   data-oneqz-local-ready= { v, at }
     为什么是队列而不是「一次一个值」：MutationObserver 在回调里只能看到属性的**最终值**，
     两次写落进同一个批次，前一次就被后一次盖掉（表现是没回应、25 秒后超时）。所以两个
     方向都写自己的队列属性、谁也不改对方的属性：主脚本只追加 data-oneqz-local、
     伴生只追加 data-oneqz-local-res，两边按 id 认领。回应留着不摘也无所谓（最多 20 条，
     认领过的 id 不会再被认领一次），这样彻底避开丢消息。 */
  var LCL_REQ = "data-oneqz-local";
  var LCL_RES = "data-oneqz-local-res";
  var LCL_READY = "data-oneqz-local-ready";
  var LCL_WAIT_MS = 25000;
  var LCL_KEEP = 20;                   // 请求队列里最多留几条（都是已认领的，留着只为不覆盖）
  var lclSeq = 0, lclWait = {}, lclMo = null, lclQueue = [];
  var ariaJob = 0, mgJob = 0;          // 两个本地出口各自的轮询代次号（互不干扰）
  var ARIA_POLL_MS = 600000, ARIA_POLL_GAP = 3000;
  var MG_POLL_MS = 600000, MG_POLL_GAP = 3000;

  function lclVersion() {
    try {
      var raw = document.documentElement.getAttribute(LCL_READY);
      var j = raw ? safeJson(raw) : null;
      return (j && j.v) || "";
    } catch (e) { return ""; }
  }
  function lclSettle(raw) {
    var j = raw ? safeJson(raw) : null;
    var q = (j && j.q) || [];
    for (var i = 0; i < q.length; i++) {
      var r = q[i];
      if (!r || !r.id || !lclWait[r.id]) continue;
      var w = lclWait[r.id];
      delete lclWait[r.id];
      if (w.timer) clearTimeout(w.timer);
      if (r.ok) w.resolve(r.data === undefined ? null : r.data);
      else w.reject(new Error(r.error || "本地转发失败"));
    }
  }
  function lclArm() {
    if (lclMo || !document.documentElement) return;
    if (typeof MutationObserver !== "function") return;
    var mo = new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        if (recs[i].attributeName === LCL_RES) lclSettle(document.documentElement.getAttribute(LCL_RES));
      }
    });
    try { mo.observe(document.documentElement, { attributes: true, attributeFilter: [LCL_RES] }); lclMo = mo; }
    catch (e) {}
  }
  function lclMissing() {
    return new Error("没有检测到本地转发脚本（伴生脚本 one-local-dispatch.user.js 没装，或装完还没刷新本页）。" +
      "本地 aria2 / MediaGo 靠它代发：页面主世界的 fetch 打不通 127.0.0.1（CORS / 私有网络策略）。" +
      "装好后刷新一次页面，面板顶部会显示「本地转发 v…」");
  }
  function lclCall(op, payload, timeoutMs) {
    if (!lclVersion()) return Promise.reject(lclMissing());
    lclArm();
    var id = "one" + Date.now().toString(36) + "-" + (++lclSeq);
    var ms = timeoutMs || LCL_WAIT_MS;
    return new Promise(function (resolve, reject) {
      var w = { resolve: resolve, reject: reject, timer: 0 };
      lclWait[id] = w;
      w.timer = setTimeout(function () {
        if (!lclWait[id]) return;
        delete lclWait[id];
        reject(new Error("本地转发脚本 " + Math.round(ms / 1000) + " 秒没回应（它可能被禁用了，或那个端口一直没回）"));
      }, ms);
      /* 追加进队列再整体写：写自己这条属性，不碰伴生脚本那条，所以不会互相覆盖 */
      lclQueue.push({ id: id, op: op, payload: payload || {} });
      if (lclQueue.length > LCL_KEEP) lclQueue.splice(0, lclQueue.length - LCL_KEEP);
      try {
        document.documentElement.setAttribute(LCL_REQ, JSON.stringify({ q: lclQueue }));
      } catch (e) {
        delete lclWait[id]; clearTimeout(w.timer); reject(e);
      }
    });
  }

  /* aria2 / MediaGo 的本机默认值。都是「这台机器上怎么连」与「上次存在哪」，
     属于会记住的偏好（⚙ 里能改），单子上也能改 —— 改的是同一个键。 */
  function ariaCfg() {
    var rpc = String(store.get("one_aria_rpc", "http://127.0.0.1:6800/jsonrpc") || "").trim();
    return {
      /* 尾斜杠去掉：日志里看着干净，也免得拼出 //jsonrpc 被某些反代当成别的路径 */
      rpc: (rpc || "http://127.0.0.1:6800/jsonrpc").replace(/\/+$/, ""),
      secret: String(store.get("one_aria_secret", "") || ""),
      dir: String(store.get("one_aria_dir", "") || "").trim(),
      proxy: String(store.get("one_aria_proxy", "") || "").trim(),
      multi: store.get("one_aria_multi", "1") !== "0"
    };
  }
  function mgCfg() {
    var base = String(store.get("one_mg_base", "http://127.0.0.1:9900") || "").trim();
    return {
      base: (base || "http://127.0.0.1:9900").replace(/\/+$/, ""),
      key: String(store.get("one_mg_key", "") || ""),
      folder: String(store.get("one_mg_folder", "") || "").trim(),
      del: store.get("one_mg_del", "1") !== "0"
    };
  }

  /* 单子上那一栏请求头 → 本地服务要的形状。和 GitHub 那条用同一份解析：
     栏里写什么发什么（栏里本来就已经铺好了 UA 与来源），不是后台另补一套。 */
  function selHeaderJson(sel) {
    if (sel && sel.headers !== undefined) return ghFormHeadersJson(sel.headers);
    return ghHeadersJson(ghCfg().headers);
  }
  function headerListOf(json) {
    var o = json ? safeJson(json) : null;
    if (!o || typeof o !== "object") return [];
    return Object.keys(o).map(function (k) { return k + ": " + o[k]; });
  }

  function ariaStatusText(s) {
    var zh = { waiting: "等待中", active: "下载中", paused: "已暂停", complete: "完成",
               error: "失败", removed: "已移除" };
    return zh[s] || s || "?";
  }
  function mgStatusText(s) {
    var zh = { waiting: "等待中", downloading: "下载中", success: "完成", failed: "失败", stopped: "已停止" };
    return zh[s] || s || "?";
  }
  /* aria2 的 out 是「-o 原样落盘」：MP4 给带后缀的名字；M3U8 给它 .m3u8，
     否则会得到一个没有扩展名的文件（而 aria2 本身不下 HLS，见下面的提醒）。 */
  function ariaOutName(name, fmt) {
    var p = ghSplitExt(name);
    if (!p.stem) return "";
    return p.stem + "." + (p.ext || (fmt === "M3U8" ? "m3u8" : "mp4"));
  }

  /* 下发到 aria2：addUri 回来就返回，进度轮询丢到后台。
     两个本地出口可以同时勾，所以各自的轮询用各自的代次号（ariaJob / mgJob）：
     再发一次 aria2 只作废旧的那条 aria2 轮询，不碰 MediaGo 的。 */
  function sendToAria2(item, sel) {
    var cfg = ariaCfg();
    var plan = { rpc: cfg.rpc, secret: cfg.secret };
    var opts = { "allow-overwrite": sel.overwrite ? "true" : "false", "auto-file-renaming": "false" };
    if (cfg.dir) opts.dir = cfg.dir;
    if (cfg.proxy) opts["all-proxy"] = cfg.proxy;
    var hl = headerListOf(selHeaderJson(sel));
    if (hl.length) opts.header = hl;
    if (cfg.multi) {
      opts.split = "16";
      opts["max-connection-per-server"] = "16";
      opts["min-split-size"] = "1M";
    }
    var out = ariaOutName(sel.name, item.fmt);
    if (out) opts.out = out;

    log("── 发给本地 aria2 ──", "dim");
    log("   RPC        " + cfg.rpc + (cfg.secret ? "（带 RPC 密钥）" : "（无密钥）"), "dim");
    log("   urls       " + item.url);
    log("   out        " + (out || "（空：aria2 按 URL 命名）") + (cfg.dir ? "    dir " + cfg.dir : ""), "dim");
    log("   header     " + (hl.length ? hl.join(" | ") : "（不带）"), "dim");
    if (cfg.multi) log("   多连接     开（-x 16 -s 16）", "dim");
    if (item.fmt === "M3U8")
      log("   提醒：aria2 原版不解析 HLS，这条 .m3u8 大概率只会下到播放列表文件本身（要分片得用 aria2-next 之类支持 HLS 的版本，" +
          "或者改发 GitHub 的 m3u8.yml / MediaGo）", "bad");
    var my = ++ariaJob;
    return lclCall("aria2.call", { rpc: plan.rpc, secret: plan.secret, method: "aria2.addUri",
                                  params: [[item.url], opts] }).then(function (gid) {
      log("✓ 已加入 aria2   gid=" + gid + "（进度在后台轮询，不挡别的出口）", "ok");
      if (my === ariaJob) ariaPoll(gid, plan, my);      // 不等它：下载可能好几分钟
      return gid;
    }).catch(function (e) {
      log("× 发给 aria2 失败：" + String(e && e.message || e), "bad");
      return null;
    });
  }

  function ariaPoll(gid, cfg, my) {
    var lastKey = "";
    function step(left) {
      if (my !== ariaJob) { log("（又发了一次 aria2，这次轮询停掉）", "dim"); return Promise.resolve(null); }
      return lclCall("aria2.call", { rpc: cfg.rpc, secret: cfg.secret, method: "aria2.tellStatus",
        params: [gid, ["gid", "status", "totalLength", "completedLength", "downloadSpeed", "errorMessage", "files"]] })
        .then(function (st) {
          st = st || {};
          var total = Number(st.totalLength) || 0, done = Number(st.completedLength) || 0;
          var pct = total > 0 ? Math.floor(done / total * 100) : 0;
          /* 每 3 秒一条会把面板刷满：只有状态、百分比（按 5% 一档）或「在不在跑」变了才写一行 */
          var key = (st.status || "?") + "|" + Math.floor(pct / 5) + "|" + (Number(st.downloadSpeed) > 0 ? 1 : 0);
          if (key !== lastKey) {
            lastKey = key;
            log("   " + ariaStatusText(st.status) +
                (total > 0 ? "  " + pct + "%（" + mb(done) + " / " + mb(total) + "）" : "") +
                (Number(st.downloadSpeed) > 0 ? "  " + mb(st.downloadSpeed) + "/s" : "") +
                (st.files && st.files[0] && st.files[0].path ? "  → " + st.files[0].path : ""),
                st.status === "error" ? "bad" : (st.status === "complete" ? "ok" : "dim"));
          }
          if (st.status === "complete") { log("✓ aria2 下载完成（文件在 aria2 那台机器上，路径见上一行）", "ok"); return st; }
          if (st.status === "error" || st.status === "removed") {
            log("× aria2 结束：" + (st.errorMessage || st.status), "bad");
            return st;
          }
          if (left <= 0) { log("本机轮询到 " + Math.round(ARIA_POLL_MS / 1000) + " 秒结束，aria2 里应该还在跑", "dim"); return st; }
          return sleep(ARIA_POLL_GAP).then(function () { return step(left - ARIA_POLL_GAP); });
        }, function (e) {
          log("× 查 aria2 进度失败：" + String(e && e.message || e), "bad");
          return null;
        });
    }
    return step(ARIA_POLL_MS);
  }

  /* 下发到 MediaGo：POST /api/downloads 一次一个任务；返回任务 id 就返回，进度丢到后台。
     MediaGo 的 /api/downloads 没有选流参数，但我们这条链接本身就是详情给出的具体清单
     （不是多码率的 master），所以不需要在页面侧选画质 —— 这一点和 m3u8 站点抓到的
     master 播放列表不同，那里必须先选流再发。 */
  function sendToMediaGo(item, sel) {
    var cfg = mgCfg();
    var hdr = headerListOf(selHeaderJson(sel)).join("\n");   // MediaGo 要「每行一个 Name: Value」
    var type = /\.m3u8(?:$|[?#])/i.test(item.url) ? "m3u8" : "direct";
    var task = { type: type, url: item.url };
    var stem = ghSplitExt(sel.name).stem;
    if (stem) task.name = sanitizeFileName(stem);             // 后缀交给 MediaGo 按类型补
    if (cfg.folder) task.folder = cfg.folder;
    if (hdr) task.headers = hdr;
    if (cfg.del) task.deleteSegments = true;

    log("── 发给 MediaGo ──", "dim");
    log("   地址       " + cfg.base + (cfg.key ? "（带 API Key）" : "（无认证）"), "dim");
    log("   task       type=" + type + "   name=" + (task.name || "（空：MediaGo 按 URL 命名）") +
        (cfg.folder ? "   folder=" + cfg.folder : ""), "dim");
    log("   urls       " + item.url);
    log("   headers    " + (hdr ? hdr.replace(/\n/g, " | ") : "（不带）"), "dim");
    var my = ++mgJob;
    return lclCall("mediago.call", { base: cfg.base, key: cfg.key, method: "POST",
                                    path: "/api/downloads", body: { tasks: [task], startDownload: true } })
      .then(function (created) {
        var list = Array.isArray(created) ? created : ((created && created.list) || []);
        if (!list.length) {
          log("× MediaGo 没返回创建出来的任务（可能已存在相同任务），去它自己的界面看", "bad");
          return null;
        }
        var id = list[0] && list[0].id;
        log("✓ 已创建 MediaGo 任务" + (id ? "  #" + id : "") + "（进度在后台轮询，不挡别的出口）", "ok");
        if (my === mgJob && id !== undefined && id !== null) mgPoll(id, cfg, my);
        return id;
      }).catch(function (e) {
        log("× 发给 MediaGo 失败：" + String(e && e.message || e), "bad");
        return null;
      });
  }

  function mgPoll(id, cfg, my) {
    var lastKey = "";
    function step(left) {
      if (my !== mgJob) { log("（又发了一次 MediaGo，这次轮询停掉）", "dim"); return Promise.resolve(null); }
      return lclCall("mediago.call", { base: cfg.base, key: cfg.key, method: "GET",
        path: "/api/downloads/" + encodeURIComponent(String(id)) })
        .then(function (st) {
          st = st || {};
          var key = String(st.status || "?");
          if (key !== lastKey) {
            lastKey = key;
            log("   " + mgStatusText(st.status) + (st.file ? "  → " + st.file : ""),
                st.status === "failed" ? "bad" : (st.status === "success" ? "ok" : "dim"));
          }
          if (st.status === "success") { log("✓ MediaGo 下载完成", "ok"); return st; }
          if (st.status === "failed" || st.status === "stopped") {
            log("× MediaGo 结束：" + (st.status === "failed" ? "失败" : "已停止"), "bad");
            return st;
          }
          if (left <= 0) { log("本机轮询到 " + Math.round(MG_POLL_MS / 1000) + " 秒结束，MediaGo 里应该还在跑", "dim"); return st; }
          return sleep(MG_POLL_GAP).then(function () { return step(left - MG_POLL_GAP); });
        }, function (e) {
          log("× 查 MediaGo 进度失败：" + String(e && e.message || e), "bad");
          return null;
        });
    }
    return step(MG_POLL_MS);
  }

  /* 单子上勾了哪几个出口就往哪几个发。顺序是先本地后 GitHub：本地那两条拿到任务 id 就
     回来（进度在后台轮询），不会因为 GitHub 那边要排队几分钟而让本地迟迟不下发。 */
  function sendToTargets(res, sel) {
    var t = (sel && sel.targets) || { gh: true };
    var jobs = [];
    if (t.aria) jobs.push(function () { return sendToAria2(sel.item, sel); });
    if (t.mg) jobs.push(function () { return sendToMediaGo(sel.item, sel); });
    if (t.gh) jobs.push(function () { return sendToAction(res, sel); });
    if (!jobs.length) { log("一个出口都没勾：勾上 GitHub / aria2 / MediaGo 里至少一个再确认。", "bad"); return Promise.resolve(null); }
    return jobs.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve(null));
  }

  /* ---------- UI ---------- */
  /* 夹位置是「无论窗口怎么缩放，图标都必须在窗口里」的全部难度所在。
     写成不吃 DOM 的纯函数，_core_test.js 就能拿极端视口（320x240、比球还窄的视口）直接算，
     不用在浏览器里一寸一寸试。下面 clampPos/placeBody 是它们唯一的调用点。 */
  function clampInside(left, top, boxW, boxH, winW, winH, pad) {
    pad = pad || 8;
    var maxL = Math.max(pad, winW - boxW - pad);
    var maxT = Math.max(pad, winH - boxH - pad);
    return {
      left: Math.round(Math.min(Math.max(pad, left), maxL)),
      top:  Math.round(Math.min(Math.max(pad, top), maxT))
    };
  }
  /* 展开体贴哪一侧：下方放得下就下方；翻上方；上下都放不下就整块贴进可视区
     （这时宁可压住球——球能拖走，展开体里正在看的内容压掉才真的没法用）。 */
  function bodyPlace(fL, fT, fW, fH, bW, bH, winW, winH, pad) {
    pad = pad || 8;
    var gap = 8;
    var down = fT + fH + gap;
    var up = fT - gap - bH;
    var top;
    if (down + bH <= winH - pad) top = down;
    else if (up >= pad) top = up;
    else top = Math.max(pad, winH - bH - pad);
    var left = Math.min(Math.max(pad, fL), Math.max(pad, winW - bW - pad));
    var side = top >= fT + fH ? "down" : (top + bH <= fT ? "up" : "inside");
    return { left: Math.round(left), top: Math.round(top), side: side };
  }
  /* 行内文本一律走 textNode/anchor 节点，不碰 innerHTML：服务端字段（标题、提示语）里带尖括号
     也只能是文字。带 http(s) 的片段拆出来做成 <a target=_blank>，其余原样保留，选中照样能复制。 */
  var URL_SPLIT = /((?:https?:\/\/)[^\s，。；：、（）()【】「」『』“”‘’"'`]+)/;
  function appendLineText(line, text) {
    var parts = String(text).split(URL_SPLIT);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (/^https?:\/\//.test(p)) {
        var a = document.createElement("a");
        a.href = p;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        /* <a href> 默认是可拖的：从链接上按下再拖动会被浏览器当成「拖这个链接」，
           于是选不中文字。关掉拖拽，拖选才落在选字上，单击照旧开新标签页。 */
        a.draggable = false;
        a.textContent = p;
        line.appendChild(a);
      } else {
        line.appendChild(document.createTextNode(p));
      }
    }
  }

  var CSS = [
    /* 悬浮球是页面上唯一常驻的元素：可拖，位置由 JS 夹在视口内（left/top 而不是 right/bottom，
       否则拖动时两套锚点会打架）。touch-action:none 是给 pointermove 用的，少了它触屏一拖就变成滚动。 */
    "#oneqz-fab{position:fixed;z-index:2147483647;width:44px;height:44px;box-sizing:border-box;" +
      "border-radius:50%;border:1px solid #4a5060;background:#2b2f3a;color:#cfd6e6;" +
      "font:13px/1 ui-monospace,Consolas,monospace;display:flex;align-items:center;justify-content:center;" +
      "cursor:grab;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.45)}",
    "#oneqz-fab:active{cursor:grabbing}",
    "#oneqz-fab.st-ok{background:#1c3a26;border-color:#7ddc8f;color:#c7f5d2}",
    "#oneqz-fab.st-warn{background:#3a3320;border-color:#f0c674;color:#ffe6ac}",
    "#oneqz-fab.st-bad{background:#3a1c1c;border-color:#ff8f8f;color:#ffc9c9}",
    "#oneqz-fab .dot{position:absolute;right:-3px;top:-3px;min-width:16px;height:16px;padding:0 3px;" +
      "box-sizing:border-box;border-radius:8px;background:#f0c674;color:#1b1200;font-size:10px;" +
      "line-height:16px;text-align:center;display:none;pointer-events:none}",
    "#oneqz-fab .dot.on{display:block}",
    /* 展开体：点图标才出现。宽高都按视口收，位置由 placeBody 依图标周围的空间决定。
       页面本身是 Flutter 画布，它把 user-select 关掉了，展开体必须显式打开才能选中文字复制；
       -webkit-touch-callout:default 是给手机浏览器的长按复制留的。 */
    "#oneqz{position:fixed;z-index:2147483647;display:none;box-sizing:border-box;" +
      "width:min(760px,calc(100vw - 16px));max-height:min(70vh,calc(100vh - 60px));overflow:auto;" +
      "overscroll-behavior:contain;" +
      "user-select:text;-webkit-user-select:text;-webkit-touch-callout:default;cursor:text;" +
      "background:#16181f;border:1px solid #4a5060;border-radius:10px;padding:10px;" +
      "font:13px/1.5 ui-monospace,Consolas,monospace;color:#e8e8ee;box-shadow:0 6px 24px rgba(0,0,0,.5)}",
    "#oneqz.on{display:block}",
    "#oneqz ::selection,#oneqz::selection{background:#3a6ea5;color:#fff}",
    "#oneqz .status{margin:0 0 8px;color:#9aa3b8;font-size:11px/1.5;white-space:normal;word-break:break-all}",
    "#oneqz .btns{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 8px}",
    "#oneqz button{background:#2b2f3a;color:#e8e8ee;border:1px solid #4a5060;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit}",
    "#oneqz button:hover{background:#3a4050}",
    "#oneqz .panel{white-space:pre-wrap;word-break:break-all}",
    /* 链接：点一下新标签页打开，同时保留选中/长按复制。选中优先于跳转，所以拖选不会误开页面。 */
    "#oneqz .panel a{color:#7fd0ff;text-decoration:underline;text-underline-offset:2px;" +
      "cursor:pointer;user-select:text;-webkit-user-select:text;-webkit-user-drag:none;word-break:break-all}",
    "#oneqz .panel a:hover{background:#22303f;color:#cbeaff}",
    "#oneqz .cfg{margin:0 0 8px;padding:8px;border:1px solid #333a48;border-radius:6px;background:#11141b;display:none}",
    "#oneqz .cfg.on{display:block}",
    "#oneqz .cfg label{display:block;margin:4px 0;color:#9aa3b8}",
    "#oneqz .cfg input,#oneqz .cfg select{width:100%;box-sizing:border-box;background:#0d0f14;color:#e8e8ee;border:1px solid #3a4050;border-radius:4px;padding:4px;font:inherit}",
    "#oneqz .cfg input[type=checkbox]{width:auto;margin:0 6px 0 0;vertical-align:-2px}",
    /* 复选框不能跟着 input 的 width:100% 走，否则整行被撑成一个巨大的方块 */
    "#oneqz .cfg label.auto{background:#0f1320;border:1px solid #3a4050;border-radius:6px;padding:6px}",
    "#oneqz .cfg label.auto input[type=checkbox]{width:auto;margin:0 6px 0 0;vertical-align:-2px}",
    /* ⬇ 下载表单：和 .cfg 同一套底色，但它是「一次性的单子」，出现/消失都由 ⬇ 与取消控制 */
    "#oneqz .ghform{margin:8px 0;padding:8px;border:1px solid #3a6ea5;border-radius:6px;background:#0f1320}",
    "#oneqz .ghform label{display:block;margin:5px 0;color:#9aa3b8}",
    "#oneqz .ghform input[type=text]{width:100%;box-sizing:border-box;background:#0d0f14;color:#e8e8ee;" +
      "border:1px solid #3a4050;border-radius:4px;padding:4px;font:inherit}",
    "#oneqz .ghform input[type=radio],#oneqz .ghform input[type=checkbox]{width:auto;margin:0 6px 0 0;vertical-align:-2px}",
    /* 单子里的子分组：aria2 / MediaGo 各自一块，只勾了哪个才显出来 */
    "#oneqz .ghform .ghsub{margin:8px 0 0;padding:6px 8px;border:1px dashed #3a4050;border-radius:6px;background:#0c0f16}",
    "#oneqz .ghform .ghsub>div.dim{margin-bottom:2px}",
    "#oneqz .ghform .ghsub label{display:block;margin:4px 0;color:#9aa3b8}",
    "#oneqz .ghform .ghrow{display:flex;gap:6px;margin-top:8px}",
    "#oneqz .ok{color:#7ddc8f}#oneqz .bad{color:#ff8f8f}#oneqz .dim{color:#8a93a8}",
    "#oneqz .json{color:#c3ffd8;max-height:40vh;overflow:auto;border-top:1px dashed #333a48;margin-top:6px;padding-top:6px}"
  ].join("\n");

  var panel, cfgBox, statusEl, hostDiv, fab, fabNum, fabDot, lastResult = null;
  var POS = { left: 12, top: 12 };   // 悬浮球左上角（不是中心）；夹取时按球的外框算
  var unread = 0;                    // 收起状态下又拦到了新东西，用球上的红点提醒
  var viewShown = false;             // 面板里当前是不是「某个视图」，而不是攒下来的流水日志

  function log(text, cls, plain) {
    if (!panel) return;
    var line = document.createElement("div");
    if (cls) line.className = cls;
    if (plain) line.textContent = String(text);   // 明确不该点的行（比如那个 404 的 ts 域）就走纯文本
    else appendLineText(line, text);              // 纯文本落地，只有 http(s) 片段升级为可点链接
    panel.appendChild(line);
    /* 现在滚动的是展开体，不是 .panel（panel 不再自己带 overflow），滚错对象面板就不会跟到底 */
    if (hostDiv) hostDiv.scrollTop = hostDiv.scrollHeight;
  }
  function reset() { if (panel) { panel.textContent = ""; lastResult = null; } if (ghFormEl) closeGhForm(); }

  function isDetailPage() { return /detail|videoPlay|minified/i.test(location.hash || ""); }
  function hookTag() {
    var dirty = "";
    try { if ((window.__oneqz_layers || 1) > 1) dirty = " ⚠页面里有 " + window.__oneqz_layers + " 层钩子，刷新一次再测"; } catch (e) {}
    var auto = autoOn() ? " · 自动替换 token=开" + (STAT.repl ? "(" + STAT.repl + " 次)" : "") +
                          (STAT.replErr ? " ⚠有 " + STAT.replErr + " 次替换失败" : "") : "";
    if (HOOK.mode === "direct") return "钩子=直接拦 App ✓" + dirty + auto;
    if (HOOK.mode === "local" && HOOK.relay) return "钩子=注入回传 ✓" + dirty + auto;
    if (HOOK.mode === "local") return "钩子=沙箱 ✗(注入未生效，拦不到 App)" + dirty + auto;
    return "钩子=安装中…";
  }
  function hookOk() { return HOOK.mode === "direct" || HOOK.relay; }

  /* ---------- 悬浮球：定位 / 夹取 / 展开体跟随 ---------- */
  function vw() { return window.innerWidth || document.documentElement.clientWidth || 1024; }
  function vh() { return window.innerHeight || document.documentElement.clientHeight || 768; }
  function clampPos() {
    var s = fab ? { w: fab.offsetWidth || 44, h: fab.offsetHeight || 44 } : { w: 44, h: 44 };
    var p = clampInside(POS.left, POS.top, s.w, s.h, vw(), vh());
    POS.left = p.left; POS.top = p.top;
  }
  function placeFab() {
    if (!fab) return;
    clampPos();
    fab.style.left = POS.left + "px";
    fab.style.top  = POS.top + "px";
  }
  function savePos() { store.set("one_fab_pos", POS.left + "," + POS.top); }
  function loadPos() {
    var m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(String(store.get("one_fab_pos", "") || ""));
    if (m) { POS.left = +m[1]; POS.top = +m[2]; }
    else { POS.left = vw() - 56; POS.top = Math.round(vh() * 0.42); }   // 首装：右侧中部，竖屏也不压底部导航
    clampPos();
  }
  /* 展开体是独立的 fixed 层：位置由 bodyPlace 依球周围的空间决定。 */
  function placeBody() {
    if (!fab || !hostDiv || !isOpen()) return;
    var r = fab.getBoundingClientRect();
    var w = hostDiv.offsetWidth || Math.min(760, vw() - 16);
    var h = hostDiv.offsetHeight || 240;
    var p = bodyPlace(r.left, r.top, r.width || 44, r.height || 44, w, h, vw(), vh());
    hostDiv.style.top = p.top + "px";
    hostDiv.style.left = p.left + "px";
  }
  function onVpChange() { placeFab(); placeBody(); }
  function isOpen() { return !!hostDiv && hostDiv.classList.contains("on"); }
  function openBody() {
    if (!hostDiv) return;
    hostDiv.classList.add("on");
    if (unread) { unread = 0; }
    placeBody();
    updateFab();
    viewShown = true;      // 走到这里的一定是在渲染某个视图（诊断/看拦截/重取/切身份）
  }
  function closeBody() { if (hostDiv) hostDiv.classList.remove("on"); }
  function toggleBody() {
    if (isOpen()) { closeBody(); return; }
    var hadView = viewShown;
    openBody();
    /* 收起期间 log() 一直在往面板里堆流水，直接展开会看到一堆日志而不是当前拦截结果。
       所以只要还没有渲染过视图（或收起期间又来了新拦截），展开时先渲染一次拦截详情。 */
    if (!hadView) showAppCapture();
  }

  function updateFab() {
    if (!fab) return;
    var head = hookTag(), text, state;
    if (CAP.id) {
      text = head + " · 拦截到 id=" + CAP.id + (CAP.response ? " ✓（响应也解密了）" : " …（还没拿到响应）") +
             "  [" + (CAP.route || "?") + "]";
      state = "st-ok";
    } else if (hookOk()) {
      text = head + (STAT.seen
        ? " · 已拦到 App 的 " + STAT.seen + " 个请求（" + STAT.plain + " 个解密成功），里面没有文章 id —— 点进视频那一下才会带 id"
        : " · 从列表点进视频才会触发详情请求（刷新/直开不会）") + "  [" + (location.hash || "?") + "]";
      state = "st-warn";
    } else {
      text = head + " · [" + (location.hash || "?") + "]";
      state = "st-bad";
    }
    if (!isDetailPage()) text += "   当前路由不是详情页，拦到的东西不代表本页";
    fab.setAttribute("class", state);
    fab.title = text;
    if (fabNum) fabNum.textContent = CAP.id ? (CAP.response ? "✓" : "i") : (STAT.seen ? String(STAT.seen) : "·");
    if (fabDot) {
      fabDot.textContent = unread ? (unread > 99 ? "99+" : String(unread)) : "";
      fabDot.setAttribute("class", "dot" + (unread ? " on" : ""));
    }
    if (statusEl) statusEl.textContent = text;
  }
  /* 旧名字留着，调用点太多，含义变成「刷新悬浮球与状态行」 */
  function updateChip(why) { placeFab(); updateFab(); if (isOpen()) placeBody(); }

  function diagnose() {
    reset();
    openBody();
    log("诊断 " + new Date().toLocaleTimeString() + "   " + location.href);
    log("脚本版本   " + SCRIPT_VERSION + "   世界判定=" + WORLD +
        "   钩子模式=" + (HOOK.mode || "?"), hookOk() ? "ok" : "bad");
    log("拦截能力   " + (hookOk()
        ? "直接拦 App 的 fetch/XHR（与页面同世界）"
        : "只在沙箱，拦不到 App —— 需把 @grant 设为 none 让脚本进主世界"), hookOk() ? "ok" : "bad");
    var aspec = replaceSpec();
    log("自动替换   " + (autoOn()
        ? "开 —— 用 " + (aspec ? aspec.label : "?") + "，本次页面已换过 " + STAT.repl + " 次（付费类接口不碰）" +
          (STAT.replErr ? "；⚠ 有 " + STAT.replErr + " 次没换成，看上面报错行" : "")
        : "关（默认）—— 页面的请求原样发，只有点「用模块 token 重取」时才换身份"),
        autoOn() ? (STAT.replErr ? "bad" : "ok") : "dim");
    if (HOOK.error) log("注入报错   " + HOOK.error, "bad");
    try {
      log("传输指纹   XMLHttpRequest.open 被改写=" + (XMLHttpRequest.prototype.open.toString().indexOf("__oneqz") >= 0 ? "是" : "否") +
          "   fetch 被改写=" + (window.fetch.toString().indexOf("isDetailUrl") >= 0 || window.fetch.toString().indexOf("OF.apply") >= 0 ? "是" : "否"));
    } catch (e) { log("指纹读取失败 " + String(e && e.message || e), "dim"); }
    log("当前路由   " + (location.hash || "(空)") + "   详情页=" + (isDetailPage() ? "是" : "否"));
    /* 本地出口的那半条链路：没有它，aria2 / MediaGo 两个勾就是灰的 */
    var lv = lclVersion();
    log("本地转发   " + (lv
        ? "伴生脚本在线 v" + lv + " → 本地 aria2 / MediaGo 可用（请求由它用 GM_xmlhttpRequest 发出）"
        : "没检测到伴生脚本 one-local-dispatch.user.js —— 本地 aria2 / MediaGo 发不出去（本脚本 @grant none，页面 fetch 打不通 127.0.0.1）"),
        lv ? "ok" : "dim");
    log("钩子计数   经过 " + STAT.seen + " 次 · 请求体解密成功 " + STAT.plain + " 次 · 还原出 id " + STAT.ids + " 次",
        STAT.seen ? "ok" : "bad");
    STAT.last.slice(-6).reverse().forEach(function (x) {
      log("  " + x.ep + "   " + (x.ok ? (x.id ? "id=" + x.id : "体内无 id") : "无请求体/非本密钥") + "   " +
          new Date(x.at).toLocaleTimeString(), x.id ? "ok" : "dim");
    });
    if (CAP.id) {
      log("拦截结果   id=" + CAP.id + "   响应=" + (CAP.response ? "code " + CAP.response.code : "未解密"), "ok");
      return;
    }
    if (!STAT.seen) log("拦截结果   还没有任何 App 请求经过钩子", "bad");
    else log("拦截结果   钩子在收，但当前页面还没发过带文章 id 的请求", "dim");
    log("", "dim");
    log("这个 SPA 的详情请求只在你「从列表点卡片进详情」时才发；刷新或直开 #/videoDetail 它不发，就没有可拦的。", "dim");
    log("先确认这里显示「直接拦 App」；若显示「只在沙箱」，说明 Tampermonkey 把脚本放进了隔离世界——", "dim");
    log("  把脚本头部 @grant 改成 none（当前已是 none），或在 TM 设置里对该脚本关闭沙箱/允许访问页面主世界。", "dim");
  }

  function showAppCapture() {
    reset();
    openBody();
    if (!CAP.id) {
      log("还没有拦截到带文章 id 的请求。" + (STAT.seen ? "（钩子已收到 " + STAT.seen + " 个 App 请求，见下）" : "（钩子一次都没收到）"),
          STAT.seen ? "dim" : "bad");
      STAT.last.slice(-6).reverse().forEach(function (x) {
        log("  拦到 " + x.ep + "   " + (x.ok ? (x.id ? "id=" + x.id : "体内无 id") : "无请求体/非本密钥"), x.id ? "ok" : "dim");
      });
      log("脚本 " + SCRIPT_VERSION + " · " + hookTag() + "   路由 " + (location.hash || "?"), hookOk() ? "dim" : "bad");
      if (hookOk()) {
        log("钩子是好的，能拦到 App 的 XHR/fetch。拦不到，几乎一定是因为 App 在这一刻根本没发详情请求：", "dim");
        log("  · 这个 SPA 的详情页只认「从列表点卡片进来」时内存里传的 id；", "dim");
        log("  · 直接刷新或打开 #/videoDetail（哪怕 URL 里带 ?id=）App 会忽略、不发 /v2.5/article/detail，就没有可拦的请求。", "dim");
        log("正确触发：回发现页/收藏列表，点一张视频卡片进来 —— App 自己发的那次 detail 请求会被自动拦下并显示。", "ok");
      } else {
        log("× 拦不到 App 是因为脚本被放进了隔离世界，patch 的 fetch/XHR 只对沙箱生效 —— 点「诊断」看修法。", "bad");
      }
      return;
    }
    log("拦截来源   " + (CAP.route || "?") + "   POST /v2.5/" + (CAP.idFrom || "article/detail"));
    log("请求体明文 " + String(CAP.plain || ("id=" + CAP.id)).slice(0, 160) +
        "   ← id=" + CAP.id + "（URL 里没有它，只有请求体能给）", "ok");
    log("ts 域名(dn) " + (CAP.dn || "请求体里没有 dn") +
        "   ← 它就是 M3U8 清单里 *.ts 分片的域名（服务端把 dn 原样写进清单）；mp4 不用它，所以这里不做成链接", "dim", true);
    refreshPlayHost();
    log("播放域名   " + playHost() + (CAP.playHost ? "  （" + CAP.playFrom + "）" : "  （种子池成员；面板里可手填）") +
        "   ← 下面的完整链接用它 + 路径", "ok");
    var h = CAP.headers || {};
    log("网页 App 身份（本页登录态） uuid=" + (h.uuid || "-") + "   user-key=\"" + (h["user-key"] || "") + "\"  token@" + issOf(h.token));
    log("网页 App 时刻 " + new Date(CAP.at).toLocaleTimeString() + "   ts=" + (h.timestamp || "-"));
    if (CAP.response) {
      if (CAP.response.code !== 200) {
        log("网页 App 那次响应 code=" + CAP.response.code + " " + (CAP.response.message || ""), "bad");
      } else {
        summarizeInto(CAP.response, log, "网页 App 自己拿到的（本页登录态 = 页面默认值）");
        lastResult = CAP.response;
      }
    } else {
      log("App 响应尚未解密到：" + (CAP.respBad || "load 回调里没读到响应体（responseType 不是文本/二进制？）"), "dim");
    }
    log("", "dim");
    log("下一步：点「用模块 token 重取」——同一个 id 换 one 模块身份再请求，直接对比两个 token 的门控结果。", "dim");
  }

  function issOf(t) {
    if (!t) return "-";
    var m = /"iss"\s*:\s*"?(\d+)/.exec(t);
    if (m) return m[1];
    try {
      var parts = String(t).split(".");
      if (parts.length === 3) {
        var p = JSON.parse(b64.dec(parts[1]).reduce(function (s, b) { return s + String.fromCharCode(b); }, ""));
        return String(p.iss != null ? p.iss : "?");
      }
    } catch (e) {}
    return "?";
  }

  function run() {
    if (!CAP.id) { showAppCapture(); return; }
    reset();
    openBody();
    var mode = cfgBox ? cfgBox.querySelector("select[name=mode]").value : "module";
    var ident = identity(mode);
    if (!ident) { log("模式「网页 App 那次原样」还没拦截到请求，先用默认身份。", "bad"); ident = identity("module"); }
    log("文章 id    " + CAP.id + "（来自拦截到的 " + (CAP.idFrom || "?") + " 请求体，不是 URL）", "ok");
    log("身份       " + ident.label + "   user-key=\"" + ident.userKey + "\"  uuid=" + ident.uuid);
    log("接口       POST " + DETAIL + "   body=AES(id=" + CAP.id + (CAP.dn ? "&dn=" + CAP.dn : "") + ")" +
        (CAP.dn ? "" : "   ← 没带 dn，服务端不会给 video_hls，只有 MP4"), "dim");
    log("---- 请求中 ----", "dim");
    var t0 = Date.now();
    return getDetail(CAP.id, ident, log).then(function (json) {
      if (json.code !== 200) {
        log("× 服务端 code=" + json.code + "  " + (json.message || ""), "bad");
        if (json.code === 450) log("  450 = 该接口需要 user-key 解析成真实账号（detail 一般不该出现，说明 token 已失效）", "dim");
        if (json.code === 401) log("  401 = 签名/头校验失败；确认 uuid 是 8-4-4-4-12 小写、身份模式选对", "dim");
        return;
      }
      var d = json.data || {};
      log("✓ 解密成功  " + (Date.now() - t0) + "ms  字段数=" + Object.keys(d).length, "ok");
      summarize(d, log);
      if (CAP.response && CAP.response.code === 200 && CAP.response.data) {
        var a = CAP.response.data, b = d;
        var same = a.video_file === b.video_file && a.preview_video === b.preview_video;
        // params 是按「条目+账号+dn」生成的，两次即便指向同一份清单字符串也不会相同，所以只比给没给
        var sameHls = !!a.video_hls === !!b.video_hls;
        log("---- 与页面自己那次对比 ----", "dim");
        log("「网页 App」= 这个页面自己发出的请求，用的就是你浏览器的登录态，也就是本页的默认值；" +
            "「模块」= 脚本换成 one 模块 token 重发的同一次 detail。", "dim");
        log("网页 App 拿到  MP4  " + videoUrl(a.video_file), same ? "dim" : "ok");
        log("模块 token 拿到 MP4  " + videoUrl(b.video_file), same ? "dim" : "ok");
        log("网页 App 拿到  M3U8 " + (hlsUrl(a) || "（服务端没给）"), sameHls ? "dim" : "ok");
        log("模块 token 拿到 M3U8 " + (hlsUrl(b) || "（服务端没给）"), sameHls ? "dim" : "ok");
        log(same ? "→ 两次给的是同一个文件：这个 token 对本页的门控结果一致"
                  : "→ 两次给的不是同一个文件：门控由 token 所属账号决定，列表/详情都是服务端给的", same ? "dim" : "ok");
      }
      lastResult = json;
      CAP.resId = CAP.id;    // 这份结果属于哪个 id，⬇ 下载按钮据此判断它是不是当前条目的
      console.log("[oneQZ] " + DETAIL + " 解密结果 id=" + CAP.id + " 身份=" + ident.label, json);
      var pre = document.createElement("div");
      pre.className = "json";
      pre.textContent = "完整 JSON（同一份已 console.log）\n" + JSON.stringify(json, null, 1);
      panel.appendChild(pre);
    }).catch(function (e) {
      log("× " + String(e && e.message || e), "bad");
    });
  }

  /* ⬇ 下载用哪份详情：优先「用模块 token 重取」那一次，但它必须还属于当前这个 id
     （换卡片没重取时 CAP.id 会变、resId 对不上），否则退回页面自己刚拦到的那次。 */
  function detailSource() {
    var mine = (CAP.id && lastResult && lastResult.data && String(CAP.resId) === String(CAP.id)) ? lastResult : null;
    if (mine) return { data: mine.data, from: "模块 token 重取那次（id=" + CAP.id + "）" };
    var page = (CAP.response && CAP.response.code === 200 && CAP.response.data) ? CAP.response : null;
    if (page) return { data: page.data, from: "页面自己拦到的那次" + (autoOn() ? "（自动替换开着，这一份已是模块身份的结果）" : "") };
    return null;
  }

  /* ---------- ⬇ 下载表单：点 ⬇ 先铺一张单子，改完点「确认触发」才真发 ----------
     文件名、请求头、下哪一条、M3U8 要不要转 MP4 —— 这些都是「每次可能不一样」的，
     塞进 ⚙ 当全局设置反而每次都得回去改，所以每次点 ⬇ 现填一张单子；
     ⚙ 里那几项（格式/headers/仓库/分支/token）只当这张单子的默认值。 */
  var ghFormEl = null;
  function closeGhForm() {
    if (ghFormEl && ghFormEl.parentNode) ghFormEl.parentNode.removeChild(ghFormEl);
    ghFormEl = null;
  }
  function ghHostOf(url) { var m = /^https?:\/\/([^/]+)/.exec(String(url || "")); return m ? m[1] : "?"; }
  function ghRadioBox(plan, pre) {
    var links = document.createElement("div");
    Array.prototype.forEach.call(plan, function (it, i) {
      var lab = document.createElement("label");
      var r = document.createElement("input");
      r.type = "radio"; r.name = "ghf_item"; r.value = String(i); r.checked = (i === pre);
      lab.appendChild(r);
      /* 这里只写「哪条链接」，不写会投给哪个 workflow：同一张单子可能只发 aria2 / MediaGo，
         写死「→ aria2.yml」就是在骗人。去向由下面「发送到哪」那一排勾决定。 */
      lab.appendChild(document.createTextNode(" " + it.who + " " + it.fmt + "（" + ghHostOf(it.url) + "）"));
      links.appendChild(lab);
    });
    return links;
  }

  /* 「发送到哪」那个勾集合：存在一个键里（"gh,aria,mg"），勾过就记住。
     装不了/用不了的出口自动剔除，免得存着一个点不亮的勾。 */
  var DL_TARGETS = ["gh", "aria", "mg"];
  function dlTargetsOf(hasGh, hasLcl) {
    var raw = String(store.get("one_dl_targets", "") || "");
    var set = {};
    raw.split(",").forEach(function (k) { if (k) set[k] = 1; });
    if (!raw) { if (hasGh) set.gh = 1; else if (hasLcl) set.aria = 1; }
    if (!hasGh) delete set.gh;
    if (!hasLcl) { delete set.aria; delete set.mg; }
    /* 上次勾的那个这次用不了（比如刚把 Token 清掉），就退到还能用的那个，而不是一个都没勾 */
    if (!Object.keys(set).length) { if (hasGh) set.gh = 1; else if (hasLcl) set.aria = 1; }
    return set;
  }

  function openGhForm(res) {
    var cfg = ghCfg(), hf0 = ghHfCfg(), aria0 = ariaCfg(), mg0 = mgCfg();
    var plan = res && res.data ? downloadPlan(res.data) : [];
    /* 没详情 / 没链接这两种前置不满足的情况，交回 sendToAction 用同一套话回 ——
       它在检查 token 之前就会返回，所以不会冒出「没填 Token」这种不相关的提示。 */
    if (!res || !res.data || !plan.length) return sendToAction(res);
    var title = res.data.title || "";
    var startIdx = (function () { var p = ghPick(plan, cfg.fmt); return p ? plan.indexOf(p) : 0; })();
    var nameDirty = false;
    var nameAutoExt = false;      // 框里那截后缀是表单自己补的、还是用户打的 —— 面板上要说清是谁补的
    var lclVer = lclVersion();
    var hasLcl = !!lclVer;
    var hasGh = !!cfg.token;
    var pre = dlTargetsOf(hasGh, hasLcl);
    closeGhForm();

    var box = document.createElement("div");
    box.className = "ghform";
    var head = document.createElement("div");
    head.className = "dim";
    head.textContent = "⬇ —— 先确认这一单（只对本次有效；仓库 " + cfg.repo + " / 分支 " + cfg.ref +
      " 在 ⚙ 里改" + (hasLcl ? "；本地转发 " + lclVer : "；⚠ 没检测到本地转发脚本，只能发 GitHub") + "）";
    box.appendChild(head);

    var links = ghRadioBox(plan, startIdx);
    box.appendChild(links);

    function chosen() {
      var rs = links.querySelectorAll("input[type=radio]");
      for (var i = 0; i < rs.length; i++) if (rs[i].checked) return plan[Number(rs[i].value)] || plan[0];
      return plan[0];
    }

    /* ---------- 发送到哪 ---------- */
    var tgtWrap = document.createElement("div");
    tgtWrap.className = "dim";
    tgtWrap.style.marginTop = "8px";
    tgtWrap.textContent = "发送到哪（可以只勾一个，也可以一次全勾 —— 勾几个就发几次，互不影响）";
    box.appendChild(tgtWrap);

    function tgtBox(key, text, enabled, why) {
      var lab = document.createElement("label");
      var c = document.createElement("input");
      c.type = "checkbox"; c.name = "ghf_t_" + key;
      c.checked = !!pre[key] && enabled;
      c.disabled = !enabled;
      lab.appendChild(c);
      lab.appendChild(document.createTextNode(" " + text + (enabled ? "" : " —— " + why)));
      if (!enabled) lab.className = "dim";
      box.appendChild(lab);
      return c;
    }
    var tGh = tgtBox("gh", "GitHub Actions（MP4→aria2.yml，M3U8→m3u8.yml）", hasGh,
                     "⚙ 里还没填 GitHub Token");
    var tAria = tgtBox("aria", "本地 aria2（JSON-RPC）", hasLcl,
                       "没装伴生脚本 one-local-dispatch.user.js（页面主世界打不通 127.0.0.1）");
    var tMg = tgtBox("mg", "MediaGo（HTTP API）", hasLcl,
                     "没装伴生脚本 one-local-dispatch.user.js");

    /* ---------- 文件名 ---------- */
    var nameLabel = document.createElement("label");
    nameLabel.appendChild(document.createTextNode("文件名 save_name"));
    var nameIn = document.createElement("input");
    nameIn.type = "text"; nameIn.name = "ghf_name";
    nameLabel.appendChild(nameIn);
    box.appendChild(nameLabel);

    /* ---------- GitHub 专用 ---------- */
    var muxLab = document.createElement("label");
    var muxIn = document.createElement("input");
    muxIn.type = "checkbox"; muxIn.name = "ghf_mux";
    muxIn.checked = store.get("one_gh_mux", "1") !== "0";      // 默认「转成 MP4」，勾过一次的选择不重置
    muxLab.appendChild(muxIn);
    muxLab.appendChild(document.createTextNode(" 转成 MP4（mux_format=mp4）—— 不勾就是不混流，产出分轨原文件"));
    box.appendChild(muxLab);

    var hfLab = document.createElement("label");
    var hfIn = document.createElement("input");
    hfIn.type = "checkbox"; hfIn.name = "ghf_hf";
    hfIn.checked = hf0.on;                                             // ⚙ 里那个默认勾，勾过一次也记住
    hfLab.appendChild(hfIn);
    hfLab.appendChild(document.createTextNode(" ☁ 传到 HF（hf_upload）—— 下载完成后把产物传进 Hugging Face 数据集"));
    box.appendChild(hfLab);

    var pathLab = document.createElement("label");
    pathLab.appendChild(document.createTextNode("上传目录 hf_path（数据集仓库内的子目录，留空=仓库根路径）"));
    var pathIn = document.createElement("input");
    pathIn.type = "text"; pathIn.name = "ghf_hf_path";
    pathIn.placeholder = "one/videos";
    pathIn.value = hf0.path;                                           // 上次在这张单子上填的那个目录
    pathLab.appendChild(pathIn);
    box.appendChild(pathLab);

    /* ---------- aria2 专用 ---------- */
    var ariaWrap = document.createElement("div");
    ariaWrap.className = "ghsub";
    var ariaHead = document.createElement("div");
    ariaHead.className = "dim";
    ariaHead.textContent = "本地 aria2（载荷由伴生脚本代发；下面这几项改过会被记住）";
    ariaWrap.appendChild(ariaHead);
    function ariaField(label, key, value, placeholder, type) {
      var lab = document.createElement("label");
      lab.appendChild(document.createTextNode(label));
      var inp = document.createElement("input");
      inp.type = type || "text"; inp.name = "ghf_" + key;
      inp.placeholder = placeholder || ""; inp.value = value || "";
      lab.appendChild(inp);
      ariaWrap.appendChild(lab);
      return inp;
    }
    var ariaRpcIn = ariaField("RPC 地址", "aria_rpc", aria0.rpc, "http://127.0.0.1:6800/jsonrpc");
    var ariaSecretIn = ariaField("RPC 密钥（--rpc-secret，留空=无）", "aria_secret", aria0.secret, "留空 = 无密钥", "password");
    var ariaDirIn = ariaField("下载目录 dir（aria2 那台机器上的绝对路径，留空=它自己的默认目录）", "aria_dir", aria0.dir, "D:\\Downloads");
    var ariaMultiLab = document.createElement("label");
    var ariaMultiIn = document.createElement("input");
    ariaMultiIn.type = "checkbox"; ariaMultiIn.name = "ghf_aria_multi";
    ariaMultiIn.checked = aria0.multi;
    ariaMultiLab.appendChild(ariaMultiIn);
    ariaMultiLab.appendChild(document.createTextNode(" 多连接加速（-x 16 -s 16）"));
    ariaWrap.appendChild(ariaMultiLab);
    var ariaOwLab = document.createElement("label");
    var ariaOwIn = document.createElement("input");
    ariaOwIn.type = "checkbox"; ariaOwIn.name = "ghf_aria_ow";
    ariaOwIn.checked = store.get("one_aria_ow", "0") === "1";
    ariaOwLab.appendChild(ariaOwIn);
    ariaOwLab.appendChild(document.createTextNode(" 覆盖已存在文件（allow-overwrite）"));
    ariaWrap.appendChild(ariaOwLab);
    box.appendChild(ariaWrap);

    /* ---------- MediaGo 专用 ---------- */
    var mgWrap = document.createElement("div");
    mgWrap.className = "ghsub";
    var mgHead = document.createElement("div");
    mgHead.className = "dim";
    mgHead.textContent = "MediaGo（桌面端 39719，Docker 通常 9900；载荷由伴生脚本代发）";
    mgWrap.appendChild(mgHead);
    function mgField(label, key, value, placeholder, type) {
      var lab = document.createElement("label");
      lab.appendChild(document.createTextNode(label));
      var inp = document.createElement("input");
      inp.type = type || "text"; inp.name = "ghf_" + key;
      inp.placeholder = placeholder || ""; inp.value = value || "";
      lab.appendChild(inp);
      mgWrap.appendChild(lab);
      return inp;
    }
    var mgBaseIn = mgField("MediaGo 地址", "mg_base", mg0.base, "http://127.0.0.1:9900");
    var mgKeyIn = mgField("API Key（留空=无认证）", "mg_key", mg0.key, "留空 = 无认证", "password");
    var mgFolderIn = mgField("保存子目录 folder（留空=MediaGo 默认目录）", "mg_folder", mg0.folder, "videos");
    var mgDelLab = document.createElement("label");
    var mgDelIn = document.createElement("input");
    mgDelIn.type = "checkbox"; mgDelIn.name = "ghf_mg_del";
    mgDelIn.checked = mg0.del;
    mgDelLab.appendChild(mgDelIn);
    mgDelLab.appendChild(document.createTextNode(" 合并后删除 .ts 分段（deleteSegments）"));
    mgWrap.appendChild(mgDelLab);
    box.appendChild(mgWrap);

    var hfHint = document.createElement("div");
    hfHint.className = "dim";
    box.appendChild(hfHint);

    var hLab = document.createElement("label");
    hLab.appendChild(document.createTextNode(
      "请求头 headers（UA 与来源已按当前页面填在这一栏里 —— 这栏就是最终发出去的那份，删掉一条就不带一条；本地那两个出口也用这一份）"));
    var hIn = document.createElement("input");
    hIn.type = "text"; hIn.name = "ghf_headers";
    hIn.placeholder = '{"User-Agent":"…","Referer":"…","Cookie":"…"}';
    hIn.value = ghHeadersJson(cfg.headers);      // 铺完整一份（自动两条 + ⚙ 里额外的），不让人在后台猜
    hLab.appendChild(hIn);
    box.appendChild(hLab);

    var hint = document.createElement("div");
    hint.className = "dim";
    box.appendChild(hint);

    var row = document.createElement("div");
    row.className = "ghrow";
    var go = document.createElement("button");
    go.setAttribute("data-ghact", "go");
    go.textContent = "✓ 确认发送";
    var cancel = document.createElement("button");
    cancel.setAttribute("data-ghact", "cancel");
    cancel.textContent = "取消";
    row.appendChild(go); row.appendChild(cancel);
    box.appendChild(row);

    function targets() {
      return { gh: !tGh.disabled && tGh.checked, aria: !tAria.disabled && tAria.checked,
               mg: !tMg.disabled && tMg.checked };
    }
    function anyTarget() { var t = targets(); return t.gh || t.aria || t.mg; }

    /* 换选哪条时：没动过的文件名按新那条重算默认，动过的只把后缀按新格式改回来，
       免得用户手打的「我的名字」一radio 就没了。
       每个出口都有自己的「名字规则」，提示与框里的值必须跟着「当前实际要发的出口」走：
       GitHub 的 M3U8 不带后缀、aria2 是 -o 原样落盘、MediaGo 的 name 不带后缀。 */
    function nameFor(fmt, stem) {
      var t = targets();
      if (t.gh) return ghName(sanitizeFileName(stem), fmt);
      if (t.aria) return ariaOutName(sanitizeFileName(stem), fmt);
      return sanitizeFileName(stem);
    }
    function syncForm() {
      var it = chosen(), isHls = it.fmt === "M3U8";
      var t = targets(), lcl = t.aria || t.mg;
      /* 只勾本地出口时，GitHub 那一串设置不该占地方 */
      muxLab.style.display = (t.gh && isHls) ? "" : "none";
      hfLab.style.display = t.gh ? "" : "none";
      pathLab.style.display = t.gh ? "" : "none";
      hfHint.style.display = t.gh ? "" : "none";
      ariaWrap.style.display = t.aria ? "" : "none";
      mgWrap.style.display = t.mg ? "" : "none";

      var stem = nameDirty ? ghSplitExt(nameIn.value).stem : ghDefaultStem(it, title);
      nameIn.value = nameFor(it.fmt, stem);
      nameAutoExt = t.gh && it.fmt !== "M3U8" && !ghSplitExt(stem).ext;

      var bits = [];
      if (t.gh) {
        bits.push(isHls
          ? "GitHub m3u8.yml：save_name 不带后缀（RE 按 mux_format 自己补），清单里的 params 有时效，触发后别让 runner 排太久"
          : "GitHub aria2.yml：save_name 就是最终文件名，没写后缀会自动补 .mp4");
      }
      if (t.aria) {
        bits.push(isHls
          ? "aria2：原版不解析 HLS，这条 .m3u8 多半只会下到播放列表本身（要分片得用支持 HLS 的 aria2 构建）"
          : "aria2：out 就是这个文件名（-o 原样落盘，没后缀会自动补 .mp4）");
      }
      if (t.mg) bits.push("MediaGo：name 不带后缀，后缀按链接类型由它自己补");
      if (!bits.length) bits.push("⚠ 一个出口都没勾 —— 勾上至少一个才能发");
      hint.textContent = bits.join("；");

      var dir = ghHfPath(pathIn.value);
      /* 这里现读一次 ⚙，不用开单子时那份快照：单子开着的时候人也能去上面改 hf_repo，
         提示写的落点必须和「✓ 确认发送」真正发出去的那一份一致 */
      var hfNow = ghHfCfg();
      hfHint.textContent = hfIn.checked
        ? "传到 " + (hfNow.repo
            ? "https://huggingface.co/datasets/" + hfNow.repo + "/" + (dir || "（仓库根目录）")
            : "（⚙ 里没填 hf_repo，改用仓库 Secret ARIA2_HF_REPO / M3U8_HF_REPO 兜底；Secret 也没有就只下载不上传）") +
          " —— HF 的 token 只存在那个仓库的 Secret 里，这张单子上不填、脚本也拿不到"
        : "不勾就只在 Actions 那次运行的 artifacts 里取；上传目录现在填的是「" + (dir || "（空）") + "」，改过一次就会被记住，下次开单子自动带回";
      if (lcl && !hasLcl) hint.textContent += "；⚠ 本地转发脚本没装，这两条发不出去";
      go.disabled = !anyTarget();
      go.textContent = anyTarget() ? "✓ 确认发送" : "✓ 先勾一个出口";
    }
    nameIn.addEventListener("input", function () { nameDirty = true; nameAutoExt = false; });
    Array.prototype.forEach.call(links.querySelectorAll("input[type=radio]"), function (r) {
      r.addEventListener("change", syncForm);
    });
    [tGh, tAria, tMg, hfIn, ariaMultiIn, mgDelIn].forEach(function (c) {
      c.addEventListener("change", syncForm);
    });
    pathIn.addEventListener("input", syncForm);
    go.addEventListener("click", function () {
      var it = chosen();
      var t = targets();
      if (!anyTarget()) { log("一个出口都没勾：勾上 GitHub / 本地 aria2 / MediaGo 里至少一个再确认。", "bad"); return; }
      var raw = nameIn.value;                       // 原样交下去：后缀是不是用户自己写的，那边要在面板上说明白
      if (t.gh && !ghName(sanitizeFileName(raw), it.fmt)) {
        log("文件名空着没法交给 GitHub（aria2.yml 的 -o、RE 的 --save-name 都拿它当名字），填一个或清空让它回到默认。", "bad");
        return;
      }
      var hs = String(hIn.value || "").trim();
      if (hs && !/^\{/.test(hs)) {
        log("headers 得是一行 JSON 对象（例：{\"Cookie\":\"…\"}），这栏写坏了 —— 这次按刚铺好的那份（自动的 UA 与来源）发。", "bad");
        hs = ghHeadersJson(cfg.headers);
      }
      var dir = ghHfPath(pathIn.value);
      store.set("one_gh_mux", muxIn.checked ? "1" : "0");
      store.set("one_gh_hf", hfIn.checked ? "1" : "0");
      store.set("one_gh_hf_path", dir);             // 目录只认这一个键：⚙ 里看到的默认值就是上次在这张单子上填的
      /* 本地那几栏也记住：RPC 地址/密钥/目录、MediaGo 地址/Key/子目录，都是「下次还用这一台」的东西 */
      store.set("one_aria_rpc", String(ariaRpcIn.value || "").trim() || "http://127.0.0.1:6800/jsonrpc");
      store.set("one_aria_secret", String(ariaSecretIn.value || "").trim());
      store.set("one_aria_dir", String(ariaDirIn.value || "").trim());
      store.set("one_aria_multi", ariaMultiIn.checked ? "1" : "0");
      store.set("one_aria_ow", ariaOwIn.checked ? "1" : "0");
      store.set("one_mg_base", String(mgBaseIn.value || "").trim() || "http://127.0.0.1:9900");
      store.set("one_mg_key", String(mgKeyIn.value || "").trim());
      store.set("one_mg_folder", String(mgFolderIn.value || "").trim());
      store.set("one_mg_del", mgDelIn.checked ? "1" : "0");
      store.set("one_dl_targets", DL_TARGETS.filter(function (k) { return t[k]; }).join(","));
      closeGhForm();
      sendToTargets(res, { item: it, name: raw, headers: hs, mux: muxIn.checked, autoExt: nameAutoExt,
                           hf: hfIn.checked, hfPath: dir, targets: t,
                           overwrite: ariaOwIn.checked });
      if (isOpen()) placeBody();
    });
    cancel.addEventListener("click", function () {
      closeGhForm();
      log("已取消，没有发出任何请求。", "dim");
      if (isOpen()) placeBody();
    });

    syncForm();
    panel.appendChild(box);
    ghFormEl = box;
    if (hostDiv) hostDiv.scrollTop = hostDiv.scrollHeight;
    return box;
  }

  function copyJson() {
    if (!lastResult) { log("还没有结果可复制", "bad"); return; }
    var text = JSON.stringify(lastResult, null, 1);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { log("✓ 已复制 " + text.length + " 字节 JSON", "ok"); },
        function () { log("× 剪贴板被拒绝，请从面板文本手动复制", "bad"); });
    }
  }

  function build() {
    var st = document.createElement("style");
    st.textContent = CSS;
    (document.documentElement || document).appendChild(st);

    /* 同一个页面里被注入两次（改了脚本没刷新、或旧版还挂在文档级注入里）时，让最新这份接管 UI：
       先拆掉前一份的 DOM。否则 querySelector 拿到的是旧球，点出来的是旧代码的行为，排查会绕远路。 */
    Array.prototype.forEach.call(document.querySelectorAll("#oneqz, #oneqz-fab"), function (old) {
      if (old.parentNode) old.parentNode.removeChild(old);
    });

    hostDiv = document.createElement("div");
    hostDiv.id = "oneqz";
    hostDiv.innerHTML =
      '<div class="btns">' +
        '<button data-act="run" title="用选定身份重取同一 id 的详情">用模块 token 重取</button>' +
        '<button data-act="cap" title="显示拦截到的 App 请求与响应">看拦截</button>' +
        '<button data-act="diag" title="检查钩子装在哪个世界、为何拦不到">诊断</button>' +
        '<button data-act="copy" title="复制上一次解密出的 JSON">复制 JSON</button>' +
        '<button data-act="dl" title="把刚拿到的链接先填一张单子，再发出去：可勾 GitHub Actions（MP4→aria2.yml，M3U8→m3u8.yml）、本地 aria2、MediaGo，勾几个发几个">⬇</button>' +
        '<button data-act="cfg" title="切换配置">⚙</button>' +
        '<button data-act="close" title="收起（也可以再点一次悬浮球）">收起 ✕</button>' +
      '</div>' +
      '<div class="status"></div>' +
      '<div class="cfg">' +
        '<label class="auto"><input type="checkbox" name="auto"> 自动替换页面的 token（默认关）' +
          '<span class="dim">开：App 自己发出的那些请求（详情/评论/点赞…）在离开浏览器前就换成 one 模块这一档的身份，' +
          'token/uuid/user-key/sign/ip 五个头一起重算，页面本身看到的就是替换后的结果，不用再点按钮。' +
          '关：页面的请求原样发，只有你点「用模块 token 重取」时才换。这个开关会被记住，下次进页面自动读回。' +
          '付费/扣币类接口永远不替换。</span></label>' +
        '<label>身份模式' +
          '<select name="mode"><option value="module">one 模块（uid 4406487，user-key 留空）</option>' +
          '<option value="page">网页当前登录态</option>' +
          '<option value="app">网页 App 刚发出的那次原样（拦截到的头）</option></select></label>' +
        '<label>模块 token（会覆盖内置值，换 exp 后粘新的）<input name="token" placeholder="eyJ0eXAiOiJKV1Qi…"></label>' +
        '<label>指定 api 域（留空=自动，优先用拦截到的域，再退 localStorage.current_domain 与种子池）<input name="host" placeholder="https://api.61c76a0.com"></label>' +
        '<label>播放域名（留空=自动：先取页面自己正在播的那次请求的域，再退媒体池种子。它和请求体里的 ts 域名 dn 不是一回事）<input name="play" placeholder="https://z4bey8.bx7qxb.com"></label>' +
        '<div class="dim" style="margin-top:8px">GitHub 下载（⬇ 那个按钮先在面板里铺一张单子：选哪条链接、发到哪、文件名、请求头、要不要传 HF，确认后才发。GitHub 这条：MP4→aria2.yml，M3U8→m3u8.yml。下面这几项是那张单子的默认值）</div>' +
        '<label>仓库 owner/repo<input name="gh_repo" placeholder="owner/gh-toolbox"></label>' +
        '<label>分支 ref<input name="gh_ref" placeholder="main"></label>' +
        '<label>下载格式（单子里默认选中哪一条）<select name="gh_fmt">' +
          '<option value="auto">自动：有 MP4 用 MP4（aria2），没有才用 M3U8（m3u8）</option>' +
          '<option value="mp4">仅 MP4 → aria2.yml</option>' +
          '<option value="hls">仅 M3U8 → m3u8.yml</option></select></label>' +
        '<label>GitHub Token<input name="gh_token" type="password" placeholder="github_pat_… 或 ghp_…（需要 Actions: write）"></label>' +
        '<label>额外请求头 headers（这里只放额外要带的；开单子时会连 UA 与来源一起铺进单子的 headers 栏，' +
        '那一栏里写的就是最终发出去的那份）<input name="gh_headers" placeholder=\'{"Cookie":"…"}\'></label>' +
        '<div class="dim" data-hdrprev></div>' +
        '<div class="dim" style="margin-top:8px">Hugging Face 上传（单子里勾「☁ 传到 HF」才会传，下面这几栏是那张单子的默认值；' +
        '产物按 dataset 仓库上传，没配仓库 ID 时走 Secret ARIA2_HF_REPO / M3U8_HF_REPO 兜底）</div>' +
        '<label>HF 数据集仓库 ID（如 myuser/my-videos，也可直接粘 huggingface.co 的链接；留空=用 Secret 兜底）<input name="gh_hf_repo" placeholder="myuser/my-videos"></label>' +
        '<label>上传目录（hf_path，数据集仓库内的子目录，如 one/videos；留空=仓库根路径。单子里可以改，改过就记住，下次开单子自动带回）<input name="gh_hf_path" placeholder="one/videos"></label>' +
        '<label class="auto"><input type="checkbox" name="gh_hf_on"> 默认勾上「☁ 传到 HF」<span class="dim">这里只管单子里那个勾的初始状态，真正传不传每次仍以单子为准；' +
        '上传本身由 workflow 完成，HF 的 token 只放在仓库 Secret（ARIA2_HF_TOKEN / M3U8_HF_TOKEN）里，本脚本不经手、也不往页面上写。</span></label>' +
        '<div class="dim">Token 只用来触发 workflow 和查自己那次的运行状态。本脚本是 @grant none，' +
        '它和这里填的东西都存在 j7tu.com 这个站点的 localStorage 里（不是 Tampermonkey 的存储），' +
        '所以请只用一个「只授权这一个仓库、只给 Actions: write」的 fine-grained token，别拿账号级 PAT。</div>' +
        '<div class="dim" style="margin-top:8px">本地出口：aria2 / MediaGo（同样在单子里勾，下面这几栏是默认值，单子上改了也记住同一个键）。' +
        '这两条要打 127.0.0.1 或局域网地址，而本脚本是 @grant none（拦 App 请求靠的就是它），页面里的 fetch 打不通常见被 CORS / ' +
        '私有网络策略挡住 —— 所以请求交给伴生脚本 one-local-dispatch.user.js 代发。没装它的时候这两个勾是灰的，面板会写明原因。</div>' +
        '<label>aria2 RPC 地址<input name="aria_rpc" placeholder="http://127.0.0.1:6800/jsonrpc"></label>' +
        '<label>aria2 RPC 密钥（--rpc-secret，留空=无）<input name="aria_secret" type="password" placeholder="留空 = 无密钥"></label>' +
        '<label>aria2 下载目录 dir（aria2 那台机器上的绝对路径，留空=它自己的默认目录）<input name="aria_dir" placeholder="D:\\Downloads"></label>' +
        '<label>aria2 代理 all-proxy（留空=直连）<input name="aria_proxy" placeholder="http://127.0.0.1:7890"></label>' +
        '<label class="auto"><input type="checkbox" name="aria_multi"> aria2 默认多连接（-x 16 -s 16）</label>' +
        '<label>MediaGo 地址<input name="mg_base" placeholder="http://127.0.0.1:9900"></label>' +
        '<label>MediaGo API Key（Docker 认证时填，留空=无认证）<input name="mg_key" type="password" placeholder="留空 = 无认证"></label>' +
        '<label>MediaGo 保存子目录 folder（留空=它配置里的默认目录）<input name="mg_folder" placeholder="videos"></label>' +
        '<label class="auto"><input type="checkbox" name="mg_del"> MediaGo 默认合并后删除 .ts 分段（deleteSegments）</label>' +
        '<div style="display:flex;gap:6px;margin-top:6px">' +
          '<button type="button" data-lcltest="aria">测试 aria2 连接</button>' +
          '<button type="button" data-lcltest="mg">测试 MediaGo 连接</button></div>' +
        '<div class="dim" data-lclstate></div>' +
        '<div class="dim" style="margin-top:6px">detail 只是读：本脚本不调用 purchase/buy，不扣币，不取流；' +
        '下载由你主动触发 —— GitHub 那条跑在你自己的仓库上，本地两条跑在你自己的 aria2 / MediaGo 上。</div>' +
      '</div>' +
      '<div class="panel"></div>';
    (document.body || document.documentElement).appendChild(hostDiv);
    panel = $(".panel", hostDiv);
    bindLinkSelectGuard(panel);
    cfgBox = $(".cfg", hostDiv);
    statusEl = $(".status", hostDiv);

    /* 悬浮球：默认页面上只有它。点=开关，按住拖=移位，位置存 GM/localStorage。 */
    fab = document.createElement("div");
    fab.id = "oneqz-fab";
    fab.setAttribute("class", "st-warn");
    fab.innerHTML = '<span class="num">·</span><span class="dot"></span>';
    (document.body || document.documentElement).appendChild(fab);
    fabNum = $(".num", fab);
    fabDot = $(".dot", fab);
    loadPos();
    placeFab();
    bindFabDrag();

    /* 窗口/可视区一变就把球夹回来，展开体跟着重定位 */
    window.addEventListener("resize", onVpChange);
    window.addEventListener("orientationchange", onVpChange);
    /* 手机浏览器收放地址栏、弹软键盘时常常只发 visualViewport 的 resize，
       少了这条，球会留在已经被顶出屏幕的位置上。 */
    try {
      if (window.visualViewport) window.visualViewport.addEventListener("resize", onVpChange);
    } catch (e) {}
    window.addEventListener("scroll", function () { if (isOpen()) placeBody(); }, true);
    try {
      if (window.ResizeObserver) {
        new ResizeObserver(onVpChange).observe(document.documentElement);
        /* 展开体自己是 max-height 内部滚动，但内容变化（比如复制出大 JSON）也会改高度，
           高度一变就可能顶出下边界，所以观察它自己的尺寸再重贴。 */
        new ResizeObserver(function () { placeBody(); }).observe(hostDiv);
      }
    } catch (e) {}

    cfgBox.querySelector("select[name=mode]").value = store.get("one_mode", "module");
    cfgBox.querySelector("input[name=token]").value = store.get("one_token", "");
    cfgBox.querySelector("input[name=host]").value = store.get("one_host", "");
    cfgBox.querySelector("input[name=play]").value = store.get("one_play_host", "");
    cfgBox.querySelector("input[name=auto]").checked = autoOn();
    cfgBox.querySelector("input[name=gh_repo]").value = store.get("one_gh_repo", GH_REPO);
    cfgBox.querySelector("input[name=gh_ref]").value = store.get("one_gh_ref", GH_REF);
    cfgBox.querySelector("select[name=gh_fmt]").value = ghCfg().fmt;
    cfgBox.querySelector("input[name=gh_token]").value = store.get("one_gh_token", "");
    cfgBox.querySelector("input[name=gh_headers]").value = store.get("one_gh_headers", "");
    cfgBox.querySelector("input[name=gh_hf_repo]").value = store.get("one_gh_hf_repo", "");
    cfgBox.querySelector("input[name=gh_hf_path]").value = store.get("one_gh_hf_path", "");
    cfgBox.querySelector("input[name=gh_hf_on]").checked = ghHfCfg().on;
    cfgBox.querySelector("input[name=aria_rpc]").value = ariaCfg().rpc;
    cfgBox.querySelector("input[name=aria_secret]").value = ariaCfg().secret;
    cfgBox.querySelector("input[name=aria_dir]").value = ariaCfg().dir;
    cfgBox.querySelector("input[name=aria_proxy]").value = ariaCfg().proxy;
    cfgBox.querySelector("input[name=aria_multi]").checked = ariaCfg().multi;
    cfgBox.querySelector("input[name=mg_base]").value = mgCfg().base;
    cfgBox.querySelector("input[name=mg_key]").value = mgCfg().key;
    cfgBox.querySelector("input[name=mg_folder]").value = mgCfg().folder;
    cfgBox.querySelector("input[name=mg_del]").checked = mgCfg().del;

    /* 测试连接：链路是两段（伴生脚本在不在 → 本地服务通不通），分开报，一眼能看出卡在哪段。
       这里用面板里「当前填的值」，不读 store —— 刚改完还没触发 change 时也该按新值测。 */
    Array.prototype.forEach.call(cfgBox.querySelectorAll("[data-lcltest]"), function (btn) {
      btn.addEventListener("click", function () {
        var which = btn.getAttribute("data-lcltest");
        var val = function (n) { var e2 = cfgBox.querySelector("input[name=" + n + "]"); return e2 ? String(e2.value || "").trim() : ""; };
        if (!lclVersion()) {
          log("× 测试失败：没检测到本地转发脚本 —— 先装 tools/one/one-local-dispatch.user.js 再刷新本页。" +
              "本脚本是 @grant none，自己发不了 127.0.0.1 的请求。", "bad");
          return;
        }
        if (which === "aria") {
          var rpc = val("aria_rpc") || "http://127.0.0.1:6800/jsonrpc";
          log("aria2 测试   RPC " + rpc + " …", "dim");
          lclCall("aria2.call", { rpc: rpc, secret: val("aria_secret"), method: "aria2.getVersion", params: [] })
            .then(function (v) {
              v = v || {};
              var feats = Array.isArray(v.enabledFeatures) ? v.enabledFeatures : [];
              var hls = feats.some(function (f) { return /HLS/i.test(f); });
              log("✓ aria2 连上了：" + (v.product || "aria2") + " " + v.version +
                  (hls ? "（支持 HLS）" : "（不支持 HLS —— .m3u8 只会下到播放列表本身）"), hls ? "ok" : "dim");
            }, function (e) {
              log("× aria2 测试失败：" + String(e && e.message || e) +
                  " —— 确认 aria2c 带 --enable-rpc 启动，地址/端口/密钥对得上（局域网还要带 --rpc-allow-origin-all 或允许内网访问）", "bad");
            });
        } else {
          var base = val("mg_base") || "http://127.0.0.1:9900";
          log("MediaGo 测试  " + base + " …", "dim");
          lclCall("mediago.call", { base: base, key: val("mg_key"), method: "GET",
                                   path: "/api/downloads?current=1&pageSize=1" })
            .then(function (d) {
              var total = d && typeof d.total === "number" ? d.total : null;
              log("✓ MediaGo 连上了：" + base + (total === null ? "" : "（当前 " + total + " 个任务）"), "ok");
            }, function (e) {
              log("× MediaGo 测试失败：" + String(e && e.message || e) +
                  " —— 确认 MediaGo 已启动、地址/端口对（桌面端 39719，Docker 常 9900），Docker 开了认证时要填 API Key", "bad");
            });
        }
      });
    });
    /* 本地转发脚本在不在，是「这两个勾亮不亮」的唯一依据：写在这里省得每次开单子才发现没装 */
    function syncLclState() {
      var pv = cfgBox.querySelector("[data-lclstate]");
      if (!pv) return;
      var v = lclVersion();
      pv.textContent = v
        ? "本地转发脚本在线（v" + v + "）：⬇ 单子里的 aria2 / MediaGo 两个勾可用"
        : "⚠ 没检测到本地转发脚本：⬇ 单子里 aria2 / MediaGo 两个勾是灰的。装 tools/one/one-local-dispatch.user.js（带 GM_xmlhttpRequest）" +
          "后刷新本页即可 —— 本脚本是 @grant none，自己打不通 127.0.0.1";
      pv.className = v ? "dim" : "bad";
    }
    syncLclState();
    /* 伴生脚本也可能比本脚本晚一点就绪（两个都是 document-start，谁先谁后不定）：
       盯一下就绪属性，它一出现就把 ⚙ 里那句话和 ⬇ 单子的可勾状态跟上。 */
    try {
      if (typeof MutationObserver === "function") {
        new MutationObserver(syncLclState).observe(document.documentElement,
          { attributes: true, attributeFilter: [LCL_READY] });
      }
    } catch (e) {}
    /* ⚙ 里当场写出「单子的 headers 栏会铺成哪一份」：UA 与来源是每次开单子按当前页面算的，
       所以这里只是给你看一眼最终那串长什么样，存的仍然只有你额外要带的那几条。 */
    function syncHdrPrev() {
      var pv = cfgBox.querySelector("[data-hdrprev]");
      if (!pv) return;
      var extra = cfgBox.querySelector("input[name=gh_headers]");
      pv.textContent = "单子里那一栏会铺成：" + (ghHeadersJson(extra ? extra.value : "") || "（空）");
    }
    syncHdrPrev();
    armReplace();                      // 读回上次的开关：开就把 DOM 桥挂上，关就摘掉
    Array.prototype.forEach.call(cfgBox.querySelectorAll("select,input"), function (el) {
      el.addEventListener("change", function () {
        var k = el.name;
        if (k === "mode") store.set("one_mode", el.value);
        if (k === "host") store.set("one_host", el.value.trim());
        if (k === "play") { store.set("one_play_host", trimSlash(el.value.trim()));
                            log("播放域名已存为 " + (trimSlash(el.value.trim()) || "（留空=自动）") + "，下次取数/查看用它拼链接", "dim"); }
        if (k === "token") store.set("one_token", el.value.trim() || MODULE_TOKEN);
        if (k === "auto") {
          store.set("one_auto", el.checked ? "1" : "0");
          var s = armReplace();
          log(s ? "自动替换已开：" + s.label + " —— 页面自己发出的详情等请求会被换成这个身份（设置已记住，下次进页面读回）"
                : "自动替换已关：页面的请求原样发出去，只有点「用模块 token 重取」时才换身份", s ? "ok" : "dim");
          updateChip("auto");
        }
        if (k === "gh_repo") {
          var rp = ghRepoPath(el.value);
          if (rp) { store.set("one_gh_repo", rp); el.value = rp; log("下载仓库已存为 " + rp, "dim"); }
          else { store.set("one_gh_repo", GH_REPO); el.value = GH_REPO; log("仓库得写成 owner/repo，已退回默认 " + GH_REPO, "bad"); }
        }
        if (k === "gh_ref") store.set("one_gh_ref", trimSlash(el.value.trim()) || GH_REF);
        if (k === "gh_fmt") store.set("one_gh_fmt", el.value);
        if (k === "gh_token") {
          store.set("one_gh_token", el.value.trim());
          log(el.value.trim() ? "GitHub Token 已保存（只存在本机；@grant none 下就是 j7tu.com 的 localStorage）"
                              : "GitHub Token 已清空，⬇ 按钮会提示未配置", "dim");
        }
        if (k === "gh_headers") {
          var hv = el.value.trim();
          if (!hv || !/^\{/.test(hv) || safeJson(hv)) {
            store.set("one_gh_headers", hv);
            log("额外请求头已存为 " + (hv || "（空）") + " —— 开单子时它会排在自动补的 UA 与来源后面，那一栏就是最终发出去的那份", "dim");
            syncHdrPrev();
          }
          else { el.value = store.get("one_gh_headers", ""); log("headers 得是一行合法 JSON，已退回上一个值", "bad"); syncHdrPrev(); }
        }
        if (k === "gh_hf_repo") {
          var hr = ghHfRepo(el.value);
          if (!hr && String(el.value).trim()) {
            el.value = store.get("one_gh_hf_repo", "");
            log("HF 仓库 ID 得写成 owner/name（或直接粘数据集链接），已退回上一个值", "bad");
          } else {
            store.set("one_gh_hf_repo", hr); el.value = hr;
            log(hr ? "HF 目标数据集已存为 " + hr + "（单子里勾了才传）"
                   : "HF 仓库 ID 清空：勾了「传到 HF」时改用 Secret ARIA2_HF_REPO / M3U8_HF_REPO 兜底", "dim");
          }
        }
        if (k === "gh_hf_path") {
          var hpd = ghHfPath(el.value);
          store.set("one_gh_hf_path", hpd); el.value = hpd;
          log("HF 上传目录已存为 " + (hpd || "（仓库根路径）") + "，单子里改的话以单子为准（同一个键）", "dim");
        }
        if (k === "gh_hf_on") {
          store.set("one_gh_hf", el.checked ? "1" : "0");
          log(el.checked ? "单子里的「☁ 传到 HF」默认勾上" : "单子里的「☁ 传到 HF」默认不勾", "dim");
        }
        if (k === "aria_rpc") {
          var rpc = String(el.value || "").trim();
          if (rpc && !/^https?:\/\//i.test(rpc)) {
            el.value = store.get("one_aria_rpc", ariaCfg().rpc);
            log("aria2 RPC 地址得是 http:// 或 https:// 开头，已退回上一个值", "bad");
          } else {
            var rpcv = rpc || "http://127.0.0.1:6800/jsonrpc";
            store.set("one_aria_rpc", rpcv); el.value = rpcv;
            log("aria2 RPC 已存为 " + rpcv, "dim");
          }
        }
        if (k === "aria_secret") { store.set("one_aria_secret", el.value.trim()); log("aria2 RPC 密钥已保存" + (el.value.trim() ? "" : "（空 = 无密钥）"), "dim"); }
        if (k === "aria_dir") { store.set("one_aria_dir", el.value.trim()); log("aria2 下载目录已存为 " + (el.value.trim() || "（留空 = aria2 自己的默认目录）"), "dim"); }
        if (k === "aria_proxy") { store.set("one_aria_proxy", el.value.trim()); log("aria2 代理已存为 " + (el.value.trim() || "（留空 = 直连）"), "dim"); }
        if (k === "aria_multi") { store.set("one_aria_multi", el.checked ? "1" : "0"); log(el.checked ? "aria2 默认多连接（-x 16 -s 16）" : "aria2 默认单连接", "dim"); }
        if (k === "mg_base") {
          var mb2 = String(el.value || "").trim();
          if (mb2 && !/^https?:\/\//i.test(mb2)) {
            el.value = store.get("one_mg_base", mgCfg().base);
            log("MediaGo 地址得是 http:// 或 https:// 开头，已退回上一个值", "bad");
          } else {
            var mbv = mb2 || "http://127.0.0.1:9900";
            store.set("one_mg_base", mbv); el.value = mbv;
            log("MediaGo 地址已存为 " + mbv, "dim");
          }
        }
        if (k === "mg_key") { store.set("one_mg_key", el.value.trim()); log("MediaGo API Key 已保存" + (el.value.trim() ? "" : "（空 = 无认证）"), "dim"); }
        if (k === "mg_folder") { store.set("one_mg_folder", el.value.trim()); log("MediaGo 子目录已存为 " + (el.value.trim() || "（留空 = 它自己的默认目录）"), "dim"); }
        if (k === "mg_del") { store.set("one_mg_del", el.checked ? "1" : "0"); log(el.checked ? "MediaGo 合并后删除 .ts 分段" : "MediaGo 保留 .ts 分段", "dim"); }
        if (k === "mode" || k === "token") armReplace();     // 身份来源变了，DOM 桥要跟着刷新
        if (k !== "mode") return;
        reset();
        openBody();
        var u = identity(el.value) || identity("module");
        log("已切到 " + u.label + "   user-key=\"" + u.userKey + "\"  uuid=" + u.uuid, "dim");
      });
    });

    hostDiv.addEventListener("click", function (ev) {
      var act = ev.target && ev.target.getAttribute("data-act");
      if (!act) return;
      if (act === "run") run();
      else if (act === "cap") showAppCapture();
      else if (act === "diag") diagnose();
      else if (act === "copy") copyJson();
      else if (act === "dl") { var ds = detailSource(); if (!ds) reset(); openBody(); openGhForm(ds); }
      else if (act === "close") closeBody();
      else { cfgBox.classList.toggle("on"); syncLclState(); placeBody(); }
      if (isOpen()) placeBody();
    });
    /* 展开体上的滚动/触摸不要漏给下层页面，否则在 Flutter 画布上滑动会变成页面自己在动 */
    ["pointerdown", "wheel", "touchstart"].forEach(function (t) {
      hostDiv.addEventListener(t, function (ev) { ev.stopPropagation(); }, { passive: true });
    });

    updateChip("init");
  }

  /* 从链接上按住拖动是为了选字复制，浏览器却会在抬手时补一个 click 把新标签页打开。
     记住「这次按下有没有真的拖动」，拖过就把紧随其后的那次链接点击吃掉——单纯单击照常跳转。 */
  function bindLinkSelectGuard(root) {
    var down = null, dragged = false;
    root.addEventListener("pointerdown", function (ev) { down = { x: ev.clientX, y: ev.clientY }; dragged = false; });
    root.addEventListener("pointermove", function (ev) {
      if (!down) return;
      if (Math.abs(ev.clientX - down.x) + Math.abs(ev.clientY - down.y) > 4) dragged = true;
    });
    root.addEventListener("pointerup", function () { down = null; });
    root.addEventListener("pointercancel", function () { down = null; dragged = false; });
    root.addEventListener("click", function (ev) {
      if (!dragged) return;
      dragged = false;
      var a = ev.target && ev.target.closest ? ev.target.closest("a") : null;
      if (!a) return;
      ev.preventDefault();
      ev.stopPropagation();
    }, true);
  }

  /* 拖动用 Pointer Events：鼠标/触屏/画笔一套代码。
     setPointerCapture 是关键——球只有 44px，不抓住指针的话拖到一半就收不到后续 move。
     位移超过阈值才算拖，抬手时不再触发开关，免得拖完顺手把面板弹开。 */
  function bindFabDrag() {
    var drag = null;
    fab.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
    fab.addEventListener("pointerdown", function (ev) {
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, ox: POS.left, oy: POS.top, moved: false };
      try { fab.setPointerCapture(ev.pointerId); } catch (e) {}
      fab.setAttribute("data-drag", "1");
      ev.stopPropagation();
      ev.preventDefault();
    });
    fab.addEventListener("pointermove", function (ev) {
      if (!drag || ev.pointerId !== drag.id) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) <= 5) return;
      drag.moved = true;
      POS.left = drag.ox + dx;
      POS.top = drag.oy + dy;
      placeFab();                 // 边拖边夹，拖出窗口边缘也会立刻回到可见区
      if (isOpen()) placeBody();
    });
    fab.addEventListener("pointerup", function (ev) {
      if (!drag) return;
      var moved = drag.moved;
      try { fab.releasePointerCapture(ev.pointerId); } catch (e) {}
      fab.removeAttribute("data-drag");
      drag = null;
      if (moved) { savePos(); ev.stopPropagation(); return; }
      toggleBody();               // 轻点：展开 / 收起
      ev.stopPropagation();
    });
    fab.addEventListener("pointercancel", function () {
      if (drag && drag.moved) savePos();
      drag = null;
      if (fab) fab.removeAttribute("data-drag");
    });
  }

  /* Flutter web 是用 history.pushState 改「hash」的，hashchange 根本不触发：
     只监听 hashchange 的话，App 里换页既不会清掉上一页的拦截结果，也不会自动收起，
     状态行还会一直挂着按旧路由算出来的那句提示。 */
  var lastRoute = "";
  function watchRoute() {
    lastRoute = location.hash || "";
    window.addEventListener("hashchange", onRoute);
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== "function") return;
      history[m] = function () {
        var r = orig.apply(history, arguments);
        try { window.dispatchEvent(new Event("oneqz-nav")); } catch (e) {}
        return r;
      };
    });
    window.addEventListener("oneqz-nav", onRoute);
  }
  function onRoute() {
    var now = location.hash || "";
    if (now === lastRoute) return;         // pushState 经常带着同一个 hash 反复调，别每次都当换页
    lastRoute = now;
    updateChip("route");                   // 状态行先跟上真实路由
    if (CAP.route === now) return;         // 还停在拦到那次请求的页面上，结果仍然是本页的，不清
    clearCapture("route");
    if (panel) reset();
    viewShown = false;
    closeBody();                           // 换页就收回图标，别把上一页的结论留在新页面上
  }

  function start() {
    build();
    watchRoute();
    onCapture(function (kind) {
      if (!isOpen() && (kind === "id" || kind === "resp")) { unread++; viewShown = false; }
      updateChip(kind);
      if (kind === "hook") log("钩子就绪：" + hookTag() + "  世界=" + WORLD + (HOOK.error ? "（" + HOOK.error + "）" : ""),
                                hookOk() ? "ok" : "bad");
      else if (kind === "id") log("拦到 id=" + CAP.id + "（来自 App 自己发的 " + (CAP.idFrom || "?") + "，路由 " + (CAP.route || "?") + "）", "ok");
      /* 拦到响应不再自动展开：默认收起是用户要的形态，改成球上点亮角标，点开才看 */
      else if (kind === "resp") { log("拦截到该请求的响应，已用同一把密钥解密", "ok"); if (isOpen()) showAppCapture(); }
      else if (kind === "body-noid") log("拦到 " + epOf(CAP.urlFull) + "，请求体能解密但体内没有 id", "dim");
      else if (kind === "body-bad") log("拦到 " + epOf(CAP.urlFull) + "，请求体解密失败（不是这套 AES 的密文）", "dim");
    });
    updateChip("start");
    console.log("[oneQZ] 钩子安装中：等待 App 发出 POST " + DETAIL);
  }

  if (!crypto || !crypto.subtle) {
    // 非安全上下文（http://）时 WebCrypto 不存在，给出可见提示而不是静默失败
    var warn = document.createElement("div");
    warn.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;background:#400;color:#fff;padding:6px;border-radius:6px;font:13px monospace";
    warn.textContent = "oneQZ: 当前上下文没有 WebCrypto（需要 https），脚本无法加解密";
    document.documentElement.appendChild(warn);
    return;
  }
  installHooks();
  armReplace();      // 面板还没建也先把 DOM 桥挂上：App 的第一次详情可能早于 DOMContentLoaded
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();



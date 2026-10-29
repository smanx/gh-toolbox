// ==UserScript==
// @name         j7tu 跳过开屏广告并屏蔽弹窗广告
// @namespace    https://j7tu.com/
// @version      2.1.0
// @description  跳过 j7tu.com 开屏页（清空开屏广告配置，开屏页直接消失）；并从数据源头清空弹窗广告（首页图片/文字弹窗及各频道 popup 弹窗），弹不掉的兜底自动点击关闭按钮
// @match        https://j7tu.com/*
// @match        https://www.j7tu.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

/*
 * 原理：
 *
 * 一、跳过开屏页（2.1 改进 + 1.x 的坐标点击兜底）
 *   本站是 Flutter Web 应用，开屏页（#/splash）读的是 localStorage 里的
 *   开屏广告配置（flutter.ad_helper_splash_ad，pattern=full，is_multiple=2）。
 *   实测发现：即使没有广告数据，开屏页也会傻等 5 秒倒计时才进入首页——
 *   而且没有广告图时右上角根本没有「跳过」按钮，坐标点击无从下手。
 *   所以脚本在 document-start 直接把开屏广告键也清空：没有广告数据，
 *   开屏页整个不再出现，启动后 ~2 秒直接进首页（实测路由时间线：
 *   0ms 空 hash → 2.2s 已在 #/app）。原坐标点击逻辑保留作兜底：
 *   若开屏页仍然出现（画着全屏广告图 + 右上角倒计时按钮），脚本按固定
 *   坐标（视口右上角）向 Flutter 的 flt-glass-pane 派发指针事件点它。
 *
 * 二、屏蔽进入首页后的弹窗广告（2.0 新增）
 *   实测该站的广告配置整体缓存在 localStorage（GetStorage，键名以 flutter.ad_helper_ 开头）：
 *     - flutter.ad_helper_popup_ad_image  首页-图片弹窗（pattern=popup_image，is_multiple=1，
 *                                         所以有时弹一个、有时弹两个）
 *     - flutter.ad_helper_popup_ad_text   首页-文字弹窗（公告）
 *     - flutter.ad_helper_*_image_ad      漫画/电台/写真/点播等频道的 popup_image 弹窗
 *   弹窗数据来源（均实测验证）：
 *     1) 启动时请求 /v2.5/ad/space 拿新配置，成功则用新数据弹窗；
 *     2) 该请求失败则回退读取上面的 localStorage 缓存来弹窗。
 *   因此脚本在 document-start（先于 Flutter 启动）做三件事：
 *     A. 把所有 pattern=popup_image / popup_text（弹窗）与 full（开屏）的广告键的 ads 数组清空
 *        （只动广告键，不碰横幅等其它配置），并记住原弹窗图片的 URL；
 *     B. 拦截 /v2.5/ad/space 请求并模拟网络失败，让新广告数据进不来，
 *        应用只能走回退路径——而缓存已被清空，于是无弹窗可弹；
 *     C. 兜底：若 A/B 失效弹窗仍然出现，它的图片请求（URL 在步骤 A 已记录）
 *        会被拦下，图片加载失败时弹窗只剩一个关闭按钮，位置固定在
 *        「屏幕中心 x、中心 y+20px」（实测值），脚本自动点击把它关掉。
 *
 *   脚本只在「启动页路由」上点跳过按钮、只在「首页路由」上做兜底关闭，
 *   不会影响你在站内的正常浏览。
 */

(function () {
  'use strict';

  // ---- 可调参数（开屏跳过） ------------------------------------------------
  // 跳过按钮中心点相对「视口右上角」的偏移（CSS px）。
  var SKIP_X_FROM_RIGHT = 31;
  var SKIP_Y = 16;

  var FIRST_TRY_DELAY = 800;    // Flutter 引擎启动前点了也没用，先等一会儿
  var RETRY_INTERVAL = 400;     // 重试间隔
  var TAP_COOLDOWN = 500;       // 点一次后等页面跳转，避免连点
  var GIVE_UP_AFTER = 20000;    // 20 秒还没跳过就放弃（例如站点改版 / 加载太慢）

  // ---- 可调参数（弹窗兜底关闭） --------------------------------------------
  var CLOSE_Y_FROM_CENTER = 20; // 图片加载失败时，关闭按钮在屏幕中心下方约 20px（实测）
  var POPUP_TAP_DELAY = 1000;   // 弹窗图片请求被拦后，等弹窗渲染出来再点关闭
  var POPUP_TAP_GAP = 700;      // 两次兜底点击之间的最小间隔
  var POPUP_MAX_TAPS = 8;       // 兜底点击次数上限，防止异常时乱点
  var POPUP_WINDOW = 30000;     // 首次发现弹窗图片请求后 30s 内兜底有效
  // --------------------------------------------------------------------------

  // ======================================================================
  // 一、广告配置清理（必须最先执行：抢在 Flutter 读取 localStorage 之前）
  // ======================================================================

  // 记录弹窗广告的图片路径，用于兜底识别
  var popupImagePaths = [];

  function collectPopupImageUrls(obj) {
    try {
      (obj && obj.ads || []).forEach(function (ad) {
        var p = (ad && ad.parameters) || {};
        var img = p.popup_image && p.popup_image.image;
        if (typeof img === 'string' && img) popupImagePaths.push(img);
      });
    } catch (e) { /* 忽略解析失败 */ }
  }

  // 把 pattern=popup_image / popup_text（弹窗）与 full（开屏）的广告键的 ads 清空
  function emptyPopupAdKeys() {
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('flutter.ad_helper_') === 0) keys.push(k);
      }
      keys.forEach(function (k) {
        try {
          var raw = localStorage.getItem(k);
          if (!raw) return;
          // GetStorage 的值是「JSON 字符串里再套一层 JSON」，两种形态都兼容
          var obj = raw;
          try { obj = JSON.parse(raw); } catch (e) { return; }
          if (typeof obj === 'string') {
            try { obj = JSON.parse(obj); } catch (e) { return; }
          }
          if (!obj || typeof obj !== 'object') return;
          if (obj.pattern !== 'popup_image' && obj.pattern !== 'popup_text' && obj.pattern !== 'full') return;

          // 开屏广告（pattern=full）不参与弹窗兜底，只清空
          if (obj.pattern === 'popup_image') collectPopupImageUrls(obj);

          obj.ads = [];
          if (obj.parameters) obj.parameters.is_multiple = '0';
          localStorage.setItem(k, JSON.stringify(JSON.stringify(obj)));
        } catch (e) { /* 单个键失败不影响其它 */ }
      });
    } catch (e) { /* localStorage 不可用时跳过 */ }
  }

  emptyPopupAdKeys();

  // 命中类型：1 = 广告配置接口，2 = 弹窗图片（需要兜底关闭）
  function blockTypeOf(url) {
    if (!url) return 0;
    url = String(url);
    if (url.indexOf('/v2.5/ad/space') !== -1) return 1;
    for (var i = 0; i < popupImagePaths.length; i++) {
      if (url.indexOf(popupImagePaths[i]) !== -1) return 2;
    }
    return 0;
  }

  function isAppRoute() {
    return location.hash.indexOf('#/app') === 0;
  }

  // ---- 兜底：自动点击弹窗关闭按钮 ----
  var tapQueue = [];
  var lastScheduledTapAt = 0;
  var firstTriggerAt = 0;
  var tapCount = 0;

  function schedulePopupCloseTap() {
    if (!isAppRoute()) return;                 // 只在首页兜底
    var now = Date.now();
    if (firstTriggerAt === 0) firstTriggerAt = now;
    if (now - firstTriggerAt > POPUP_WINDOW) return;
    if (tapCount >= POPUP_MAX_TAPS) return;
    var due = Math.max(now + POPUP_TAP_DELAY, lastScheduledTapAt + POPUP_TAP_GAP);
    tapQueue.push(due);
    lastScheduledTapAt = due;
  }

  function pumpPopupCloseTaps() {
    if (!isAppRoute()) { tapQueue.length = 0; return; }
    var now = Date.now();
    while (tapQueue.length && tapQueue[0] <= now) {
      tapQueue.shift();
      if (tapCount >= POPUP_MAX_TAPS) return;
      tapCount++;
      tapPopupCloseButton();
    }
  }

  // ---- 派发指针事件（画在 canvas 上的按钮没有 DOM 节点，只能按坐标点） ----
  function firePointer(pane, x, y) {
    var base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      width: 1,
      height: 1
    };

    function dispatch(type, extra) {
      var Ctor;
      if (type.indexOf('pointer') === 0) {
        Ctor = window.PointerEvent || window.MouseEvent;
      } else {
        Ctor = window.MouseEvent;
      }
      var init = {};
      for (var k in base) {
        if (Object.prototype.hasOwnProperty.call(base, k)) init[k] = base[k];
      }
      for (var j in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, j)) init[j] = extra[j];
      }
      pane.dispatchEvent(new Ctor(type, init));
    }

    // Flutter 需要完整的 down → up → click 序列才会判定为一次点击
    dispatch('pointerdown', { button: 0, buttons: 1 });
    dispatch('mousedown', { button: 0, buttons: 1 });
    dispatch('pointerup', { button: 0, buttons: 0 });
    dispatch('mouseup', { button: 0, buttons: 0 });
    dispatch('click', { button: 0, buttons: 0 });
  }

  function tapPopupCloseButton() {
    var pane = document.querySelector('flt-glass-pane');
    if (!pane) return;
    // 图片请求被拦下后弹窗里没有图片，关闭按钮固定在屏幕中心下方 CLOSE_Y_FROM_CENTER px
    firePointer(pane, window.innerWidth / 2, window.innerHeight / 2 + CLOSE_Y_FROM_CENTER);
  }

  setInterval(pumpPopupCloseTaps, 250);

  // ---- 拦截网络请求：改写目标地址，让请求以真实网络错误快速失败 ----
  // 不可达地址：连接立即被拒，浏览器会派发真实的 error 事件，
  // 应用的 HTTP 库（Dart http/dio）能正常收到失败并走「读缓存」回退。
  // （不要用手工派发合成事件来模拟失败：Dart 侧在等原生 load/error 事件，
  //   合成事件时机/类型稍有出入就会让请求 Promise 永远挂起，实测会卡死启动屏。）
  var BLOCKED_BASE = 'https://127.0.0.1:9';

  function rewriteToBlocked(url) {
    try {
      return BLOCKED_BASE + String(url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^\/]*/i, '');
    } catch (e) {
      return BLOCKED_BASE;
    }
  }

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var type = 0;
    try { type = blockTypeOf(url); } catch (e) { type = 0; }
    if (type) {
      if (type === 2) schedulePopupCloseTap();
      url = rewriteToBlocked(url);
      // 注意：必须显式传入改写后的 url，不能用 arguments（那还是原始地址）
      return origOpen.call(this, method, url);
    }
    return origOpen.apply(this, arguments);
  };

  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var type = 0;
      try { type = blockTypeOf(url); } catch (e) { type = 0; }
      if (type) {
        if (type === 2) schedulePopupCloseTap();
        return origFetch.call(this, rewriteToBlocked(url), input instanceof Request ? undefined : init);
      }
      return origFetch.apply(this, arguments);
    };
  }

  // ======================================================================
  // 二、跳过开屏页兜底（1.x 坐标点击逻辑；正常情况下开屏页已不再出现）
  // ======================================================================

  var startedAt = Date.now();
  var lastTapAt = 0;
  var timer = null;

  // 启动页的路由形态：空 hash、#/、#/splash
  function isSplashRoute() {
    var h = location.hash;
    return h === '' || h === '#' || h === '#/' || h === '#/splash';
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function tapSkipButton() {
    var pane = document.querySelector('flt-glass-pane');
    if (!pane) return false;

    var x = window.innerWidth - SKIP_X_FROM_RIGHT;
    var y = SKIP_Y;
    firePointer(pane, x, y);
    return true;
  }

  function tick() {
    var now = Date.now();

    // 已经离开启动页（进入首页或其它路由）→ 任务完成，停止
    if (!isSplashRoute()) {
      stop();
      return;
    }
    if (now - startedAt > GIVE_UP_AFTER) {
      stop();
      return;
    }
    if (now - startedAt < FIRST_TRY_DELAY) return;
    if (now - lastTapAt < TAP_COOLDOWN) return;

    if (tapSkipButton()) lastTapAt = now;
  }

  timer = setInterval(tick, RETRY_INTERVAL);
  tick();
})();

// ==UserScript==
// @name         linux.do 话题自动浏览（蓝点刷帖 v2）
// @namespace    https://linux.do/
// @version      0.8.0
// @description  只在带未读蓝点(unseen-topic / .topic-post-badges .new-topic)的话题行上工作：打开话题标签并切过去等数据加载，再回列表等蓝点消失+间隔后才开下一个；蓝点未消失则回该话题多下滑一段再回来。在 /latest、/new?subset=topics、/unseen 三个列表间每 10 分钟自动轮换。
// @author       you
// @match        https://linux.do/*
// @run-at       document-idle
// @noframes
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// ==/UserScript==

/* =====================================================================
 * 纯页面行为，不判断登录。同脚本两角色靠 localStorage 协作：
 *   - 调度者：运行在三个列表页之一，只处理带小蓝点(unseen-topic)的行；
 *             轮换 URL；打开/关闭话题标签；等蓝点消失。
 *   - 打工者：运行在被打开的 /t/topic/<id>，pending 命中时：等数据加载、
 *             前台下滑 N 段（N=重试次数+1）并停留，让 Discourse 记录已读，
 *             完成后清 pending。
 * 手动打开的话题不受影响。
 * ===================================================================== */

(function () {
  'use strict';

  /* 三个列表，轮换顺序与说明一致 */
  const LIST_URLS = [
    { name: 'latest', url: 'https://linux.do/latest' },
    { name: 'new',    url: 'https://linux.do/new?subset=topics' },
    { name: 'unseen', url: 'https://linux.do/unseen' },
  ];

  function curKey() {
    const p = location.pathname;
    if (p.indexOf('/unseen') === 0) return 'unseen';
    if (p.indexOf('/latest') === 0) return 'latest';
    if (p.indexOf('/new') === 0)    return 'new';
    return null;
  }
  const roleName = () => {
    if (curKey()) return 'list-dispatcher';
    if (/^\/t\/topic\/(\d+)/.test(location.pathname)) return 'topic-worker';
    return 'none';
  };
  const isListPage  = () => roleName() === 'list-dispatcher';
  const isTopicPage = () => roleName() === 'topic-worker';
  const topicId     = () => { const m = location.pathname.match(/^\/t\/topic\/(\d+)/); return m ? m[1] : null; };

  console.log('[ldbot] 脚本已注入 v0.8.0 @', location.href, 'role=' + roleName());

  /* ------------------------- 可调参数 ------------------------- */
  const CFG = {
    AUTO_START: true,
    ROTATE_MS: 10 * 60 * 1000,      // 三个列表间轮换周期：10 分钟
    EMPTY_GROW_LIMIT: 3,            // 当前列表连续 N 次“下滑加载后仍无待阅蓝点”即切换列表
    GAP_SEC: 10,                    // 上一次打开话题 -> 下一次打开话题 的间隔(秒)，面板可调
    ATTEMPT_SCROLL_PX: 800,         // 每次“下滑固定距离”的基础长度(px)；第 N 次重试会滑 N 倍
    MAX_ATTEMPTS: 4,                // 蓝点未消失的最大重试次数，超过则本次跳过该话题
    DOT_WAIT_MS: 8000,              // 回列表后等待蓝点消失的最长时间（实测约 1s）
    FALLBACK_HOLD_MS: 10000,        // 兜底：打开话题后无论 worker 是否回报，到点即关标签回列表
    OPEN_TIMEOUT_MS: 30000,         // worker 完成信号的最大等待（正常 8s 内）
    LOAD_TIMEOUT_MS: 20000,         // 帖子内容加载等待上限
    READY_STABLE_MS: 700,           // 帖子数连续稳定多久视为“数据加载完”
    STEP_MIN: 160, STEP_MAX: 380,   // 滚动步长
    STEP_DELAY_MIN: 120, STEP_DELAY_MAX: 320,
    DWELL_MIN: 2200, DWELL_MAX: 3500, // 加载完后再前台停留时长(≈3s，阅读心跳上报用)
    FEED_GROW_WAIT_MS: 8000,
    PANEL: true,
  };

  /* ------------------------- 存储工具 ------------------------- */
  const P = (k) => 'ldbot:' + k;
  const K = { running: 'running', pending: 'pending', owner: 'owner', attempt: 'attempt', gap: 'gap' };
  const store = {
    get(k)    { try { return localStorage.getItem(P(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(P(k), v); } catch (e) {} },
    del(k)    { try { localStorage.removeItem(P(k)); } catch (e) {} },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand  = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const uid   = () => Math.random().toString(36).slice(2);

  /* ------------------------- 列表行筛选 ------------------------- */
  // “带小蓝点的未读行”判据：tr.unseen-topic（等价于 .topic-post-badges 内含 .new-topic）
  function collectRows() {
    const rows = [...document.querySelectorAll('tbody tr[data-topic-id]')];
    return rows
      .filter((tr) => tr.classList.contains('unseen-topic'))
      .map((tr) => {
        const id = tr.getAttribute('data-topic-id');
        const a = tr.querySelector('a.title.raw-link.raw-topic-link, a.raw-topic-link');
        return { id: String(id), url: a && a.href ? a.href : 'https://linux.do/t/topic/' + id };
      })
      .filter((r) => /\/t\/topic\//.test(r.url));
  }
  const allRowIds = () => new Set([...document.querySelectorAll('tbody tr[data-topic-id]')].map((r) => r.getAttribute('data-topic-id')));

  function rowStillDotted(id) {
    const tr = [...document.querySelectorAll('tbody tr[data-topic-id]')].find((r) => r.getAttribute('data-topic-id') === String(id));
    if (!tr) return false;                      // 行已不在(从未看列表消失)= 已处理
    return tr.classList.contains('unseen-topic');
  }

  async function waitRows(timeout = 15000) {
    const dl = Date.now() + timeout;
    while (Date.now() < dl) {
      if ([...document.querySelectorAll('tbody tr[data-topic-id]')].length) return true;
      await sleep(500);
    }
    return false;
  }

  function isRunning() { return store.get(K.running) === '1'; }

  /* ------------------------- 页主争夺 ------------------------- */
  const myId = uid();
  function amOwner() {
    if (!isListPage()) return false;
    let cur = null;
    try { cur = JSON.parse(store.get(K.owner) || 'null'); } catch (e) { cur = null; }
    if (!cur || (Date.now() - cur.ts) > 10000) { store.set(K.owner, JSON.stringify({ id: myId, ts: Date.now() })); return true; }
    return cur.id === myId;
  }
  function heartbeat() { store.set(K.owner, JSON.stringify({ id: myId, ts: Date.now() })); }
  function releaseOwner() {
    try { const cur = JSON.parse(store.get(K.owner) || 'null'); if (cur && cur.id === myId) store.del(K.owner); } catch (e) {}
  }
  window.addEventListener('beforeunload', releaseOwner);

  /* --------------------- 打工者：话题页 --------------------- */
  // 帖子数量稳定后视为加载完
  async function waitTopicReady() {
    const t0 = Date.now();
    let prev = -1, stableT = -1;
    while (Date.now() - t0 < CFG.LOAD_TIMEOUT_MS) {
      const n = document.querySelectorAll('.post-stream article').length;
      if (n > 0) {
        if (n === prev) {
          if (stableT < 0) stableT = Date.now();
          else if (Date.now() - stableT >= CFG.READY_STABLE_MS) return true;
        } else { stableT = -1; prev = n; }
      }
      await sleep(400);
    }
    return document.querySelectorAll('.post-stream article').length > 0;
  }

  // 下滑固定距离(分段、拟人步长)后停留 ~3s；后台标签时步长加快避免被节流拖慢
  async function humanScrollTo(goalPx) {
    try { document.documentElement.style.scrollBehavior = 'auto'; } catch (e) {}
    const hidden = () => !!(document.hidden || document.visibilityState === 'hidden');
    const stepWait = () => (hidden() ? rand(40, 120) : rand(CFG.STEP_DELAY_MIN, CFG.STEP_DELAY_MAX));
    const maxY = Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight);
    if (maxY <= 0) { await sleep(rand(CFG.DWELL_MIN, CFG.DWELL_MAX)); return; }
    const target = Math.min(maxY, Math.max(goalPx, 300));
    await sleep(300);
    let y = window.scrollY;
    while (y < target) {
      y = Math.min(target, y + rand(CFG.STEP_MIN, CFG.STEP_MAX));
      window.scrollTo(0, y);
      await sleep(stepWait());
    }
    await sleep(rand(CFG.DWELL_MIN, CFG.DWELL_MAX));       // 前台停留让阅读心跳上报
  }

  async function workerMain() {
    if (!isTopicPage()) return;
    const id = topicId();
    if (!id) return;
    const dl = Date.now() + 8000;
    while (Date.now() < dl) { if (store.get(K.pending) === id) break; await sleep(200); }
    if (store.get(K.pending) !== id) return;               // 手动打开，不打扰

    try {
      const att = parseInt(store.get(K.attempt) || '0', 10) || 0;
      const ready = await waitTopicReady();
      if (ready) await humanScrollTo(CFG.ATTEMPT_SCROLL_PX * (att + 1));
      else await sleep(rand(1500, 2500));
    } catch (err) {
      console.error('[ldbot] 打工异常 #' + id, err);
    } finally {
      // 无论成败都清令牌并尽量自关，保证调度者不会空等
      store.del(K.pending);
      console.log('[ldbot] 打工结束 #' + id);
      try { window.close(); } catch (e) {}
    }
  }

  /* --------------------- 调度者：一次前台访问 --------------------- */
  async function openAttempt(row) {
    store.set(K.pending, String(row.id));
    let tab = null;
    if (typeof GM_openInTab === 'function') {
      try { tab = GM_openInTab(row.url, { active: true, insert: true }); } catch (e) { tab = null; } // active:true = 切过去
      try { if (tab && typeof tab.focus === 'function') tab.focus(); } catch (e) {}
    }
    if (!tab) {
      try { const w = window.open(row.url, '_blank'); if (w) tab = w; } catch (e) {}
    }
    if (!tab) {
      log('⚠ 打不开新标签，跳过 #' + row.id);
      store.del(K.pending);
      return false;
    }
    // 等打工者清 pending 完成本次；兜底 FALLBACK_HOLD_MS 到点即关，绝不久等
    const deadline = Date.now() + CFG.FALLBACK_HOLD_MS;
    while (Date.now() < deadline) {
      await sleep(400);
      if (store.get(K.pending) !== String(row.id)) break;  // 打工者已完成本次
      if (typeof tab.closed === 'boolean' && tab.closed) break;
    }
    try { if (typeof tab.close === 'function') tab.close(); } catch (e) {}  // 关闭话题标签 = 焦点回到主列表
    if (store.get(K.pending) === String(row.id)) store.del(K.pending);
    return true;
  }

  // 蓝点消失检测
  async function waitDotGone(id) {
    await sleep(1200);                                     // 先给 Discourse 同步一点时间
    const dl = Date.now() + CFG.DOT_WAIT_MS;
    while (Date.now() < dl) {
      await sleep(700);
      if (!rowStillDotted(id)) return true;
    }
    return false;
  }

  async function browseRow(row) {
    const t0 = Date.now();
    for (let att = 0; att < CFG.MAX_ATTEMPTS; att++) {
      store.set(K.attempt, String(att));
      const ok = await openAttempt(row);
      if (!ok) break;
      if (await waitDotGone(row.id)) {
        log('✓ 蓝点消失 #' + row.id);
        return t0;
      }
      log('蓝点仍在，第 ' + (att + 1) + ' 次回到话题下滑');
    }
    skipSet.add(row.id);
    log('✗ 多次尝试蓝点仍在，本次跳过 #' + row.id);
    return t0;
  }

  // 让“开上一个话题”到“开下一个话题”间隔 >= 面板设定
  async function paceFrom(t0) {
    const rem = gapMs - (Date.now() - t0);
    if (rem > 0) { log('等待 ' + (rem / 1000).toFixed(1) + 's 开下一个'); await sleep(rem); }
  }

  /* --------------------- 调度者：主循环 --------------------- */
  let gapMs = 1000 * (parseFloat(store.get(K.gap)) || CFG.GAP_SEC);
  let skipSet = new Set();
  let sessionOk = 0, sessionSkip = 0;
  let cycleStartAt = Date.now();

  function setGapSec(v) {
    const s = Math.max(1, Math.round(parseFloat(v) || CFG.GAP_SEC));
    gapMs = s * 1000;
    store.set(K.gap, String(s));
    return s;
  }

  function nextCandidate() {
    const p = store.get(K.pending);
    return collectRows().find((r) => !skipSet.has(r.id) && p !== r.id) || null;
  }

  function gotoNextList() {
    const key = curKey();
    const i = LIST_URLS.findIndex((x) => x.name === key);
    const next = LIST_URLS[(i + 1) % LIST_URLS.length];
    log('轮换列表 -> ' + next.name + '  ' + next.url);
    store.del(K.pending);
    location.href = next.url;
  }

  async function smoothScrollBottom() {
    await new Promise((resolve) => {
      const maxY = () => Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight);
      let y = window.scrollY;
      const step = () => {
        y = Math.min(maxY(), y + rand(250, 500));
        window.scrollTo(0, y);
        if (y < maxY()) setTimeout(step, rand(60, 140)); else resolve();
      };
      step();
    });
  }

  async function growFeed() {
    const before = allRowIds();
    await smoothScrollBottom();
    const dl = Date.now() + CFG.FEED_GROW_WAIT_MS;
    while (Date.now() < dl) {
      await sleep(700);
      const now = allRowIds();
      if ([...now].some((id) => !before.has(id))) return true;
    }
    return false;
  }

  // 把候选话题行滚动到视口垂直正中，打开/回来时能直观看到当前进度
  async function centerCandidate(id) {
    const tr = [...document.querySelectorAll('tbody tr[data-topic-id]')].find((r) => r.getAttribute('data-topic-id') === String(id));
    if (!tr) return;
    try { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { tr.scrollIntoView(true); }
    await sleep(450);
  }

  async function runDispatcher() {
    if (!(await waitRows())) { log('⚠ 当前列表没有话题行'); return; }
    log('开始调度 @ ' + curKey() + '，带蓝点 ' + collectRows().length + ' 个');
    cycleStartAt = Date.now();
    let emptyStreak = 0;               // 连续“下滑后仍无待阅蓝点”次数

    while (isRunning()) {
      if (!amOwner()) { log('已被其它列表页接管，本页让位'); return; }
      heartbeat();

      // 每 10 分钟切下一个列表
      if (Date.now() - cycleStartAt >= CFG.ROTATE_MS) { gotoNextList(); return; }

      const cand = nextCandidate();
      if (cand) {
        emptyStreak = 0;               // 找到待阅蓝点，清空计数
        await centerCandidate(cand.id);          // 先把该行滚到视口正中
        const t0 = await browseRow(cand);
        if (store.get(K.pending)) store.del(K.pending);
        if (skipSet.has(cand.id)) sessionSkip++; else sessionOk++;
        updatePanel();
        await paceFrom(t0);
        continue;
      }

      // 当前页没有带蓝点的行了：滑到底部触发加载，算一次“下滑”
      const grew = await growFeed();
      if (grew && nextCandidate()) { emptyStreak = 0; continue; }   // 加载出了新蓝点

      // 这次下滑后仍没有待阅蓝点（无论是否加载出新行）
      emptyStreak++;
      log('下滑第 ' + emptyStreak + '/' + CFG.EMPTY_GROW_LIMIT + ' 次后仍无待阅蓝点');
      if (emptyStreak >= CFG.EMPTY_GROW_LIMIT) {
        log('连续 ' + CFG.EMPTY_GROW_LIMIT + ' 次下滑无待阅蓝点，切换列表');
        gotoNextList();
        return;
      }
      await sleep(1500);
    }
    releaseOwner();
  }

  /* --------------------------- 控制 --------------------------- */
  function log(msg) { console.log('[ldbot]', new Date().toLocaleTimeString(), msg); setStatus(msg); }
  function startAll() { store.set(K.running, '1'); log('已点开始'); if (isListPage()) runDispatcher(); }
  function stopAll() { store.set(K.running, '0'); store.del(K.pending); log('已暂停'); updatePanel(); }
  function resetAll() {
    if (!confirm('重置本次统计与“跳过”记录？')) return;
    skipSet = new Set(); sessionOk = 0; sessionSkip = 0;
    log('已重置');
    updatePanel();
  }
  function selfTest() {
    const rows = collectRows();
    const total = document.querySelectorAll('tbody tr[data-topic-id]').length;
    const info = [
      'URL: ' + location.href,
      '角色: ' + roleName(),
      'GM_openInTab: ' + (typeof GM_openInTab),
      'running: ' + store.get(K.running),
      '间隔: ' + (gapMs / 1000) + 's',
      '可见行: ' + total,
      '带蓝点: ' + rows.length,
    ];
    log('【自检】' + info.join(' | '));
    alert('【ldbot 自检】\n' + info.join('\n'));
  }

  /* ------------------------- 控制面板 ------------------------- */
  let panel = null, sBtn = null, sCnt = null, sSkp = null, sSta = null, sCtx = null;
  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'ldbot-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; right: 14px; bottom: 14px; z-index: 2147483000;
               font: 12px/1.5 -apple-system,"Segoe UI","PingFang SC",sans-serif;
               background:#1b1f24; color:#e6e6e6; border:1px solid #333;
               border-radius:8px; padding:8px 10px; width:230px;
               box-shadow:0 4px 18px rgba(0,0,0,.35); }
        .t { font-weight:600; }
        .r { display:flex; justify-content:space-between; align-items:center; margin:2px 0; }
        .r input { width:60px; background:#2a2f36; color:#eee; border:1px solid #444;
                   border-radius:4px; padding:1px 5px; font-size:12px; text-align:right; }
        .btns { display:flex; gap:6px; margin-top:6px; }
        .btns button { flex:1; cursor:pointer; border:0; border-radius:5px; padding:4px 0; font-size:12px; color:#fff; }
        #ldbot-start { background:#2e8b57; } #ldbot-start.pause { background:#b35900; }
        #ldbot-reset { background:#7a2020; } #ldbot-test { background:#2f5d8a; }
        .log { margin-top:5px; color:#9aa; font-size:11px; word-break:break-all; max-height:36px; overflow:hidden; }
      </style>
      <div class="box">
        <div class="t">linux.do 蓝点刷帖 v0.8.0</div>
        <div class="r"><span>列表/距轮换</span><span id="ldbot-ctx"></span></div>
        <div class="r"><span>成功(蓝点消失)</span><b id="ldbot-n">0</b></div>
        <div class="r"><span>跳过</span><b id="ldbot-s">0</b></div>
        <div class="r"><span>间隔(秒)</span><input id="ldbot-gap" type="number" min="1" max="600" step="1"></div>
        <div class="btns">
          <button id="ldbot-start"></button>
          <button id="ldbot-test">自检</button>
          <button id="ldbot-reset">重置</button>
        </div>
        <div class="log" id="ldbot-log">等待操作…</div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    panel = host;
    sBtn = shadow.getElementById('ldbot-start');
    sCnt = shadow.getElementById('ldbot-n');
    sSkp = shadow.getElementById('ldbot-s');
    sSta = shadow.getElementById('ldbot-log');
    sCtx = shadow.getElementById('ldbot-ctx');
    sBtn.addEventListener('click', () => (isRunning() ? stopAll() : startAll()));
    shadow.getElementById('ldbot-test').addEventListener('click', selfTest);
    shadow.getElementById('ldbot-reset').addEventListener('click', resetAll);

    const gapInput = shadow.getElementById('ldbot-gap');
    gapInput.value = Math.round(gapMs / 1000);
    gapInput.addEventListener('input', () => {
      const s = setGapSec(gapInput.value);
      gapInput.value = Math.round(gapMs / 1000);
      setStatus('间隔已设为 ' + s + 's');
    });

    updatePanel();
    setInterval(updatePanel, 1000);
  }
  function setStatus(t) { if (sSta) sSta.textContent = String(t).slice(0, 80); }
  function fmt(ms) {
    ms = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(ms / 60), s = ms % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function updatePanel() {
    if (!sBtn) return;
    const running = isRunning();
    sBtn.textContent = running ? '暂停' : '开始';
    sBtn.classList.toggle('pause', running);
    if (sCnt) sCnt.textContent = sessionOk;
    if (sSkp) sSkp.textContent = sessionSkip;
    if (sCtx) {
      const remain = CFG.ROTATE_MS - (Date.now() - cycleStartAt);
      sCtx.textContent = (curKey() || '?') + ' / ' + fmt(remain);
    }
  }

  /* --------------------------- 入口 --------------------------- */
  (async function main() {
    try {
      if (CFG.PANEL && document.body) buildPanel();
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('开始', () => startAll());
        GM_registerMenuCommand('暂停', () => stopAll());
        GM_registerMenuCommand('自检', () => selfTest());
      }
      if (isTopicPage()) { await workerMain(); return; }
      if (!isListPage()) return;
      if (CFG.AUTO_START && !store.get(K.running)) store.set(K.running, '1');
      if (isRunning()) await runDispatcher();
    } catch (err) {
      console.error('[ldbot] 主流程异常:', err);
      setStatus('异常: ' + err.message);
    }
  })();
})();

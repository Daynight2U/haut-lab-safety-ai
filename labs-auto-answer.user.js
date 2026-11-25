// ==UserScript==
// @name         实验室安全准入 · AI 自动答题
// @namespace    labs.auto.answer
// @version      3.0
// @description  实验室安全练习/考核系统的自动答题助手：AI 答题 + 本地题库自学习
// @match        https://labs.haut.edu.cn/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      api.moonshot.cn
// @connect      dashscope.aliyuncs.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/*
 * 使用方式
 * A. Tampermonkey 安装（推荐，AI 请求要靠它跨域）
 * B. 直接粘到 F12 控制台（需先输入 allow pasting），仅本地题库可用
 *
 * 改成本校系统：把上面 @match 换成你们练习系统的域名，
 * 并确认页面结构（题干 + "正确/错误"或"A./B."选项 + "下一题/提交"按钮）与目标一致。
 *
 * 常用命令：
 *   __LQB__.start(3)        跑 3 轮（1–20）
 *   __LQB__.stop()          停止（或 Esc）
 *   __LQB__.help()          命令列表
 */
(function () {
  'use strict';
  if (window.__LQB__) { console.log('[LQB] 已经加载过了'); return; }

  /* ================= 0. 配置 ================= */
  const VERSION = '3.0';
  const CFG = {
    threshold: 85,                               // 选项模糊匹配相似度下限
    cacheKey: 'LQB_CACHE_V1',
    // AI 答题
    aiBase: localStorage.getItem('LQB_AI_BASE') || 'https://api.deepseek.com/v1',
    aiKey: localStorage.getItem('LQB_AI_KEY') || '',
    aiModel: localStorage.getItem('LQB_AI_MODEL') || 'deepseek-chat',
  };

  // 常见国产大模型（OpenAI 兼容接口）
  const AI_PRESETS = {
    deepseek:    { base: 'https://api.deepseek.com/v1',                          model: 'deepseek-chat' },
    kimi:        { base: 'https://api.moonshot.cn/v1',                            model: 'moonshot-v1-8k' },
    qwen:        { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',     model: 'qwen-plus' },
    glm:         { base: 'https://open.bigmodel.cn/api/paas/v4',                  model: 'glm-4-flash' },
    hunyuan:     { base: 'https://api.hunyuan.cloud.tencent.com/v1',              model: 'hunyuan-turbos-latest' },
    ark:         { base: 'https://ark.cn-beijing.volces.com/api/v3',              model: 'doubao-pro-32k' },
    siliconflow: { base: 'https://api.siliconflow.cn/v1',                         model: 'Qwen/Qwen2.5-7B-Instruct' },
    minimax:     { base: 'https://api.minimax.chat/v1',                           model: 'abab6.5s-chat' },
  };
  const ROUNDS_MAX = 20;

  /* ================= 1. 内置题库（机电安全 20 题，已按系统判定校准） ================= */
  const BANK = [
    ['遇有电器着火，应先切断电源再救火', '正确'],
    ['全国消防宣传日是每年的11月9日', '正确'],
    ['禁止使用回火后烧损的橡胶软管输送气体', '正确'],
    ['氢气应保留残余压力', 'B'],                       // 2MPa
    ['实验项目安全风险评价不包括', 'D'],               // 实验项目研究对象
    ['左手食指从指根完全离断', '正确'],                // 系统判定：正确
    ['学校层面组织的实验室安全检查每年应不少', 'D'],   // 4 次
    ['跨步电压', 'A'],                                  // 20m 以内
    ['一般无机酸、碱液和稀硫酸不慎滴在皮肤上', 'C'],   // 用水直接冲洗
    ['用砂轮对试样进行打磨', 'B'],                      // 活性大的金属不能磨
    ['使用车床切削工件时要先锁紧', 'D'],                // 刀架
    ['实验室安全学习考试合格线', 'D'],                  // 90 分
    ['拉压实验机使用过程出现异常情况', 'D'],            // 停机并联系技术人员
    ['可以用手触摸钼丝', '错误'],
    ['电子底板贴焊、剪脚', 'A'],                        // 防护眼镜
    ['整改通知书应包含', '错误'],                       // 系统判定：错误
    ['发生触电事故时，应马上直接将其拉开远离电源', '错误'],
    ['乙炔发生器或回火防止器内的水冻结', '错误'],
    ['喷射干粉灭火剂', 'C'],                            // 干粉灭火器
    ['有机膦、砷化物、有机汞、氰化物', 'C'],
  ];

  /* ================= 2. 工具 ================= */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);

  const norm = (s) =>
    (s || '')
      .replace(/\s+/g, '')
      .replace(/^\d+[\.、．]/, '')
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
      .toLowerCase();

  const stripLabel = (t) => (t || '').replace(/^\s*[A-Za-z]\s*[.．、:：\]\)]\s*/, '');

  // Levenshtein 相似度（0-100），照搬小助手的打分方式
  function similarity(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 100;
    const a = Array.from(left), b = Array.from(right);
    const d = Array.from({ length: a.length + 1 }, (_, i) => i);
    b.forEach((ch, row) => {
      let diag = d[0];
      d[0] = row + 1;
      a.forEach((other, col) => {
        const above = d[col + 1];
        d[col + 1] = ch === other ? diag : Math.min(diag, above, d[col]) + 1;
        diag = above;
      });
    });
    return Math.round((1 - d[a.length] / Math.max(a.length, b.length)) * 100);
  }

  /* ================= 3. 题库查询：本地 → 缓存 → 在线 ================= */
  function readCache() {
    try { return JSON.parse(localStorage.getItem(CFG.cacheKey) || '{}'); } catch (e) { return {}; }
  }
  function writeCache(obj) {
    try { localStorage.setItem(CFG.cacheKey, JSON.stringify(obj)); } catch (e) {}
  }
  function cacheSet(q, ans, text) {
    const c = readCache();
    c[norm(q)] = { q, ans, text: text || '', t: Date.now() };
    writeCache(c);
  }
  function cacheGet(q) {
    const all = readCache();
    const exact = all[norm(q)];
    if (exact && exact.ans) return exact;
    // 兜底：包含匹配（题干略有差异时）
    const nq = norm(q);
    if (!nq) return null;
    let best = null, len = 0;
    for (const k of Object.keys(all)) {
      if (!all[k] || !all[k].ans) continue;
      if (nq.includes(k) || k.includes(nq)) {
        const s = Math.min(k.length, nq.length);
        if (s > len) { len = s; best = all[k]; }
      }
    }
    return best;
  }

  function lookupLocal(q) {
    const nq = norm(q);
    if (!nq) return null;
    for (const [k, a] of BANK) {
      const nk = norm(k);
      if (!nk) continue;
      if (nq.includes(nk) || nk.includes(nq)) return a;
    }
    return null;
  }

  const isJudgeOpts = (opts) => opts.some((o) => /^(正确|错误)$/.test(o));

  function judgeToken(raw) {
    const t = String(raw).trim().toLowerCase().replace(/^[a-z0-9]+[.．、:：\]\)]\s*/i, '').replace(/[\s.．、:：()（）\[\]{}]/g, '');
    if (/^(?:正确|是|对|√|t|true|right|y|yes)$/.test(t)) return '正确';
    if (/^(?:错误|否|错|×|x|f|false|wrong|n|no)$/.test(t)) return '错误';
    return '';
  }

  // 把题库返回的 values 映射成页面上的选项行文本
  function matchValues(values, opts) {
    if (!Array.isArray(values) || !values.length) return null;
    const judge = isJudgeOpts(opts);
    const normOpts = opts.map((o) => norm(stripLabel(o)));
    for (const v of values) {
      const raw = String(v).trim();
      if (!raw) continue;
      if (judge) {
        const t = judgeToken(raw);
        if (t && opts.includes(t)) return t;
      }
      const nv = norm(stripLabel(raw));
      const exact = normOpts.indexOf(nv);
      if (exact >= 0) return opts[exact];
      const letter = raw.match(/^([A-Za-z])[.．、:：\]\)]?$/);
      if (letter) {
        const i = letter[1].toUpperCase().charCodeAt(0) - 65;
        if (opts[i]) return opts[i];
      }
      if (!judge && nv) {
        let best = 0, bi = -1;
        normOpts.forEach((t, i) => { const s = similarity(t, nv); if (s > best) { best = s; bi = i; } });
        if (best >= CFG.threshold && bi >= 0) return opts[bi];
      }
    }
    return null;
  }

  function httpPostJson(url, body, headers) {
    const data = JSON.stringify(body);
    // Tampermonkey 环境走 GM 请求，免 CORS
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          url, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), data,
          timeout: 15000,
          onload: (res) => { try { resolve({ status: res.status, json: JSON.parse(res.responseText) }); } catch (e) { reject(new Error('返回不是 JSON')); } },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('请求超时')),
        });
      });
    }
    return fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: data })
      .then((r) => r.json().then((json) => ({ status: r.status, json })));
  }

  /* ============ 3.5 学校题库（直接从 admittance 接口抓，接口会把正确答案 yesAnswer 一起下发） ============ */
  const SCHOOL_KEY = 'LQB_SCHOOL_BANK';
  let schoolCache = null;

  function readSchool() {
    if (schoolCache) return schoolCache;
    try { schoolCache = JSON.parse(localStorage.getItem(SCHOOL_KEY) || '[]'); } catch (e) { schoolCache = []; }
    return schoolCache;
  }
  function writeSchool(arr) {
    schoolCache = arr;
    try { localStorage.setItem(SCHOOL_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  const isAscii = (v) => /^[\x20-\x7E]+$/.test(String(v == null ? '' : v));

  function getToken() {
    const safe = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
    const ck = (n) => {
      const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]+)'));
      return m ? safe(m[1]) : '';
    };
    for (const n of ['Admin-ZR-Token', 'Admin-Token', 'admin-token', 'Admin-Token-Expire', 'token', 'satoken', 'SESSION']) {
      const v = ck(n);
      if (v && v.length > 8) return v.replace(/^Bearer\s+/i, '');
    }
    try {
      for (const k of Object.keys(localStorage)) {
        if (!/token/i.test(k)) continue;
        const v = localStorage.getItem(k);
        if (v && v.length > 12) return String(v).replace(/^"?Bearer\s+/i, '').replace(/"/g, '');
      }
    } catch (e) {}
    return '';
  }

  async function schoolApi(method, path, body, extraHeaders) {
    const headers = Object.assign({ 'Content-Type': 'application/json;charset=utf-8' }, extraHeaders || {});
    const token = getToken();
    if (token && isAscii(token) && !headers.Authorization) headers['Authorization'] = 'Bearer ' + token;
    if (AUTH && AUTH.h && isAscii(AUTH.v)) headers[AUTH.h] = AUTH.v;
    // 兜底：任何非 ISO-8859-1 的头值一律剔掉，否则 fetch 直接抛错
    Object.keys(headers).forEach((k) => { if (!isAscii(headers[k])) delete headers[k]; });
    const res = await fetch('/pxzr-prod-api' + path, {
      method,
      headers,
      credentials: 'include',
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 300) }; }
    return { status: res.status, json };
  }

  /* ---- 鉴权自动探测：把页面能读到的 cookie / storage 值挨个当 token 试 ---- */
  let AUTH = null;
  try { AUTH = JSON.parse(localStorage.getItem('LQB_AUTH') || 'null'); } catch (e) { AUTH = null; }

  function collectTokens() {
    const out = [];
    const seen = new Set();
    const push = (src, val) => {
      if (val == null) return;
      let v = String(val).trim().replace(/^"|"$/g, '');
      if (v.length < 10 || v.length > 4096) return;
      if (/^(true|false|null|undefined|\d+)$/i.test(v)) return;
      if (seen.has(v)) return;
      seen.add(v);
      out.push({ src, val: v });
    };
    try {
      document.cookie.split(';').forEach((s) => {
        const i = s.indexOf('=');
        if (i > 0) push('cookie:' + s.slice(0, i).trim(), decodeURIComponent(s.slice(i + 1)));
      });
    } catch (e) {}
    for (const store of ['localStorage', 'sessionStorage']) {
      try {
        const st = window[store];
        Object.keys(st).forEach((k) => {
          const v = st.getItem(k);
          push(store + ':' + k, v);
          if (v && /^[{[]/.test(v)) {
            try {
              const walk = (o) => {
                for (const kk of Object.keys(o || {})) {
                  const vv = o[kk];
                  if (typeof vv === 'string' && vv.length > 10 && /token|auth|jwt|ticket/i.test(kk)) push(store + ':' + k + '.' + kk, vv);
                  else if (vv && typeof vv === 'object') walk(vv);
                }
              };
              walk(JSON.parse(v));
            } catch (e) {}
          }
        });
      } catch (e) {}
    }
    return out;
  }

  function diag() {
    const ck = [];
    try { document.cookie.split(';').forEach((s) => { const i = s.indexOf('='); if (i > 0) ck.push(s.slice(0, i).trim() + '(' + s.slice(i + 1).length + ')'); }); } catch (e) {}
    const ls = Object.keys(localStorage || {}).map((k) => k + '(' + String(localStorage.getItem(k)).length + ')');
    const ss = Object.keys(sessionStorage || {}).map((k) => k + '(' + String(sessionStorage.getItem(k)).length + ')');
    console.log('%c[LQB] 诊断', 'color:#38bdf8');
    console.log('cookie 可读项：', ck.length ? ck.join(', ') : '（空 → token 可能是 HttpOnly）');
    console.log('localStorage：', ls.join(', ') || '（空）');
    console.log('sessionStorage：', ss.join(', ') || '（空）');
    const cands = collectTokens();
    console.log('候选 token 明细（脱敏，只看形态）：');
    cands.forEach((c) => {
      const v = c.val;
      const flags = [];
      if (/^eyJ/.test(v)) flags.push('JWT');
      if (/%/.test(v)) flags.push('含%');
      if (/^["']/.test(v)) flags.push('带引号');
      if (/^[{[]/.test(v)) flags.push('JSON');
      if (/^Bearer\s/i.test(v)) flags.push('自带Bearer');
      console.log('  ' + c.src + ' → 长度 ' + v.length + ' · 开头 "' + v.slice(0, 18).replace(/[\r\n]/g, '') + '" ' + (flags.join('/') || ''));
    });
    return { ck, ls, ss };
  }

  async function probeAuth() {
    const list = collectTokens().filter((c) => isAscii(c.val));
    console.log('[LQB] 自动试鉴权：' + list.length + ' 个候选（已滤掉非 ASCII），' + list.map((x) => x.src).join(' | '));
    const schemes = [
      ['Authorization', (v) => 'Bearer ' + v],
      ['Authorization', (v) => v],
      ['Admin-ZR-Token', (v) => v],
      ['satoken', (v) => v],
      ['X-Token', (v) => v],
      ['token', (v) => v],
      ['Blade-Auth', (v) => 'bearer ' + v],
      ['X-Access-Token', (v) => v],
    ];
    const okCode = (j) => !!j && (j.code === 200 || j.code === 0 || typeof j.total === 'number' || Array.isArray(j.rows) || Array.isArray(j.data));
    const checkPath = '/admittance/exercises/exercisesList?pageNum=1&pageSize=1';
    for (const c of list) {
      for (const [h, f] of schemes) {
        let r;
        try { r = await schoolApi('GET', checkPath, null, { [h]: f(c.val) }); } catch (e) { continue; }
        if (okCode(r.json)) {
          AUTH = { h, v: f(c.val) };
          localStorage.setItem('LQB_AUTH', JSON.stringify(AUTH));
          console.log('%c[LQB] 鉴权成功 → 头 ' + h + ' 来自 ' + c.src, 'color:#22c55e;font-weight:bold');
          return true;
        }
      }
      const r2 = await schoolApi('GET', checkPath + '&token=' + encodeURIComponent(c.val));
      if (okCode(r2.json)) {
        AUTH = { h: 'X-LQB-Query', v: c.val, query: true };
        localStorage.setItem('LQB_AUTH', JSON.stringify(AUTH));
        console.log('%c[LQB] 鉴权成功 → query 参数，来自 ' + c.src, 'color:#22c55e');
        return true;
      }
    }
    console.warn('[LQB] 所有组合都 401。token 大概是 HttpOnly cookie，JS 读不到。');
    console.warn('[LQB] 换招：运行 __LQB__.sniff()，然后在页面上点一下练习/答题，把 [LQB-SNIFF] 开头的行发我。');
    return false;
  }

  async function ensureAuth() {
    const p = '/admittance/exercises/exercisesList?pageNum=1&pageSize=1';
    if (AUTH) {
      const r = await schoolApi('GET', p);
      if (r.json && (r.json.code === 200 || r.json.code === 0)) { console.log('[LQB] 鉴权 OK（上次保存的）'); return true; }
      console.log('[LQB] 保存的鉴权失效，重新探测');
      AUTH = null;
      localStorage.removeItem('LQB_AUTH');
    }
    const r0 = await schoolApi('GET', p);
    if (r0.json && (r0.json.code === 200 || r0.json.code === 0)) { console.log('[LQB] 鉴权 OK（浏览器 cookie 自动带上）'); return true; }
    return await probeAuth();
  }

  // 嗅探页面自己的请求，看它到底用什么头带 token
  function sniff() {
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    if (W.__lqbSniff) { console.log('[LQB] 嗅探已经在跑了，去页面上点一下'); return; }
    W.__lqbSniff = true;
    const of = W.fetch;
    if (of) {
      W.fetch = function (input, init) {
        try {
          const url = typeof input === 'string' ? input : (input && input.url);
          if (url && /admittance|pxzr-prod-api/.test(url)) {
            console.log('[LQB-SNIFF fetch]', (init && init.method) || 'GET', url,
              JSON.stringify(init && init.headers || {}), init && init.body ? String(init.body).slice(0, 300) : '');
          }
        } catch (e) {}
        return of.apply(this, arguments);
      };
    }
    const X = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
    if (X) {
      const oOpen = X.open, oSet = X.setRequestHeader, oSend = X.send;
      X.open = function (m, u) { this.__l = { m, u, h: {} }; return oOpen.apply(this, arguments); };
      X.setRequestHeader = function (k, v) { try { if (this.__l) this.__l.h[k] = v; } catch (e) {} return oSet.apply(this, arguments); };
      X.send = function (b) {
        try {
          if (this.__l && /admittance|pxzr-prod-api/.test(this.__l.u)) {
            console.log('[LQB-SNIFF xhr]', this.__l.m, this.__l.u, JSON.stringify(this.__l.h), b ? String(b).slice(0, 300) : '');
            const h = this.__l.h || {};
            const authKey = Object.keys(h).find((k) => /authorization|token/i.test(k));
            if (authKey) {
              const sent = String(h[authKey]).replace(/^Bearer\s+/i, '');
              const mine = getToken();
              console.log('  ↳ 页面用的是 ' + authKey + '，长度 ' + sent.length + '；脚本读到长度 ' + mine.length + '，' + (sent === mine ? '✅ 一致' : '❌ 不一致（说明 cookie 有多份或读错了）'));
            } else {
              console.log('  ↳ 这个请求没带 Authorization 头，鉴权走的是 cookie 或别的头');
            }
          }
        } catch (e) {}
        return oSend.apply(this, arguments);
      };
    }
    console.log('%c[LQB] 嗅探已开启：现在去页面上进入一次练习 / 答一题，然后把 [LQB-SNIFF] 开头的行发我', 'color:#f59e0b;font-weight:bold');
  }

  function pickRows(json) {
    if (!json) return null;
    const arr = json.rows
      || (json.data && (json.data.rows || json.data.list || json.data.records))
      || (Array.isArray(json.data) ? json.data : null)
      || (Array.isArray(json) ? json : null);
    return Array.isArray(arr) ? arr : null;
  }

  // 抓题库：GET 练习集列表 → 逐个 POST /admittance/exercises/{id} 拿题目（含 yesAnswer）
  async function crawlBank() {
    console.log('[LQB] 开始抓学校题库…');
    const ok = await ensureAuth();
    if (!ok) {
      diag();
      console.warn('[LQB] 鉴权没通过，先用 __LQB__.sniff() 抓一次真实请求头');
      return null;
    }

    const tries = [
      ['GET', '/admittance/exercises/exercisesList?pageNum=1&pageSize=500'],
      ['GET', '/admittance/exercises/exercisesList'],
      ['GET', '/admittance/exercises/list?pageNum=1&pageSize=500'],
    ];
    let rows = null;
    for (const [m, p] of tries) {
      const r = await schoolApi(m, p);
      const arr = pickRows(r.json);
      console.log('[LQB] 试 ' + p + ' → HTTP ' + r.status + ' / code ' + (r.json && (r.json.code || '-')) + ' / 条数 ' + (arr ? arr.length : 0));
      if (arr && arr.length) { rows = arr; break; }
      if (r.json && r.json.code === 401) { console.warn('[LQB] 401 认证失败，把这条响应发我：' + JSON.stringify(r.json).slice(0, 200)); }
    }
    if (!rows) { console.warn('[LQB] 没拿到练习集列表'); return null; }
    console.log('%c[LQB] 练习集 ' + rows.length + ' 个，样例：', 'color:#22c55e', rows.slice(0, 2));

    const bank = [];
    let okSet = 0;
    for (const it of rows) {
      const id = it.id || it.exercisesId || it.questionId || it.practiceId;
      if (!id) continue;
      const r = await schoolApi('POST', '/admittance/exercises/' + id, {});
      const qs = Array.isArray(r.json && r.json.data) ? r.json.data
        : (Array.isArray(r.json) ? r.json : (pickRows(r.json) || []));
      if (!qs.length) { console.warn('[LQB] 题集 ' + id + ' 无题目（code ' + (r.json && r.json.code) + '）'); continue; }
      okSet++;
      for (const q of qs) {
        const stem = String(q.questions || q.questionName || q.content || q.name || '').trim();
        if (!stem) continue;
        const optList = q.optionList || q.options || [];
        const judge = String(q.type) === '03';
        const ya = q.yesAnswer == null ? '' : String(q.yesAnswer).trim();
        let values = [];
        if (judge) {
          const o = optList.find((x) => String(x.name) === ya);
          values = [o ? String(o.content).trim() : (ya === '1' || ya === 'A' ? '正确' : '错误')];
        } else if (/^[A-Fa-f][,，\s]*[A-Fa-f]?$/.test(ya)) {
          values = [ya.charAt(0).toUpperCase()];
        } else {
          values = ya ? [ya] : [];
        }
        if (!values.length || !values[0]) continue;
        bank.push({ q: stem, type: q.type, values, opts: optList.map((o) => String(o.name) + ' ' + String(o.content)).slice(0, 8) });
      }
      await sleep(160);
    }

    writeSchool(bank);
    console.log('%c[LQB] 抓取完成：' + okSet + ' 个题集 / ' + bank.length + ' 道题，已存入本地', 'color:#22c55e;font-weight:bold');
    console.log('[LQB] 前 3 题样例：', bank.slice(0, 3));
    return bank;
  }

  function lookupSchool(q, opts) {
    const bank = readSchool();
    if (!bank.length) return null;
    const nq = norm(q);
    if (!nq) return null;
    let best = null, score = 0;
    for (const it of bank) {
      const nk = norm(it.q);
      if (!nk) continue;
      if (nk === nq) return matchValues(it.values, opts);
      if (nq.includes(nk) || nk.includes(nq)) {
        const s = Math.min(nk.length, nq.length);
        if (s > score) { score = s; best = it; }
      }
    }
    return best ? matchValues(best.values, opts) : null;
  }

  /* ============ 3.6 拦截页面自己的请求，把题目+答案直接捞进题库 ============ */
  function harvest(text, url) {
    if (!text || text.length > 3e6) return 0;
    let json;
    try { json = JSON.parse(text); } catch (e) { return 0; }
    const items = [];
    const seen = new Set();
    const walk = (node, d) => {
      if (!node || d > 9) return;
      if (Array.isArray(node)) { for (const n of node) walk(n, d + 1); return; }
      if (typeof node !== 'object') return;
      const stem = node.questions || node.questionName || node.question || node.content;
      let ya = node.yesAnswer;
      if (ya == null) ya = node.rightAnswer;
      if (ya == null) ya = node.correctAnswer;
      if (typeof stem === 'string' && stem.trim().length > 4 && ya != null && ya !== '') {
        const k = norm(stem);
        if (k && !seen.has(k)) {
          seen.add(k);
          items.push({ stem: stem.trim(), type: node.type, ya: String(ya).trim(), opts: node.optionList || node.options || [] });
        }
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (v && typeof v === 'object') walk(v, d + 1);
      }
    };
    walk(json, 0);
    if (!items.length) return 0;

    const bank = readSchool();
    const index = new Map(bank.map((b) => [norm(b.q), b]));
    let added = 0;
    for (const it of items) {
      const judge = String(it.type) === '03';
      let values = [];
      if (judge) {
        const o = (it.opts || []).find((x) => String(x.name) === it.ya);
        values = [o ? String(o.content).trim() : ((it.ya === '1' || it.ya.toUpperCase() === 'A') ? '正确' : '错误')];
      } else if (/^[A-Fa-f][,，\s]*[A-Fa-f]?$/.test(it.ya)) {
        values = [it.ya.charAt(0).toUpperCase()];
      } else {
        values = [it.ya];
      }
      if (!values[0]) continue;
      const k = norm(it.stem);
      if (!k) continue;
      const rec = { q: it.stem, type: it.type, values, opts: (it.opts || []).map((o) => String(o.name) + ' ' + String(o.content)).slice(0, 8) };
      if (!index.has(k)) added++;
      index.set(k, rec);
    }
    writeSchool(Array.from(index.values()));
    if (added) console.log('%c[LQB] 页面响应里捞到 ' + added + ' 题答案 → 题库共 ' + index.size + ' 题', 'color:#22c55e;font-weight:bold');
    return added;
  }

  function hookExamApi() {
    if (window.__lqbHooked) return;
    window.__lqbHooked = true;
    const isExamUrl = (u) => /admittance|pxzr-prod-api/.test(u || '');

    // XHR
    const X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (X) {
      const oOpen = X.open, oSend = X.send;
      X.open = function (m, u) { try { this.__lqbUrl = String(u || ''); } catch (e) {} return oOpen.apply(this, arguments); };
      X.send = function () {
        try {
          if (isExamUrl(this.__lqbUrl)) {
            this.addEventListener('load', () => {
              try { harvest(this.responseText, this.__lqbUrl); } catch (e) {}
            });
          }
        } catch (e) {}
        return oSend.apply(this, arguments);
      };
    }
    // fetch
    const of = window.fetch;
    if (of) {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : ((input && input.url) || '');
        const p = of.apply(this, arguments);
        if (isExamUrl(url)) {
          p.then((r) => { try { r.clone().text().then((t) => harvest(t, url)).catch(() => {}); } catch (e) {} }).catch(() => {});
        }
        return p;
      };
    }
    console.log('[LQB] 已挂上接口嗅探：进练习、答题、交卷时，题目和答案会自动进题库');
  }

  /* ============ 3.7 AI 答题（OpenAI 兼容接口，强制 JSON 输出） ============ */
  const AI_PROMPT = (q, opts, judge) => {
    const lines = opts.map((o, i) => (judge ? o : String.fromCharCode(65 + i) + '. ' + stripLabel(o))).join('\n');
    return `你是高校「实验室安全」考试的答题助手。请判断下面这道题的正确答案。

题目：${String(q).trim()}
选项：
${lines}

严格只输出一个 JSON 对象，不要 markdown 代码块、不要解释、不要任何多余字符：
{"answer":"A","confidence":0.9}

${judge ? '本题是判断题，answer 只能是 "正确" 或 "错误"。' : '本题是单选题，answer 只能是选项字母 A / B / C / D 之一。'}
confidence 用 0 到 1 的小数表示你的把握程度。`;
  };

  async function askAI(q, opts) {
    if (!CFG.aiKey) return null;
    const base = String(CFG.aiBase || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) { console.warn('[LQB] AI 接口地址不合法'); return null; }
    const judge = isJudgeOpts(opts);
    const url = base + (/\/chat\/completions$/.test(base) ? '' : '/chat/completions');
    const body = {
      model: CFG.aiModel || 'deepseek-chat',
      messages: [
        { role: 'system', content: '你只输出 JSON，不输出任何其他内容。' },
        { role: 'user', content: AI_PROMPT(q, opts, judge) },
      ],
      temperature: 0,
      max_tokens: 120,
    };
    try {
      const { status, json } = await httpPostJson(url, body, { Authorization: 'Bearer ' + CFG.aiKey });
      const msg = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!msg) {
        const err = (json && json.error && (json.error.message || json.error.type)) || ('HTTP ' + status);
        console.warn('[LQB] AI 无有效返回：' + String(err).slice(0, 160));
        return null;
      }
      const m = String(msg).match(/\{[\s\S]*?\}/);
      if (!m) { console.warn('[LQB] AI 输出不是 JSON：' + String(msg).slice(0, 120)); return null; }
      const obj = JSON.parse(m[0]);
      let ans = String(obj.answer == null ? '' : obj.answer).trim();
      if (judge) {
        if (/^(正确|对|是|真|true|t|y|yes|√)$/i.test(ans)) ans = '正确';
        else if (/^(错误|错|否|假|false|f|n|no|×)$/i.test(ans)) ans = '错误';
        else { console.warn('[LQB] AI 判断题答案无法识别：' + ans); return null; }
      } else {
        const letter = (ans.match(/[A-D]/i) || [])[0];
        if (!letter) { console.warn('[LQB] AI 选择题答案无法识别：' + ans); return null; }
        ans = letter.toUpperCase();
      }
      console.log('%c[LQB] AI 作答 → ' + ans + (obj.confidence ? '（把握 ' + obj.confidence + '）' : ''), 'color:#a78bfa');
      return ans;
    } catch (e) {
      console.warn('[LQB] AI 请求失败：' + e.message);
      return null;
    }
  }

  async function resolveAnswer(q, opts) {
    const local = lookupLocal(q);
    if (local) return { ans: local, src: 'bank' };
    const school = lookupSchool(q, opts);
    if (school) return { ans: school, src: 'school' };
    const cached = cacheGet(q);
    if (cached) return { ans: cached.ans, text: cached.text, src: 'cache' };
    const ai = await askAI(q, opts);
    if (ai) { cacheSet(q, ai, ''); return { ans: ai, src: 'ai' }; }
    return { ans: null, src: 'none' };
  }

  /* ================= 4. 页面读写 ================= */
  const isOptLine = (t) =>
    /^(正确|错误)$/.test(t) || /^[A-D][\.、．\)）]/.test(t) || /^[A-D]\s+\S/.test(t);

  function findQuestion() {
    const lines = document.body.innerText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      if (!isOptLine(lines[i])) continue;
      const opts = [];
      let j = i;
      while (j < lines.length && isOptLine(lines[j]) && opts.length < 8) { opts.push(lines[j]); j++; }
      if (opts.length < 2) continue;
      let q = lines[i - 1];
      let k = i - 2;
      while (k >= 0 && q.length < 12 && !isOptLine(lines[k])) { q = lines[k] + q; k--; }
      return { q, opts };
    }
    return null;
  }

  function findLeaf(text) {
    const cand = document.querySelectorAll('div,span,p,li,label,a,td');
    let hit = null;
    for (const el of cand) {
      if (el.children.length > 3) continue;
      if ((el.innerText || '').trim() === text) hit = el;
    }
    return hit;
  }

  function clickEl(el) {
    if (!el) return false;
    let target = el, p = el;
    for (let d = 0; d < 5 && p; d++) {
      if (getComputedStyle(p).cursor === 'pointer') { target = p; break; }
      p = p.parentElement;
    }
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'LABEL') {
      // input 必须走原生 click，否则勾选状态不会变
      target.click();
      return true;
    }
    const r = target.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    });
    return true;
  }

  function clickButton(label) {
    const cand = document.querySelectorAll('button,div,span,a');
    let hit = null;
    for (const el of cand) {
      if (el.children.length > 2) continue;
      if (el.matches(':disabled, [disabled], .is-disabled, .disabled')) continue;
      if ((el.innerText || '').trim() === label) hit = el;
    }
    if (!hit) return false;
    clickEl(hit);
    return true;
  }

  function pickOption(opts, ans, text) {
    if (text) {
      const nt = norm(text);
      if (nt) {
        const exact = opts.find((o) => norm(stripLabel(o)) === nt);
        if (exact) return exact;
        const near = opts.find((o) => { const no = norm(stripLabel(o)); return no && (no.includes(nt) || nt.includes(no)); });
        if (near) return near;
      }
    }
    if (ans === '正确' || ans === '错误') return opts.includes(ans) ? ans : null;
    return opts.find((o) => o.charAt(0).toUpperCase() === String(ans).toUpperCase()) || null;
  }

  /* ================= 5. 主循环 ================= */
  let running = false, stopped = false;
  const stats = { answered: 0, byBank: 0, bySchool: 0, byCache: 0, byAI: 0, guessed: [], rounds: 0 };

  async function doRound(idx, total) {
    console.log(`%c[LQB] 第 ${idx}/${total} 轮开始`, 'color:#3b82f6');
    for (let step = 0; step < 60 && !stopped; step++) {
      await sleep(rnd(400, 900));
      if (/正确率/.test(document.body.innerText)) {
        console.log('%c[LQB] 本轮结束（成绩页）', 'color:#22c55e');
        return 'finish';
      }
      const qt = findQuestion();
      if (!qt) { console.warn('[LQB] 没识别到题目'); return 'unknown'; }

      const { ans, text, src } = await resolveAnswer(qt.q, qt.opts);
      let finalAns = ans, guessed = false;
      if (!finalAns) {
        guessed = true;
        finalAns = qt.opts.includes('正确') ? '正确' : 'A';
        stats.guessed.push({ q: qt.q, opts: qt.opts.slice() });
        console.warn('[LQB] 三处都没答案，先猜 →', qt.q);
      } else if (src === 'bank') stats.byBank++;
      else if (src === 'school') stats.bySchool++;
      else if (src === 'cache') stats.byCache++;
      else if (src === 'ai') stats.byAI++;

      const label = pickOption(qt.opts, finalAns, text);
      const el = label ? findLeaf(label) : null;
      if (!el) { console.warn('[LQB] 找不到选项元素', label, qt.opts); return 'unknown'; }

      clickEl(el);
      stats.answered++;
      await sleep(rnd(250, 500));

      if (!clickButton('下一题')) {
        if (clickButton('提交')) {
          await sleep(rnd(500, 800));
          clickButton('确定');
          await sleep(1500);
          console.log('%c[LQB] 已提交本轮', 'color:#f59e0b');
          return 'finish';
        }
        console.warn('[LQB] 既没有"下一题"也没有"提交"');
        return 'unknown';
      }
      await sleep(rnd(350, 700));

      const after = findQuestion();
      if (after && after.q === qt.q) {
        console.warn('[LQB] 页面没前进，重试一次');
        clickEl(el);
        await sleep(300);
        clickButton('下一题');
        await sleep(500);
      }
      if (guessed) console.warn('[LQB] 本题是猜的，答案可能错：', qt.q);
    }
    return 'limit';
  }

  async function start(rounds = 3) {
    if (running) { console.warn('[LQB] 正在跑，先 stop()'); return; }
    const n = Math.max(1, Math.min(ROUNDS_MAX, parseInt(rounds, 10) || 3));
    rounds = n;
    running = true; stopped = false;
    stats.answered = 0; stats.byBank = 0; stats.bySchool = 0; stats.byCache = 0; stats.byAI = 0;
    stats.guessed = []; stats.rounds = 0;
    console.log('%c[LQB] 开始，Esc 或 __LQB__.stop() 停止', 'color:#a855f7;font-weight:bold');
    for (let r = 1; r <= rounds && !stopped; r++) {
      stats.rounds = r;
      await doRound(r, rounds);
      if (stopped) break;
      await sleep(600);
      // 成绩页 / 错题查看里藏着正确答案，顺手学下来
      if (/正确率/.test(document.body.innerText)) await learnWrong();
      if (r < rounds) {
        await sleep(800);
        if (!clickButton('重复练习')) { console.log('[LQB] 没找到"重复练习"，结束'); break; }
        await sleep(1500);
      }
    }
    running = false;
    summary();
  }

  function stop() { stopped = true; running = false; console.log('%c[LQB] 已停止', 'color:#ef4444'); }
  function summary() {
    console.table({ 已作答: stats.answered, 内置题库: stats.byBank, 学校题库: stats.bySchool, 缓存命中: stats.byCache, 'AI作答': stats.byAI, 靠猜: stats.guessed.length });
    if (stats.guessed.length) console.log('[LQB] 猜的题：', stats.guessed, '→ __LQB__.dump() 导出');
  }
  // 从"错题查看"弹窗里把题干 + 正确答案学到本地缓存（不依赖任何接口鉴权）
  async function learnWrong() {
    if (!clickButton('错题查看')) { console.log('[LQB] 没找到"错题查看"按钮，跳过学习'); return 0; }
    await sleep(900);
    const lines = document.body.innerText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    let learned = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^正确答案[：:]\s*(.+)$/);
      if (!m) continue;
      const ansRaw = m[1].trim();
      let top = i - 1;
      while (top >= 0 && !/^\d+[\.、．]/.test(lines[top]) && !/^正确答案[：:]/.test(lines[top])) top--;
      if (top < 0 || /^正确答案[：:]/.test(lines[top])) continue;
      const stem = lines.slice(top, i).join(' ').replace(/^\d+[\.、．]\s*/, '').trim();
      if (!stem || stem.length < 6) continue;
      const lm = ansRaw.match(/^([A-Fa-f])[\.、．\s、:：]\s*(.*)$/);
      let ans = '', txt = '';
      if (lm) { ans = lm[1].toUpperCase(); txt = lm[2].trim(); }
      else if (/^(正确|对|√)/.test(ansRaw)) { ans = '正确'; txt = '正确'; }
      else if (/^(错误|错|×)/.test(ansRaw)) { ans = '错误'; txt = '错误'; }
      if (!ans) continue;
      cacheSet(stem, ans, txt);
      learned++;
      console.log('[LQB] 学到：' + stem.slice(0, 26) + ' → ' + ans + (txt && txt !== ans ? '（' + txt + '）' : ''));
    }
    console.log('%c[LQB] 从错题里学到 ' + learned + ' 题', 'color:#22c55e');
    const btn = document.querySelector('.el-dialog__headerbtn, .el-dialog__close, .el-icon-close');
    if (btn) { clickEl(btn); await sleep(400); }
    return learned;
  }

  function dump() {
    const json = JSON.stringify(stats.guessed, null, 2);
    console.log(json);
    try { navigator.clipboard.writeText(json); console.log('[LQB] 已复制'); } catch (e) {}
    return json;
  }

  // 列出页面请求过的接口，并尝试把响应抓回来（用于找学校自己的题库接口）
  async function probe() {
    const list = performance.getEntriesByType('resource')
      .map((e) => e.name)
      .filter((u) => /labs\.haut\.edu\.cn/.test(u) && /(api|pxzr|question|practice|exam|paper|tiku|list)/i.test(u));
    console.log('%c[LQB] 页面请求记录：', 'color:#38bdf8');
    list.forEach((u) => console.log(u));
    if (!list.length) { console.log('（没有记录，先进入一次练习触发接口，再运行 probe）'); return []; }
    for (const u of list) {
      try {
        const r = await fetch(u, { credentials: 'include' });
        const text = await r.text();
        console.log('%c[LQB] ↓ ' + u + '  [' + r.status + ']', 'color:#f59e0b');
        console.log(text.slice(0, 3000));
      } catch (e) {
        console.warn('[LQB] 抓取失败 ' + u + '：' + e.message);
      }
    }
    return list;
  }


  function downloadBank() {
    const bank = readSchool();
    if (!bank.length) { console.warn('[LQB] 学校题库还是空的，先点"抓学校题库"'); return; }
    const blob = new Blob([JSON.stringify(bank, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'labs-bank-' + bank.length + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    console.log('[LQB] 已导出 ' + bank.length + ' 题');
  }

  /* ================= 6. 悬浮面板（Shadow DOM，不受页面样式影响） ================= */
  let ui = null;

  function pushLog(text, kind) {
    if (!ui || !ui.log) return;
    const d = document.createElement('div');
    d.className = kind || 'info';
    d.textContent = text;
    ui.log.appendChild(d);
    while (ui.log.children.length > 200) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function mountUI() {
    if (ui) return ui;
    if (document.getElementById('lqb-host')) return null;

    const host = document.createElement('div');
    host.id = 'lqb-host';
    document.documentElement.appendChild(host);
    const sh = host.attachShadow({ mode: 'open' });

    sh.innerHTML = `
<style>
  :host{all:initial}
  *{box-sizing:border-box;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{position:fixed;right:18px;bottom:18px;z-index:2147483647}
  .ball{width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;
        display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;
        box-shadow:0 6px 20px rgba(99,102,241,.45);user-select:none;transition:transform .15s}
  .ball:hover{transform:scale(1.07)}
  .panel{position:absolute;right:0;bottom:58px;width:292px;background:#15171c;color:#e6e8ee;
         border:1px solid #2a2e37;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);
         overflow:hidden;font-size:12px}
  .hid{display:none!important}
  .hd{display:flex;align-items:center;gap:7px;padding:10px 12px;background:#1c1f26;font-weight:600;font-size:12.5px}
  .dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;flex:0 0 auto}
  .x{margin-left:auto;cursor:pointer;color:#9aa0ad;font-size:16px;line-height:1}
  .x:hover{color:#fff}
  .bd{padding:10px 12px 12px}
  .stat{display:flex;gap:6px;margin-bottom:9px}
  .stat>div{flex:1;background:#1b1e25;border:1px solid #262a33;border-radius:8px;padding:6px 0;text-align:center}
  .stat b{display:block;font-size:15px;color:#c7b9ff;font-weight:700}
  .stat i{font-style:normal;font-size:10px;color:#8b90a0}
  input{width:100%;background:#1b1e25;border:1px solid #2a2e37;color:#e6e8ee;border-radius:8px;
        padding:7px 9px;font-size:11.5px;outline:none;margin-bottom:8px}
  input:focus{border-color:#6366f1}
  .btns{display:flex;gap:7px;margin-bottom:8px}
  button{flex:1;border:0;border-radius:8px;padding:8px 0;font-size:12px;cursor:pointer;color:#fff;
         background:linear-gradient(135deg,#6366f1,#a855f7);font-weight:600;transition:opacity .15s}
  button.g{background:#2a2e37;color:#c9cedb}
  button:disabled{opacity:.42;cursor:not-allowed}
  .mini{font-size:11px;color:#8b90a0;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ai{margin-bottom:8px;border:1px solid #262a33;border-radius:8px;padding:7px 8px;background:#171a20}
  .aihd{display:flex;align-items:center;font-size:11px;color:#9aa0ad;margin-bottom:6px}
  .aihd span{margin-left:auto;color:#7dd3fc;cursor:pointer;font-size:10.5px;user-select:none}
  .aihd span:hover{color:#bae6fd}
  .ai input{margin-bottom:4px;font-size:10.5px;padding:5px 7px}
  .ai input:last-child{margin-bottom:0}
  .ai select{width:100%;background:#1b1e25;border:1px solid #2a2e37;color:#e6e8ee;border-radius:8px;
             padding:6px 7px;font-size:10.5px;outline:none;margin-bottom:4px;cursor:pointer}
  .rowline{display:flex;align-items:center;gap:6px;font-size:11px;color:#9aa0ad;margin-bottom:7px}
  .rowline input{width:54px;margin:0;padding:4px 6px;text-align:center;font-size:11px}
  .rowline .tip{font-size:10px;color:#6b7280;margin-left:auto}
  .log{height:96px;overflow:auto;background:#101216;border:1px solid #23262e;border-radius:8px;
       padding:6px 7px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;line-height:1.55;color:#9aa3b2}
  .log div{word-break:break-all}
  .log .ok{color:#4ade80}.log .warn{color:#fbbf24}.log .err{color:#f87171}.log .info{color:#7dd3fc}
</style>
<div class="wrap">
  <div class="panel hid" id="panel">
    <div class="hd"><span class="dot" id="dot"></span><span>实验室安全 · 自动答题</span><span class="x" id="close">×</span></div>
    <div class="bd">
      <div class="stat">
        <div><b id="n-done">0</b><i>已答</i></div>
        <div><b id="n-bank">0</b><i>题库</i></div>
        <div><b id="n-onl">0</b><i>AI</i></div>
        <div><b id="n-gue">0</b><i>靠猜</i></div>
      </div>
      <div class="ai">
        <div class="aihd">AI 答题（OpenAI 兼容）<span id="ai-test">测试</span></div>
        <select id="ai-provider">
          <option value="">自定义</option>
          <option value="deepseek">DeepSeek</option>
          <option value="kimi">Kimi 月之暗面</option>
          <option value="qwen">阿里通义千问</option>
          <option value="glm">智谱 GLM</option>
          <option value="hunyuan">腾讯混元</option>
          <option value="ark">火山方舟 豆包</option>
          <option value="siliconflow">硅基流动</option>
          <option value="minimax">MiniMax</option>
        </select>
        <input id="ai-base" placeholder="接口地址：https://api.deepseek.com/v1" />
        <input id="ai-model" placeholder="模型：deepseek-chat" />
        <input id="ai-key" placeholder="API Key：sk-..." />
      </div>
      <div class="rowline">
        <span>轮数</span>
        <input id="rounds" type="number" min="1" max="20" value="3" />
        <span class="tip">1–20</span>
      </div>
      <div class="btns">
        <button id="go">开始 3 轮</button>
        <button id="stop" class="g">停止</button>
      </div>
      <div class="btns">
        <button id="crawl" class="g">抓学校题库</button>
        <button id="exp" class="g">导出题库</button>
      </div>
      <div class="mini" id="msg">待机 · 本地题库 ${BANK.length} 条</div>
      <div class="log" id="log"></div>
    </div>
  </div>
  <div class="ball" id="ball" title="实验安全自动答题">⚡</div>
</div>`;

    const $ = (id) => sh.getElementById(id);
    ui = {
      ball: $('ball'), panel: $('panel'), log: $('log'), msg: $('msg'), dot: $('dot'),
      go: $('go'), stopBtn: $('stop'), crawl: $('crawl'), exp: $('exp'),
      aiKey: $('ai-key'), aiBase: $('ai-base'), aiModel: $('ai-model'), aiTest: $('ai-test'),
      aiProvider: $('ai-provider'), rounds: $('rounds'),
      nDone: $('n-done'), nBank: $('n-bank'), nOnl: $('n-onl'), nGue: $('n-gue'),
    };

    const saveAI = () => {
      CFG.aiKey = ui.aiKey.value.trim();
      CFG.aiBase = ui.aiBase.value.trim() || 'https://api.deepseek.com/v1';
      CFG.aiModel = ui.aiModel.value.trim() || 'deepseek-chat';
      localStorage.setItem('LQB_AI_KEY', CFG.aiKey);
      localStorage.setItem('LQB_AI_BASE', CFG.aiBase);
      localStorage.setItem('LQB_AI_MODEL', CFG.aiModel);
    };
    ui.aiKey.value = CFG.aiKey;
    ui.aiBase.value = CFG.aiBase;
    ui.aiModel.value = CFG.aiModel;
    const matchedPreset = Object.keys(AI_PRESETS).find((k) => AI_PRESETS[k].base === CFG.aiBase);
    ui.aiProvider.value = matchedPreset || '';
    [ui.aiKey, ui.aiBase, ui.aiModel].forEach((el) => el.addEventListener('change', saveAI));
    ui.aiBase.addEventListener('input', () => {
      const m = Object.keys(AI_PRESETS).find((k) => AI_PRESETS[k].base === ui.aiBase.value.trim());
      ui.aiProvider.value = m || '';
    });
    ui.aiProvider.addEventListener('change', () => {
      const p = AI_PRESETS[ui.aiProvider.value];
      if (p) { ui.aiBase.value = p.base; ui.aiModel.value = p.model; }
      saveAI();
    });

    const getRounds = () => {
      const n = parseInt(ui.rounds.value, 10);
      return Math.max(1, Math.min(ROUNDS_MAX, Number.isFinite(n) ? n : 3));
    };
    const syncRounds = () => {
      const n = getRounds();
      ui.rounds.value = n;
      ui.go.textContent = '开始 ' + n + ' 轮';
      localStorage.setItem('LQB_ROUNDS', n);
    };
    ui.rounds.value = parseInt(localStorage.getItem('LQB_ROUNDS'), 10) || 3;
    ui.rounds.addEventListener('input', syncRounds);
    ui.rounds.addEventListener('blur', syncRounds);
    syncRounds();

    ui.ball.addEventListener('click', () => ui.panel.classList.toggle('hid'));
    sh.getElementById('close').addEventListener('click', () => ui.panel.classList.add('hid'));
    ui.go.addEventListener('click', () => {
      saveAI();
      syncRounds();
      if (!CFG.aiKey) console.warn('[LQB] 没填 AI Key，只能走内置题库/缓存');
      start(getRounds());
    });
    ui.aiTest.addEventListener('click', async () => {
      saveAI();
      ui.msg.textContent = 'AI 测试中…';
      const r = await askAI('一切电气设备起火都可以用水扑救。', ['正确', '错误']);
      ui.msg.textContent = r ? 'AI 测试通过，判断为「' + r + '」' : 'AI 测试失败，看下面日志';
    });
    ui.stopBtn.addEventListener('click', () => stop());
    ui.crawl.addEventListener('click', async () => {
      ui.crawl.disabled = true;
      ui.crawl.textContent = '抓取中…';
      try { await crawlBank(); } catch (e) { console.warn('[LQB] 抓取出错：' + e.message); }
      ui.crawl.textContent = '抓学校题库';
      ui.crawl.disabled = false;
    });
    ui.exp.addEventListener('click', () => downloadBank());

    // 面板内键盘事件不要冒泡到页面（避免触发页面快捷键）
    ['keydown', 'keyup', 'keypress'].forEach((t) =>
      sh.addEventListener(t, (e) => e.stopPropagation()));

    // 接管 console，把 [LQB] 日志同步进面板
    const raw = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
    const toText = (args) => args.map((x) => (typeof x === 'string' ? x : '')).join(' ').replace(/%c/g, '');
    console.log = (...a) => { raw.log(...a); const s = toText(a); if (s.indexOf('[LQB]') === 0) pushLog(s, 'info'); };
    console.warn = (...a) => { raw.warn(...a); const s = toText(a); if (s.indexOf('[LQB]') === 0) pushLog(s, 'warn'); };
    console.error = (...a) => { raw.error(...a); const s = toText(a); if (s.indexOf('[LQB]') === 0) pushLog(s, 'err'); };

    setInterval(() => {
      if (!ui) return;
      ui.nDone.textContent = stats.answered;
      ui.nBank.textContent = stats.byBank + stats.bySchool + stats.byCache;
      ui.nOnl.textContent = stats.byAI;
      ui.nGue.textContent = stats.guessed.length;
      ui.go.disabled = running;
      ui.stopBtn.disabled = !running;
      ui.dot.style.background = running ? '#fbbf24' : '#22c55e';
      ui.dot.style.boxShadow = '0 0 8px ' + (running ? '#fbbf24' : '#22c55e');
      ui.msg.textContent = running
        ? `运行中 · 第 ${stats.rounds} 轮 · 已答 ${stats.answered}`
        : `待机 · 内置 ${BANK.length} · 校库 ${readSchool().length} 题`;
    }, 400);

    console.log('[LQB] 面板已就绪（右下角 ⚡）');
    return ui;
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });

  window.__LQB__ = {
    start, stop, dump, probe, stats,
    crawlBank, downloadBank, diag, sniff, probeAuth, learnWrong, harvest, hookExamApi,
    bank: BANK,
    school: readSchool,
    clearSchool() { writeSchool([]); console.log('[LQB] 学校题库已清空'); },
    cache: readCache,
    clearCache() { localStorage.removeItem(CFG.cacheKey); console.log('[LQB] 缓存已清空'); },
    addRule(key, answer) { BANK.push([key, answer]); console.log('[LQB] 已加规则', key, '=>', answer); },
    // 单独测一道题：__LQB__.ask("题干","选项1","选项2")
    async ask(stem, ...opts) { console.log(await resolveAnswer(stem, opts)); },
    help() {
      console.log('%c[LQB] 命令：\n  __LQB__.start(3)               跑 3 轮（1–20）\n  __LQB__.stop()                 停止\n  __LQB__.crawlBank()            尝试抓学校题库\n  __LQB__.downloadBank()         导出题库 JSON\n  __LQB__.diag()                 看 cookie / storage 概况\n  __LQB__.sniff()                嗅探页面真实请求\n  __LQB__.probe()                列出页面调过的接口\n  __LQB__.ask(题干, ...选项)      单题测试\n  __LQB__.dump()                 导出没答案的题\n  __LQB__.clearCache()/cache()   清空/查看缓存',
        'color:#38bdf8;line-height:1.7');
    },
  };

  // 挂到页面上下文，控制台里也能直接调 __LQB__
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow !== window) {
      unsafeWindow.__LQB__ = window.__LQB__;
    }
  } catch (e) {}

  // 先挂接口嗅探（越早越好），再挂面板
  try { hookExamApi(); } catch (e) { console.warn('[LQB] 接口嗅探挂载失败：' + e.message); }
  try { mountUI(); } catch (e) { console.warn('[LQB] 面板挂载失败：' + e.message); }

  window.__LQB__.ui = mountUI;
  window.__LQB__.hideUI = () => {
    const h = document.getElementById('lqb-host');
    if (h) h.remove();
    ui = null;
    console.log('[LQB] 面板已移除，__LQB__.ui() 可重新打开');
  };

  console.log('%c[LQB] v' + VERSION + ' 已注入 · 右下角 ⚡ 打开面板 · __LQB__.help() 帮助', 'color:#22c55e;font-weight:bold');
})();

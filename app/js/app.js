/* 到此一游 HIKERS —— 路由、页面与交互 */
(function () {
  'use strict';
  var H = window.HIKES, U = window.UI, esc = U.esc;

  /* ==================== 状态 ==================== */
  var S = {
    visited: U.load('visited', H.visitedSeed.slice()),
    want: U.load('want', H.wantSeed.slice()),
    joined: U.load('joined', []),
    claps: U.load('claps', {}),
    myComments: U.load('myComments', {}),
    myIntel: U.load('myIntel', []),
    intelUp: U.load('intelUp', {}),
    letters: U.load('letters', []),
    friends: U.load('friends', {}),
    pb: U.load('pb', { dongling: '03:05' }),
    mySeqs: U.load('mySeqs', {}),
    myActs: U.load('myActs', [])
  };
  function persist() {
    ['visited', 'want', 'joined', 'claps', 'myComments', 'myIntel', 'intelUp',
      'letters', 'friends', 'pb', 'mySeqs', 'myActs'].forEach(function (k) { U.save(k, S[k]); });
  }
  window.APP_S = S;          /* 让 api.js 把后端数据灌进来 */

  /* 列表只渲染当前页；本次浏览里第 4 次点「下一页」时提醒游客注册。 */
  var PAGE_SIZE = 5, CAROUSEL_PAGE = 6;
  var pages = { trailHot: 0, trails: 0, peaks: 0, peakHot: 0, junctions: 0 };
  var nextPageClicks = 0, browseSignupShown = false;
  function pageCount(total, size) { return Math.max(1, Math.ceil(total / size)); }
  function pageSlice(rows, key, size) {
    pages[key] = Math.min(pages[key] || 0, pageCount(rows.length, size) - 1);
    return rows.slice(pages[key] * size, (pages[key] + 1) * size);
  }
  function pager(key, total, size) {
    var count = pageCount(total, size), p = Math.min(pages[key] || 0, count - 1);
    if (count < 2) return '';
    return '<nav class="list-pager" aria-label="列表分页">' +
      '<button data-act="page-prev" data-val="' + key + '"' + (p === 0 ? ' disabled' : '') + '>‹ 上一页</button>' +
      '<span>第 ' + (p + 1) + ' / ' + count + ' 页</span>' +
      '<button data-act="page-next" data-val="' + key + '"' + (p >= count - 1 ? ' disabled' : '') + '>下一页 ›</button>' +
      '</nav>';
  }
  function resetPages() { pages.trails = pages.peaks = pages.peakHot = pages.junctions = 0; }

  /* ---------- 关注要落库 ----------
     「想去 / 收藏」不能只躺在 localStorage 里：热门登顶榜的"用户关注度"
     数的是服务端那张 wants 表。只在浏览器里点，服务端永远算不出来。 */
  var _tk = null;
  var _collaborationAfterAuth = null;
  function apiToken() {
    if (_tk) return Promise.resolve(_tk);
    try { _tk = localStorage.getItem('hikes.auth.token'); } catch (e) { _tk = null; }
    return Promise.resolve(_tk);
  }
  function wantKindOf(id) {
    if ((H.trails || []).some(function (t) { return t.id === id; })) return 'trail';
    if ((H.peaks || []).some(function (p) { return p.id === id; })) return 'peak';
    return null;      /* 岔路还是本地 mock id，不上报，免得往表里写脏 key */
  }
  function syncWant(id, on) {
    var kind = wantKindOf(id);
    if (!kind) return;
    apiToken().then(function (tk) {
      if (!tk) return;
      var url = '/api/wants';
      var opt = { method: on ? 'POST' : 'DELETE',
                  headers: { Authorization: 'Bearer ' + tk } };
      if (on) {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify({ kind: kind, target_key: id });
      } else {
        url += '?kind=' + kind + '&target_key=' + encodeURIComponent(id);
      }
      /* 静默失败：本地那份是即时反馈的来源，服务端只用来算关注度 */
      return fetch(url, opt).catch(function () {});
    });
  }

  /* ==================== 查询 ==================== */
  function trail(id) { return H.trails.filter(function (t) { return t.id === id; })[0]; }
  function peak(id) { return H.peaks.filter(function (p) { return p.id === id; })[0]; }
  function junction(id) { return H.junctions.filter(function (j) { return j.id === id; })[0]; }
  function isWant(id) { return S.want.indexOf(id) >= 0; }
  function beenThere(id) { return S.visited.some(function (v) { return v.id === id; }); }
  function commentsFor(id) {
    var mine = (S.myComments[id] || []).map(function (c) {
      return { who: 'me', when: c.when, text: c.text, mine: true };
    });
    var base = [];
    var p = peak(id); if (p && p.comments) base = base.concat(p.comments);
    var t = trail(id); if (t && t.comments) base = base.concat(t.comments);
    return mine.concat(base);
  }
  function intelFor(j) {
    var extra = S.myIntel.filter(function (i) { return i.jid === j.id; }).map(function (i) {
      return { id: i.id, who: 'me', when: '刚刚', ok: false, title: i.title, text: i.text, confirm: 1, mine: true };
    });
    return extra.concat(j.intel);
  }
  function placeOf(type, id) {
    if (type === 'peak') return peak(id);
    if (type === 'junction') return junction(id);
    if (type === 'trail') return trail(id);
    return null;
  }
  function personByName(name) {
    if (name === '你' || name === '我') return H.me;
    var byId = Object.keys(H.people).map(function (k) { return H.people[k]; })
      .filter(function (p) { return p.name === name; })[0];
    var hit = byId || H.peoples.filter(function (p) { return p.name === name; })[0];
    return hit || { name: name, av: String(name).slice(0, 1), tone: 'a4' };
  }

  /* 留言 / 情报的作者有两种写法，得都认：
     演示数据和关系表里存的是人物 key（chuan / yu / zhou…），
     服务端返回的是用户自己写的**昵称**（点位的第一条留言就是创建人昵称）。
     以前只查 H.people[who]，第二种会取到 undefined，
     esc(person.name) 直接抛错——用户点位的详情页整页空白。
     顺序不能反：先按 key 查，查不到再按名字查。 */
  function personOf(who) {
    if (who === 'me' || who === '你' || who === '我') return H.me;
    return H.people[who] || personByName(who);
  }
  function linkTo(p) {
    if (p.type === 'me') return '#/me/' + p.id;          /* 山间信箱 / 我的山头 这类"回到我自己"的上下文 */
    return p.type === 'peak' ? '#/peaks/' + p.id : p.type === 'junction' ? '#/junctions/' + p.id : '#/trails/' + p.id;
  }

  /* ==================== 片段 ==================== */
  function rankRows(rows, opts) {
    opts = opts || {};
    return rows.map(function (r, i) {
      var mine = r.mine || r.who === '我';
      return '<div class="rank' + (i === 0 ? ' p1' : '') + (mine ? ' me' : '') + '">' +
        '<span class="pos">' + (r.pos || i + 1) + '</span>' +
        (r.thumb ? '<span class="thumb">' + U.scene(r.thumb) + '</span>' : (r.av ? U.avatar(r.av) : '')) +
        '<span class="nm"><b>' + esc(r.name || r.who) + '</b><em>' + esc(r.sub || r.when || '') + '</em></span>' +
        (r.right ? '<span class="tm" style="font-size:12px;color:var(--ink3)">' + esc(r.right) + '</span>'
          : '<span class="tm"' + (opts.tmSmall ? ' style="font-size:12px"' : '') + '>' + esc(r.time || '') + '</span>') +
        '</div>';
    }).join('');
  }

  function postCard(p) {
    var person = H.people[p.who];
    var clapped = !!S.claps[p.id];
    return '<div class="item">' +
      '<div class="ph" style="height:' + p.h + 'px">' + U.scene(p.place.id) +
      (p.seq ? '<span class="seq">' + esc(p.seq) + '</span>' : '') + '</div>' +
      '<div class="body">' +
      '<div class="who">' + U.avatar(person) + esc(person.name) + ' · ' + esc(p.when) + '</div>' +
      '<div class="txt">' + esc(p.text) + '</div>' +
      '<a class="place" href="' + linkTo(p.place) + '">' + esc(p.place.name) + ' ›</a>' +
      '<div class="foot">' +
      '<button class="clap' + (clapped ? ' on' : '') + '" data-act="clap" data-id="' + p.id + '">' +
      U.icon('clap', 's') + ' 击掌 <b>' + (p.claps + (clapped ? 1 : 0)) + '</b></button>' +
      '<span>' + U.icon('chat', 's') + ' ' + p.comments + '</span>' +
      '</div></div></div>';
  }

  function trailCard(t) {
    return '<a class="trailcard" href="#/trails/' + t.id + '">' +
      '<div class="tc-top">' +
      '<span class="tc-name">' + esc(t.name) + '</span>' +
      '<button class="favbtn flat" data-act="want" data-id="' + t.id + '" data-on="♥" data-off="♡">' +
      (isWant(t.id) ? '♥' : '♡') + '</button></div>' +
      '<div class="tc-mid">' + (t.detailError
        ? '<span class="trk trk-tc trk-unavailable">轨迹暂不可用</span>'
        : apiTrackSVG(t, true)) +
      '<div class="tc-stats">' +
      '<div class="tcs"><span>长度</span><b>' + t.km + ' km</b></div>' +
      '<div class="tcs"><span>累计爬升</span><b class="hi">' + t.up + ' m</b></div>' +
      '<div class="tcs"><span>参考用时</span><b class="who">' + esc(t.hours) + '</b></div>' +
      '</div></div>' +
      '<div class="tc-bot"><span class="tc-dim">' + t.km + ' km · ↗ ' + t.up + ' m</span>' +
      '<span class="tc-dim">参考用时 ' + esc(t.hours) + '</span></div>' +
      '</a>';
  }

  function compactRow(o) {
    var inner =
      (o.pos != null ? '<span class="pos">' + o.pos + '</span>' : '') +
      (o.thumb ? U.trackBox(o.thumb, 'trk-xs') : '') +
      '<span class="nm"><b>' + esc(o.title) + '</b><em>' + esc(o.sub) + '</em></span>' +
      '<span class="tm" style="font-size:12px">' + (o.level ? U.levelBadge(o.level) : esc(o.right)) + '</span>';
    /* 有 href 就整行可点：详情页是每条线路都该有的入口，
       不能只有热门轮播那几张卡点得进去 */
    return o.href
      ? '<a class="rank" href="' + o.href + '">' + inner + '</a>'
      : '<div class="rank">' + inner + '</div>';
  }

  function intelCard(i, jid) {
    var up = !!S.intelUp[i.id];
    var person = personOf(i.who);
    return '<div class="intel' + (i.ok ? ' ok' : '') + '">' +
      '<div class="hd">' + U.avatar(person) + esc(person.name) +
      (i.by ? ' · ' + esc(i.by) : '') + (i.when ? ' · ' + esc(i.when) : '') +
      '<span class="tag ' + (i.ok ? 'ok' : 'wait') + '">' + (i.ok ? '已核验' : '待核验') + '</span></div>' +
      '<b class="t">' + esc(i.title) + '</b><p>' + esc(i.text) + '</p>' +
      '<div class="foot"><button data-act="intel-up" data-id="' + i.id + '" class="' + (up ? 'on' : '') + '">' +
      (up ? '✓ 你已确认' : '我也遇到了') + '</button>' +
      '<span>' + (i.confirm + (up ? 1 : 0)) + ' 人确认</span>' +
      '<span style="margin-left:auto">' + esc(i.when || '') + '</span></div></div>';
  }

  function commentCard(c) {
    if (c.real) return '<div class="comment"><div class="ph">' +
      U.avatar({ av: (c.who || '山').slice(0, 1), name: c.who || '山友' }) +
      esc(c.who || '山友') + ' · ' + esc(c.when) + '</div><p>' + esc(c.text) + '</p></div>';
    var person = personOf(c.who);
    return '<div class="comment"><div class="ph">' + U.avatar(person, c.who === 'me' ? 'a1' : null) +
      esc(person.name) + ' · ' + esc(c.when) + (c.mine ? ' · 我发的' : '') + '</div>' +
      '<p>' + esc(c.text) + '</p></div>';
  }

  /* ==================== 广告位 ====================
     每个山头一个轮播广告位，能挂几条由维护人等级决定；首页和路书页各有一个
     全站广告轮播位。所有卡片都明标「广告」，不做原生混排——这是产品信誉的事。 */
  function adCard(a) {
    /* 山头详情的路由 id 是 p-{编号}（H.peaks 的 id），不是数据库里的数字 id */
    var href = a.link || ('#/peaks/p-' + a.pointCode);
    return '<a class="slide" href="' + href + '">' +
      '<div class="ph">' + U.scene('ad-' + a.id) + '<div class="scrim"></div>' +
      '<div class="ovl tl"><h4>' + esc(a.title) + '</h4>' +
      (a.body ? '<div class="st">' + esc(a.body) + '</div>' : '') +
      '<div class="st" style="opacity:.7">广告 · ' + esc(a.peakName || a.pointCode || '') + '</div>' +
      '</div></div></a>';
  }

  function adCarousel(list, title) {
    if (!list || !list.length) return '';
    return '<div class="sec-head" style="margin-top:14px"><h3>' + esc(title || '山友的推荐') +
      '</h3><span class="more">广告 · ' + list.length + ' 条</span></div>' +
      '<div class="carousel">' + list.map(adCard).join('') + '</div>';
  }

  /* 这个山头是不是我负责的（维护人 / 山大王），广告入口只给这两种人看 */
  function myPeakRole(code) {
    var m = (H.mySummits || []).filter(function (x) {
      return x.code === code || (x.boardPointCodes || []).indexOf(code) >= 0;
    })[0];
    return m ? m.role : null;
  }

  function maintainerAdEntry(p) {
    var ads = adsOf(p.code);
    var n = ads.first.length + ads.board.length;      /* 在架 = 首屏 + 留言区 */
    return '<button class="rowlink" style="width:100%;text-align:left;margin:0 0 12px" ' +
      'data-act="ad-panel" data-code="' + esc(p.code) + '">' +
      '<span class="em">📣</span><div class="tx"><b>你是这座山的维护人 · 管理广告位</b>' +
      '<span>当前在架 ' + n + ' 条 · 投放新广告 / 看待审状态</span></div>' +
      '<span class="ar">›</span></button>';
  }

  /* 某个点位（山头 / 岔路口）的广告位怎么摆：
     **默认全部在留言区最上面（第一屏之外）**；
     只有审核时被"放第一屏"的那几条才提到首屏。 */
  function adsOf(code) {
    var point = (H.peaks || []).filter(function (p) { return p.code === code; })[0];
    var codes = point && point.boardPointCodes || [code];
    var all = point && point.boardAds || (H.ads || []).filter(function (a) {
      return codes.indexOf(a.pointCode) >= 0;
    });
    return {
      first: all.filter(function (a) { return a.promoted; }),
      board: all.filter(function (a) { return !a.promoted; })
    };
  }

  /* 维护人的广告面板：单板展示位、我提交的版本与投放表单 */
  var adPanelItems = [];
  function sheetAdPanel(code) {
    U.openSheet('<h3>广告位 · 维护人</h3><div class="sh-sub">正在加载…</div>');
    window.API.ja('/api/points/' + code + '/ads').then(function (d) {
      var el = document.getElementById('sheet');
      if (!el) return;
      adPanelItems = d.mine || [];
      var q = d.quota || { level: 1, levelName: '每板一位', used: 0, total: 1 };
      var st = { draft: '草稿', pending: '待审', approved: '已上架', expired: '已过期' };
      el.innerHTML = '<h3>广告位 · 维护人</h3>' +
        '<div class="sh-sub">每块留言板一个广告位 · 当前展示 ' + q.used + ' / ' + q.total + '</div>' +
        ((d.mine || []).length
          ? '<div class="card tight">' + d.mine.map(function (a) {
              return '<div style="padding:9px 0;border-bottom:1px solid var(--hair)">' +
                '<b style="font-size:13.5px">' + esc(a.title) + '</b>' +
                '<em style="font-style:normal;display:block;font-size:11.5px;color:var(--ink3)">' +
                (a.status === 'rejected' ? '被拒：' + esc(a.rejectReason || '不符合投放规范')
                                         : (st[a.status] || a.status)) +
                ' · 到 ' + String(a.endsAt).slice(0, 10) + '</em>' +
                ((a.status === 'draft' || a.status === 'rejected')
                  ? '<button class="btn ghost mini" data-act="ad-edit" data-id="' + a.id + '">编辑并重提</button>' : '') +
                '</div>';
            }).join('') + '</div>'
          : '<div class="empty">还没投过广告。</div>') +
        '<input id="adEditId" type="hidden" value="">' +
        '<div class="fld"><label>主标题</label><input id="adTitle" placeholder="例：大觉寺 · 免费热水"></div>' +
            '<div class="fld"><label>一行说明</label><input id="adBody" placeholder="例：凭号码布免费灌热水"></div>' +
            '<div class="fld"><label>点进去去哪（可留空）</label><input id="adLink" placeholder="#/places 或 https://…"></div>' +
            '<div class="fld"><label>投放天数</label><input id="adDays" type="number" value="30" min="1" max="30"></div>' +
            '<button class="btn ghost" data-act="ad-save-draft" data-code="' + esc(code) + '">保存草稿</button>' +
            '<button class="btn coral" style="margin-top:9px" data-act="ad-submit" data-code="' + esc(code) + '">提交审核</button>' +
        '<div class="hint">新素材通过审核后替换当前展示，不会增加广告位。</div>' +
        '<button class="btn ghost" style="margin-top:9px" data-act="close">关闭</button>';
    }).catch(function () {
      var el = document.getElementById('sheet');
      if (el) el.innerHTML = '<h3>广告位 · 维护人</h3><div class="empty">没加载出来，重新加载页面试试。</div>' +
        '<button class="btn ghost" data-act="close">关闭</button>';
    });
  }

  /* ==================== 首页 ==================== */
  /* 首页"扫码打卡"下面那条线路信息：每次进首页随机取一条，之后每 3 秒翻牌换下一条。
     数据来自库里的全量线路（api.js 取 /api/routes?limit=300），不是写死的。 */
  var FEATURED_MS = 3000;
  var FLIP_MS = 280;           /* 翻牌：翻一半的时长（CSS 里 .hf-text 的 transition 同值） */
  var TYPE_MS = 45;            /* 打字机：每个字的间隔（路书页那条用它） */
  /* 系统开了"减少动态效果"就按设计降级成瞬切。审查动画的人常常不想改系统设置：
     URL 加 ?motion=1 就强制播动画，同时给 <html> 加 .force-motion 让 CSS 降级规则让位。 */
  function motionAllowed() {
    var force = /[?&]motion=1(&|$)/.test(location.search);
    document.documentElement.classList[force ? 'add' : 'remove']('force-motion');
    return force || !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function randomTrail(exclude) {
    var list = H.trails || [];
    if (list.length < 2) return list[0] || null;
    var pick = exclude, guard = 0;
    /* 别抽到刚展示过的那条，否则看着像卡住了 */
    while ((!pick || pick.id === (exclude && exclude.id)) && guard++ < 12) {
      pick = list[Math.floor(Math.random() * list.length)];
    }
    return pick || list[0];
  }
  function featuredLabel(t) {
    return '去看路书：' + t.name + '，' + t.km + ' 公里，爬升 ' + t.up + ' 米';
  }
  function hfMeta(t) {
    return (t.km != null ? t.km + ' km · 爬升 ' + t.up + ' m' : '');
  }
  function featuredBoxHTML(id, t) {
    return '<a class="home-featured hf-flip" id="' + id + '"' +
      (t ? ' data-id="' + esc(t.id) + '" aria-label="' + esc(featuredLabel(t)) + '"' : '') +
      ' href="' + (t ? '#/trails/' + encodeURIComponent(t.id) : '#/trails') + '">' +
      U.icon('hill') +
      '<span class="hf-text"><strong class="hf-name">' + esc(t ? t.name : '去看路书') +
      '</strong><span class="hf-meta">' + esc(t ? hfMeta(t) : '') + '</span></span>' +
      '<b aria-hidden="true">›</b></a>';
  }

  var homeData = null;
  var homeLoading = false;
  var homeStaleTokenCleared = false;
  function loadHomeData() {
    if (homeLoading) return;
    homeLoading = true;
    window.API.token().then(function (token) {
      return token ? Promise.resolve({ token: token, guest: false }) :
        window.API.guestToken().then(function (guest) { return { token: guest, guest: true }; });
    }).then(function (identity) {
      if (!identity.token) return { summary: [], receipts: [] };
      var base = identity.guest ? '/api/guest/' : '/api/me/';
      var headers = identity.guest ? { 'X-Guest-Token': identity.token } :
        { Authorization: 'Bearer ' + identity.token };
      function load(path) { return fetch(base + path, { headers: headers }).then(function (r) {
        if (r.status === 401 && !identity.guest) {
          // 本地存着一个过期的登录令牌：这不是"数据读不到"，而是身份过期。
          var expired = new Error('登录状态已过期');
          expired.status = 401;
          throw expired;
        }
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }); }
      return Promise.allSettled([load('mountain-summary?limit=3'), load('visit-receipts?limit=1')])
        .then(function (results) {
          var expired = results.some(function (r) {
            return r.status === 'rejected' && r.reason && r.reason.status === 401;
          });
          if (expired && !homeStaleTokenCleared) {
            /* 过期的令牌要清掉、退回游客身份再看一次：否则首页会一直显示
               "暂时无法读取"，用户以为站点坏了，其实是登录过期。 */
            homeStaleTokenCleared = true;
            try {
              localStorage.removeItem('hikes.auth.token');
              localStorage.removeItem('hikes.auth.userId');
            } catch (e) { /* 隐身模式 */ }
            window.API.setToken(null);
            homeLoading = false;
            homeData = null;
            U.toast('登录状态已过期，先按游客身份显示；重新登录后能看到账号里的记录');
            loadHomeData();
            return null;
          }
          return {
            summary: results[0].status === 'fulfilled' ? results[0].value : null,
            receipts: results[1].status === 'fulfilled' ? results[1].value : null
          };
        });
    }).then(function (data) {
      if (!data) return null;      // 过期令牌那条分支已经自己重排了
      // 待同步记录单独算：失败/等待登录的记录要能在首页说清楚，而不是只报个总数
      return window.HIKES_CHECKIN.summary().catch(function () {
        return { pending: 0, failed: 0, blocked: 0, total: 0 };
      }).then(function (queue) { data.queue = queue; return data; });
    }).then(function (data) { if (data) homeData = data; })
      .catch(function () {
        homeData = { summary: null, receipts: null,
                     queue: { pending: 0, failed: 0, blocked: 0, total: 0 } };
      })
      .then(function () { homeLoading = false; if (parse().name === 'home') render(); });
  }
  function homeView() {
    if (!homeData) loadHomeData();
    var summary = homeData && homeData.summary;
    var receipts = homeData && homeData.receipts;
    var latest = receipts && receipts[0];
    var queue = (homeData && homeData.queue) || { pending: 0, failed: 0, blocked: 0, total: 0 };
    return '<div class="home-page"><section class="home-scene" aria-label="动漫山景主视觉">' +
      messageEntry() + '<div class="home-brand"><img src="assets/brand/logo-reference-white-sun.png" alt="到此一游山形标志"><span>DCYY</span></div>' +
      '<img class="home-hiker" src="images/home/hiker.png" alt="徒步者坐在岩石上眺望群山">' +
      '</section><section class="home-content"><div class="home-copy"><h1>到此一游</h1>' +
      '<p>一条线路、一座山头、一句现场留言。<br>把走过的路，留给后来的人。</p>' +
      '<div class="home-actions"><a class="home-primary" href="#/scan">' + U.icon('scan') + '扫码打卡</a>' +
      '<button class="btn ghost" data-act="nearby">附近定位打卡</button>' +
      '</div></div>' +
      '<div class="pad"><div class="sec-head"><h3>我的山峰</h3></div>' +
      (!homeData ? '<div class="empty">正在读取到访记录…</div>' : summary === null ?
        '<div class="empty">暂时无法读取到访人数。<button class="btn ghost" data-act="home-retry">重试</button></div>' :
        summary.length ? summary.map(function (m) {
          return '<div class="rowlink"><span class="em">⛰</span><div class="tx"><b>' + esc(m.name || '名称待定') +
            '</b><span>有记录的到访者 ' + m.visitorCount + ' 人 · 最近到访 ' +
            esc((m.myLastVisitedAt || '').slice(0, 10)) + '</span></div></div>';
        }).join('') + rowlink('#/me/visited', '›', '查看全部', '我记录过的山峰与凭证') :
        '<div class="empty">还没有到访记录，去扫一扫留下第一次。</div>') +
      '<div class="sec-head"><h3>最近的打卡凭证</h3></div>' +
      (latest ? '<div class="card"><b>' + esc(latest.name || latest.code) + '</b><div class="hint">' +
        esc((latest.visitedAt || '').replace('T', ' ').slice(0, 16)) +
        (latest.durationS ? ' · 本次用时 ' + Math.round(latest.durationS / 60) + ' 分钟' : '') +
        (latest.seq ? ' · 该点位第 ' + latest.seq + ' 条记录' : '') +
        '</div></div>' : receipts === null ?
        '<div class="empty">凭证暂时无法读取。<button class="btn ghost" data-act="home-retry">重试</button></div>' :
        '<div class="empty">还没有打卡凭证。</div>') +
      (queue.total ? '<div class="hint">本机有 ' + queue.total + ' 条待同步记录' +
        (queue.failed ? '（其中 ' + queue.failed + ' 条被服务器拒绝，原因保留在本机）' : '') +
        (queue.blocked ? '（其中 ' + queue.blocked + ' 条属于另一个身份，需登录原身份）' : '') +
        ' <button class="btn ghost" data-act="sync-checkins" data-force="1">重试同步</button></div>' : '') +
      /* 两个社区榜：位次榜（山友口径）与打卡人数榜（山头口径）。
         数据各读各的，一个读不到不影响另一个，也不影响上面的个人数据。 */
      '<div class="sec-head"><h3>位次榜</h3><span class="more">' + boardWindowLabel() +
      ' ›</span></div>' + boardWindowTabs('board-window') + climbersBoardHTML({ page: 'home', limit: 3 }) +
      '<div class="sec-head"><h3>打卡人数榜</h3><span class="more">按人数 ›</span></div>' +
      mountainsBoardHTML('people', { page: 'home', limit: 3, title: '打卡人数榜' }) +
      '</div></section></div>';
  }

  /* 轮换：每 3 秒翻牌换下一条。悬停 / 聚焦时暂停（别在人家正要点的瞬间把链接换掉），
     页面切走或标签页不可见时也不动；换页由路由统一清掉 homeTimer。 */
  var homeTimer = null;
  function stopHomeAnim() {
    if (homeTimer) { clearInterval(homeTimer); homeTimer = null; }
  }
  function startFeaturedRotate() {
    stopHomeAnim();
    var box = document.getElementById('homeFeatured');
    if (!box) return;
    var list = H.trails || [];
    if (list.length < 2) return;
    var cur = null;
    list.forEach(function (t) { if (t.id === box.getAttribute('data-id')) cur = t; });
    var reduce = !motionAllowed();
    var paused = false;
    box.addEventListener('pointerenter', function () { paused = true; });
    box.addEventListener('pointerleave', function () { paused = false; });
    box.addEventListener('focus', function () { paused = true; });
    box.addEventListener('blur', function () { paused = false; });
    function apply(t) {
      box.setAttribute('data-id', t.id);
      box.setAttribute('aria-label', featuredLabel(t));
      box.setAttribute('href', '#/trails/' + encodeURIComponent(t.id));
      var name = box.querySelector('.hf-name'), meta = box.querySelector('.hf-meta');
      if (name) name.textContent = t.name;
      if (meta) meta.textContent = hfMeta(t);
    }
    /* 翻牌：绕 X 轴翻下去 → 在翻面时换内容 → 翻回来（CSS 负责过渡） */
    homeTimer = setInterval(function () {
      if (document.hidden || paused) return;
      if (!document.body.contains(box)) { stopHomeAnim(); return; }
      var next = randomTrail(cur);
      if (!next || next === cur) return;
      cur = next;
      if (reduce) { apply(next); return; }
      box.classList.add('is-swapping');            /* 翻下去 */
      setTimeout(function () {
        apply(next);                                /* 在"翻面"那一刻换内容，链接与看到的线路始终一致 */
        box.classList.remove('is-swapping');        /* 翻回来 */
      }, FLIP_MS);
    }, FEATURED_MS);
  }

  /* ==================== 路书 ==================== */
  var q = '', lv = 'all', kb = 'all', rg = 'all', ru = 'all';

  /* 区域取自线路的 city（"浙江 · 杭州 · 西湖区"→浙江）。库里写法不统一，
     有"四川省"也有"四川"，统一去掉后缀，别让筛选卡里冒出两个四川。 */
  function regionOf(t) {
    var head = String((t && t.city) || '').split('·')[0].trim();
    return head.replace(/(省|市|自治区|特别行政区)$/, '') || '其他';
  }

  /* 搜索与筛选摘要固定在列表上方，详细条件放到底部面板。 */
  function trailFilterBar() {
    return '<div class="searchbar">' + U.icon('search') +
      '<input id="q" type="search" aria-label="搜索线路名称或地区" placeholder="搜索线路名称或地区" value="' + esc(q) + '"></div>' +
      filterTrigger('trails');
  }

  function trailListResults() {
    var all = H.trails;
    var kw = q.trim();
    var list = all.filter(function (t) {
      var okRg = rg === 'all' || regionOf(t) === rg;
      var okKb = kb === 'all' ||
        (kb === 's' && t.km < 10) ||
        (kb === 'm' && t.km >= 10 && t.km < 30) ||
        (kb === 'l' && t.km >= 30 && t.km < 60) ||
        (kb === 'xl' && t.km >= 60);
      var okRu = ru === 'all' || (ru === 'low' && t.up < 500) ||
        (ru === 'mid' && t.up >= 500 && t.up < 1500) || (ru === 'high' && t.up >= 1500);
      var okQ = !kw || (t.name + ' ' + (t.sub || '') + ' ' + (t.city || '')).indexOf(kw) >= 0;
      return okKb && okRg && okRu && okQ;
    }).sort(function (a, b) { return a.km - b.km; });
    var fresh = all.filter(function (t) { return t.newest; });
    var shown = pageSlice(list, 'trails', CAROUSEL_PAGE);
    var dirty = !!kw || kb !== 'all' || rg !== 'all' || ru !== 'all';

    return (
      '<div class="sec-head"><h3>全部路线</h3><span class="more">' +
      list.length + ' / ' + all.length + ' 条' +
      (dirty
        ? ' · <button class="more" data-act="clear-filter" style="font:inherit">清除筛选</button>' : '') +
      '</span></div>' +
      (list.length
        ? '<div class="card tight">' + shown.map(function (t) {
            return compactRow({
              href: '#/trails/' + t.id, thumb: t.id, title: t.name,
              sub: t.km + ' km · ↗ ' + t.up + ' m · 参考 ' + t.hours +
                (t.city ? ' · ' + t.city : '')
            });
          }).join('') + '</div>' +
          pager('trails', list.length, CAROUSEL_PAGE)
        : '<div class="empty"><span class="big">⛰</span>没有匹配的线路，换个词或地区试试。</div>') +

      '<a class="rowlink" href="#/me/activity" style="margin-top:14px"><span class="em">＋</span>' +
      '<div class="tx"><b>本周新增路线 ' + fresh.length + ' 条</b><span>由 ' + (fresh.length * 2) + ' 位山友共建 · 发起你自己的线路</span></div>' +
      '<span class="ar">›</span></a>' +
      '<button class="rowlink" style="width:100%;text-align:left" data-act="doc">' +
      '<span class="em">?</span><div class="tx"><b>关于难度</b>' +
      '<span>单段四档 ● ▲ ◆ ⬢ · 线路综合看用时 · 中美瑞对照</span></div>' +
      '<span class="ar">›</span></button>'
    );
  }

  function trailListView() {
    /* 顺序：热门线路置顶 → 筛选条件 → 全部路线（默认 10 条，其余折叠） */
    var hot = H.trails.slice().sort(function (a, b) { return b.visits7 - a.visits7; });
    var hotPage = pageSlice(hot, 'trailHot', CAROUSEL_PAGE);
    /* "今天去走哪条？"下面那条线路：随机取一条，之后每 4 秒打字机换下一条（见 startListFeatured） */
    var feat = randomTrail(null);
    var featHref = feat ? '#/trails/' + encodeURIComponent(feat.id) : '#/trails';
    var originalHero = '<section class="route-hero route-hero-bottom"><div class="route-hero-copy"><h2>下一条路，去山里找</h2>' +
      '<p>' + H.trails.length + ' 条山野线路，按长度和爬升挑一条</p></div>' +
      '<img class="route-hero-art" src="images/home/hero-routes-male.png" alt="" aria-hidden="true"></section>';
    return '<section class="trailbook-intro" aria-label="今天去走哪条"><div class="trailbook-copy">' +
      '<h1>今天去走哪条？</h1></div>' +
      /* 山景插画（trailbook-hero.png）：手机是标题下面这张铺满到底的图，桌面换成
         .trailbook-intro 的 background（这张则 display:none，只当版式占位）。
         两边都为了让"找路线"那块磨砂玻璃背后垫着真图片，而不是平涂的底色。
         两点别改回去：① 别用整页设计稿截图（截图里带着标题和卡片，裁切一变就重影）；
         ② 插画里没有字，按容器 cover 裁就行。 */
      '<div class="trailbook-landscape"><img src="images/home/trailbook-hero.png" alt="青绿色群山间蜿蜒的粉色徒步路线"></div>' +
      '<div class="trailbook-feature">' +
      '<a class="tbf-link" id="trailbookFeature" href="' + featHref + '"' +
      (feat ? ' data-id="' + esc(feat.id) + '" aria-label="' + esc(featuredLabel(feat)) + '"' : '') + '>' +
      '<h2 class="tbf-name"><span class="tbf-text">' + esc(feat ? feat.name : '看全部线路') + '</span>' +
      '<i class="tbf-caret" aria-hidden="true"></i></h2>' +
      '<p class="tbf-meta">' + esc(feat ? listFeatureMeta(feat) : H.trails.length + ' 条线路') + '</p></a>' +
      '<button type="button" class="trailbook-find" data-act="find-trail-list">找路线</button></div></section>' +
      '<div class="sec-head" id="page-trailHot"><h3>热门线路</h3><span class="more">按本周打卡 ›</span></div>' +
      '<div class="carousel" id="trailHotCarousel">' + hotPage.map(trailCard).join('') + '</div>' +
      pager('trailHot', hot.length, CAROUSEL_PAGE) +
      '<div class="card" style="background:var(--blue-bg);box-shadow:none;padding:13px 15px;font-size:12.5px;color:var(--blue-deep);margin-top:10px">' +
      '<b>口径</b>　完整线路展示行程数据；难度与个人用时只在明确方向和起终点的路段上比较。</div>' +
      /* 广告轮播位：夹在「热门线路轮播」和「全部路线」之间 */
      adCarousel(H.ads, '山友的推荐') +
      trailFilterBar() +
      '<div id="trailResults">' + trailListResults() + '</div>' + originalHero;
  }

  function refreshTrailResults() {
    var el = document.getElementById('trailResults');
    if (el) el.innerHTML = trailListResults();
  }

  /* 路书页顶部那条线路：每 4 秒随机换下一条，名字用打字机逐字打出来、打完再出里程。
     悬停 / 聚焦暂停（别在正要点的瞬间换掉），换页由路由清定时器。 */
  var LIST_FEATURED_MS = 4000;
  var listFeaturedTimer = null, listTypeTimer = null;
  function stopListFeatured() {
    if (listFeaturedTimer) { clearInterval(listFeaturedTimer); listFeaturedTimer = null; }
    if (listTypeTimer) { clearInterval(listTypeTimer); listTypeTimer = null; }
  }
  function listFeatureMeta(t) {
    var parts = [t.km + ' km', '爬升 ' + t.up + ' m'];
    if (t.hoursVal != null) parts.push('约 ' + t.hoursVal + ' 小时');
    return parts.join(' · ');
  }
  function startListFeatured() {
    stopListFeatured();
    var link = document.getElementById('trailbookFeature');
    if (!link) return;
    var list = H.trails || [];
    if (list.length < 2) return;
    var cur = null;
    list.forEach(function (t) { if (t.id === link.getAttribute('data-id')) cur = t; });
    var reduce = !motionAllowed();
    var paused = false;
    link.addEventListener('pointerenter', function () { paused = true; });
    link.addEventListener('pointerleave', function () { paused = false; });
    link.addEventListener('focus', function () { paused = true; });
    link.addEventListener('blur', function () { paused = false; });
    function typeIn(t) {
      var span = link.querySelector('.tbf-text'), meta = link.querySelector('.tbf-meta');
      /* 链接与 aria 在开打时就更新：中途点进去的正是正在打出来的那条 */
      link.setAttribute('data-id', t.id);
      link.setAttribute('aria-label', featuredLabel(t));
      link.setAttribute('href', '#/trails/' + encodeURIComponent(t.id));
      if (span) span.textContent = '';
      if (meta) meta.textContent = '';
      link.classList.add('is-typing');
      if (listTypeTimer) { clearInterval(listTypeTimer); listTypeTimer = null; }
      var chars = Array.from(t.name), i = 0;
      listTypeTimer = setInterval(function () {
        if (document.hidden || paused) return;
        if (span) span.textContent = chars.slice(0, ++i).join('');
        if (i >= chars.length) {
          clearInterval(listTypeTimer); listTypeTimer = null;
          link.classList.remove('is-typing');
          if (meta) meta.textContent = listFeatureMeta(t);
        }
      }, TYPE_MS);
    }
    function apply(t) {
      link.setAttribute('data-id', t.id);
      link.setAttribute('aria-label', featuredLabel(t));
      link.setAttribute('href', '#/trails/' + encodeURIComponent(t.id));
      var span = link.querySelector('.tbf-text'), meta = link.querySelector('.tbf-meta');
      if (span) span.textContent = t.name;
      if (meta) meta.textContent = listFeatureMeta(t);
    }
    listFeaturedTimer = setInterval(function () {
      if (document.hidden || paused) return;
      if (!document.body.contains(link)) { stopListFeatured(); return; }
      var next = randomTrail(cur);
      if (!next || next === cur) return;
      cur = next;
      if (reduce) { apply(next); return; }
      typeIn(next);
    }, LIST_FEATURED_MS);
  }

  function trailDetailView(id) {
    var t = trail(id);
    if (!t) return notFound();
    var want = isWant(t.id);
    var rows = t.sections.length ? t.sections.map(function (s) {
      return '<div class="rank">' +
        '<span class="pos" style="color:#C9C3B4">' + s.no + '</span>' +
        '<span class="nm"><b>' + esc(s.name) + '</b><em>' + esc(s.tip) + '</em></span>' +
        '<span class="tm" style="font-size:12px;color:var(--ink3)">待核验</span></div>';
    }).join('') : '<div class="note" style="padding:12px 2px">这条线路是环线/单点轨迹，还没有分段扫码点，' +
      '先看上面的轨迹与坡度分析。</div>';
    var cs = [];
    H.posts.forEach(function (p) { if (p.place.id === t.id) cs.push({ who: p.who, when: p.when, text: p.text }); });
    return (
      /* 路书首屏先给可信信息：线路名、区域、距离、爬升。通用山景不再占一整屏，
         真实轨迹图提前出现；没有已审核封面时自然收起，不做丑陋占位。 */
      (t.coverUrl ? '<figure class="route-cover"><img src="' + esc(t.coverUrl) +
        '" alt="" loading="eager" onerror="this.closest(\'.route-cover\').style.display=\'none\'">' +
        '<figcaption>' + esc(t.coverByline || '') + '</figcaption></figure>' : '') +
      '<header class="route-compact-head"><span class="eyebrow">TRAILBOOK</span>' +
      '<h1>' + esc(t.name) + '</h1><p>' + esc(t.city || t.sub || '山野线路') +
      ' · ' + t.km + ' km · ↗ ' + t.up + ' m' + (t.hours ? ' · 约 ' + esc(t.hours) : '') + '</p></header>' +
      '<div class="route-cover-tools"><span>封面只展示已审核的真实照片；没有照片时不占位。</span>' +
      '<button class="btn ghost mini" data-act="cover-open" data-id="' + esc(t.id) + '">投稿真实封面</button></div>' +
      '<p class="muted" style="font-size:13.5px">' + esc(t.desc) + '</p>' +
      (t.group === 'park' ? runCard(t) : '') +
      /* 轨迹图可以缩放：滚轮 / 双指 / 右下角按钮都行，双击复位。
         轨迹围起来的区域铺了一层透明淡色，放大后能看清这条线覆盖了哪片地形。 */
      '<div class="tracewrap" data-track="' + esc(t.id) + '">' + apiTrackSVG(t) +
      '<div class="trkctl">' +
      '<button type="button" class="btn ghost" data-act="trk-zoom" data-id="' + esc(t.id) + '" data-val="out" aria-label="缩小">－</button>' +
      '<span class="trk-k">100%</span>' +
      '<button type="button" class="btn ghost" data-act="trk-zoom" data-id="' + esc(t.id) + '" data-val="in" aria-label="放大">＋</button>' +
      '<button type="button" class="btn ghost" data-act="trk-zoom" data-id="' + esc(t.id) + '" data-val="reset">复位</button>' +
      '<span class="trk-tip">滚轮 / 双指缩放 · 放大后拖动平移</span>' +
      '</div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;padding:5px 2px 2px;font-size:10.5px;color:var(--ink3)">' +
      '<span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#52B44A;margin-right:4px"></i>缓</span>' +
      '<span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#2563EB;margin-right:4px"></i>中</span>' +
      '<span><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#9E1B1B;margin-right:4px"></i>陡</span>' +
      '<span style="margin-left:auto">真实 DEM · 等高距 200→10 m</span></div>' +
      '<div class="tcap"><span>真实地形 · 线路海拔</span>' +
      '<span>' + t.km + ' km · ↗ ' + t.up + ' m</span></div></div>' +

      '<div class="sec-head"><h3>坡度图</h3>' +
      '<span class="more">海拔 · 里程 · 山顶 / CP</span></div>' +
      '<div class="profilebox">' + (apiProfileSVG(t) ||
        '<div class="trace-empty">这条线路还没有坡度剖面数据。<button class="btn ghost mini" data-act="reload">重新加载</button></div>') +
      '<div style="display:flex;gap:12px;padding:4px 0 2px;font-size:10.5px;color:var(--ink3)">' +
      '<span style="color:#52B44A">● ≤15% 缓</span><span style="color:#2563EB">● 15–25% 中</span>' +
      '<span style="color:#9E1B1B">● &gt;25% 陡</span><span style="color:#778396">● 底色透明，地形透过来</span></div>' +
      apiSlopeTable(t) + '</div>' +
      ((t.peakList || []).length ? '<div class="card tight" style="margin-top:8px"><b style="font-size:12px">沿途山顶名称</b>' +
        t.peakList.map(function (pk) {
          return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--hair)">' +
            '<span style="flex:1;font-size:12px">' + esc(pk.name || '山顶 · 待命名') + ' · ' + pk.altitude + ' m · ' + pk.km + ' km</span>' +
            '<button class="btn ghost" style="width:auto;padding:5px 9px;font-size:11px" data-act="peak-name" data-idx="'+pk.idx+'">'+(pk.name ? '建议修改' : '建议名称')+'</button>' +
            (t.canMaintainRoute && pk.candidate_id ? '<button class="btn ghost" style="width:auto;padding:5px 9px;font-size:11px" data-act="peak-name-review" data-idx="'+pk.idx+'" data-cid="'+pk.candidate_id+'">确认「'+esc(pk.candidate_name)+'」</button><button class="btn ghost" style="width:auto;padding:5px 9px;font-size:11px" data-act="peak-name-reject" data-idx="'+pk.idx+'" data-cid="'+pk.candidate_id+'">驳回</button>' : '') +
          '</div>';
        }).join('') + '</div>' : '') +
      '<div class="card tight">' + apiSegTable(t) +
      '<div style="font-size:11.5px;color:var(--ink3);padding:10px 0 2px;line-height:1.7">' +
      '段难度只看<strong>段内最长连续爬升</strong>与<strong>平均坡度</strong>：' +
      '最长连续爬升 ≤200 / 200–500 / &gt;500 m，坡度 ≤15 / 15–25 / &gt;25%。' +
      '距离不进难度——它体现在用时与消耗里；净下坡段与爬升很小的平路不评级。' +
      '是否要手脚并用、是否需要绳索冰爪，由山友和维护人确认。</div></div>' +

      /* 打卡点：组委会 GPX 里的 <wpt>，我们贴回轨迹算出里程与海拔。
         顺便把附近的顶带上——赛道上的顶大多就在补给点旁边，
         这样"名称待定"的顶至少能说清"在 CP3 东坪 旁边 400 m"。 */
      ((t.checkpoints || []).length || t.canMaintainRoute
        ? '<div class="sec-head"><h3>打卡点</h3>' +
          '<span class="more">沿线 CP ' + t.checkpoints.length + ' 个 ›</span></div>' +
          '<div class="card tight">' + t.checkpoints.map(function (cp) {
            var near = (t.peakList || []).filter(function (pk) {
              return Math.abs(pk.km - cp.km) * 1000 <= 500;
            }).sort(function (a, b) {
              return Math.abs(a.km - cp.km) - Math.abs(b.km - cp.km);
            }).slice(0, 2);
            return '<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--hair)">' +
              '<span style="flex:0 0 auto;width:22px;height:22px;border-radius:7px;background:var(--blue);' +
              'color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center">' +
              cp.no + '</span><span style="flex:1;min-width:0">' +
              '<b style="font-size:13.5px">' + esc(cp.name) + '</b>' +
              '<em style="font-style:normal;display:block;font-size:11.5px;color:var(--ink3)">' +
              cp.km + ' km' + (cp.altitude ? ' · 海拔 ' + cp.altitude + ' m' : '') +
              (cp.off_track_m > 150 ? ' · 离轨迹 ' + cp.off_track_m + ' m' : '') + '</em>' +
              (cp.supply_type ? '<em style="font-style:normal;display:block;font-size:11.5px;color:var(--ink3)">补给：'+esc(cp.supply_type)+'</em>' : '') +
              (cp.notes ? '<em style="font-style:normal;display:block;font-size:11.5px;color:var(--ink3)">'+esc(cp.notes)+'</em>' : '') +
              (near.length
                ? '<em style="font-style:normal;display:block;font-size:11.5px;color:var(--ink3)">' +
                  '附近山顶：' + near.map(function (pk) {
                    return pk.altitude + ' m（' + Math.round(Math.abs(pk.km - cp.km) * 1000) + ' m）';
                  }).join('、') + '</em>'
                : '') + '</span></div>';
          }).join('') + (t.canMaintainRoute ? '<button class="btn ghost" style="margin-top:8px" data-act="checkpoint-add" data-id="'+esc(t.id)+'">＋ 添加 CP</button>' : '') + '</div>'
        : '') +

      '<div class="sec-head"><h3>分段路书</h3><span class="more">' +
      (t.status ? '维护人 ' + esc(t.status.who) + ' ›' : '待维护人确认 ›') + '</span></div>' +
      '<div class="card tight">' + rows + '</div>' +

      (t.status
        ? '<div class="card" style="background:var(--blue-bg);box-shadow:none;margin-top:14px">' +
          '<div style="font-size:12px;font-weight:800;color:var(--blue);margin-bottom:6px">最近路况</div>' +
          '<div style="font-size:13px;color:#33415E">' + esc(t.status.when) + '维护人确认：' +
          esc(t.status.text) + '</div></div>'
        : '<div class="card soonrow" style="margin-top:14px;border:1px dashed #DED7C8">' +
          '<div style="font-size:12px;font-weight:800;color:var(--ink2);margin-bottom:6px">' +
          '最近路况<span class="soon-tag">待开发</span></div>' +
          '<div style="font-size:12.5px;color:var(--ink3)">' +
          '需要维护人核验的数据表，还没有。</div></div>') +

      '<div class="sec-head"><h3>留言板</h3><span class="more">全部 ›</span></div>' +
      (commentsFor(t.id).length ? commentsFor(t.id).slice(0, 2).map(commentCard).join('')
        : '<div class="empty">还没有留言，做第一个。</div>') +
      '<button class="btn ghost" style="margin-top:6px" data-act="comment-open" data-type="trail" data-id="' + t.id + '">写一句给下一位</button>' +

      '<div class="btn-row">' +
      '<button class="btn ghost" data-act="want" data-id="' + t.id + '" data-on="♥ 已收藏到想去" data-off="♡ 收藏到想去">' + (want ? '♥ 已收藏到想去' : '♡ 收藏到想去') + '</button>' +
      '<a class="btn coral" href="#/scan">我也到了</a></div>'
    );
  }

  function addMin(t, m) {
    var parts = String(t).split(':').map(Number);
    var total = parts[0] * 60 + parts[1] + m;
    return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ============ 详情页：全部读服务端算好的结果，前端不再重算（P6） ============ */
  var LV_C = { easy: '#52B44A', mid: '#2563EB', hard: '#9E1B1B', hidden: '#22242E' };
  var LV_T = { easy: '简单', mid: '中等', hard: '困难', hidden: '隐藏' };
  var KND = { climb: '爬升', desc: '下降', flat: '平缓' };
  /* 定级靠"段内最长连续爬升"：净坡度小但爬升可观的段叫"起伏"，别写成"平缓"。
     规则与 pipeline/build.py 一致（下降段/平缓段 level 为 null = 不评级）。 */
  function segKind(s) {
    return (s.kind === 'flat' && s.difficulty_applicable) ? '起伏' : KND[s.kind];
  }
  function segNumbers(s) {
    if (s.max_rise_m == null) return (s.rise > 0 ? '+' : '') + s.rise + ' m · ' +
      (s.pct > 0 ? '+' : '') + s.pct + '%';
    var head = '最长连续爬升 ' + s.max_rise_m + ' m';
    if (s.kind === 'desc') head = '最长连续下降 ' + s.max_drop_m + ' m';
    return head + ' · 累计 ↑' + s.up_m + ' ↓' + s.down_m + ' m · 净' +
      (s.rise > 0 ? '+' : '') + s.rise + ' m · ' + (s.pct > 0 ? '+' : '') + s.pct + '%';
  }

  /* ① 轨迹图：按段着色，山顶标海拔 */
  function apiTrackSVG(t, compact) {
    if (t.coordinates && t.coordinates.length > 1) {
      var coords = t.coordinates, bounds = t.terrainBounds, W = compact ? 200 : 380, H = compact ? 120 : 210, n = coords.length;
      if (!bounds) {
        var la = coords.map(function (p) { return p[0]; }), lo = coords.map(function (p) { return p[1]; });
        var south = Math.min.apply(null,la), north = Math.max.apply(null,la), west = Math.min.apply(null,lo), east = Math.max.apply(null,lo);
        var cos = Math.cos((south+north)*Math.PI/360), latPad = Math.max((north-south)*.12,.0037), lonPad = Math.max((east-west)*.12,.0045/cos);
        bounds = {south:south-latPad,north:north+latPad,west:west-lonPad,east:east+lonPad};
        var ratio = (east-west)*cos/(north-south), target = W/H;
        if (ratio < target) { var dx=((north-south)*target-(east-west)*cos)/(2*cos); bounds.west-=dx; bounds.east+=dx; }
        else { var dy=((east-west)*cos/target-(north-south))/2; bounds.south-=dy; bounds.north+=dy; }
      }
      function geoP(i) { var p=coords[Math.max(0,Math.min(n-1,i))]; return [
        (p[1]-bounds.west)/(bounds.east-bounds.west)*W,
        (bounds.north-p[0])/(bounds.north-bounds.south)*H]; }
      var svg = '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:'+(compact?'124px':'230px')+'" aria-label="真实地形路线图">';
      svg += '<rect width="'+W+'" height="'+H+'" rx="12" fill="#edf5f2"/>';
      if (t.terrainUrl) svg += '<image href="'+esc(t.terrainUrl)+'" x="0" y="0" width="'+W+'" height="'+H+'" preserveAspectRatio="none" opacity=".8"/>';
      /* 轨迹覆盖的区域：整条线连成一个面，填一层透明色——一眼看出这条线路占了哪片地形，
         底色透过来，地形还看得清。缩放时跟着一起放大（在同一个 <g> 里）。 */
      var outline = '';
      for (var oi = 0; oi < n; oi++) { var oq = geoP(oi); outline += (oi ? 'L' : 'M') + oq[0].toFixed(1) + ' ' + oq[1].toFixed(1); }
      var zoomAttr = compact ? '' : ' data-zoom="1"';
      svg += '<g' + zoomAttr + '>';
      svg += '<path d="' + outline + ' Z" fill="#2563EB" fill-opacity=".12" stroke="none"/>';
      (t.segments || []).forEach(function (sg) {
        var a=Math.max(0,Math.round(sg.from_km/t.km*(n-1))), b=Math.min(n-1,Math.round(sg.to_km/t.km*(n-1))), d='';
        for(var i=a;i<=b;i++){var q=geoP(i);d+=(i===a?'M':'L')+q[0].toFixed(1)+' '+q[1].toFixed(1);}
        svg+='<path d="'+d+'" fill="none" stroke="#fff" stroke-width="'+(compact?7:10)+'" stroke-linecap="round" stroke-linejoin="round"/>';
        svg+='<path d="'+d+'" fill="none" stroke="'+(sg.difficulty_applicable === false ? '#64748b' : (LV_C[sg.level]||'#22242E'))+'" stroke-width="'+(compact?4:6)+'" stroke-linecap="round" stroke-linejoin="round"/>';
      });
      var start=geoP(0), end=geoP(n-1), rad=compact?4:6;
      svg+='<circle cx="'+start[0]+'" cy="'+start[1]+'" r="'+rad+'" fill="#39A875" stroke="#fff" stroke-width="2"/>';
      svg+='<circle cx="'+end[0]+'" cy="'+end[1]+'" r="'+rad+'" fill="#FF5298" stroke="#fff" stroke-width="2"/>';
      svg += compact ? '' : '</g>';
      return (compact ? '<span class="trk trk-tc">' : '') + svg+'</svg>' + (compact ? '</span>' : '');
    }
    var path = t.path || [];
    if (path.length < 2) return compact
      ? '<span class="trk trk-tc" style="display:grid;place-items:center;background:#edf5f2;color:#718096;font-size:10px">读取地形…</span>'
      : '<div class="trace-empty">这条线路还没有可用的轨迹数据。<button class="btn ghost mini" data-act="reload">重新加载</button></div>';
    var W = compact ? 200 : 380, H = compact ? 120 : 210, pad = compact ? 14 : 26, xs = [], ys = [];
    path.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var s = Math.min((W - pad * 2) / ((x1 - x0) || 1), (H - pad * 2) / ((y1 - y0) || 1));
    var ox = (W - (x1 - x0) * s) / 2, oy = (H - (y1 - y0) * s) / 2;
    function P(i) { return [(xs[i] - x0) * s + ox, (ys[i] - y0) * s + oy]; }
    var n = path.length - 1;
    var o = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" ' +
      'style="display:block;width:100%;height:' + (compact ? '124px' : '230px') + '">';
    o += '<rect width="' + W + '" height="' + H + '" rx="12" fill="#edf5f2"/>';
    if (t.terrainUrl && !compact) {
      o += '<image href="' + esc(t.terrainUrl) + '" x="0" y="0" width="' + W + '" height="' + H + '" preserveAspectRatio="none" opacity=".86"/>';
      o += '<rect width="' + W + '" height="' + H + '" rx="12" fill="#ffffff" opacity=".14"/>';
    }
    /* 段边界：服务端给的是公里数，path 是等距重采样的，按比例换算成下标 */
    (t.segments || []).forEach(function (sg) {
      var a = Math.round(sg.from_km / t.km * n), b = Math.round(sg.to_km / t.km * n), d = '';
      for (var i = a; i <= b; i++) {
        var q = P(i); d += (i === a ? 'M' : 'L') + q[0].toFixed(1) + ' ' + q[1].toFixed(1);
      }
      o += '<path d="' + d + '" fill="none" stroke="' + (sg.difficulty_applicable === false ? '#64748b' : (LV_C[sg.level] || '#999')) +
        '" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>';
    });
    (t.peakList || []).forEach(function (pk) {
      var q = P(Math.round(pk.km / t.km * n));
      o += '<circle cx="' + q[0].toFixed(1) + '" cy="' + q[1].toFixed(1) + '" r="6.5" fill="#22242E"/>' +
        '<text x="' + q[0].toFixed(1) + '" y="' + (q[1] - 11).toFixed(1) +
        '" text-anchor="middle" font-size="10.5" font-weight="700" fill="#22242E">' +
        pk.altitude + '</text>';
    });
    /* 打卡点：组委会给的点名，蓝色方块 + 序号（山顶是黑圆点 + 海拔，两套记号不混） */
    (t.checkpoints || []).forEach(function (cp) {
      var q = P(Math.round(cp.km / t.km * n));
      o += '<rect x="' + (q[0] - 4.5).toFixed(1) + '" y="' + (q[1] - 4.5).toFixed(1) +
        '" width="9" height="9" rx="2.5" fill="#3455F5" stroke="#fff" stroke-width="1.4"/>' +
        '<text x="' + q[0].toFixed(1) + '" y="' + (q[1] + 3.2).toFixed(1) +
        '" text-anchor="middle" font-size="6.6" font-weight="800" fill="#fff">' + cp.no + '</text>';
    });
    return (compact ? '<span class="trk trk-tc">' : '') + o + '</svg>' + (compact ? '</span>' : '');
  }

  /* ==================== 轨迹图缩放 / 平移 ====================
     状态按线路 id 存；按钮、滚轮、双指、拖动共用同一份状态。
     SVG 里整条轨迹画在 <g data-zoom> 里，这里只改它的 transform。 */
  var trkZoomState = {};
  function trkState(id) {
    return trkZoomState[id] || (trkZoomState[id] = { k: 1, x: 0, y: 0 });
  }
  function trkNode(id) {
    var host = document.querySelector('[data-track="' + id + '"]');
    return host && host.querySelector('svg');
  }
  function trkApply(id) {
    var node = trkNode(id);
    if (!node) return;
    var group = node.querySelector('g[data-zoom]');
    if (!group) return;
    var st = trkState(id);
    group.setAttribute('transform', 'translate(' + st.x.toFixed(1) + ' ' + st.y.toFixed(1) +
      ') scale(' + st.k.toFixed(3) + ')');
    var label = document.querySelector('[data-track="' + id + '"] .trk-k');
    if (label) label.textContent = Math.round(st.k * 100) + '%';
  }
  /* 以画布上的某一点为锚点缩放：手指/鼠标指哪儿就放大哪儿 */
  function trkZoomAt(id, factor, clientX, clientY) {
    var node = trkNode(id);
    if (!node) return;
    var st = trkState(id);
    var next = Math.max(1, Math.min(8, st.k * factor));
    if (next === st.k) return;
    var point = node.createSVGPoint();
    point.x = clientX; point.y = clientY;
    var matrix = node.getScreenCTM();
    var svgPoint = matrix ? point.matrixTransform(matrix.inverse()) : { x: 190, y: 105 };
    var ratio = next / st.k;
    st.x = svgPoint.x - (svgPoint.x - st.x) * ratio;
    st.y = svgPoint.y - (svgPoint.y - st.y) * ratio;
    st.k = next;
    trkApply(id);
  }
  function trkPan(id, dx, dy) {
    var st = trkState(id);
    st.x += dx; st.y += dy;
    trkApply(id);
  }
  function trkReset(id) {
    trkZoomState[id] = { k: 1, x: 0, y: 0 };
    trkApply(id);
  }
  /* 把画布上的像素位移换成 SVG 用户单位（缩放后 1px 不等于 1 单位） */
  function trkUnitsPerPixel(node) {
    var matrix = node && node.getScreenCTM();
    if (!matrix) return 1;
    return 1 / (matrix.a || 1);
  }
  function trkWireTrack() {
    var host = null, dragging = null, pinch = null, pointers = {};
    function trackHost(target) {
      return target && target.closest ? target.closest('[data-track]') : null;
    }
    document.addEventListener('wheel', function (e) {
      var wrap = trackHost(e.target);
      if (!wrap || !wrap.querySelector('g[data-zoom]')) return;
      e.preventDefault();                       /* 在图上滚轮是缩放，不是翻页 */
      trkZoomAt(wrap.getAttribute('data-track'), e.deltaY < 0 ? 1.15 : 1 / 1.15,
                e.clientX, e.clientY);
    }, { passive: false });
    document.addEventListener('pointerdown', function (e) {
      var wrap = trackHost(e.target);
      if (!wrap || !wrap.querySelector('g[data-zoom]')) return;
      var id = wrap.getAttribute('data-track');
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]];
        pinch = { id: id, dist: Math.hypot(a.x - b.x, a.y - b.y), k: trkState(id).k };
        dragging = null;
        return;
      }
      var st = trkState(id);
      if (st.k <= 1) return;                     /* 没放大时拖动交给页面滚动 */
      dragging = { id: id, x: e.clientX, y: e.clientY, node: wrap.querySelector('svg') };
      /* 不用 setPointerCapture：捕获会把后续 click 事件重定向到容器上，
         这样"放大"按钮第二次点就没反应了（closest('[data-act]') 找不到按钮）。
         拖动靠 document 上的 pointermove 就够。 */
    });
    document.addEventListener('pointermove', function (e) {
      if (pointers[e.pointerId]) { pointers[e.pointerId] = { x: e.clientX, y: e.clientY }; }
      if (pinch && Object.keys(pointers).length >= 2) {
        var ids = Object.keys(pointers);
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var dist = Math.hypot(a.x - b.x, a.y - b.y);
        var mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        var target = Math.max(1, Math.min(8, pinch.k * (dist / (pinch.dist || dist))));
        trkZoomAt(pinch.id, target / trkState(pinch.id).k, mid[0], mid[1]);
        return;
      }
      if (!dragging) return;
      var node = trkNode(dragging.id);
      var unit = trkUnitsPerPixel(node) / trkState(dragging.id).k;
      trkPan(dragging.id, (e.clientX - dragging.x) / unit, (e.clientY - dragging.y) / unit);
      dragging.x = e.clientX; dragging.y = e.clientY;
    });
    function release(e) {
      delete pointers[e.pointerId];
      if (Object.keys(pointers).length < 2) pinch = null;
      dragging = null;
    }
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  }

  /* ② 坡度图：按坡度自动分段（≤15% 绿 · 15–25% 蓝 · >25% 深红）
     同名点：剖面是等距重采样的，所以相邻两点的高差 / 水平距离就是这一小段的坡度。 */
  var SLOPE_BANDS = [
    { max: 15, level: 'easy', color: '#52B44A' },
    { max: 25, level: 'mid', color: '#2563EB' },
    { max: 1e9, level: 'hard', color: '#9E1B1B' }
  ];
  function slopeColor(pct) {
    for (var i = 0; i < SLOPE_BANDS.length; i++) {
      if (pct <= SLOPE_BANDS[i].max) return SLOPE_BANDS[i];
    }
  }
  function slopeBands(t) {
    var prof = (t.elevationM || []).length >= 2 ? t.elevationM : (t.profile || []);
    var n = prof.length;
    if (n < 2) return { prof: prof, bands: [], stepKm: 0, n: n };
    var stepKm = t.km && n > 1 ? t.km / (n - 1) : 0;
    if (!stepKm) return { prof: prof, bands: [], stepKm: 0, n: n };
    /* 用 ±0.4 km 的滑动窗口估坡度：单点相邻高差会抖成噪点，
       而"这段陡不陡"看的是持续几百米的趋势（跟服务端"持续坡度只认 ≥400 m"同一个口径）。
       窗口内取绝对高差之和，方向不抵消——下坡的陡也是陡。 */
    var win = Math.max(1, Math.round(0.4 / stepKm));
    function windowSlope(i) {
      var a = Math.max(0, i - win), b = Math.min(n - 1, i + win), rise = 0, dist = 0;
      for (var k = a; k < b; k++) { rise += Math.abs(prof[k + 1] - prof[k]); dist += stepKm; }
      return dist > 0 ? rise / (dist * 1000) * 100 : 0;
    }
    var bands = [];
    for (var i = 1; i < n; i++) {
      var band = slopeColor(windowSlope(i));
      var last = bands[bands.length - 1];
      if (last && last.level === band.level) last.to = i;
      else bands.push({ level: band.level, color: band.color, from: i - 1, to: i });
    }
    /* 碎段合并：不到全程 1.5% 又不到 0.5 km 的段并进前一段，
       否则颜色条会碎成噪点。合并后用绝对高差重算这一段到底多陡。 */
    var minKm = Math.max(0.5, (t.km || 0) * 0.015);
    var merged = [];
    bands.forEach(function (b) {
      var last = merged[merged.length - 1];
      if (last && ((b.to - b.from) * stepKm < minKm || last.level === b.level)) last.to = b.to;
      else merged.push({ level: b.level, color: b.color, from: b.from, to: b.to });
    });
    if (merged.length > 1 && (merged[0].to - merged[0].from) * stepKm < minKm) {
      merged[1].from = merged[0].from;
      merged.shift();
    }
    merged.forEach(function (b) {
      var rise = 0;
      for (var k = b.from; k < b.to; k++) rise += Math.abs(prof[k + 1] - prof[k]);
      var km = (b.to - b.from) * stepKm;
      b.pct = km > 0 ? rise / (km * 1000) * 100 : 0;
      var band = slopeColor(b.pct);
      b.level = band.level; b.color = band.color;
      b.km = km; b.fromKm = b.from * stepKm; b.toKm = b.to * stepKm;
    });
    return { prof: prof, bands: merged, stepKm: stepKm, n: n };
  }
  function apiProfileSVG(t) {
    var hasElevation = (t.elevationM || []).length >= 2;
    var sg = slopeBands(t), prof = sg.prof;
    if (prof.length < 2) return '';
    var W = 380, H = 178, L = 40, R = 8, T = 24, B = 30, n = prof.length;
    var min = hasElevation ? Math.floor(Math.min.apply(null, prof) / 100) * 100 : 0;
    var max = hasElevation ? Math.ceil(Math.max.apply(null, prof) / 100) * 100 : 1;
    if (max <= min) max = min + 100;
    function X(i) { return L + i / (n - 1) * (W - L - R); }
    function Y(v) { return H - B - (v - min) / (max - min) * (H - T - B); }
    var line = prof.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' ');
    var o = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
      'style="display:block;width:100%;height:166px">';
    for (var alt = min; alt <= max; alt += (max - min > 1000 ? 300 : 100)) {
      var gy = Y(alt);
      o += '<path d="M' + L + ' ' + gy.toFixed(1) + 'H' + (W - R) + '" stroke="#dce5e3" stroke-width="1"/>' +
        (hasElevation ? '<text x="2" y="' + (gy + 3).toFixed(1) + '" font-size="8" fill="#718096">' + alt + 'm</text>' : '');
    }
    /* 轨迹覆盖的区域：只铺一层透明的淡色（不遮地形），形状一眼可见 */
    o += '<path d="' + line + ' L' + X(n - 1).toFixed(1) + ' ' + (H - B) + ' L' + X(0).toFixed(1) +
      ' ' + (H - B) + ' Z" fill="#2563EB" fill-opacity=".08" stroke="none"/>';
    o += '<text x="' + L + '" y="13" font-size="9" fill="#718096">坡度图 · 颜色 = 该段坡度（纵轴：海拔 m）</text>';
    sg.bands.forEach(function (b) {
      var d = '';
      for (var i = b.from; i <= b.to; i++) d += (i === b.from ? 'M' : 'L') + X(i).toFixed(1) + ' ' + Y(prof[i]).toFixed(1);
      o += '<path d="' + d + '" fill="none" stroke="' + b.color + '" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>';
      var x0 = X(b.from), x1 = X(b.to);
      o += '<rect x="' + x0.toFixed(1) + '" y="' + (H - 8) + '" width="' + Math.max(1, x1 - x0).toFixed(1) +
        '" height="6" rx="3" fill="' + b.color + '"/>';
    });
    (t.peakList || []).forEach(function (pk) {
      var x = L + pk.km / t.km * (W - L - R), i = Math.max(0, Math.min(n - 1, Math.round(pk.km / t.km * (n - 1)))), y = Y(prof[i]);
      o += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.5" fill="#ff5298" stroke="#fff" stroke-width="1.5"/>' +
        '<text x="' + x.toFixed(1) + '" y="' + Math.max(21, y - 7).toFixed(1) + '" text-anchor="middle" font-size="7.5" font-weight="700" fill="#26324d">' +
        esc(pk.name || (pk.candidate_name ? '待确认：' + pk.candidate_name : '山顶待命名')) +
        (pk.elevation_m || pk.altitude ? ' · ' + (pk.elevation_m || pk.altitude) + 'm' : '') + '</text>';
    });
    /* 打卡点在坡度图上的位置：一条虚线，一眼看出补给点落在上坡还是下坡 */
    (t.checkpoints || []).forEach(function (cp) {
      var x = L + (cp.km / t.km) * (W - L - R);
      o += '<line x1="' + x.toFixed(1) + '" y1="' + T + '" x2="' + x.toFixed(1) + '" y2="' + (H - B) +
        '" stroke="#3455F5" stroke-width="1" stroke-dasharray="2 3" opacity=".6"/>';
      o += '<circle cx="' + x.toFixed(1) + '" cy="' + (H - B - 3) + '" r="2.7" fill="#3455F5"/>';
      if (cp.name) o += '<text x="' + x.toFixed(1) + '" y="' + (H - B - 7) + '" text-anchor="middle" font-size="6.7" fill="#3455F5">' + esc(cp.name) + '</text>';
    });
    return o + '</svg>';
  }

  /* 坡度图下面的分段清单：每段多少公里、平均坡度、属于哪一档 */
  function apiSlopeTable(t) {
    var sg = slopeBands(t);
    if (!sg.bands.length) return '';
    var shown = sg.bands.filter(function (b) { return b.km >= 0.15; });
    if (!shown.length) shown = sg.bands;
    shown = shown.slice(0, 12);
    return shown.map(function (b, index) {
      return '<div style="display:flex;align-items:center;gap:9px;padding:10px 0;' +
        'border-bottom:1px solid var(--hair);font-size:12.5px">' +
        '<span style="width:10px;height:10px;border-radius:3px;flex:0 0 auto;background:' + b.color + '"></span>' +
        '<span style="font-weight:800;flex:0 0 56px">第 ' + (index + 1) + ' 段</span>' +
        '<span style="color:var(--ink2);flex:0 0 96px">' + b.fromKm.toFixed(1) + '–' + b.toKm.toFixed(1) + ' km</span>' +
        '<span style="flex:1;color:var(--ink2)">平均坡度 ' + Math.round(b.pct) + '%</span>' +
        '<span style="color:' + b.color + ';font-weight:700">' +
        (b.level === 'easy' ? '缓' : b.level === 'mid' ? '中' : '陡') + '</span></div>';
    }).join('') +
      '<div class="hint" style="padding:8px 2px 0">按坡度自动分段：≤15% 缓 · 15–25% 中 · &gt;25% 陡；' +
      '下坡与上坡按同一个绝对坡度看待。' + (hasElevation(t) ? '' : '（这段还没有海拔数据，坡度为估算）') + '</div>';
  }
  function hasElevation(t) { return (t.elevationM || []).length >= 2; }

  /* ③ 分段表：每段一行 */
  function apiSegTable(t) {
    if (!t.segments || !t.segments.length) return '';
    return t.segments.map(function (s) {
      /* 每一段可点：进去看别人对这一段的留言，也留一句 */
      return '<div data-act="seg-comments" data-id="' + s.id + '" data-no="' + s.no + '" ' +
        'style="display:flex;align-items:center;gap:9px;padding:11px 0;cursor:pointer;' +
        'border-bottom:1px solid var(--hair);font-size:12.5px">' +
        '<span style="width:10px;height:10px;border-radius:3px;flex:0 0 auto;background:' +
        (s.difficulty_applicable === false ? '#778396' : (LV_C[s.level] || '#999')) + '"></span>' +
        '<span style="font-weight:800;flex:0 0 56px">' + s.no + '. ' + segKind(s) + '</span>' +
        '<span style="color:var(--ink2);flex:0 0 92px">' + s.from_km + '–' + s.to_km + ' km</span>' +
        '<span style="flex:1;color:var(--ink2);line-height:1.5">' + segNumbers(s) + '</span>' +
        (s.difficulty_applicable === false ? '<span style="color:#778396">不评级</span>' : U.levelBadge(s.level)) +
        '<span style="color:#C9C3B4;font-size:14px;margin-left:4px">›</span></div>';
    }).join('');
  }

  /* 公园跑道的跑步参考：单圈距离 / 常见路面 / 常见配速换算 */
  function fmtClock(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.round(sec % 60);
    return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s);
  }
  function runCard(t) {
    var st = (H.routeStats || {})[t.id] || {};
    var loop = (st.closed != null && st.closed < 150) ? '闭合环线' : '环线';
    return '<div class="sec-head"><h3>跑步参考</h3><span class="more">' + loop + ' ›</span></div>' +
      '<div class="card">' +
      '<div class="kv2"><span>单圈距离</span><b>' + t.km + ' km</b></div>' +
      '<div class="kv2"><span>累计爬升</span><b>' + t.up + ' m</b></div>' +
      (st.surface ? '<div class="kv2"><span>常见路面</span><b>' + esc(st.surface) + '</b></div>' : '') +
      [5, 6, 7].map(function (p) {
        return '<div class="kv2"><span>配速 ' + p + ':00 /km</span><b>' +
          fmtClock(Math.round(t.km * p * 60)) + '</b></div>';
      }).join('') +
      '<div class="note" style="padding:10px 2px 0">配速用时按距离直接换算，不含等灯与爬升修正；' +
      '路面是按公园普遍路况的判断，没有逐段核实。</div></div>';
  }

  /* ==================== 山头 · 岔路 ==================== */
  var seg = 'peak';
  /* 山头页只留三组筛选：距离 / 海拔 / 登顶难度。系列、城市、离我最近都撤了。 */
  var pq = '', pd = 'all', pf = 'all', plv = 'all';
  var boardSort = 'time', boardFollow = 'all';
  /* 山头、登顶和岔路榜单各自分页，但共用筛选状态。 */

  /* ==================== 榜单（登顶榜 / 打卡人数榜 / 位次榜） ====================
     三个榜都读服务端真实计数：
       · 登顶榜 = 山头按到访人次排（同一人多次也算）      /api/boards/mountains?metric=visits
       · 打卡人数榜 = 山头按去重人数排                    /api/boards/mountains?metric=people
       · 位次榜 = 山友按"打过卡的不同山头数"排            /api/boards/climbers
     人数与人次是两个口径，标题上就写清楚，不让它们混着说。 */
  var boardWindow = 'week';
  var winBoardCache = {};
  var winBoardLoading = {};
  var BOARD_WINDOWS = [['week', '本周'], ['month', '本月'], ['year', '本年'], ['all', '历史']];
  /* 榜单口径：人次（谁这儿爬得勤）与热门（数据里门票/接待量最大的那些山）。
     两者不是一回事，摆成两个按钮让用户自己切，标题上写清楚当前是哪个口径。 */
  var boardMetric = 'visits';

  function boardWindowTabs(act) {
    return '<div class="btn-row">' + BOARD_WINDOWS.map(function (w) {
      return '<button class="btn ghost" data-act="' + act + '" data-val="' + w[0] + '">' +
        (boardWindow === w[0] ? '✓ ' : '') + w[1] + '</button>';
    }).join('') + '</div>';
  }
  function boardMetricTabs(act) {
    return '<div class="btn-row">' + [['visits', '按人次'], ['hot', '按热门']].map(function (m) {
      return '<button class="btn ghost" data-act="' + act + '" data-val="' + m[0] + '">' +
        (boardMetric === m[0] ? '✓ ' : '') + m[1] + '</button>';
    }).join('') + '</div>';
  }
  function boardWindowLabel() {
    return (BOARD_WINDOWS.filter(function (w) { return w[0] === boardWindow; })[0] || [])[1];
  }
  /* 年接待量是长句，列表里只留"数字 + 万/人"这一小段 */
  function shortVisits(text) {
    if (!text) return '';
    var m = /([0-9]+([.][0-9]+)?)\s*万/.exec(text);
    if (m) return m[1] + ' 万人次/年';
    return text.length > 18 ? text.slice(0, 18) + '…' : text;
  }
  function boardKey(kind, metric) { return kind + ':' + metric + ':' + boardWindow; }
  function activeMountainMetric() { return boardMetric; }

  function loadBoard(kind, metric, onReady) {
    var key = boardKey(kind, metric);
    if (winBoardCache[key] || winBoardLoading[key]) return;
    winBoardLoading[key] = true;
    var url = kind === 'climbers'
      ? '/api/boards/climbers?window=' + boardWindow + '&limit=10'
      : '/api/boards/mountains?window=' + boardWindow + '&metric=' + metric + '&limit=10';
    if (kind === 'mountains' && metric === 'hot') {
      url = '/api/boards/mountains?metric=hot&limit=10';   /* 热门不随时间窗口变 */
    }
    window.API.ja(url).then(function (data) { winBoardCache[key] = data; })
      .catch(function () { winBoardCache[key] = { error: true }; })
      .then(function () {
        winBoardLoading[key] = false;
        if (onReady) onReady();
      });
  }

  function boardReload() {
    winBoardCache = {};
    render();
  }

  function mountainsBoardHTML(metric, opts) {
    opts = opts || {};
    loadBoard('mountains', metric, function () { if (parse().name === opts.page) render(); });
    var data = winBoardCache[boardKey('mountains', metric)];
    if (!data) return '<div class="empty">正在读取' + esc(opts.title || '榜单') + '…</div>';
    if (data.error) {
      return '<div class="empty">' + esc(opts.title || '榜单') +
        '暂时读不到，打卡与留言不受影响。<button class="btn ghost" data-act="board-retry">重试</button></div>';
    }
    if (!data.items || !data.items.length) {
      return '<div class="empty">这个时间段还没有记录。</div>';
    }
    return '<div class="card tight">' + data.items.slice(0, opts.limit || 5).map(function (row, index) {
      var sub = metric === 'hot'
        ? esc([row.heatTier, shortVisits(row.annualVisits)].filter(Boolean).join(' · ')) +
          ' · 本周 ' + row.visits + ' 次记录'
        : row.people + ' 人到访 · 共 ' + row.visits + ' 次记录' +
          (row.heatTier ? ' · ' + esc(row.heatTier) : '');
      return '<a class="rank" href="#/peaks/p-' + encodeURIComponent(row.pointCode || row.mountainId) + '">' +
        '<span class="pos" style="flex:0 0 26px;font-weight:800;color:var(--coral)">' +
        (index + 1) + '</span>' +
        '<span class="nm"><b>' + esc(row.name || '名称待定') + '</b><em>' + sub + '</em></span>' +
        '<span class="tm" style="font-size:12px;color:var(--ink3)">›</span></a>';
    }).join('') + '</div>' +
      '<div class="hint" style="padding:8px 2px 0">' +
      (metric === 'hot'
        ? '按资料里的热度档与年接待量排（门票/入园口径），不依赖这里打了多少卡；' +
          '数字来自公开年报与估算，标了"估算"的只作参考。'
        : metric === 'people'
          ? '按去重的到访身份数排（游客跨设备算不同身份）；同一座山的两个码算一座山。'
          : '按到访人次排：同一个人多次登顶都算，所以人次 ≥ 人数。') +
      '</div>';
  }

  function climbersBoardHTML(opts) {
    opts = opts || {};
    loadBoard('climbers', null, function () { if (parse().name === opts.page) render(); });
    var data = winBoardCache[boardKey('climbers', null)];
    if (!data) return '<div class="empty">正在读取位次榜…</div>';
    if (data.error) {
      return '<div class="empty">位次榜暂时读不到。<button class="btn ghost" data-act="board-retry">重试</button></div>';
    }
    if (!data.items || !data.items.length) {
      return '<div class="empty">这个时间段还没有人打卡。</div>';
    }
    var rows = data.items.slice(0, opts.limit || 5).map(function (row) {
      return '<div class="rank"><span class="pos" style="flex:0 0 26px;font-weight:800;color:var(--coral)">' +
        row.rank + '</span><span class="nm"><b>' + esc(row.nickname || '山友') +
        '</b><em>登过 ' + row.summits + ' 座山 · 共 ' + row.visits + ' 次记录</em></span></div>';
    }).join('');
    var mine = data.mine
      ? '<div class="hint" style="padding:8px 2px 0">我的位次：第 ' + data.mine.rank + ' 位 · 登过 ' +
        data.mine.summits + ' 座山 · 共 ' + data.mine.visits + ' 次记录</div>'
      : '<div class="hint" style="padding:8px 2px 0">登录后可以看到自己的位次。</div>';
    return '<div class="card tight">' + rows + '</div>' + mine +
      '<div class="hint" style="padding:4px 2px 0">只公开昵称与计数，不带账号、不带坐标。</div>';
  }

  /* 「城市」筛选：跟路书页的「区域」一个做法——按数据里真实存在的地区出卡。
     不再用"本市 / 本省 / 本国 / 海外"那种相对口径：没有账号级位置，
     那四档只能拿北京硬顶，"本省"和"本市"在北京还会变成同一批。

     山头榜里有 69 座名山，摊开是 26 个国家 + 33 个省级区，铺 60 张卡没法用，
     所以国内按省出卡、海外收成一档（想找具体国家用搜索框，峰名里带国名）。 */
  function peakRegion(p) {
    var prov = String(p.province || '').trim().replace(/(省|市|自治区|特别行政区)$/, '');
    if (prov) return prov;
    var co = String(p.country || '').trim();
    if (co && co !== '中国') return '海外';
    return '其他';        /* 没地区的（用户自建点位）只在"全部城市"里出现，不硬塞进某一档 */
  }

  function regionOptions(kind) {
    var cnt = {};
    (kind === 'trails' ? H.trails : H.peaks).forEach(function (item) {
      var r = kind === 'trails' ? regionOf(item) : peakRegion(item);
      if (r !== '其他') cnt[r] = (cnt[r] || 0) + 1;
    });
    var regions = Object.keys(cnt).sort(function (a, b) {
      if ((a === '海外') !== (b === '海外')) return a === '海外' ? 1 : -1;
      return cnt[b] - cnt[a] || a.localeCompare(b);
    });
    return [['all', '全部地区']].concat(regions.map(function (r) { return [r, r + ' ' + cnt[r]]; }));
  }

  var filterDraft = null, filterKind = '';
  function filterGroups(kind) {
    if (kind === 'trails') return [
      ['距离', 'kb', [['all','不限'],['s','10 km 以内'],['m','10–30 km'],['l','30–60 km'],['xl','60 km 以上']]],
      ['爬升', 'ru', [['all','不限'],['low','500 m 以下'],['mid','500–1500 m'],['high','1500 m 以上']]],
      ['地区', 'rg', regionOptions('trails')]
    ];
    if (kind === 'peaks') return [
      ['海拔', 'pf', [['all','不限'],['h8000','8000 m 以上'],['m3000','3000–8000 m'],['m1000','1000–3000 m'],['l1000','1000 m 以下']]],
      ['地区', 'pd', regionOptions('peaks')],
      ['登顶难度', 'plv', [['all','不限'],['easy','简单'],['mid','中等'],['hard','困难'],['hidden','隐藏']]]
    ];
    return [['核验状态', 'pf', [['all','全部'],['ok','已核验'],['wait','待核验']]]];
  }
  function currentFilter(kind) {
    return kind === 'trails' ? { kb:kb, ru:ru, rg:rg } :
      kind === 'peaks' ? { pf:pf, pd:pd, plv:plv } : { pf:pf };
  }
  function filterTrigger(kind) {
    var current = currentFilter(kind), active = [];
    filterGroups(kind).forEach(function (g) {
      if (current[g[1]] === 'all') return;
      var choice = g[2].filter(function (c) { return c[0] === current[g[1]]; })[0];
      if (choice) active.push(g[0] + '：' + choice[1].replace(/ \d+$/, ''));
    });
    return '<button class="filter-trigger ' + (kind === 'trails' ? 'trail' : kind === 'peaks' ? 'peak' : 'junction') +
      '" data-act="filter-open" data-val="' + kind + '"><span>' +
      (active.length ? active.map(esc).join(' · ') : '按条件查找') +
      '</span><b>筛选' + (active.length ? ' ' + active.length : '') + ' ›</b></button>';
  }
  function filterResultCount(kind, d) {
    if (kind === 'trails') return H.trails.filter(function (t) {
      return (d.rg === 'all' || regionOf(t) === d.rg) &&
        (d.kb === 'all' || d.kb === 's' && t.km < 10 || d.kb === 'm' && t.km >= 10 && t.km < 30 ||
         d.kb === 'l' && t.km >= 30 && t.km < 60 || d.kb === 'xl' && t.km >= 60) &&
        (d.ru === 'all' || d.ru === 'low' && t.up < 500 || d.ru === 'mid' && t.up >= 500 && t.up < 1500 ||
         d.ru === 'high' && t.up >= 1500) &&
        (!q.trim() || (t.name + ' ' + (t.sub || '') + ' ' + (t.city || '')).indexOf(q.trim()) >= 0);
    }).length;
    if (kind === 'peaks') return H.peaks.filter(function (p) {
      return (d.pd === 'all' || peakRegion(p) === d.pd) && (d.plv === 'all' || p.level === d.plv) &&
        (d.pf === 'all' || d.pf === 'h8000' && p.alt >= 8000 || d.pf === 'm3000' && p.alt >= 3000 && p.alt < 8000 ||
         d.pf === 'm1000' && p.alt >= 1000 && p.alt < 3000 || d.pf === 'l1000' && p.alt < 1000) &&
        (!pq.trim() || ((p.name || '') + ' ' + (p.trailName || '')).indexOf(pq.trim()) >= 0);
    }).length;
    var count = 0;
    H.junctions.forEach(function (j) { intelFor(j).forEach(function (i) {
      if ((d.pf === 'all' || d.pf === 'ok' && i.ok || d.pf === 'wait' && !i.ok) &&
          (!pq.trim() || ((j.name || '') + ' ' + (i.title || '') + ' ' + (i.text || '')).indexOf(pq.trim()) >= 0)) count++;
    }); });
    return count;
  }
  function drawFilterSheet() {
    var groups = filterGroups(filterKind);
    var oldBody = document.querySelector('.filter-sheet-body');
    var oldScroll = oldBody ? oldBody.scrollTop : 0;
    U.openSheet('<h3>筛选' + (filterKind === 'trails' ? '路线' : filterKind === 'peaks' ? '山头' : '岔路情报') + '</h3>' +
      '<div class="sh-sub">每组选择一项，可组合查找。</div><div class="filter-sheet-body">' +
      groups.map(function (g) { return '<section class="filter-group"><h4>' + g[0] + '</h4><div class="filter-options">' +
        g[2].map(function (o) { return '<button class="filter-option' + (filterDraft[g[1]] === o[0] ? ' on' : '') +
          '" data-act="filter-opt" data-key="' + g[1] + '" data-val="' + esc(o[0]) + '">' + esc(o[1]) + '</button>'; }).join('') +
        '</div></section>'; }).join('') + '</div><div class="filter-sheet-actions">' +
      '<button class="btn ghost" data-act="filter-reset">重置</button>' +
      '<button class="btn coral" data-act="filter-apply">查看 ' + filterResultCount(filterKind, filterDraft) + ' 条结果</button></div>');
    var newBody = document.querySelector('.filter-sheet-body');
    if (newBody) newBody.scrollTop = oldScroll;
  }

  function placesView() {
    var head = '';

    /* 搜索栏 + 筛选：两段共用，选项随分段变 */
    /* 海拔档位跟着数据走：以前榜上只有京郊 300–2300 m，用 1500/2000 分档还行；
       现在顶上有 8849 m 的珠峰，2000 m 以上等于"全部"——按登山界的分法重切。 */
    var FILTERS = seg === 'peak'
      ? [['all', '全部海拔'], ['h8000', '8000 m 以上'],
         ['m3000', '3000–8000 m'], ['m1000', '1000–3000 m'], ['l1000', '1000 m 以下']]
      : [['all', '全部'], ['ok', '已核验'], ['wait', '待核验']];
    if (FILTERS.every(function (f) { return f[0] !== pf; })) pf = 'all';
    var bar =
      '<div class="searchbar">🔍<input id="pq" type="search" aria-label="搜索山头名称或所属线路" placeholder="' +
      (seg === 'peak' ? '搜索山头名称或所属线路' : '搜索岔路名称或情报内容') +
      '" value="' + esc(pq) + '"></div>' +
      filterTrigger(seg === 'peak' ? 'peaks' : 'junctions');

    var segmentTabs = '<div class="seg places-seg" role="tablist" aria-label="占山为王分类">' +
      '<button role="tab" aria-selected="' + (seg === 'peak') + '" class="' + (seg === 'peak' ? 'on' : '') +
      '" data-act="seg" data-val="peak">山头</button>' +
      '<button role="tab" aria-selected="' + (seg === 'junction') + '" class="' + (seg === 'junction' ? 'on' : '') +
      '" data-act="seg" data-val="junction">岔路</button></div>';
    if (seg === 'peak') {
      var board = H.peaks.slice().sort(function (a, b) {
          return b.alt - a.alt;
        })
        .filter(function (p) {
          var kw = pq.trim();
          var okQ = !kw || (p.name || '').indexOf(kw) >= 0 || (p.trailName || '').indexOf(kw) >= 0;
          var okF = pf === 'all' ||
            (pf === 'h8000' && p.alt >= 8000) ||
            (pf === 'm3000' && p.alt >= 3000 && p.alt < 8000) ||
            (pf === 'm1000' && p.alt >= 1000 && p.alt < 3000) ||
            (pf === 'l1000' && p.alt < 1000);
          return okQ && okF && (seg !== 'peak' || pd === 'all' || peakRegion(p) === pd) &&
            (plv === 'all' || p.level === plv);
        });
      /* 顶部不再放"山野地点 / 占山为王"那组标题（2026-10-15 用户要求删） */
      return '<div class="places-page"><h1 class="sr">占山为王</h1>' + segmentTabs + newKingEntry('peak') + bar +
        /* 登顶榜放在山头列表之前：这是"占山为王"的主榜（人次口径），
           下面的山头卡是完整名单。先选山头也能直接点进榜上的山。 */
        '<div class="sec-head" id="page-board" style="margin-top:6px"><h3>登顶榜</h3>' +
        '<span class="more">' + (activeMountainMetric() === 'hot' ? '热门山头' : boardWindowLabel() + ' · 人次') +
        ' ›</span></div>' +
        boardMetricTabs('board-metric') +
        (activeMountainMetric() === 'hot' ? '' : boardWindowTabs('board-window')) +
        mountainsBoardHTML(activeMountainMetric(), { page: 'places', limit: 6 }) +
        '<div class="sec-head" id="page-peaks" style="margin-top:4px"><h3>山头</h3>' +
        '<span class="more">' + (pq || pf !== 'all' || pd !== 'all'
          ? board.length + ' 个结果' : H.peaks.length + ' 个 · 按海拔 ›') + '</span></div>' +
        (board.length ? pageSlice(board, 'peaks', PAGE_SIZE).map(function (p, i) {
          return locCard({
            href: '#/peaks/' + p.id,
            scene: U.scene(p.id),
            /* 标题是**主峰名**。没采到就写「名称待定」——绝不拿线路名冒充峰名，
               线路只在下面那行 @ 出来。 */
            title: p.name ? esc(p.name) : '<span class="tbd">名称待定</span>',
            sub: '海拔 ' + p.alt + ' m' + (p.city ? ' · ' + esc(p.city) : '') +
                 (p.rise && p.km ? ' · 最难一段 +' + p.rise + ' m / ' + p.km + ' km' : ''),
            route: p.routeSlug ? { slug: p.routeSlug, name: p.trailName } : null,
            heat: p.visits30 || 0,
            footTitle: p.origin === 'user' ? '还没有人留言' : '山顶留言',
            /* 自建点位不套用示例留言——那是编的，用户自己的点位里一眼就能看出来 */
            foots: [{ plain: true, who: p.code || '山头',
              text: '进入山头查看现场留言与登顶路线。' }]
          });
        }).join('') : '<div class="empty">没有匹配的山头</div>') +
        pager('peaks', board.length, PAGE_SIZE) +
        '</div>';
    }

    var all = [];
    H.junctions.forEach(function (j) {
      intelFor(j).forEach(function (i) { all.push({ j: j, i: i }); });
    });
    var kw = pq.trim();
    all = all.filter(function (x) {
      var okQ = !kw || (x.j.name || '').indexOf(kw) >= 0 ||
        (x.i.title || '').indexOf(kw) >= 0 || (x.i.text || '').indexOf(kw) >= 0;
      var okF = pf === 'all' || (pf === 'ok' && x.i.ok) || (pf === 'wait' && !x.i.ok);
      return okQ && okF;
    });
    all.sort(function (a, b) { return (b.i.mine ? 1 : 0) - (a.i.mine ? 1 : 0) || (b.i.ok ? 0 : 1) - (a.i.ok ? 0 : 1); });
    /* 同上：顶部标题组已删 */
    return '<div class="places-page">' + segmentTabs + newKingEntry('junction') + bar +
      '<div class="sec-head" id="page-junctions" style="margin-top:4px"><h3>岔路情报 · 最新</h3><span class="more">共 ' + all.length + ' 条</span></div>' +
      '<div class="hint" style="margin-top:-6px">岔路的留言不是情绪，是情报：往哪走、能不能过。</div>' +
      (all.length ? pageSlice(all, 'junctions', CAROUSEL_PAGE).map(function (x) {
        var person = personOf(x.i.who);
        return '<div data-act="goto-junction" data-id="' + x.j.id + '">' + locCard({
          scene: U.scene(x.j.id),
          title: esc(person.name) + ' 上报 <span class="soon-tag">示例</span>',
          sub: '第 ' + (x.j.index || 1) + ' 个点位 · ' + (x.i.ok ? '已核验' : '待核验'),
          heat: 0,
          footTitle: '岔路情报',
          foots: [
            { who: person.name, text: esc(x.i.title) },
            { who: '维护人', text: esc(x.i.text) },
            { who: '路况', text: x.i.ok ? '已核验，可以放心走。' : '还没人核验，走过去留意一下。' }
          ]
        }) + '</div>';
      }).join('') : '<div class="empty">没有匹配的岔路情报</div>') +
      pager('junctions', all.length, CAROUSEL_PAGE) +
      '<div class="hint" style="text-align:center;margin-top:6px">共 ' + all.length + ' 条情报 · 来自 ' +
      H.junctions.length + ' 个岔路点位</div></div>';
  }

  /* 山头 / 岔路 共用卡片：
     上半 = 图 + 名称 + 定位 + 热度 +「我到过」；下半 = 留言 / 情报。
     两张卡片大小一致。 */
  /* 热门登顶榜 · 一张卡一座山
     左：主峰名 + 地点（大字），下面 单段爬升 / 单段距离 / 打卡人数
     右：登顶最快用时 / 记录保持 */
  function hotCard(h, i) {
    var href = h.kind === 'peak' ? '#/peaks/' + h.target_key : '#/trails/' + h.target_key;
    return '<div class="hotcard">' +
      '<a class="hc-main" href="' + href + '">' +
      '<span class="no' + (i < 3 ? ' top' : '') + '">' + h.rank + '</span>' +
      '<span class="l">' +
        /* 大字是主峰名。没采到就写「名称待定」，线路只在小字里 @ 出来 */
        '<b>' + (h.name ? esc(h.name) : '<span class="tbd">名称待定</span>') + '</b>' +
        '<span class="st2">海拔 ' + h.altitude + ' m' +
        (h.city ? ' · ' + esc(h.city) : '') + '</span>' +
        '<span class="st"><span>单段爬升 <i>' + h.seg_rise + ' m</i></span>' +
        '<s>·</s><span>单段距离 <i>' + h.seg_km + ' km</i></span>' +
        '<s>·</s><span>打卡 <i>' + h.visitors + ' 人</i></span></span>' +
      '</span>' +
      '<span class="r">' +
        '<span class="rb">' + (h.fastest_time || '—') + '</span><i>登顶最快</i>' +
        '<span class="rh">' + esc(h.fastest_holder || '还没人记录') + '</span><i>记录保持</i>' +
      '</span></a>' +
      (h.route_slug ? '<a class="hc-route" href="#/trails/' + h.route_slug + '">@' +
        esc(h.route_name) + ' · 看整条路书 ›</a>' : '') +
      '</div>';
  }

  /* 热门登顶榜和上面的山头榜共用同一套筛选（城市 / 海拔 / 登顶难度）。
     它的字段是接口原始形状（altitude / level / province…），所以单独判一遍。 */
  function hotPass(h) {
    var alt = h.altitude || 0;
    var okF = pf === 'all' ||
      (pf === 'h8000' && alt >= 8000) ||
      (pf === 'm3000' && alt >= 3000 && alt < 8000) ||
      (pf === 'm1000' && alt >= 1000 && alt < 3000) ||
      (pf === 'l1000' && alt < 1000);
    return okF && (pd === 'all' || peakRegion(h) === pd) &&
      (plv === 'all' || !h.level || h.level === plv);
  }

  function hotBoard() {
    var all = H.hotPeaks || [];
    var rows = all.filter(hotPass);
    if (!rows.length) {
      if (all.length) {
        return '<div class="sec-head"><h3>热门登顶榜</h3>' +
          '<span class="more">0 / ' + all.length + ' 座 ›</span></div>' +
          '<div class="empty"><span class="big">🔍</span>当前筛选条件下，这个榜里没有山头，' +
          '换个城市或海拔档试试。</div>';
      }
      var why = (window.API && window.API.hotError)
        ? '接口 /api/peaks/hot 报错：' + esc(window.API.hotError)
        : '接口返回了空列表';
      return '<div class="sec-head"><h3>热门登顶榜</h3>' +
        '<span class="more">本周打卡 + 关注 ›</span></div>' +
        '<div class="empty"><span class="big">📡</span>' + why + '<br>' +
        '<span style="font-size:12.5px">如果刚才还好好的，多半是页面还是旧的——' +
        '重新加载一次就好</span><br>' +
        '<button class="btn ghost" style="margin-top:12px" data-act="reload">重新加载</button></div>';
    }
    return '<div class="sec-head" id="page-peakHot"><h3>热门登顶榜</h3>' +
      '<span class="more">' + rows.length + ' 座 · 本周打卡 + 关注</span></div>' +
      pageSlice(rows, 'peakHot', PAGE_SIZE).map(function (h, i) { return hotCard(h, i); }).join('') +
      pager('peakHot', rows.length, PAGE_SIZE) +
      '<div class="hint" style="text-align:center;margin-top:-4px">' +
      '排名 = 本周打卡 ×3 + 近 30 天打卡 + 关注 ×2</div>';
  }

  /* 成为版主：认领一个已经存在的山头 / 岔路（不是新建） */
  /* ==================== 游客模式 ====================
     规则：游客能**看**（路书 / 山头 / 留言）+ **打卡**（带时间戳的到此一游凭证）；
     想留言、想起个称呼，一律走注册流程 —— 所以游客只有一个写入口：打卡。
     没有匿名 UGC，也就没有匿名内容要审。 */

  function fmtLocal(iso) {
    var d = new Date(iso);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 到访卡：打卡结果先给足（时间戳、第几位、海拔、线路位置），再提注册。
     三件事里两件要注册，所以这张卡同时也是转化点——但顺序不能反。 */
  function sheetGuestCard(v) {
    var loggedIn = !!localStorage.getItem('hikes.auth.token');
    U.openSheet(
      '<h3>已到达：' + esc(v.peakName || v.pointCode) + '</h3>' +
      '<div class="sh-sub">' + fmtLocal(v.visitedAt) + ' · 到此一游凭证</div>' +
      '<div class="card" style="text-align:center;padding:18px 14px">' +
      '<span class="seal">#' + v.seq + '</span>' +
      '<div style="font-size:14px;font-weight:800;margin-top:9px">' +
      esc(v.peakName || ('海拔 ' + (v.altitude || '—') + ' m')) + '</div>' +
      '<div style="font-size:12.5px;color:var(--ink3);margin-top:5px">' +
      /* 序号是"这个点位入账的记录序号"，不是"第几个人"——同一个人每天最多一条，
         所以它谈的是记录，不是人数（计划第 2 节）。 */
      '该点位第 ' + v.seq + ' 条到访记录' +
      (v.routeName ? ' · ' + esc(v.routeName) + ' 第 ' + v.idxInRoute + '/' + v.totalInRoute + ' 个点位' : '') +
      '</div>' +
      '<div style="font-size:12px;color:var(--ink3);margin-top:7px">' +
      (v.altitude ? '海拔 ' + v.altitude + ' m · ' : '') + '编号 ' + esc(v.pointCode) + '</div>' +
      '</div>' +
      '<div class="hint" style="text-align:center">正式用时与名次在凭证详情里；这里不用手动开计时。</div>' +
      '<button class="btn ghost" data-act="arrival-draft" data-code="' + esc(v.pointCode) + '">留一句给下一位</button>' +
      (loggedIn ? '<div class="hint" style="text-align:center;margin-top:10px">已存到你的账号。</div>' :
        '<button class="btn ghost" style="margin-top:9px" data-act="signup" data-why="nickname">' +
        '起个称呼，让下一位知道是谁</button>' +
        '<div class="hint" style="text-align:center;margin-top:10px">' +
        '纪念和留言草稿可先保存；公开发布和署名需要账号。</div>' +
        '<button class="btn coral" style="margin-top:10px" data-act="signup" data-why="save">' +
        '存到我名下（换手机也不丢）</button>') +
      '<a class="btn ghost" style="margin-top:9px" href="#/peaks/p-' + encodeURIComponent(v.pointCode) + '">查看这座山</a>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">先这样</button>'
    );
  }

  /* 注册引导：先说清"为什么要注册"，不跳走、不打断已经拿到的凭证 */
  function sheetSignup(why) {
    var reason = {
      comment: '留言需要一个身份——它会被挂在你的名字下面',
      nickname: '称呼是署名的一种，所以得先有账号',
      save: '把这条到此一游记录存到你名下，换手机也不丢',
      claim: '认领山头并维护留言板需要一个账号',
      collaboration: '申请协助维护这块山顶留言板需要一个账号',
      browse: '注册后可保存你走过和关注的线路，继续探索时也能找回'
    }[why] || '这部分需要登录后才能用';
    U.openSheet(
      '<h3>注册或登录</h3><div class="sh-sub">' + esc(reason) + '。</div>' +
      '<div class="field"><label>用户名</label><input id="arrivalUser" autocomplete="username" maxlength="32"></div>' +
      '<div class="field"><label>邮箱（注册必填）</label><input id="arrivalEmail" type="email" autocomplete="email" maxlength="254"></div>' +
      '<div class="field"><label>密码</label><input id="arrivalPassword" type="password" autocomplete="current-password" maxlength="128"></div>' +
      '<div class="hint">新账号密码至少 12 位；登录后当前到访与草稿会并入账号。</div>' +
      '<div id="arrivalAuthError" class="hint" role="status"></div>' +
      '<button class="btn coral" data-act="arrival-auth" data-mode="register">' +
      (why === 'browse' ? '注册并继续探索' : '注册并保存') + '</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="arrival-auth" data-mode="login">已有账号，登录</button>' +
      '<div class="hint">注册即表示你同意 <a href="/terms.html" target="_blank">《用户协议》</a>，' +
      '并已知悉 <a href="/privacy.html" target="_blank">《隐私政策》</a>；' +
      '留言请遵守 <a href="/rules.html" target="_blank">《留言规范》</a>。</div>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">先不注册</button>'
    );
  }

  function accountName(account) {
    return account && (account.nickname || account.username) || '山友';
  }

  function syncMeIdentity(account) {
    if (account) {
      H.me.name = accountName(account);
      H.me.av = H.me.name.slice(0, 1);
      H.me.account = account;
    } else {
      H.me.name = '游客';
      H.me.av = '客';
      H.me.account = null;
    }
  }

  function authNext() {
    try {
      var raw = (location.hash || '').replace(/^#/, '');
      var at = raw.indexOf('?');
      var next = at >= 0 ? new URLSearchParams(raw.slice(at + 1)).get('next') : '';
      if (next && /^#\/[^#]*$/.test(next)) return next;
    } catch (e) { /* Ignore malformed links. */ }
    return '#/me';
  }

  function requestAuth(mode, username, password, nickname, email) {
    var body = { username: username, password: password };
    if (mode === 'register' && nickname) body.nickname = nickname;
    if (mode === 'register' && email) body.email = email;
    return window.API.guestToken().then(function (guestToken) {
      return window.API.timedFetch('/api/auth/' + mode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Guest-Token': guestToken || '' },
        body: JSON.stringify(body)
      });
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.ok) return data;
        var error = data && (data.error || (data.detail && data.detail.error));
        var failure = new Error((error && error.message) ||
          (response.status === 401 ? '用户名或密码错误' : '注册或登录失败'));
        failure.status = response.status;
        failure.code = error && error.code;
        throw failure;
      });
    });
  }

  function commitAuthSession(data, mode, oldGuestToken, username, nickname) {
    if (!oldGuestToken) {
      try { oldGuestToken = localStorage.getItem('hikes.guest.token'); } catch (e) { /* ignore */ }
    }
    localStorage.setItem('hikes.auth.token', data.token);
    localStorage.setItem('hikes.auth.userId', String(data.userId));
    window.API.setToken(data.token);
    window.API.setAccount({
      userId: data.userId,
      username: username,
      nickname: nickname || username
    });
    syncMeIdentity(window.API.account);

    var queueRebind = mode === 'register'
      ? window.HIKES_CHECKIN.rebind('g:' + (oldGuestToken || ''), 'u:' + data.userId)
      : Promise.resolve(0);
    queueRebind.then(function () { return window.HIKES_CHECKIN.route(); });

    var draftResults = [];
    return window.API.loadAccount().then(function (account) {
      if (account) syncMeIdentity(account);
      return moveGuestDraftsToAccount(oldGuestToken, data.userId);
    }).then(function (results) {
      draftResults = results || [];
      localStorage.removeItem('hikes.guest.token');
      window.API.resetGuest();
      return window.API.ja('/api/me/summits').catch(function () { return []; });
    }).then(function (items) {
      H.mySummits = items || [];
      _hiddenCommentsLoaded = false;
      return {
        draftSyncFailed: draftResults.some(function (ok) { return !ok; }),
        mergedVisits: data.mergedVisits || 0,
        mergedDrafts: data.mergedDrafts || 0
      };
    });
  }

  function authView(mode) {
    var account = window.API.account;
    if (account) {
      return '<div class="auth-page"><div class="card account-card">' +
        '<div class="profile"><div class="big">' + esc(accountName(account).slice(0, 1)) + '</div>' +
        '<div><b>' + esc(accountName(account)) + '</b><span>@' + esc(account.username) + ' · 已登录</span></div></div>' +
        '<a class="btn coral" href="#/me">返回「我」</a>' +
        '<button class="btn ghost" style="margin-top:9px" data-act="logout">退出登录</button>' +
        '</div></div>';
    }
    var register = mode === 'register';
    var expired = window.API.accountState === 'expired';
    return '<div class="auth-page">' +
      '<header class="auth-head"><span class="group-label">ACCOUNT</span>' +
      '<h1>' + (register ? '创建账号' : '登录') + '</h1>' +
      '<p>登录后可跨设备保存到访记录，并参与留言、申请和共同维护。</p></header>' +
      '<div class="seg auth-switch" role="tablist" aria-label="登录或注册">' +
      '<button type="button" role="tab" aria-selected="' + (!register) + '" class="' + (!register ? 'on' : '') +
      '" data-act="auth-mode" data-val="login">登录</button>' +
      '<button type="button" role="tab" aria-selected="' + register + '" class="' + (register ? 'on' : '') +
      '" data-act="auth-mode" data-val="register">注册</button></div>' +
      (expired ? '<div class="auth-note" role="status">登录已过期，请重新登录。</div>' : '') +
      '<form id="authForm" class="card auth-form" data-mode="' + (register ? 'register' : 'login') + '" novalidate>' +
      '<div class="field"><label for="authUser">用户名</label>' +
      '<input id="authUser" name="username" type="text" autocomplete="username" maxlength="32" ' +
      'aria-describedby="authUserHelp" required>' +
      '<div class="auth-help" id="authUserHelp">3–32 位英文字母、数字或下划线</div></div>' +
      (register ? '<div class="field"><label for="authNickname">昵称 <small>可选</small></label>' +
        '<input id="authNickname" name="nickname" type="text" autocomplete="nickname" maxlength="32">' +
        '<div class="auth-help">不填时显示用户名</div></div>' : '') +
      (register ? '<div class="field"><label for="authEmail">邮箱</label>' +
        '<input id="authEmail" name="email" type="email" autocomplete="email" maxlength="254" required>' +
        '<div class="auth-help">验证邮箱后才能登录、留言或提交山头申请</div></div>' : '') +
      '<div class="field"><label for="authPassword">密码</label>' +
      '<input id="authPassword" name="password" type="password" autocomplete="' +
      (register ? 'new-password' : 'current-password') + '" maxlength="128" required></div>' +
      (register ? '<div class="field"><label for="authPassword2">确认密码</label>' +
        '<input id="authPassword2" name="password2" type="password" autocomplete="new-password" maxlength="128" required></div>' : '') +
      (register ? '<div class="auth-help" style="margin-top:-5px">密码至少 12 位</div>' : '') +
      '<div id="authError" class="auth-note" role="alert" aria-live="polite"></div>' +
      '<button class="btn coral" id="authSubmit" type="submit">' +
      (register ? '创建账号' : '登录') + '</button>' +
      '<div class="auth-legal">' + (register
        ? '注册即表示你同意 <a href="/terms.html" target="_blank">《用户协议》</a>和<a href="/privacy.html" target="_blank">《隐私政策》</a>。'
        : '还没有账号？<button type="button" class="auth-link" data-act="auth-mode" data-val="register">立即注册</button>') +
      '</div></form></div>';
  }

  function submitAuthPage(form) {
    var mode = form.getAttribute('data-mode') === 'register' ? 'register' : 'login';
    var username = (document.getElementById('authUser') || {}).value || '';
    var password = (document.getElementById('authPassword') || {}).value || '';
    var nickname = (document.getElementById('authNickname') || {}).value || '';
    var email = (document.getElementById('authEmail') || {}).value || '';
    var password2 = (document.getElementById('authPassword2') || {}).value || '';
    var errorEl = document.getElementById('authError');
    var submit = document.getElementById('authSubmit');
    function fail(message) {
      if (errorEl) errorEl.textContent = message;
      if (submit) submit.disabled = false;
    }
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username.trim())) {
      fail('用户名需为 3–32 位英文字母、数字或下划线。');
      return;
    }
    if (!password) { fail('请填写密码。'); return; }
    if (mode === 'register' && password.length < 12) {
      fail('密码至少需要 12 位。'); return;
    }
    if (mode === 'register' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      fail('请填写有效邮箱，验证链接会发送到这个地址。'); return;
    }
    if (mode === 'register' && password !== password2) {
      fail('两次输入的密码不一致。'); return;
    }
    if (errorEl) errorEl.textContent = '';
    if (submit) {
      submit.disabled = true;
      submit.textContent = mode === 'register' ? '正在创建…' : '正在登录…';
    }
    var oldGuestToken = null;
    try { oldGuestToken = localStorage.getItem('hikes.guest.token'); } catch (e) { /* ignore */ }
    requestAuth(mode, username.trim(), password, nickname.trim(), email.trim())
      .then(function (data) {
        if (mode === 'register' && data.status === 'verification_sent') {
          if (errorEl) errorEl.className = 'auth-help';
          if (errorEl) errorEl.textContent = '验证邮件已发送。请打开邮件中的链接完成验证，再回来登录；当前游客到访记录仍保存在本设备。';
          if (submit) { submit.disabled = true; submit.textContent = '请先验证邮箱'; }
          return null;
        }
        return commitAuthSession(data, mode, oldGuestToken, username.trim(), nickname.trim());
      })
      .then(function (result) {
        if (!result) return;
        U.closeSheet();
        U.toast(result.draftSyncFailed ? '已登录；草稿保存在本机，联网后可重试' :
          '已登录，到访与草稿已保存');
        location.hash = authNext();
      })
      .catch(function (error) {
        if (error && error.code === 'EMAIL_NOT_VERIFIED') {
          fail('邮箱尚未验证。请查看收件箱或垃圾邮件文件夹，并打开验证链接。'); return;
        }
        fail(error && error.message || '注册或登录失败，请稍后重试');
      });
  }

  function arrivalCode() {
    var r = parse(), p = peak(r.id);
    return p && p.code;
  }

  function arrivalRequest(url, method, body, guest) {
    return (guest ? window.API.guestToken() : window.API.token()).then(function (tk) {
      if (!tk) throw new Error('身份不可用，请稍后重试');
      return window.API.timedFetch(url, { method: method, headers: {
        'Content-Type': 'application/json',
        [guest ? 'X-Guest-Token' : 'Authorization']: guest ? tk : 'Bearer ' + tk
      }, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) {
            var error = new Error(d.message || d.detail && d.detail.message || '请求失败，请稍后重试');
            error.status = r.status;
            throw error;
          }
          return d;
        });
      });
    });
  }

  function arrivalDraftOwner() {
    try {
      var token = localStorage.getItem('hikes.auth.token');
      if (token) {
        var uid = localStorage.getItem('hikes.auth.userId');
        if (!uid) uid = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
        return 'u:' + uid;
      }
      var guest = localStorage.getItem('hikes.guest.token');
      return guest ? 'g:' + guest : null;
    } catch (e) { return null; }
  }

  function arrivalDraftKey(code, owner) {
    return 'hikes.arrival.draft.' + owner + ':' + code;
  }

  function localArrivalDraft(code, owner) {
    try {
      var draft = JSON.parse(localStorage.getItem(arrivalDraftKey(code, owner || arrivalDraftOwner())) || 'null');
      return draft && (draft.privateNote || draft.publicCommentDraft) ? draft : null;
    }
    catch (e) { return null; }
  }

  function rememberArrivalDraft(code, note, comment) {
    var owner = arrivalDraftOwner();
    if (!owner) return;
    try {
      if (!note && !comment) {
        localStorage.removeItem(arrivalDraftKey(code, owner));
        return;
      }
      localStorage.setItem(arrivalDraftKey(code, owner), JSON.stringify({
        privateNote: note, publicCommentDraft: comment
      }));
    } catch (e) { /* Storage unavailable; server save remains available. */ }
  }

  function moveGuestDraftsToAccount(guestToken, userId) {
    if (!guestToken) return Promise.resolve([]);
    var prefix = 'hikes.arrival.draft.g:' + guestToken + ':';
    var pending = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf(prefix) === 0) {
          var code = key.slice(prefix.length), draft = JSON.parse(localStorage.getItem(key));
          if (!draft || (!draft.privateNote && !draft.publicCommentDraft)) continue;
          localStorage.setItem(arrivalDraftKey(code, 'u:' + userId), JSON.stringify(draft));
          pending.push({ key: key, code: code, draft: draft });
        }
      }
    } catch (e) { return Promise.resolve([]); }
    return Promise.all(pending.map(function (item) {
      return arrivalRequest('/api/me/arrival-drafts', 'PUT', {
        code: item.code, privateNote: item.draft.privateNote,
        publicCommentDraft: item.draft.publicCommentDraft
      }).then(function () { localStorage.removeItem(item.key); return true; })
        .catch(function () { return false; });
    }));
  }

  function sheetArrivalDraft(code) {
    if (!code) return;
    if (!localStorage.getItem('hikes.auth.token')) window.API.guestToken();
    var local = localArrivalDraft(code);
    U.openSheet('<h3>这次到访</h3><div class="sh-sub">' + esc(code) + '</div>' +
      '<div class="field"><label>私人纪念（只有自己可见）</label><textarea id="arrivalPrivate" maxlength="500"></textarea></div>' +
      '<div class="field"><label>给山友的留言草稿</label><textarea id="arrivalPublic" maxlength="200"></textarea></div>' +
      '<div id="arrivalDraftError" class="hint" role="status">正在读取已有草稿…</div>' +
      '<button class="btn coral" data-act="arrival-draft-save" data-code="' + esc(code) + '">保存草稿</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="arrival-draft-publish" data-code="' + esc(code) + '">署名发布留言</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">返回</button>');
    if (local) {
      document.getElementById('arrivalPrivate').value = local.privateNote || '';
      document.getElementById('arrivalPublic').value = local.publicCommentDraft || '';
      document.getElementById('arrivalDraftError').textContent = '草稿已从本机恢复。';
    }
    window.API.token().then(function (tk) {
      return tk ? arrivalRequest('/api/me/arrival-drafts', 'GET').then(function (rows) {
        return rows.filter(function (d) { return d.code === code; })[0] || {};
      }) : arrivalRequest('/api/guest/arrival-draft?code=' + encodeURIComponent(code), 'GET', null, true);
    }).then(function (d) {
      if (document.getElementById('arrivalPrivate') && !local &&
          !document.getElementById('arrivalPrivate').value &&
          !document.getElementById('arrivalPublic').value) {
        document.getElementById('arrivalPrivate').value = d.privateNote || '';
        document.getElementById('arrivalPublic').value = d.publicCommentDraft || '';
        document.getElementById('arrivalDraftError').textContent = '';
      }
    }).catch(function (e) {
      var el = document.getElementById('arrivalDraftError');
      if (el) el.textContent = e.message;
    });
  }

  var newPointDraft = null;
  function masterCandidateRows(query) {
    /* 使用点位台账；只展示主峰会漏掉岔路与同线路的其它可认领点。 */
    var seen = {};
    var cand = (H.points || []).filter(function (p) {
      return p.status === 'published' && (p.type === 'peak' || p.type === 'junction');
    }).map(function (p) {
      return { code: p.code, name: p.name, trailName: p.route_name,
        alt: p.altitude, kind: p.type, visits30: p.visit_count || 0 };
    }).sort(function (a, b) {
      return (b.visits30 || 0) - (a.visits30 || 0) || (b.alt || 0) - (a.alt || 0);
    }).filter(function (p) {
      var k = p.code;
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    }).filter(function (p) {
      var haystack = [p.name, p.trailName, p.code].join(' ').toLowerCase();
      return !query || haystack.indexOf(query.toLowerCase()) >= 0;
    }).slice(0, query ? 100 : 8);
    return cand.length ? cand.map(function (p) {
      return '<button class="hotrow" style="width:100%;text-align:left;background:none" ' +
        'data-act="master-claim" data-code="' + esc(p.code) + '" ' +
        'data-name="' + esc(p.name || p.trailName || '名称待定') + '">' +
        '<span class="no">' + (p.alt || '') + '</span>' +
        '<span class="nm"><b>' + (p.name ? esc(p.name) : '<span class="tbd">名称待定</span>') + '</b>' +
        '<em>' + (p.trailName ? esc(p.trailName) + ' · ' : '') +
        (p.kind === 'junction' ? '岔路 · ' : '山头 · ') + '编号 ' + esc(p.code) +
        ' · 海拔 ' + (p.alt || '—') + ' m' +
        '</em></span><span class="mt" style="color:var(--coral)">申请维护</span></button>';
    }).join('') : '<div class="empty">没有找到这个点位。试试名称、城市或编号。</div>';
  }

  function sheetBecomeMaster() {
    U.openSheet(
      '<h3>成为版主</h3>' +
      '<div class="sh-sub">选一个已经立好的山头或岔路，你来做它的维护人</div>' +
      '<div class="card" style="box-shadow:none;background:var(--blue-bg);padding:14px;margin-bottom:12px">' +
      '<div style="font-size:12.5px;color:#2B3568;line-height:1.75">' +
      '版主负责已有点位的留言板与路况信息。提交后进入 3 天审核，' +
      '通过才开放管理权限；已有点位的编号和二维码保持不变。<br>' +
      '如果山头尚未收录，请从下方新建入口填写资料和 GPX 轨迹。</div></div>' +
      '<div class="group-label">可以申请维护的点位</div>' +
      '<div class="field"><label for="masterSearch">搜索点位、线路或编号</label>' +
      '<input id="masterSearch" type="search" placeholder="例如 妙峰山 / 线路名 / MFS-01"></div>' +
      '<div class="card tight" id="masterCandidates">' + masterCandidateRows('') + '</div>' +
      '<button class="btn ghost" style="margin-top:12px" data-act="master-new-point">' +
      '没找到我的山？新建山头并领取二维码</button>' +
      (newPointDraft ? '<button class="btn ghost" style="margin-top:9px" data-act="new-point-resume">返回刚才填写的新建资料</button>' : '') +
      '<button class="btn ghost" style="margin-top:12px" data-act="close">先算了</button>');
  }

  /* 点「所有」：这一周的打卡记录 + 打卡人数最多的 5 座主峰 */
  function sheetHotAll() {
    U.openSheet('<h3>本周打卡</h3><div class="sh-sub">正在加载…</div>');
    var hot = (H.hotPeaks || []).slice(0, 5);
    fetch('/api/visits/recent?days=7&limit=40')
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; })
      .then(function (feed) {
        var el = document.getElementById('sheet');
        if (!el) return;
        el.innerHTML =
          '<h3>本周打卡</h3>' +
          '<div class="sh-sub">最近 7 天，谁在哪座山上留了痕</div>' +

          '<div class="group-label">打卡人数最多的 5 座主峰</div>' +
          hot.map(function (h, i) { return hotCard(h, i); }).join('') +

          '<div class="group-label" style="margin-top:16px">最近一周的打卡记录</div>' +
          (feed.length
            ? '<div class="card tight">' + feed.map(function (f) {
                return '<a class="hotrow" href="' + f.href + '">' +
                  '<span class="no">' + esc(String(f.who).slice(0, 1)) + '</span>' +
                  '<span class="nm"><b>' + esc(f.who) + ' · ' + esc(f.place || '') + '</b>' +
                  '<em>' + whenAgo(f.at) + (f.time ? ' · 用时 ' + f.time : '') + '</em></span>' +
                  '<span class="mt">›</span></a>';
              }).join('') + '</div>'
            : '<div class="empty">这一周还没有人打卡。<br>' +
              '<span style="font-size:12.5px">第一个扫码的人会出现在这里</span></div>') +

          '<button class="btn ghost" style="margin-top:14px" data-act="close">' +
          '查看更多 · 先收起</button>';
      });
  }

  /* ISO 时间 → "3 小时前" */
  function whenAgo(iso) {
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }

  /* 占山为王 / 我是NPC指路人：页首那张入口卡。
     同一条卡片两个说法，跟着分段走——岔路口不是山头，站在那里的人是"指路人"，
     不是"山大王"：山上的人找的是风景和留言板，岔路口的人只想知道往哪走。
     data-kind 一并带出去，点进去建的就是对应类型的点位（后端 /api/points 认 kind）。 */
  function newKingEntry(kind) {
    var jc = kind === 'junction';
    return '<button class="kingcard king-hero' + (jc ? ' npc' : '') + '" data-act="king-open" ' +
      'data-kind="' + (jc ? 'junction' : 'peak') + '">' +
      '<span class="kk-ridge">' +
      '<svg viewBox="0 0 400 80" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="M0 80 L0 54 L44 27 L84 51 L128 21 L172 55 L212 35 L256 59 ' +
      'L300 31 L342 55 L400 27 L400 80 Z" fill="#5A1200" opacity=".17"/></svg>' +
      '</span>' +
      '<span class="kk-tx">' +
      '<b class="kk-big">' + (jc ? '<span class="kk-line">我是 <em>NPC</em></span><span class="kk-line kk-line-big">指路人</span>' : '占山为王') + '</b>' +
      '<span class="kk-sub">' + (jc ? '站在岔路口，给后来的人指条明路'
        : '申请成为负责人，或加入一座山的山寨') + '</span>' +
      '<span class="kk-sub">' + (jc ? '统一申请 · 平台审核 · 通过后发编号和二维码'
        : '申请、审核、成员协作都在这一条线里') + '</span>' +
      '</span>' +
      '<span class="kk-imp">' +
      '<span class="kk-say">' + (jc ? '前面左转上山' : '大王叫我来巡山') + '</span>' +
      '<img class="kk-mascot" src="images/mascots/' + (jc ? 'guide.png' : 'patrol.png') +
      '" alt="" width="108" height="114">' +
      '<span class="kk-go">开始统一申请<i>›</i></span>' +
      '</span></button>' +
      '<div id="kingProgress" class="king-progress"></div>';
  }

  var npGeo = { lat: null, lng: null };
  var npGpx = null;      /* 选中的 GPX 原文 */
  var npKind = 'peak';   /* 这次建的是山头还是岔路口——决定表单和建成后的文案 */
  function newPointSheet(kind, resume) {
    if (!resume) { npGeo = { lat: null, lng: null }; npGpx = null; newPointDraft = null; }
    npKind = kind === 'junction' ? 'junction' : 'peak';
    var jc = npKind === 'junction';
    U.openSheet(
      '<h3>' + (jc ? '我是NPC指路人' : '我要成为山大王') + '</h3>' +
      '<div class="sh-sub">' + (jc
        ? '立在岔路口，给路过的人指条明路；编号和二维码一样当场就发'
        : '建好立刻拿到编号和二维码，印出来贴上去就能用') + '</div>' +
      '<div class="field"><label>' + (jc ? '这个岔路口叫什么' : '这座山叫什么') + '</label>' +
      '<input id="npName" type="text" maxlength="30" placeholder="' + (jc
        ? '没名字也行，比如「林道岔口」' : '没名字也行，比如「老鹰嘴」') + '"></div>' +
      '<div class="field"><label>一句话介绍 · 必填</label>' +
      '<input id="npIntro" type="text" maxlength="200" ' +
      'placeholder="' + (jc ? '往哪走、能不能过。这句话会成为第一条情报'
        : '怎么走、什么样。这句话会成为第一条留言') + '"></div>' +
      '<div class="field"><label>GPX 轨迹 · 必填</label>' +
      '<input id="npGpx" type="file" accept=".gpx,.xml,application/gpx+xml" ' +
      'style="padding:10px;border:1.5px dashed var(--line);border-radius:12px;width:100%;' +
      'font-size:12.5px;background:#fff">' +
      '<div class="note" id="npGpxMsg" style="margin-top:6px">' +
      '从六只脚 / 两步路 / 手表导出的 .gpx。有轨迹才能建点位——它证明你真的走过。</div></div>' +
      '<div class="field"><label>位置</label>' +
      '<button class="btn ghost" id="npGeo" style="font-size:13px;padding:10px">取当前位置</button>' +
      '<div class="note" id="npGeoMsg" style="margin-top:8px">取不到定位就填个大致位置：</div>' +
      '<input id="npArea" type="text" maxlength="40" placeholder="例如 门头沟 妙峰山附近"></div>' +
      '<div class="field"><label>海拔 · 选填</label>' +
      '<input id="npAlt" type="text" placeholder="例如 1180"></div>' +
      '<div class="field"><label>你的昵称</label>' +
      '<input id="npNick" type="text" maxlength="20" value="' + esc(H.me.name) + '"></div>' +
      '<div class="field"><label>微信号 · 选填（将来寄物料用）</label>' +
      '<input id="npContact" type="text" maxlength="60" placeholder="例如 wx: agan"></div>' +
      /* 两条路：自己开一座山，或者去维护别人已经立好的点位 */
      '<button class="btn coral" data-act="new-point-submit" data-kind="' + kind + '">' +
      (jc ? '成为NPC指路人<em class="btn-note">给后来的人指路</em>'
          : '成为山大王<em class="btn-note">让大家扫码打卡</em>') + '</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="become-master">' +
      '已有点位？申请成为版主<em class="btn-note">保留当前填写，去搜索已有点位</em></button>');
    if (resume && newPointDraft) {
      ['Name', 'Intro', 'Area', 'Alt', 'Nick', 'Contact'].forEach(function (key) {
        document.getElementById('np' + key).value = newPointDraft[key] || '';
      });
      if (npGpx) document.getElementById('npGpxMsg').textContent = '✓ 已保留刚才选的 GPX 轨迹';
      if (npGeo.lat !== null) document.getElementById('npGeoMsg').textContent =
        '✓ 已保留位置 ' + npGeo.lat.toFixed(5) + ', ' + npGeo.lng.toFixed(5);
    }
    var fi = document.getElementById('npGpx');
    fi.onchange = function () {
      var f = this.files && this.files[0];
      var msg = document.getElementById('npGpxMsg');
      if (!f) { npGpx = null; return; }
      if (f.size > 8 * 1024 * 1024) {
        npGpx = null; msg.innerHTML = '<b style="color:var(--coral)">文件超过 8MB，换一个</b>'; return;
      }
      var rd = new FileReader();
      rd.onload = function () {
        npGpx = String(rd.result);
        var n = (npGpx.match(/<trkpt/g) || []).length;
        var e = (npGpx.match(/<ele>/g) || []).length;
        msg.innerHTML = '✓ ' + f.name + ' · ' + n + ' 个轨迹点' +
          (n < 10 ? '<b style="color:var(--coral)">（点太少，至少要 10 个）</b>' : '') +
          (e ? ' · 带海拔' : ' · <b style="color:var(--coral)">没有海拔，算不出爬升</b>');
      };
      rd.readAsText(f);
    };
    document.getElementById('npGeo').onclick = function () {
      var m = document.getElementById('npGeoMsg');
      if (!navigator.geolocation) { m.textContent = '这个浏览器不支持定位，填大致位置吧'; return; }
      m.textContent = '正在取位置…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        npGeo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        m.textContent = '✓ 已取到 ' + npGeo.lat.toFixed(5) + ', ' + npGeo.lng.toFixed(5);
      }, function () { m.textContent = '拿不到位置，填个大致位置也一样'; }, { timeout: 8000 });
    };
  }

  function newPointSend(kind, btn) {
    npKind = kind === 'junction' ? 'junction' : 'peak';
    var v = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
    if (!npGpx) { U.toast('必须选择 GPX 轨迹文件——有轨迹才能建点位'); return; }
    var body = {
      gpx: npGpx,
      name: v('npName'), intro: v('npIntro'), nickname: v('npNick') || H.me.name,
      kind: kind, lat: npGeo.lat, lng: npGeo.lng,
      area: v('npArea') || null,
      altitude: v('npAlt') ? parseInt(v('npAlt'), 10) : null,
      contact: v('npContact') || null
    };
    if (!body.name) { U.toast('先起个名字'); return; }
    if (body.intro.length < 4) { U.toast('写一句怎么走、什么样（至少 4 个字）'); return; }
    btn.disabled = true; btn.textContent = '创建中…';
    apiToken().then(function (tk) {
        if (!tk) throw new Error('请先注册或登录，再创建点位');
        return fetch('/api/points', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tk },
          body: JSON.stringify(body)
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
      })
      .then(function (x) {
        btn.disabled = false; btn.textContent = '建好并生成二维码';
        if (!x.ok) {
          U.toast((x.d.detail && x.d.detail.error && x.d.detail.error.message) || '创建失败');
          return;
        }
        showQrSheet(x.d);
      })
      .catch(function (e) { btn.disabled = false; btn.textContent = '建好并生成二维码'; U.toast('创建失败：' + e.message); });
  }

  /* 建好之后：编号 + 二维码 + 试用期考核进度。
     首周不足 3 人 → 冻结；冻结不作废，有人重新扫就复活，只是不能申领物料。 */
  function showQrSheet(c) {
    var people = c.trialPeople || 0;
    var said = c.state === 'frozen'
      ? '已经冻结：试用期内没有 3 个不同的人扫码。二维码不作废，贴出去有人扫' +
        '（近 7 天 ≥3 人）就会自动复活；冻结期间不能申领喷漆和打孔卡。'
      : '试用期还剩 ' + (c.trialDaysLeft || 7) + ' 天，要有 3 个不同的人扫码才算站住。' +
        '满月累计到 ' + (c.monthNeed || 30) + ' 人是底线，到 100 人就能申领物料。';
    U.openSheet(
      '<h3>' + (npKind === 'junction' ? '你是这个岔路口的 NPC 指路人了'
                                       : '你是这座山头的王了') + '</h3>' +
      '<div class="sh-sub">' + esc(c.target_name) + ' · 编号 <b>' + esc(c.code) + '</b></div>' +
      '<div style="text-align:center;padding:8px 0 4px">' +
      '<img src="' + c.qrUrl + '" alt="二维码" style="width:190px;height:190px;' +
      'border:1px solid var(--line);border-radius:14px;background:#fff;padding:8px"></div>' +
      '<div class="note" style="text-align:center;margin-bottom:12px">' +
      '短链 <b>' + esc(c.shortLink) + '</b> · 二维码里印的就是它</div>' +
      '<a class="btn coral" href="' + c.qrUrl + '" download="' + c.code + '.svg">下载二维码（SVG，打印不糊）</a>' +
      /* 建完不是结束，是开始——不提醒他贴出去，这个点位就是死的 */
      '<div class="card" style="margin-top:14px;background:var(--coral-bg);box-shadow:none">' +
      '<b style="font-size:13.5px;color:#C0391C">下一步：把二维码贴出去</b>' +
      '<div style="font-size:12.5px;color:#7A3B27;line-height:1.9;margin-top:7px">' +
      '① 打印出来（A4 一张能印 12 个）<br>' +
      (npKind === 'junction'
        ? '② 贴在岔路口看得见的地方：树上、标牌上、石头正面<br>'
        : '② 贴到你那座山头的起点、岔路口、山顶<br>') +
      '③ 有人扫码，这里就会长出留言和到访记录<br>' +
      '<b>没人扫，这个点位就一直是空的。</b></div></div>' +
      '<div class="card" style="margin-top:14px;background:var(--blue-bg);box-shadow:none">' +
      '<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">' +
      '<span style="color:var(--blue-deep)">已有多少人扫过</span><b>' + people + ' 人</b></div>' +
      '<div class="progress" style="margin:8px 0 6px"><i style="width:' +
      Math.min(100, people / 3 * 100) + '%"></i></div>' +
      '<div class="note" style="color:var(--blue-deep)">' + said + '</div></div>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">知道了</button>');
  }

  function footInner(label, list, i) {
    var m = list[i] || { who: '', text: '' };
    var dots = list.length > 1
      ? '<span style="margin-left:6px">' + list.map(function (_, k) {
          return '<i style="display:inline-block;width:4px;height:4px;border-radius:2px;' +
            'margin-left:3px;background:' + (k === i ? 'var(--coral)' : '#D6D0C1') + '"></i>';
        }).join('') + '</span>' : '';
    return '<div style="display:flex;align-items:baseline;gap:8px">' +
      '<span style="font-size:10.5px;color:var(--ink3)">' + esc(label) +
      /* 空态（plain）不报条数，否则会写成"还没有人留言 · 1 条" */
      (m.plain ? '' : ' · ' + list.length + ' 条' + dots) + '</span>' +
      '<span style="margin-left:auto;font-size:11px;font-weight:700;color:var(--ink2)">' +
      esc(m.who) + '</span></div>' +
      '<div style="font-size:12.5px;color:#3C3F4E;line-height:1.55;margin-top:4px;' +
      'min-height:38px">' + m.text + '</div>';
  }

  /* 每 5 秒换下一条留言。换页时先清旧定时器，否则会越积越多 */
  var footTimer = null;
  function startFootRotate() {
    if (footTimer) { clearInterval(footTimer); footTimer = null; }
    if (!document.querySelectorAll('.footbox').length) return;
    footTimer = setInterval(function () {
      Array.prototype.forEach.call(document.querySelectorAll('.footbox'), function (el) {
        var list;
        try { list = JSON.parse(el.getAttribute('data-foot')); } catch (e) { return; }
        if (!list || list.length < 2) return;
        var i = (parseInt(el.getAttribute('data-i'), 10) + 1) % list.length;
        el.setAttribute('data-i', i);
        el.style.transition = 'opacity .3s';
        el.style.opacity = '.2';
        setTimeout(function () {
          el.innerHTML = footInner(el.getAttribute('data-label'), list, i);
          el.style.opacity = '1';
        }, 150);
      });
    }, 5000);
  }

  function claimBtn(key, name, kind) {
    return '<button class="claimbtn" data-act="claim" data-key="' + esc(key) +
      '" data-name="' + esc(name) + '" data-kind="' + kind + '">' +
      (kind === 'junction' ? '当NPC指路人' : '占山为王') + '</button>';
  }

  function locCard(o) {
    var inner =
      '<div style="display:flex;gap:12px;padding:14px">' +
      '<span style="width:78px;height:78px;border-radius:14px;overflow:hidden;flex:0 0 auto;' +
      'background:#EDE7DA;display:block">' + o.scene + '</span>' +
      '<span style="flex:1;min-width:0;display:flex;flex-direction:column">' +
      '<b style="font-size:15px;font-weight:800;line-height:1.3">' + o.title + '</b>' +
      '<span style="font-size:11.5px;color:var(--ink3);margin-top:3px">' + o.sub + '</span>' +
      '<span style="display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:8px">' +
      '<span style="font-size:11px;color:var(--ink3)">热度 <b style="color:var(--coral);' +
      'font-size:13px">' + o.heat + '</b></span>' +
      '<span class="btn coral mini" style="margin-left:auto;padding:6px 12px;font-size:12px">' +
      '我到过</span></span></span></div>' +
      /* 下半：左边标签，右边留言人；内容每 5 秒自动换下一条 */
      '<div class="footbox" data-foot=\'' + JSON.stringify(o.foots) + '\' data-i="0" ' +
      'data-label="' + esc(o.footTitle) + '">' + footInner(o.footTitle, o.foots, 0) + '</div>';
    /* 卡片里要塞一个「@线路」链接，所以外层不能再是 <a>（锚点不能套锚点）：
       上半截自己是一个链接，@线路 单独一行。 */
    var top = o.href ? '<a href="' + o.href + '" style="display:block">' + inner + '</a>' : inner;
    var via = o.route ? '<a class="lcvia" href="#/trails/' + o.route.slug + '">@' +
      esc(o.route.name) + ' · 看整条路书 ›</a>' : '';
    return '<div class="card' + (o.href ? '' : '') + '" style="padding:0;overflow:hidden;' +
      'margin-bottom:12px">' + top + via + '</div>';
  }

  /* ==================== 山头页 ==================== */
  /* 点位详情：山脚、还没进榜的山顶，前端没有它们的卡，直接按编号去后端取。
     ——「扫一次码点亮一格」，点那一格当然也得打得开。 */
  var _loading = {}, _pointErrors = {};
  var _communityLoading = {};
  function hydratePeakCommunity(p) {
    if (!p.code || (p.communityReady && p.commentsReady) || _communityLoading[p.code]) return;
    _communityLoading[p.code] = true;
    var detail = p.communityReady ? Promise.resolve(null) : fetch('/api/points/' + encodeURIComponent(p.code)).then(function (r) {
      if (!r.ok) throw new Error('community unavailable');
      return r.json();
    });
    detail.then(function (d) {
      if (d) {
        p.guide = d.guide || p.guide || {};
        p.maintainerName = d.maintainerName;
        p.recentContribution = d.recentContribution;
        p.pendingCount = d.pendingCount;
        p.pointId = d.id;
        p.mountainId = d.mountainId;
        p.visitCount = d.visitCount;
        p.boardId = d.boardId;
        p.boardPointCodes = d.boardPointCodes;
        p.communityReady = true;
      }
      return Promise.all([
        fetch('/api/points/' + p.pointId + '/comments?limit=20').then(function (r) {
          if (!r.ok) throw new Error('comments unavailable');
          return r.json();
        }),
        fetch('/api/points/' + encodeURIComponent(p.code) + '/ads').then(function (r) {
          return r.ok ? r.json() : { items: [] };
        })
      ]);
    }).then(function (results) {
      p.comments = (results[0].items || []).map(function (c) {
        return { who: c.nickname || '山友', when: new Date(c.created_at).toLocaleDateString(),
          text: c.text, mine: false, top: c.is_maintainer, real: true };
      });
      p.boardAds = results[1].items || [];
      p.commentsReady = true;
      if ((parse().name === 'peak' || parse().name === 'arrive') && parse().id === p.id) render();
    }).catch(function () { p.communityError = true; })
      .then(function () { delete _communityLoading[p.code]; });
  }
  function mountainMaintenance(p) {
    if (!p.code) return '';
    var role = myPeakRole(p.code);
    var title = role === 'collaborator' ? '协作维护 · 待核验 ' + (p.pendingCount || 0) + ' 条信息'
      : role ? '大王，今天有 ' + (p.pendingCount || 0) + ' 条信息待核验'
      : p.maintainerName ? '这座山有人维护' : '这座山，等一位山大王';
    var detail = role === 'collaborator' ? '进入维护台，协助处理这块板的留言'
      : role ? '进入维护台，处理留言与广告素材' : p.maintainerName
      ? '维护人 ' + esc(p.maintainerName) + (p.recentContribution ? ' · 最近贡献：' + esc(p.recentContribution) : '')
      : '维护山顶留言板，核验山友留下的信息';
    var action = role ? '<a class="btn coral" href="#/admin/p/' + esc(p.code) + '">进入维护台</a>'
      : p.maintainerName ? '<button class="btn ghost" data-act="collaboration-open" data-code="' + esc(p.code) + '">' +
        (p.collaborationStatus === 'pending' ? '申请审核中' : p.collaborationStatus === 'rejected' ? '重新申请协作' : '我也来帮忙') + '</button>'
      : '<button class="btn coral" data-act="master-claim" data-code="' + esc(p.code) + '" data-name="' + esc(p.name || p.code) + '">查看职责与福利</button>';
    return '<div class="sec-head"><h3>山头维护</h3></div><div class="card">' +
      '<b style="font-size:15px">' + title + '</b><div class="hint">' + detail + '</div>' + action + '</div>';
  }
  function loadPointByCode(code) {
    if (_loading[code]) return;
    _loading[code] = 1;
    fetch('/api/points/' + encodeURIComponent(code))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) { _pointErrors[code] = '未找到这个扫码点位，请核对编号。'; render(); return; }
        var tc = d.topComment;
        H.peaks.unshift({
          id: 'p-' + d.code, pointId: d.id, code: d.code, origin: 'user',
          mountainId: d.mountainId,
          type: d.type,                      /* peak / junction —— 决定这页上的说法 */
          name: d.name, alt: d.altitude, trailName: d.route_name,
          routeSlug: d.route_slug, city: null, level: d.level,
          guide: d.guide || {},
          km: 0, rise: 0, peakCount: d.total_in_route || 1,
          lat: null, lng: null,
          visits30: 0, visitCount: d.visitCount || 0, fastest: null, holder: null, photos: 0,
          board: [], communityReady: true, maintainerName: d.maintainerName,
          boardId: d.boardId, boardPointCodes: d.boardPointCodes,
          recentContribution: d.recentContribution, pendingCount: d.pendingCount,
          comments: tc ? [{ who: tc.nickname, when: '最新一条', text: tc.text,
                            mine: false, top: tc.is_maintainer }] : []
        });
        render();
      })
      .catch(function (e) {
        /* 这里以前把原因吞掉了，页面上只留一句"读取点位失败"，查不出是哪一步挂的 */
        console.error('读取点位失败', code, e);
        _pointErrors[code] = '点位加载失败，请稍后重试。'; render();
      });
  }

  function peakStoryCard(p, junction) {
    var guide = p.guide || {};
    var waiting = '<span class="story-pending">待维护人补充并核实</span>';
    if (junction) {
      var text = guide.intro || guide.desc || '';
      return '<section class="peak-story junction-story"><h3>岔路口介绍</h3><p>' +
        (text ? esc(text) : waiting) + '</p></section>';
    }
    function row(title, value, hint) {
      return '<div class="story-row"><b>' + title + '</b><p>' +
        (value ? esc(value) : waiting + (hint ? '<small>' + esc(hint) + '</small>' : '')) +
        '</p></div>';
    }
    return '<section class="peak-story"><h3>山峰小档案</h3>' +
      row('山峰介绍', guide.intro, '建议约 100 字，介绍位置、地貌与沿途特点。') +
      row('首登者', guide.first_ascent, '注明姓名或队伍、时间与资料来源；尚无可靠记录时请标待核实。') +
      row('登顶方式', guide.ascent_method, '填写适用线路、关键岔口及返程提示。') +
      (p.code && myPeakRole(p.code) ? '<a class="story-edit" href="#/admin/p/' + esc(p.code) + '">编辑山峰资料 ›</a>' : '') +
      '</section>';
  }

  var peakBoardWindow = 'week';
  var peakBoards = {};
  var peakBoardLoading = {};
  function loadPeakBoard(mountainId) {
    var key = mountainId + ':' + peakBoardWindow;
    if (peakBoardLoading[key]) return;
    peakBoardLoading[key] = true;
    window.API.ja('/api/mountains/' + mountainId + '/courses').then(function (courses) {
      return Promise.all(courses.map(function (course) {
        return window.API.ja('/api/efforts/leaderboard?courseId=' + course.id +
          '&window=' + peakBoardWindow).then(function (board) {
          return { course: course, board: board };
        });
      }));
    }).then(function (rows) { peakBoards[key] = rows; })
      .catch(function () { peakBoards[key] = { error: true }; })
      .then(function () { peakBoardLoading[key] = false; if (parse().name === 'peak') render(); });
  }
  function peakBoardHTML(p) {
    if (!p.mountainId) return '<div class="sec-head"><h3>登顶用时榜</h3></div>' +
      '<div class="empty">这座山的路线身份仍待核实。</div>';
    var key = p.mountainId + ':' + peakBoardWindow;
    if (!peakBoards[key]) loadPeakBoard(p.mountainId);
    var data = peakBoards[key];
    var tabs = [['week','本周'],['month','本月'],['year','本年'],['all','历史']].map(function (w) {
      return '<button class="btn ghost" data-act="peak-board-window" data-val="' + w[0] + '">' +
        (peakBoardWindow === w[0] ? '✓ ' : '') + w[1] + '</button>';
    }).join('');
    return '<div class="sec-head"><h3>登顶用时榜</h3></div><div class="btn-row">' + tabs + '</div>' +
      (!data ? '<div class="empty">正在读取路线成绩…</div>' : data.error ?
        '<div class="empty">用时榜暂时无法读取，打卡不受影响。</div>' : data.length ?
        data.map(function (item) {
          var board = item.board;
          return '<div class="card"><b>' + esc(item.course.name) + '</b>' +
            (board.myBest ? '<div class="hint">我的用时 ' + Math.round(board.myBest.durationS / 60) +
              ' 分钟' + (board.myBest.rank ? ' · 第 ' + board.myBest.rank + ' 名' : '') + '</div>' : '') +
            (board.rankingAvailable ? board.leaders.map(function (r) {
              return '<div class="rowlink"><span class="em">' + r.rank + '</span><div class="tx"><b>' +
                esc(r.nickname) + '</b><span>' + Math.round(r.durationS / 60) + ' 分钟 · ' + esc(r.date) +
                '</span></div></div>';
            }).join('') : '<div class="hint">有效样本不足 8 人，暂不显示名次。</div>') + '</div>';
        }).join('') : '<div class="empty">登顶路线尚未核实，暂不开放用时榜。</div>');
  }
  function peakView(id) {
    var p = peak(id);
    if (!p && id.indexOf('p-') === 0) {
      loadPointByCode(id.slice(2));
      return '<div class="pad"><div class="empty">正在读取点位 ' + esc(id.slice(2)) +
        ' …</div></div>';
    }
    if (!p) return notFound();
    hydratePeakCommunity(p);
    var cs = commentsFor(p.id);
    var want = isWant(p.id);
    var selfBuilt = p.origin === 'user';        /* 用户自己上传 GPX 建的点位 */
    var isJunction = p.type === 'junction';     /* 自建的岔路点位也走这个页面模板 */
    return (
      '<div class="hero tall">' + U.scene(p.id) +
      '<div class="floating"><a href="#/places"><span class="pill">‹ 返回</span></a></div>' +
      '<div class="floating right"><span class="pill">' +
      (selfBuilt ? (isJunction ? '岔路 · ' : '山头 · ') + esc(p.code)
                 : (isJunction ? '岔路 · 路书点' : '山头 · 打卡点')) + '</span></div>' +
      (p.code ? '' : claimBtn(p.id, p.name || p.trailName, isJunction ? 'junction' : 'peak')) + '</div>' +
      '<div class="pad">' +
      /* 首屏只放**被审核提到第一屏**的广告；维护人自己投的默认都在留言区顶部 */
      adCarousel(adsOf(p.code).first, '推荐 · 广告') +
      '<h2 class="arrive-h" style="margin-top:0">' + esc(p.name || '名称待定') + '</h2>' +
      '<p class="arrive-p">' +
      (p.name ? esc(p.name) + ' · ' : '<span class="soon-tag">待命名</span>') +
      (p.alt ? '海拔 ' + p.alt + ' m' : '海拔待补') +
      (p.trailName ? ' · 属于「' + esc(p.trailName) + '」'
                   : ' · 轨迹 ' + p.km + ' km · 爬升 ' + p.rise + ' m') + '</p>' +
      '<div class="hint" style="margin:-8px 2px 14px;display:flex;gap:12px;flex-wrap:wrap">' +
      '<span>' + (p.pointId ? '累计到访 ' : '本周热度 ') + '<b style="color:var(--coral)">' +
      (p.pointId ? p.visitCount || 0 : p.visits30 || 0) + '</b></span>' +
      (p.lat ? '<span>坐标 ' + p.lat + ', ' + p.lng + '</span>'
             : '<span>坐标待采集</span>') +
      '</div>' +
      '<div class="btn-row peak-primary-actions">' +
      (p.code ? '<button class="btn coral" data-act="guest-checkin" data-code="' + esc(p.code) + '">我也到了</button>' :
        '<button class="btn coral" data-act="checkin" data-type="peak" data-id="' + p.id + '">' +
        (beenThere(p.id) ? '再打一次卡' : '我也到了') + '</button>') +
      '</div>' +
      peakStoryCard(p, isJunction) +
      U.signage(p, { code: p.code || ('PK-' + p.id.toUpperCase()), realQR: !!p.pointId }) +
      mountainMaintenance(p) +

      peakBoardHTML(p) +

      '<div class="sec-head"><h3>山顶照片墙</h3><span class="more">' + p.photos + ' 张 ›</span></div>' +
      (selfBuilt
        ? '<div class="empty" style="padding:22px 0"><span class="big">📷</span>照片还没开<br>' +
          '<span style="font-size:12.5px">等第一个到访的人来贴</span></div>'
        : '<div class="photowall">' + [1, 2, 3].map(function (i) {
            return '<div class="pw">' + U.scene(p.id + '-photo' + i, { palette: (i * 2) % 6 }) + '</div>';
          }).join('') + '</div>') +

      '<div class="sec-head"><h3>留言板</h3><span class="more">全部 ›</span></div>' +
      /* 维护人的广告位默认就在这儿：留言板最上面（第一屏之外） */
      adCarousel(adsOf(p.code).board, '这座山的广告位') +
      (myPeakRole(p.code) && myPeakRole(p.code) !== 'collaborator' ? maintainerAdEntry(p) : '') +
      (cs.length ? cs.slice(0, 3).map(commentCard).join('') : '<div class="empty">还没有留言。</div>') +

      '<div class="btn-row">' +
      '<button class="btn ghost" data-act="want" data-id="' + p.id + '" data-on="♥ 已收藏到想去" data-off="♡ 收藏到想去">' + (want ? '♥ 已收藏到想去' : '♡ 收藏到想去') + '</button>' +
      '</div>' +
      (p.code ? '<button class="btn ghost" style="margin-top:9px" data-act="arrival-draft" data-code="' +
        esc(p.code) + '">在留言板写一句</button>' :
        '<button class="btn ghost" style="margin-top:9px" data-act="comment-open" data-type="peak" data-id="' +
        p.id + '">在留言板写一句</button>')
      + '</div>'
    );
  }

  /* ==================== 岔路页 ==================== */
  function junctionView(id) {
    var j = junction(id);
    if (!j) return notFound();
    return (
      '<div class="hero tall">' + U.scene(j.id, { palette: 1 }) +
      '<div class="floating"><a href="#/places/junction"><span class="pill">‹ 返回</span></a></div>' +
      '<div class="floating right"><span class="pill">岔路 · 路书点</span></div>' +
      claimBtn(j.id, j.name, 'junction') + '</div>' +
      '<div class="pad">' +
      /* 岔路口同一套规则：默认在情报区顶部（屏外），被审核提升的才上首屏 */
      adCarousel(adsOf(j.code).first, '推荐 · 广告') +
      '<h2 class="arrive-h" style="margin-top:0">' + esc(j.name) + '</h2>' +
      '<p class="arrive-p">' + esc(j.trailName) + ' · 第 <b style="color:var(--blue)">' + j.index + '</b>/' + j.total +
      ' 个点位 · 点位编号 ' + esc(j.code) + '</p>' +
      U.signage(j, { level: (trail(j.trailId) || {}).level || 'easy',
        alt: '第 ' + j.index + '/' + j.total + ' 个点位' }) +

      '<div class="sec-head"><h3>岔路情报</h3><span class="more">按新鲜 ›</span></div>' +
      adCarousel(adsOf(j.code).board, '这个岔路口的广告位') +
      (myPeakRole(j.code) && myPeakRole(j.code) !== 'collaborator' ? maintainerAdEntry(j) : '') +
      intelFor(j).map(function (i) { return intelCard(i, j.id); }).join('') +
      '<div class="hint" style="text-align:center">一条情报被 3 个人确认后会自动升级为「已核验」</div>' +

      '<button class="btn ghost" data-act="intel-open" data-id="' + j.id + '">上报一条情报</button>' +
      '<button class="btn coral" style="margin-top:9px" data-act="checkin" data-type="junction" data-id="' + j.id + '">' +
      (beenThere(j.id) ? '再打一次卡' : '顺路打卡') + '</button>' +
      peakStoryCard(j, true) +
      '<div class="guide"><div class="gtag">你在这里 · 往哪走</div>' +
      '<div class="grow"><div class="gshot">' + U.scene(j.id + '-guide', { palette: 1 }) + '</div>' +
      '<span class="dir">' + esc(j.guide.arrow) + '</span>' +
      '<div class="gtxt"><b>' + esc(j.guide.title) + '</b><span>' + esc(j.guide.desc) + '</span></div></div>' +
      '<div class="next">' + esc(j.guide.next) + '</div></div>' +
      '<div class="hint" style="text-align:center">路过这里也可以打卡，留下「我走过这一段」</div>'
      + '</div>'
    );
  }

  /* ==================== 消息 ====================
     第一屏是"我要负责的山头"和"我关注的山头"，然后是留言提醒；
     最后才是原有的互动 / 请求 / 信件 / 系统（那几组还是示例数据）。 */

  /* 自己开的点位分两种说法：山头是「山大王」，岔路口是「NPC指路人」。
     接管留言板的两种点位都叫「维护人」。 */
  function roleTag(role, type) {
    return '<span class="pill-btn ' + (role === 'maintainer' ? 'acc' : '') +
      '" style="font-size:10.5px;padding:1px 7px;margin-left:6px">' +
      (role === 'maintainer' ? '维护人'
        : role === 'collaborator' ? '协作者'
        : (type === 'junction' ? 'NPC指路人' : '山大王')) + '</span>';
  }

  function unreadTag(n) {
    return n ? '<span class="pill-btn acc" style="font-size:10.5px;padding:1px 7px;margin-left:6px">' +
      n + ' 条新留言</span>' : '';
  }

  /* 我的山头：我维护的（版主）+ 我自己开的（山大王）。
     维护人这一行多一个「维护 · 管留言」入口——这就是"更高权限"的落点。 */
  function mySummitsBlock() {
    var mine = H.mySummits || [];
    var unread = mine.reduce(function (n, x) { return n + (x.unread || 0); }, 0);
    var head = '<div class="group-label">我的山头' +
      (unread ? '<span style="color:var(--coral);margin-left:6px">' + unread + ' 条新留言</span>' : '') +
      '</div>';
    if (!mine.length) {
      return head +
        '<div class="card" style="text-align:center;padding:18px 14px">' +
        '<div style="font-size:13.5px;font-weight:700">你还没有山头</div>' +
        '<div style="font-size:12.5px;color:var(--ink3);margin:6px 0 12px">' +
        '自己开一座山或立一个岔路点位（拿编号和二维码），或者接管一个已有山头的留言板</div>' +
        '<a class="btn coral mini" href="#/me/peak">去占山为王</a></div>';
    }
    return head + mine.map(function (m) {
      return '<div class="msg"><div class="tx" style="flex:1;min-width:0">' +
        '<b>' + (m.name ? esc(m.name) : '<span class="tbd">名称待定</span>') +
        roleTag(m.role, m.type) + unreadTag(m.unread) + '</b>' +
        '<em>' + esc(m.code) + (m.altitude ? ' · 海拔 ' + m.altitude + ' m' : '') +
        (m.city ? ' · ' + esc(m.city) : '') + '</em>' +
        '<p style="margin-top:6px">留言 ' + m.commentCount + ' 条' +
        (m.heat7 ? ' · 本周打卡 ' + m.heat7 + ' 人' : '') + '</p>' +
        '<div class="mini-actions">' +
        '<a class="pill-btn acc" href="#/peaks/p-' + esc(m.code) + '">进留言板 ›</a>' +
        (m.role === 'maintainer' || m.role === 'collaborator'
          ? '<button class="pill-btn" data-act="summit-board" data-id="' + m.pointId +
            '">维护 · 管留言</button>' : '') +
        '</div></div></div>';
    }).join('');
  }

  /* 我关注的山头：留言有更新，这里和下面的提醒都会亮 */
  function followBlock() {
    var list = H.followPeaks || [];
    var unread = list.reduce(function (n, x) { return n + (x.unread || 0); }, 0);
    var head = '<div class="group-label">我关注的山头' +
      (unread ? '<span style="color:var(--coral);margin-left:6px">' + unread + ' 条新留言</span>' : '') +
      '</div>';
    if (!list.length) {
      return head + '<div class="card" style="padding:16px 14px">' +
        '<div style="font-size:13px;color:var(--ink2)">去山头页点 ♡ 关注一座山，' +
        '它的留言板有更新就会提醒你。</div>' +
        '<a class="btn ghost mini" style="margin-top:10px" href="#/places">去挑山头</a></div>';
    }
    return head + list.map(function (f) {
      return '<div class="msg"><div class="tx" style="flex:1;min-width:0">' +
        '<b>' + (f.name ? esc(f.name) : '<span class="tbd">名称待定</span>') + unreadTag(f.unread) + '</b>' +
        '<em>' + esc(f.code || '') + (f.altitude ? ' · 海拔 ' + f.altitude + ' m' : '') +
        (f.city ? ' · ' + esc(f.city) : '') + '</em>' +
        '<p style="margin-top:6px">留言 ' + f.commentCount + ' 条</p>' +
        '<div class="mini-actions">' +
        (f.code ? '<a class="pill-btn acc" href="#/peaks/p-' + esc(f.code) + '">进留言板 ›</a>' : '') +
        '</div></div></div>';
    }).join('');
  }

  /* 留言提醒：我维护的 + 我关注的山头上的新留言 */
  function notifBlock() {
    var list = H.notif || [];
    if (!list.length) return '';
    var unread = list.filter(function (x) { return x.unread; }).length;
    var head = '<div class="group-label">留言提醒' +
      (unread ? '<span style="color:var(--coral);margin-left:6px">' + unread + ' 条未读</span>' : '') +
      '</div>';
    return head + list.slice(0, 10).map(function (n) {
      return '<div class="msg">' +
        '<div class="tx" style="flex:1;min-width:0">' +
        '<b>' + esc(n.who || '山友') +
        (n.unread ? '<span class="pill-btn acc" style="font-size:10.5px;padding:1px 7px;margin-left:6px">新</span>' : '') +
        '<span class="pill-btn" style="font-size:10.5px;padding:1px 7px;margin-left:6px">' +
        (n.reason === 'maintainer' ? '你维护的' : '你关注的') + '</span></b>' +
        '<p style="margin-top:4px">' + esc(n.text) + '</p>' +
        '<div class="mini-actions"><a class="pill-btn acc" href="#/peaks/p-' + esc(n.code) + '">' +
        (n.peakName ? esc(n.peakName) : esc(n.code || '这个山头')) + ' 的留言板 ›</a>' +
        (n.reason === 'maintainer'
          ? '<button class="pill-btn" data-act="summit-board" data-id="' + n.pointId + '">维护</button>' : '') +
        '</div></div></div>';
    }).join('') +
      (unread ? '<button class="btn ghost" style="margin-top:8px" data-act="notif-seen">全部标记已读</button>' : '');
  }

  var _hiddenCommentsLoading = false, _hiddenCommentsLoaded = false;
  function loadHiddenComments() {
    if (_hiddenCommentsLoading || _hiddenCommentsLoaded) return;
    _hiddenCommentsLoading = true;
    apiToken().then(function (tk) {
      return tk ? window.API.ja('/api/me/hidden-comments') : [];
    }).then(function (items) {
      H.hiddenComments = items || [];
      _hiddenCommentsLoaded = true;
      if (parse().name === 'messages') render();
    }).catch(function () { H.hiddenComments = []; })
      .then(function () { _hiddenCommentsLoading = false; });
  }
  function hiddenCommentsBlock() {
    var items = H.hiddenComments || [];
    if (!items.length) return '';
    return '<div class="group-label">我的内容处置</div>' + items.map(function (c) {
      var appeal = c.appeal;
      var status = appeal ? (appeal.status === 'pending' ? '申诉审核中' :
        appeal.status === 'rejected' ? '申诉未通过' : '已恢复') : '已隐藏';
      return '<div class="msg"><div class="tx" style="flex:1;min-width:0">' +
        '<b>' + esc(c.pointName || c.pointCode || '山顶留言板') +
        '<span class="pill-btn" style="font-size:10.5px;padding:1px 7px;margin-left:6px">' + status + '</span></b>' +
        '<p>' + esc(c.text) + '</p>' +
        (appeal && appeal.reviewNote ? '<em>' + esc(appeal.reviewNote) + '</em>' : '') +
        (c.appealable && !appeal ? '<div class="mini-actions"><button class="pill-btn acc" ' +
          'data-act="appeal-open" data-id="' + c.id + '">申请复核</button></div>' : '') +
        '</div></div>';
    }).join('');
  }

  /* 维护人视角的留言板管理：列出这个山头的留言，可以逐条隐藏（隐藏不删除，留痕） */
  function sheetSummitBoard(pid) {
    U.openSheet('<h3>留言板 · 维护人</h3><div class="sh-sub">正在加载…</div>');
    window.API.ja('/api/points/' + pid + '/comments?limit=50').then(function (d) {
      var rows = (d && d.items) || [];
      var el = document.getElementById('sheet');
      if (!el) return;
      el.innerHTML = '<h3>留言板 · 维护人</h3>' +
        '<div class="sh-sub">可处理本板留言；隐藏他人内容需要说明理由，记录可追溯。</div>' +
        (rows.length
          ? '<div class="card tight">' + rows.map(function (c) {
              return '<div style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--hair)">' +
                '<div style="flex:1;min-width:0">' +
                '<b style="font-size:13px">' + esc(c.nickname || '山友') + '</b>' +
                (c.is_maintainer ? '<span class="pill-btn acc" style="font-size:10px;padding:0 6px;margin-left:6px">维护人</span>' : '') +
                '<em style="font-style:normal;display:block;font-size:11px;color:var(--ink3)">' +
                esc(String(c.created_at || '').slice(0, 16).replace('T', ' ')) + '</em>' +
                '<p style="font-size:13px;margin:4px 0 0">' + esc(c.text) + '</p></div>' +
                '<button class="pill-btn" data-act="hide-comment" data-id="' + c.id +
                '" data-pid="' + pid + '">隐藏</button></div>';
            }).join('') + '</div>'
          : '<div class="empty">这个山头还没有留言。</div>') +
        '<button class="btn ghost" style="margin-top:12px" data-act="close">关闭</button>';
    }).catch(function () {
      var el = document.getElementById('sheet');
      if (el) el.innerHTML = '<h3>留言板 · 维护人</h3>' +
        '<div class="empty">没加载出来（多半是登录态过期）。重新加载页面试试。</div>' +
        '<button class="btn ghost" data-act="close">关闭</button>';
    });
  }

  function messageActivityCard(a) {
    var host = H.people[a.host] || { name: '山友', av: '山', tone: 'a4' };
    var joined = Number(a.joined || 0) + (S.joined.indexOf(a.id) >= 0 ? 1 : 0);
    var capacity = Number(a.capacity || 0);
    var full = capacity > 0 && joined >= capacity && S.joined.indexOf(a.id) < 0;
    return '<div class="act message-act"><div class="date"><b>' + esc(a.day) + '</b><span>' + esc(a.week) + '</span></div>' +
      '<div class="act-main"><a class="act-title" href="#/trails/' + encodeURIComponent(a.trailId || '') + '">' + esc(a.title) + '</a>' +
      '<div class="meta">' + esc(a.time || '集合时间待定') + ' · ' + esc((H.levels[a.level] || {}).short || '徒步') +
      (a.hours ? ' · ' + esc(a.hours) : '') + '</div>' +
      (a.note ? '<div class="act-note">' + esc(a.note) + '</div>' : '') +
      '<div class="foot"><span class="act-host">发起人 ' + esc(host.name) + '</span>' +
      '<span class="cnt">' + joined + ' 人已参加' + (capacity ? ' · 共 ' + capacity + ' 位' : '') + '</span>' +
      '<button class="btn coral mini" style="margin-left:auto" data-act="join" data-id="' + esc(a.id) + '"' +
      (full ? ' disabled' : '') + '>' + (S.joined.indexOf(a.id) >= 0 ? '已参加' : full ? '已满员' : '我也去参加') + '</button></div></div></div>';
  }

  function messageDiscovery() {
    var acts = (H.activities || []).concat(S.myActs || []);
    return adCarousel(H.ads, '山友的推荐') +
      '<div class="sec-head" style="margin-top:0"><h3>周末有人组队</h3><a class="more" href="#/me/activity">发起活动 ›</a></div>' +
      (acts.length ? acts.map(messageActivityCard).join('') : '<div class="empty">暂时没有组队活动。</div>');
  }

  var boardLoading = false, boardLoaded = false, boardError = false;
  var boardQuery = '', boardPeakFilter = '', boardReplies = {}, boardOpen = {}, boardVotes = {};
  function loadBoardComments() {
    if (boardLoading || boardLoaded) return;
    boardLoading = true;
    var items = (H.peaks || []).filter(function (p) { return p.pointId; });
    if (!items.length) { boardLoaded = true; boardLoading = false; return; }
    var cursor = 0, active = 0, failed = false;
    function finish() {
      if (boardLoaded && !boardLoading) return;
      boardLoaded = true; boardError = failed; boardLoading = false;
      if (parse().name === 'board') render();
    }
    function worker() {
      if (cursor >= items.length) {
        if (active === 0) finish();
        return;
      }
      var p = items[cursor++];
      active++;
      fetch('/api/points/' + encodeURIComponent(p.pointId) + '/comments?limit=50')
        .then(function (r) { if (!r.ok) throw new Error('留言加载失败'); return r.json(); })
        .then(function (d) { p.boardComments = (d.items || []).map(function (c) {
          return { id:c.id, replyCount:c.reply_count || 0, bad:c.bad_count, who:c.nickname, text:c.text, when:new Date(c.created_at).toLocaleString(), at:c.created_at, claps:c.like_count, real:true };
        }); })
        .catch(function () { failed = true; })
        .then(function () { active--; worker(); });
    }
    /* 最多 8 个并发：166 个山头同时开请求会挤占「我管理的留言版」等更重要的请求。 */
    for (var w = 0; w < 8; w++) worker();
  }
  function boardView() {
    var entries = [];
    (H.peaks || []).forEach(function (p) {
      var route = trail(p.trailId);
      var visited = S.visited.some(function (v) { return v.id === p.id || String(v.pointId || v.id) === String(p.pointId); });
      var wanted = isWant(p.id) || (route && isWant(route.id));
      (p.boardComments || []).forEach(function (c, i) {
        entries.push({ c:c, peak:p, route:route, visited:!!visited, wanted:!!wanted, index:i });
      });
    });
    entries = entries.filter(function (x) { return (!boardPeakFilter || x.peak.id === boardPeakFilter) && (!boardQuery || (x.peak.name || '').indexOf(boardQuery) >= 0); });
    if (boardFollow === 'visited') entries = entries.filter(function (x) { return x.visited; });
    if (boardFollow === 'want') entries = entries.filter(function (x) { return x.wanted; });
    entries.sort(function (a, b) {
      if (boardSort === 'peak') return a.peak.name.localeCompare(b.peak.name, 'zh') || a.index - b.index;
      return new Date(b.c.at) - new Date(a.c.at);
    });
    var filters = [['all','全部留言'],['visited','我去过的山头'],['want','我想去的山头']];
    return '<div class="board-page"><header class="board-intro"><span class="eyebrow">MOUNTAIN NOTES</span>' +
      '<h1>山友留言版</h1><p>每句话都来自一座山。看看大家在山上遇见了什么。</p>' +
      '<a class="board-write" href="#/scan">扫码留言 <b>＋</b></a></header>' +
      (window.KING_APP && window.KING_APP.boardBlock ? window.KING_APP.boardBlock() : '') +
      '<div class="board-mountains"><label>搜索山头<input id="board-search" type="search" placeholder="输入山头名称" value="' + esc(boardQuery) + '"></label><label>选择山头<select id="board-peak-filter"><option value="">全部山头</option>' + (H.peaks || []).map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === boardPeakFilter ? ' selected' : '') + '>' + esc(p.name || '名称待定') + '</option>'; }).join('') + '</select></label></div>' +
      '<div class="board-controls"><div class="board-follow" role="group" aria-label="留言范围">' +
      filters.map(function (f) { return '<button class="' + (boardFollow === f[0] ? 'on' : '') +
        '" data-act="board-follow" data-val="' + f[0] + '">' + f[1] + '</button>'; }).join('') +
      '</div><label class="board-sort">排列 <select data-act="board-sort" aria-label="留言排列方式">' +
      '<option value="time"' + (boardSort === 'time' ? ' selected' : '') + '>按时间</option>' +
      '<option value="peak"' + (boardSort === 'peak' ? ' selected' : '') + '>按山头</option></select></label></div>' +
      '<div class="board-count">' + (boardLoading ? '正在加载… ' : boardError ? '部分留言加载失败，请刷新重试 · ' : '') + entries.length + ' 条留言' +
      (boardFollow === 'visited' ? ' · 来自你去过的山头' : boardFollow === 'want' ? ' · 来自你想去的山头' : ' · 所有山头') + '</div>' +
      (entries.length ? '<div class="board-waterfall">' + entries.map(function (x) {
        var person = personOf(x.c.who);
        var routeHref = '#/peaks/' + encodeURIComponent(x.peak.id);
        var cid = x.c.id, replies = boardReplies[cid];
        return '<section class="board-thread"><a class="board-mountain-name" href="' + routeHref + '">' + U.icon('hill') + esc(x.peak.name || '名称待定') + ' ›</a>' +
          '<article class="board-note"><div class="board-note-top">' + U.avatar(person) + '<b>' + esc(person.name || '山友') + '</b></div>' +
          '<p>' + esc(x.c.text) + '</p><time class="board-time">' + esc(x.c.when) + '</time>' +
          '<div class="board-interactions"><button data-act="board-vote" data-id="' + cid + '" data-val="bad" aria-label="踩">👎 ' + x.c.bad + '</button>' +
          '<button data-act="board-replies" data-id="' + cid + '" aria-expanded="' + !!boardOpen[cid] + '">' + U.icon('chat') + ' <span>' + (replies ? replies.length : x.c.replyCount) + '</span></button>' +
          '<button data-act="board-vote" data-id="' + cid + '" data-val="like" aria-label="点赞">👍 ' + x.c.claps + '</button></div>' +
          (boardOpen[cid] ? '<div class="board-replies">' + (replies ? (replies.length ? replies.map(function (r) {
            return '<div class="board-reply"><b>' + esc(r.nickname || '山友') + '</b><p>' + esc(r.text) + '</p><time>' + esc(new Date(r.created_at).toLocaleString()) + '</time></div>';
          }).join('') : '<p class="muted">还没有回复，来说一句吧。</p>') : '<p>正在加载回复…</p>') +
          '<label class="board-reply-label" for="reply-' + cid + '">回复这条留言</label><textarea id="reply-' + cid + '" maxlength="200" placeholder="写下你的回复"></textarea><button class="btn coral" data-act="board-reply-send" data-id="' + cid + '">发送回复</button></div>' : '') + '</article></section>';
      }).join('') + '</div>' : '<div class="empty board-empty"><span class="big">⛰</span>' +
        (boardFollow === 'visited' ? '你去过的山头还没有留言。' : boardFollow === 'want' ? '你想去的山头还没有留言。' : '还没有留言。') +
        '<br><a href="#/places">去看看山头</a></div>') + '</div>';
  }

  function pageQuoteHero(kind, quote) {
    var art = kind === 'messages' ? 'hero-messages-companions.png' : 'hero-me-resting.png';
    return '<section class="page-quote-hero ' + kind + '" aria-label="' + esc(quote) + '">' +
      '<img class="quote-landscape" src="images/home/' + art + '" alt="" loading="eager">' +
      '<blockquote>' + esc(quote) + '</blockquote></section>';
  }

  function messagesView() {
    loadHiddenComments();
    var groups = ['互动', '请求', '信件', '系统'];
    var body = groups.map(function (g) {
      var list = H.messages.filter(function (m) { return m.group === g; });
      var rows = list.map(function (m) {
        var st = S.friends[m.id];
        var person = H.people[m.who] || { name: '到此一游', av: '山', tone: 'a4' };
        return '<div class="msg"' + (m.warn ? ' data-urgent="true"' : '') + '>' +
          U.avatar(person, person.tone) +
          '<div class="tx"><b>' + esc(m.title || person.name) + '</b>' +
          (m.when ? '<em>' + esc(m.when) + '</em>' : '') +
          '<p>' + esc(m.text) + '</p>' +
          (m.ctx ? '<a class="ctx" href="' + linkTo(m.ctx) + '">' + esc(m.ctx.name) + ' ›</a>' : '') +
          (m.kind === 'friend' && !st
            ? '<div class="mini-actions"><button class="pill-btn acc" data-act="friend" data-id="' + m.id + '" data-val="acc">接受</button>' +
              '<button class="pill-btn ign" data-act="friend" data-id="' + m.id + '" data-val="ign">忽略</button></div>'
            : '') +
          (m.kind === 'friend' && st
            ? '<div class="mini-actions"><span class="pill-btn ' + (st === 'acc' ? 'acc' : 'ign') + '">' +
              (st === 'acc' ? '已是好友' : '已忽略') + '</span></div>' : '') +
          (m.kind === 'photo' && !st
            ? '<div class="mini-actions"><button class="pill-btn acc" data-act="friend" data-id="' + m.id + '" data-val="acc">交换照片</button>' +
              '<button class="pill-btn ign" data-act="friend" data-id="' + m.id + '" data-val="ign">先不用</button></div>' +
              '<div class="urgent">' + esc(m.urgent) + '</div>' : '') +
          (m.kind === 'photo' && st ? '<div class="mini-actions"><span class="pill-btn ' + (st === 'acc' ? 'acc' : 'ign') + '">' +
            (st === 'acc' ? '已交换，去留言板 ›' : '已拒绝') + '</span></div>' : '') +
          (m.action ? '<div class="mini-actions"><a class="pill-btn acc" href="#/me/peak">' + esc(m.action) + '</a></div>' : '') +
          '</div></div>';
      }).join('');
      return '<div class="group-label">' + g + '</div>' + rows;
    }).join('');
    return '<h1 class="sr">通知</h1>' +
      pageQuoteHero('messages', '走过山路的人，最懂一句问候的重量。') +
      (window.KING_APP && window.KING_APP.noticesBlock ? window.KING_APP.noticesBlock() : '') +
      messageDiscovery() + mySummitsBlock() + notifBlock() + hiddenCommentsBlock() + followBlock() + body +
      '<div class="hint" style="text-align:center">每条通知都带一个地点上下文胶囊，点它回到现场，而不是回到某个人的主页</div>';
  }

  /* ==================== 我 ==================== */
  function recordCard() {
    /* 登顶记录：一座山一行（取最好那次的用时），点整张卡看全部记录。
       数据是真的——就是我的打卡流水，一条都不编。 */
    var recs = summitRecords();
    if (!recs.length) {
      return '<div class="card record"><div class="row-between" style="margin-bottom:6px">' +
        '<h3 style="font-size:16px;font-weight:800">我的登顶记录</h3></div>' +
        '<div class="empty" style="padding:18px 0"><span class="big">⛰</span>还没有登顶记录<br>' +
        '<span style="font-size:12.5px">到山顶扫一次码，这里就记上时间</span></div></div>';
    }
    var bySummit = {};
    recs.forEach(function (r) {
      var k = r.name;
      if (!bySummit[k] || (r.time && (!bySummit[k].time || r.time < bySummit[k].time))) {
        bySummit[k] = bySummit[k] || {};
        bySummit[k] = { name: r.name, level: r.level, alt: r.alt, time: r.time,
                        at: r.at, count: 0 };
      }
      bySummit[k].count++;
    });
    var list = Object.keys(bySummit).map(function (k) { return bySummit[k]; });
    var rows = list.map(function (s) {
      return '<div class="row">' +
        '<span class="ic ' + (s.level === 'easy' ? 'g' : s.level === 'mid' ? 'b' : '') + '">' +
        '<span class="lvshape">' + U.shapeSVG(s.level) + '</span></span>' +
        '<span class="nm"><b>' + esc(s.name) + '</b>' +
        '<em>' + (s.alt ? '海拔 ' + s.alt + ' m · ' : '') + esc(fmtDay(s.at)) +
        (s.count > 1 ? ' · 来过 ' + s.count + ' 次' : '') + '</em></span>' +
        '<span class="tm' + (s.time ? ' pb' : '') + '">' + (s.time || '—') + '</span></div>';
    }).join('');
    return '<button class="card record" style="width:100%;text-align:left;font-family:inherit" ' +
      'data-act="records-all">' +
      '<div class="row-between" style="margin-bottom:4px"><h3 style="font-size:16px;font-weight:800">' +
      '我的登顶记录</h3>' +
      '<span class="tiny muted">' + list.length + ' 座 · 共 ' + recs.length + ' 次 ›</span></div>' +
      '<div class="tiny muted" style="margin-bottom:8px">用时只和自己比 · 点开看每一次的年月日</div>' +
      '<div>' + rows + '</div>' +
      '<div class="tiny muted" style="margin-top:10px">' +
      '橙色是最快的一次；同一座山去过多次会分开记。</div>' +
      '</button>';
  }

  /* 把打卡流水整理成登顶记录：只算山顶（山脚打卡不算登顶） */
  function summitRecords() {
    return (S.visited || []).map(function (v) {
      /* S.visited 里的 id 是后端 pointId（数字），不是 'p-CODE'，得按 pointId 找 */
      var p = peakById(v.pointId || v.id);
      return { name: v.name || (p && p.name) || '名称待定',
               level: v.level || (p && p.level) || 'mid',
               alt: (p && p.alt) || null, time: v.time || null, at: v.at || null,
               pointId: v.pointId || (p && p.pointId),
               isTrailhead: /-S$/.test(v.code || '') };
    }).filter(function (r) { return !r.isTrailhead; });
  }

  function fmtDay(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function fmtFull(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' +
      ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* 点卡片：一条一条列出来，年月日时都有 */
  function sheetRecords() {
    var recs = summitRecords().slice().sort(function (a, b) {
      return String(b.at).localeCompare(String(a.at));
    });
    U.openSheet('<h3>登顶记录</h3><div class="sh-sub">' +
      recs.length + ' 次登顶 · 时间精确到分钟</div>' +
      '<div class="card tight">' + recs.map(function (r) {
        var pk = peakById(r.pointId);
        return '<a class="hotrow" href="' + (pk ? '#/peaks/' + pk.id : '#/me') + '">' +
          '<span class="no">' + (r.alt ? r.alt : '⛰') + '</span>' +
          '<span class="nm"><b>' + esc(r.name) + '</b>' +
          '<em>' + esc(fmtFull(r.at)) + '</em></span>' +
          '<span class="mt">' + (r.time ? '用时 ' + r.time : '没记用时') + '</span></a>';
      }).join('') + '</div>' +
      '<div class="note" style="margin-top:10px">每在山上扫一次码就多一条；' +
      '同一天同一个点位只算一次。</div>' +
      '<button class="btn ghost" data-act="close">收起</button>');
  }
  function peakById(pid) {
    return (H.peaks || []).filter(function (p) { return p.pointId === pid; })[0];
  }

  /* ---------- 山径拼图 ----------
     每一格就是一座**真实的山头**：点亮 = 你去过它，点一下进那座山的详情页
     （留言板就在里头）。以前是"到过 N 个点位就点亮 N 格"，格子不对应任何一座山，
     点也点不开——那种进度条骗得了自己，骗不了用户。 */
  function puzzleTotals() {
    var pr = H.progress || [], lit = 0, all = 0;
    pr.forEach(function (r) {
      all += r.summits.length;
      lit += r.summits.filter(function (s) { return s.count; }).length;
    });
    return { lit: lit, all: all, routes: pr.length };
  }

  function puzzleBlock(withProgress) {
    var pr = H.progress || [];
    var t = puzzleTotals();
    if (!pr.length) {
      return (withProgress ? '<div class="row-between"><h3 style="font-size:16px;font-weight:800">' +
          '山径拼图</h3></div>' : '') +
        '<div class="empty"><span class="big">⛰</span>还没有点亮的格子<br>' +
        '<span style="font-size:12.5px">山上扫一次码就点亮一座山——' +
        '山脚和山顶都扫了，格子里就有这次登顶用时</span></div>' + trackUploadBox();
    }
    return (withProgress
        ? '<div class="row-between"><h3 style="font-size:16px;font-weight:800">山径拼图</h3>' +
          '<span class="tiny muted">' + t.lit + '/' + t.all + ' 座 · ' + t.routes + ' 条线</span></div>' +
          '<div class="progress"><i style="width:' + Math.round(t.lit / t.all * 100) + '%"></i></div>'
        : '') +
      pr.map(function (r) {
        return '<div class="pzrow">' +
          '<div class="pzh"><b>' + esc(r.routeName) + '</b>' +
          '<span>' + r.visited + '/' + r.total +
          (r.complete ? ' · <i>完整记录</i>' : '') + '</span></div>' +
          '<div class="pzgrid">' + r.summits.map(function (sm) {
            return summitCell(sm);
          }).join('') + '</div></div>';
      }).join('') +
      '<div class="tiny muted" style="margin-top:6px">' +
      '一格是一座山：山脚和山顶各一个扫码点。只扫一个只是点亮；' +
      '两个都扫了，格子里就是这次登顶用时。点格子看每一次的记录。</div>' +
      trackUploadBox();
  }

  /* ---------- 传轨迹 ----------
     手机上没有"文件系统"这个概念给普通用户——**微信聊天记录就是文件管理器**。
     所以最简路径不是教他"导出到文件"，而是：手表 App 分享到微信 → 我们这儿从聊天记录选。 */
  /* 选中文件 → 读出来发后端 → 解析出的山顶变成拼图候选 */
  function uploadTrack(file) {
    if (!file) return;
    if (!/\.(gpx|kml|tcx|fit)$/i.test(file.name)) {
      U.toast('这看着不是轨迹文件——要 .gpx / .kml');
      return;
    }
    if (/\.(tcx|fit)$/i.test(file.name)) {
      U.toast('TCX / FIT 还读不了，先在手表 App 里导出 GPX');
      return;
    }
    U.toast('正在解析…');
    var rd = new FileReader();
    rd.onload = function () {
      apiToken().then(function (tk) {
        if (!tk) { U.toast('上传失败：拿不到登录凭证'); return; }
        fetch('/api/tracks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tk },
          body: JSON.stringify({ text: String(rd.result), filename: file.name })
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) {
            if (!x.ok) {
              U.toast((x.d.detail && x.d.detail.error && x.d.detail.error.message) || '解析失败');
              return;
            }
            H.myTracks = [x.d].concat(H.myTracks || []);
            render();
            U.toast('识别到 ' + x.d.peakCount + ' 座山，已摆进拼图（灰色待点亮）');
          })
          .catch(function (e) { U.toast('上传失败：' + e.message); });
      });
    };
    rd.readAsText(file);
  }

  function trackUploadBox() {
    var ts = H.myTracks || [];
    return '<div class="upbox">' +
      '<div class="ubt">走了一条我们还没有的线？把轨迹传上来</div>' +
      '<div class="ubn"><b>手机上三步，全在微信里：</b>' +
      '① 手表 App 里那条记录 → 分享 → 发到微信「文件传输助手」<br>' +
      '② 回到这里点下面的按钮<br>' +
      '③ 弹窗里选「从聊天记录选择」→ 点那个文件</div>' +
      '<div class="ubn" style="color:var(--ink3)">' +
      '支持 GPX / KML（佳明、高驰、颂拓、华为、Strava 都能导出）。' +
      '传上来只是把格子**摆成灰色候选**——上山扫码才会点亮。</div>' +
      '<input id="trkFile" type="file" accept=".gpx,.kml,.tcx,.fit" style="display:none">' +
      '<button class="btn ghost" data-act="pick-track">传轨迹文件</button>' +
      (ts.length ? '<div class="ubt" style="margin-top:14px">我传过的轨迹（' + ts.length + '）</div>' +
        ts.map(function (t) {
          return '<div class="pzrow"><div class="pzh"><b>' + esc(t.name) + '</b>' +
            '<span>' + t.km + ' km · ↗ ' + (t.up || 0) + ' m · ' + t.peaks.length + ' 座 ›</span></div>' +
            '<div class="pzgrid">' + t.peaks.map(function (p, i) {
              return '<button class="pzcell cand" data-act="track-peak" ' +
                'data-track="' + t.id + '" data-i="' + i + '">' +
                '<span class="h"><b>顶' + (i + 1) + '</b></span>' +
                '<span class="mt">' + p.ele + ' m · 候选</span></button>';
            }).join('') + '</div></div>';
        }).join('') : '') +
      '</div>';
  }

  /* 一座山一格。格里三样：山脚 / 山顶 两个扫码点，人 · 时间 · 次数 */
  function summitCell(sm) {
    var lit = sm.count > 0;
    var last = sm.times.length ? sm.times[sm.times.length - 1] : null;
    return '<button class="pzcell' + (lit ? ' lit' : '') + (sm.climbTime ? ' timed' : '') +
      '" data-act="summit-cell" data-code="' + esc(sm.code) + '">' +
      '<span class="h"><b>' + (sm.name ? esc(sm.name) : '名称待定') + '</b>' +
      (sm.climbTime ? '<i>' + sm.climbTime + '</i>' : '') + '</span>' +
      '<span class="pts">' +
      '<em class="' + (sm.start && sm.start.mine ? 'on' : '') + '">山脚</em>' +
      '<em class="' + (sm.top && sm.top.mine ? 'on' : '') + '">山顶</em>' +
      '</span>' +
      '<span class="mt">' + (lit
        ? '我 · ' + shortDay(last.at) + ' · ×' + sm.count
        : (sm.altitude ? sm.altitude + ' m · 未到' : '未到')) + '</span>' +
      '</button>';
  }
  function shortDay(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  /* 点一格：这一座山的每一次打卡，谁、什么时候、用时多少 */
  function sheetSummitCell(code) {
    var hit = null;
    (H.progress || []).forEach(function (r) {
      r.summits.forEach(function (sm) { if (sm.code === code) hit = { r: r, sm: sm }; });
    });
    if (!hit) return;
    var sm = hit.sm;
    U.openSheet('<h3>' + (sm.name ? esc(sm.name) : '名称待定') + '</h3>' +
      '<div class="sh-sub">' + esc(hit.r.routeName) +
      (sm.altitude ? ' · 海拔 ' + sm.altitude + ' m' : '') + '</div>' +
      '<div class="card" style="box-shadow:none;background:var(--blue-bg);padding:14px">' +
      '<div style="display:flex;gap:10px">' +
      '<div style="flex:1"><div style="font-size:11px;color:#2B3568">山脚扫码点</div>' +
      '<div style="font-size:13.5px;font-weight:800;margin-top:3px">' +
      (sm.start.code || '—') + '</div>' +
      '<div style="font-size:11.5px;color:#2B3568;margin-top:2px">' +
      (sm.start.mine ? '我去过 ' + sm.start.mine + ' 次' : '还没扫') + '</div></div>' +
      '<div style="flex:1"><div style="font-size:11px;color:#2B3568">山顶扫码点</div>' +
      '<div style="font-size:13.5px;font-weight:800;margin-top:3px">' +
      sm.top.code + '</div>' +
      '<div style="font-size:11.5px;color:#2B3568;margin-top:2px">' +
      (sm.top.mine ? '我登顶 ' + sm.top.mine + ' 次' : '还没扫') + '</div></div>' +
      '</div></div>' +
      (sm.times.length
        ? '<div class="group-label" style="margin-top:14px">我的打卡记录</div>' +
          '<div class="card tight">' + sm.times.slice().reverse().map(function (x) {
            return '<div class="hotrow"><span class="no">' +
              (x.time ? x.time : '—') + '</span>' +
              '<span class="nm"><b>' + esc(fmtFull(x.at)) + '</b>' +
              '<em>' + (x.time ? '这次登顶用时 ' + x.time
                               : '只扫了山顶，没扫山脚 → 不算完整登顶') + '</em></span>' +
              '<span class="mt">我</span></div>';
          }).join('') + '</div>'
        : '<div class="empty" style="padding:20px 0">还没扫过这个扫码点</div>') +
      '<a class="btn coral" style="margin-top:14px" href="' + sm.href +
      '" data-act="close">去它的留言板</a>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">收起</button>');
  }

  function accountCardView() {
    var account = window.API.account;
    var state = window.API.accountState;
    if (account) {
      return '<div class="card account-card"><div class="profile"><div class="big">' +
        esc(accountName(account).slice(0, 1)) + '</div><div><b>' + esc(accountName(account)) +
        '</b><span>@' + esc(account.username) + (state === 'offline' ? ' · 暂时离线' : ' · 已登录') +
        '</span></div></div>' +
        '<button class="btn ghost" data-act="logout">退出登录</button></div>';
    }
    if (state === 'checking') {
      return '<div class="card account-card"><div class="profile"><div class="big">客</div>' +
        '<div><b>正在恢复账号…</b><span>稍候片刻</span></div></div></div>';
    }
    return '<div class="card account-card"><div class="profile"><div class="big">客</div>' +
      '<div><b>游客</b><span>记录只保存在这台浏览器</span></div></div>' +
      '<p class="account-copy">' + (state === 'expired'
        ? '登录已过期。重新登录后，会继续读取账号里的到访与草稿。'
        : '登录后可跨设备保存到访、草稿和申请进度。浏览路书和扫码打卡仍可直接使用。') + '</p>' +
      '<a class="btn coral" href="#/login">登录或注册</a></div>';
  }

  function meView() {
    return '<h1 class="sr">我的山野记录</h1>' +
      pageQuoteHero('me', '每一次出发，都是把自己带回山野。') +
      accountCardView() +

      recordCard() +
      '<div class="card">' + puzzleBlock(true) + '</div>' +
      /* 「我去过的地方」删掉了——到访记录已经在上面那张登顶 records 卡里，
         再开一个入口就是同一个东西看两遍。 */
      rowlink('#/me/want', '♡', '我想去的地方 ' + S.want.length, '收藏的线路和山峰') +
      /* 我的山头 = 拿二维码的地方，不是展示位 */
      rowlink('#/me/peak', '⛰', '我的山头',
        '成为山大王 / NPC指路人拿二维码 · 成为版主管留言板') +
      rowlink('#/king/applications', '★', '我的统一申请', '山大王、加入山寨的进度与审核说明') +
      rowlink('#/me/letters', '✉', '山间信箱', '写给未来的自己，满足条件后打开') +
      '<button class="rowlink" style="width:100%;text-align:left" data-act="leaderboard-settings">' +
      '<span class="em">⏱</span><div class="tx"><b>上榜设置</b><span>选择是否公开我的有效登顶用时</span></div><span class="ar">›</span></button>' +
      rowlink('#/me/activity', '＋', '发起周末活动<span class="soon-tag">待开发</span>',
        '选一条路，约人一起走') +
      '<button class="btn ghost" style="margin-top:14px" data-act="reset">清空我的演示数据</button>';
  }
  function rowlink(href, em, title, sub, warn) {
    return '<a class="rowlink' + (warn ? ' warn' : '') + '" href="' + href + '"><span class="em">' + em + '</span>' +
      '<div class="tx"><b>' + title + '</b><span>' + esc(sub) + '</span></div><span class="ar">›</span></a>';
  }

  var meViewMode = 'list';
  function meVisitedView() {
    var head = '<div class="seg">' +
      '<button class="' + (meViewMode === 'list' ? 'on' : '') + '" data-act="meview" data-val="list">列表</button>' +
      '<button class="' + (meViewMode === 'map' ? 'on' : '') + '" data-act="meview" data-val="map">地图</button>' +
      '<button class="' + (meViewMode === 'puzzle' ? 'on' : '') + '" data-act="meview" data-val="puzzle">拼图</button></div>';
    if (meViewMode === 'list') return head + receiptsListHTML();
    if (meViewMode === 'map') {
      if (!S.visited.length) return head + '<div class="empty">地图按本机的演示到访画点；还没有数据。</div>';
      return head + '<div class="mapbox">' + S.visited.map(function (v, i) {
        var x = 12 + (hash(v.id) % 70), y = 12 + (hash(v.id + 'y') % 64);
        return '<span class="pin" style="left:' + x + '%;top:' + y + '%" title="' + esc(v.name) + '"></span>';
      }).join('') + '</div>' +
        '<div class="hint">每个点是一个到访过的点位，橙色是这次新到的。</div>' +
        S.visited.map(function (v) { return visitedRow(v); }).join('');
    }
    if (meViewMode === 'puzzle') {
      return head + '<div class="card">' +
        puzzleBlock(true) + '</div>';
    }
    if (!S.visited.length) return head + '<div class="empty">拼图用的是本机演示到访；还没有数据。</div>';
    return head + '<div class="card tight">' + S.visited.map(function (v) {
      return '<a class="rank" href="' + (v.type === 'peak' ? '#/peaks/' + v.id : v.type === 'junction' ? '#/junctions/' + v.id : '#/trails/' + v.id) + '">' +
        '<span class="thumb">' + U.scene(v.id) + '</span>' +
        '<span class="nm"><b>' + esc(v.name) + '</b><em>第 ' + v.seq + ' 位到访 · ' + esc(v.when) + '</em></span>' +
        '<span class="tm" style="font-size:12px;color:var(--ink3)">›</span></a>';
    }).join('') + '</div>';
  }

  /* 我的到访记录读真实凭证（账号读账号的，游客读本机的），
     不再拿本地演示数据冒充"我去过的地方"。 */
  var myReceipts = null;
  var myReceiptsError = false;
  var myReceiptsLoading = false;
  function loadMyReceipts() {
    if (myReceiptsLoading) return;
    myReceiptsLoading = true;
    window.HIKES_CHECKIN.currentIdentity().then(function (identity) {
      var url = identity.kind === 'user' ? '/api/me/visit-receipts?limit=50' :
        (identity.token ? '/api/guest/visit-receipts?limit=50' : null);
      if (!url) { myReceipts = []; return null; }
      var headers = identity.kind === 'user'
        ? { Authorization: 'Bearer ' + identity.token } : { 'X-Guest-Token': identity.token };
      return window.API.timedFetch(url, { headers: headers }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (rows) { myReceipts = rows; myReceiptsError = false; })
        .catch(function () { myReceiptsError = true; });
    }).catch(function () { myReceiptsError = true; })
      .then(function () {
        myReceiptsLoading = false;
        if (parse().name === 'me-visited') render();
      });
  }
  function receiptsListHTML() {
    if (myReceipts === null) { loadMyReceipts(); return '<div class="empty">正在读取到访记录…</div>'; }
    if (myReceiptsError) {
      return '<div class="empty">到访记录暂时读不到。' +
        '<button class="btn ghost" data-act="receipts-retry">重试</button></div>';
    }
    if (!myReceipts.length) {
      return '<div class="empty"><span class="big">⛰</span>还没有到访记录，去扫一扫留下第一次。</div>';
    }
    return '<div class="card tight">' + myReceipts.map(function (row) {
      return '<a class="rank" href="#/peaks/p-' + encodeURIComponent(row.code) + '">' +
        '<span class="nm"><b>' + esc(row.name || row.code) + '</b><em>' +
        esc((row.visitedAt || '').replace('T', ' ').slice(0, 16)) + ' · 该点位第 ' +
        row.seq + ' 条记录' + (row.durationS ? ' · 用时 ' + Math.round(row.durationS / 60) + ' 分钟' :
          (row.effortReason ? ' · 未计入公开榜（' + esc(row.effortReason) + '）' : '')) +
        '</em></span><span class="tm" style="font-size:12px;color:var(--ink3)">›</span></a>';
    }).join('') + '</div>';
  }
  function visitedRow(v) {
    return '<div class="rowlink"><span class="em">✓</span><div class="tx"><b>' + esc(v.name) + '</b>' +
      '<span>第 ' + v.seq + ' 位到访 · ' + esc(v.when) + '</span></div><span class="ar">›</span></div>';
  }
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997; return h; }

  function meWantView() {
    if (!S.want.length) return '<div class="empty"><span class="big">♡</span>还没有收藏的地方。</div>';
    return '<div class="card tight">' + S.want.map(function (id) {
      var t = trail(id), p = t ? null : peak(id);
      if (!t && !p) return '';
      var name = t ? t.name : (p.name || '名称待定');
      var sub = t
        ? (t.km + ' km · ↗ ' + t.up + ' m · ' + esc(t.hours || '') + ' · 线路')
        : (p.alt + ' m' + (p.city ? ' · ' + esc(p.city) : '') +
           (p.trailName ? ' · @' + esc(p.trailName) : '') + ' · 山头');
      return '<div class="rank"><span class="thumb">' + U.scene((t || p).id) + '</span>' +
        '<span class="nm"><a href="' + (t ? '#/trails/' + t.id : '#/peaks/' + p.id) + '">' +
        '<b>' + esc(name) + '</b></a><em>' + sub + '</em></span>' +
        '<button class="wanticon" data-act="want" data-id="' + id + '" data-on="♥" data-off="♡" ' +
        'style="font-size:16px;color:var(--coral)">♥</button></div>';
    }).join('') + '</div>' +
      '<div class="hint">收藏的线路和山峰都在这里，点 ♥ 取消收藏。</div>';
  }

  function mePeakView() {
    /* 这里不是展示位，是**入口**：拿二维码、或者接管一个留言板。 */
    var k = H.king;
    return '<div class="card" style="padding:16px">' +
      '<h3 style="font-size:17px;font-weight:800;margin-bottom:6px">我的山头</h3>' +
      '<div class="note" style="line-height:1.7">申请成为山头负责人，或加入一座山的山寨。' +
      '平台审核通过后才授予权限；新山头通过时一次性创建点位、短链和二维码。</div>' +
      '<button class="btn coral" style="margin-top:12px" data-act="king-open">' +
      '统一申请<em class="btn-note">搜索已有山头，或申请一个新山头</em></button>' +
      '<a class="btn ghost" style="margin-top:9px" href="#/king/applications">' +
      '我的申请与草稿<em class="btn-note">进度、补充资料和撤回都在这里</em></a>' +
      '</div>' +
      (k ? '<div class="card" style="margin-top:12px">' +
        '<div class="row-between"><h3 style="font-size:15px;font-weight:800">我的等级</h3>' +
        '<span class="tiny muted">' + esc(k.levelName) + '</span></div>' +
        '<div style="font-size:12.5px;color:var(--ink2);margin-top:6px;line-height:1.7">' +
        '名下点位 <b>' + k.used + ' / ' + k.quota + '</b> 个 · ' +
        '累计 <b>' + k.people + '</b> 人扫过 · 维护动作 <b>' + k.kept + '</b> 次</div>' +
        '<div class="progress" style="margin:9px 0 6px"><i style="width:' +
        Math.min(100, k.used / k.quota * 100) + '%"></i></div>' +
        (k.nextName
          ? '<div class="note">升到「' + esc(k.nextName) + '」：再攒 ' +
            Math.max(0, (k.nextNeedPeople || 0) - k.people) + ' 人扫码、维护动作再 ' +
            Math.max(0, (k.nextNeedKept || 0) - k.kept) + ' 次，配额到 ' +
            (k.nextQuota || 0) + ' 个。</div>'
          : '<div class="note">已经是最高等级。</div>') +
        '</div>' : '') +
      '<a class="btn blue" style="margin-top:12px" href="#/admin">进入维护台 · 管理我的点位</a>' +
      '<div class="hint">山大王要自己印二维码贴上山——没人扫，点位就一直是空的。<br>' +
      '版主不发码，线上就能开始。</div>';
  }

  function meRecordsView() {
    var rows = Object.keys(S.pb).map(function (id) {
      var p = peak(id);
      return { pos: null, av: H.me, name: (p ? p.name : id) + ' · 个人最好', sub: '已刷新', time: S.pb[id], mine: true };
    });
    return '<div class="sec-head" style="margin-top:6px"><h3>我的纪录</h3></div>' +
      '<div class="card tight">' + (rows.length ? rankRows(rows) : '<div class="empty" style="padding:20px">还没有纪录，去打个卡。</div>') + '</div>' +
      '<div class="mini3" style="margin-top:14px">' +
      '<div><span>连续上山</span><b>' + H.me.streak + ' 周</b></div>' +
      '<div><span>到过点位</span><b>' + S.visited.length + '</b></div>' +
      '<div><span>认领山头</span><b>1</b></div></div>' +
      '<a class="rowlink" href="#/places"><span class="em">★</span><div class="tx"><b>去看山头用时榜</b>' +
      '<span>跟别人比，也跟自己比</span></div><span class="ar">›</span></a>';
  }

  var privateLetters = null;
  var privateLettersLoading = false;
  function loadPrivateLetters() {
    if (privateLettersLoading) return;
    privateLettersLoading = true;
    window.API.ja('/api/me/letters').then(function (rows) { privateLetters = rows; })
      .catch(function () { privateLetters = { error: true }; })
      .then(function () {
        privateLettersLoading = false;
        if (parse().name === 'me-letters') render();
      });
  }
  function meLettersView() {
    if (!privateLetters) { loadPrivateLetters(); return '<div class="empty">正在读取山间信箱…</div>'; }
    if (privateLetters.error) return '<div class="empty">信箱暂时无法读取。<button class="btn ghost" data-act="private-letter-retry">重试</button></div>';
    return '<div class="sec-head"><h3>写给未来的自己</h3><span class="more">' + privateLetters.length + ' 封</span></div>' +
      (privateLetters.length ? privateLetters.map(function (l) {
        return '<div class="letter"><div class="ltag">' + (l.status === 'sealed' ? '封存中' : '已解锁') + '</div>' +
          '<div class="line">' + (l.status === 'sealed' ? '内容将在解锁后显示' : esc(l.text || '')) + '</div>' +
          '<div class="lsub">' + (l.mode === 'date' ? '到期：' + esc((l.unlockAt || '').slice(0, 10)) :
            l.mode === 'checkin'
              ? '等待在' + esc(l.pointName || l.pointCode || '目标地点') + '的一次新打卡'
              : '随时可看') + '</div>' +
          '<button class="btn ghost" data-act="private-letter-delete" data-id="' + l.id + '">删除</button></div>';
      }).join('') : '<div class="empty">还没有写给自己的信。</div>') +
      '<button class="btn coral" data-act="private-letter-new">写一封信</button>';
  }

  /* 我的维护申请：状态、理由、审核说明都摆出来——被拒的时候用户最想知道为什么 */
  var myApplications = null;
  var myApplicationsError = false;
  var myApplicationsLoading = false;
  function loadMyApplications() {
    if (myApplicationsLoading) return;
    myApplicationsLoading = true;
    window.API.ja('/api/me/master-applications').then(function (rows) {
      myApplications = rows; myApplicationsError = false;
    }).catch(function () { myApplicationsError = true; })
      .then(function () {
        myApplicationsLoading = false;
        if (parse().name === 'me-applications') render();
      });
  }
  function meApplicationsView() {
    if (myApplications === null) { loadMyApplications(); return '<div class="empty">正在读取申请…</div>'; }
    if (myApplicationsError) {
      return '<div class="empty">申请读不到（需要登录）。' +
        '<button class="btn ghost" data-act="applications-retry">重试</button></div>';
    }
    if (!myApplications.length) {
      return '<div class="empty">还没有提交过维护申请。去山头页点「申请维护这座山」。</div>';
    }
    var LABEL = { pending: '审核中', approved: '已通过', rejected: '已驳回',
                  expired: '已失效', withdrawn: '已撤回' };
    var DAYS = { pending: '3 天内给答复，超时自动失效', approved: '你现在是这座山的维护人',
                 rejected: '可以补齐说明后重新申请', expired: '超过 3 天没人处理，可以重新申请',
                 withdrawn: '你自己撤回的' };
    return myApplications.map(function (a) {
      return '<div class="card"><b>' + esc(a.mountainName || a.pointCode) + ' · ' +
        (a.kind === 'clan' ? '山寨（多人协作）' : '山大王（单人独占）') + '</b>' +
        '<div class="hint">状态：<b>' + (LABEL[a.status] || a.status) + '</b> · ' + DAYS[a.status] +
        ' · 一个月能去 ' + a.visitsPerMonth + ' 次</div>' +
        '<div class="hint">为什么申请：' + esc(a.reason) + '</div>' +
        '<div class="hint">成为维护人后的期待：' + esc(a.expectations) + '</div>' +
        (a.reviewNote ? '<div class="hint" style="color:var(--ink2)"><b>审核说明：</b>' +
          esc(a.reviewNote) + '</div>' : '') +
        (a.status === 'approved' ? '<a class="btn coral mini" style="margin-top:10px" href="#/admin/p/' +
          encodeURIComponent(a.pointCode) + '">进入这座山的留言板管理</a>' : '') +
        (a.status === 'pending' ? '<button class="btn ghost" style="width:auto;padding:6px 12px" ' +
          'data-act="application-withdraw" data-id="' + a.id + '">撤回申请</button>' : '') +
        '</div>';
    }).join('');
  }

  function meActivityView() {
    return '<div class="sec-head" style="margin-top:6px"><h3>发起周末活动</h3></div>' +
      '<div class="field"><label>活动标题</label><input id="actTitle" type="text" placeholder="例如：溪谷步道 · 慢速队"></div>' +
      '<div class="field"><label>日期</label><input id="actDate" type="date"></div>' +
      '<div class="field"><label>集合时间与地点</label><input id="actTime" type="text" placeholder="例如：6:30 北门停车场集合"></div>' +
      '<div class="field"><label>线路</label><select id="actTrail">' +
      H.trails.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + ' · ' + H.levels[t.level].short + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>一句话说明</label><input id="actNote" type="text" placeholder="例如：可带新手 · 全程慢走不走散"></div>' +
      '<button class="btn coral" data-act="submit-activity">发布活动</button>' +
      '<div class="hint" style="margin-top:12px">发布后会出现在消息页的组队活动里，并在出发前 2 小时提醒你。</div>' +
      (S.myActs.length ? '<div class="sec-head"><h3>我发起的</h3><span class="more">' + S.myActs.length + ' 个</span></div>' +
        S.myActs.map(function (a) {
          return '<div class="act" style="margin-bottom:11px"><div class="date"><b>' + esc(a.day) + '</b><span>' + esc(a.week) + '</span></div>' +
            '<div style="flex:1"><h4>' + esc(a.title) + '</h4><div class="meta">' + esc(a.time) + '</div>' +
            '<div class="foot"><span class="cnt">' + a.joined + ' 人已参加</span>' +
            '<button class="btn ghost mini" style="margin-left:auto" data-act="del-act" data-id="' + a.id + '">删除</button></div></div></div>';
        }).join('') : '');
  }

  /* ==================== 扫码 ==================== */
  var scanStream = null, scanTimer = null, scanDetector = null, scanBusy = false;

  function stopScanCamera() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (scanStream) {
      scanStream.getTracks().forEach(function (track) { track.stop(); });
      scanStream = null;
    }
    scanDetector = null;
    scanBusy = false;
    var box = document.getElementById('scanbox');
    if (box) box.classList.remove('live');
    var video = document.getElementById('scanVideo');
    if (video) video.srcObject = null;
  }

  function scannedCode(raw) {
    var text = String(raw || '').trim();
    var match = text.match(/\/p\/([A-Za-z0-9_-]+)/i);
    if (match) return match[1].toUpperCase();
    match = text.match(/[?&]code=([A-Za-z0-9_-]+)/i);
    if (match) return match[1].toUpperCase();
    if (/^[A-Za-z0-9_-]{3,40}$/.test(text)) return text.toUpperCase();
    return '';
  }

  function startScanCamera() {
    var state = document.getElementById('scanState');
    var box = document.getElementById('scanbox');
    var video = document.getElementById('scanVideo');
    if (!video || !box) return;
    if (!window.isSecureContext) {
      if (state) state.textContent = '当前页面不是 HTTPS 安全连接，浏览器不会开放摄像头；请使用线上 https 地址或手动输入编号。';
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (state) state.textContent = '这个浏览器不支持相机取景。请用手机浏览器或手动输入编号。';
      return;
    }
    if (scanStream) return;
    if (state) state.textContent = '正在请求相机权限…';
    var constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
    navigator.mediaDevices.getUserMedia(constraints)
      .catch(function () { return navigator.mediaDevices.getUserMedia({ video: true, audio: false }); })
      .then(function (stream) {
        scanStream = stream;
        box.classList.add('live');
        video.srcObject = stream;
        return video.play();
      })
      .then(function () {
        if (state) state.textContent = '相机已打开，对准标牌上的二维码。';
        var nativeDetector = 'BarcodeDetector' in window
          ? Promise.resolve().then(function () {
              return new window.BarcodeDetector({ formats: ['qr_code'] });
            }).catch(function () { return null; })
          : Promise.resolve(null);
        return nativeDetector.then(function (detector) {
          scanDetector = detector;
          if (!detector && !window.jsQR) {
            if (state) state.textContent = '相机已打开。当前浏览器不支持自动识别，请手动输入编号。';
            return;
          }
          var canvas = document.createElement('canvas');
          var context = canvas.getContext('2d', { willReadFrequently: true });
          scanTimer = setInterval(function () {
            if (scanBusy || !video.videoWidth) return;
            scanBusy = true;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            var result;
            if (scanDetector) {
              result = scanDetector.detect(canvas).then(function (codes) {
                return codes && codes.length ? codes[0].rawValue : '';
              });
            } else {
              var image = context.getImageData(0, 0, canvas.width, canvas.height);
              var found = window.jsQR(image.data, canvas.width, canvas.height,
                                      { inversionAttempts: 'dontInvert' });
              result = Promise.resolve(found ? found.data : '');
            }
            result.then(function (raw) {
              var code = scannedCode(raw);
              if (code) {
                stopScanCamera();
                if (state) state.textContent = '已识别：' + code;
                location.hash = '#/arrive/p-' + encodeURIComponent(code);
              }
            }).catch(function () { /* 下一帧继续识别 */ })
              .then(function () { scanBusy = false; });
          }, 420);
        });
      })
      .catch(function (error) {
        stopScanCamera();
        if (state) {
          var name = error && error.name;
          state.textContent = name === 'NotAllowedError'
            ? '相机权限被拒绝。请点地址栏左侧的权限图标允许相机，然后重新打开；也可以手动输入编号。'
            : name === 'NotFoundError'
              ? '没有检测到摄像头。请连接摄像头后重试，或手动输入编号。'
              : name === 'NotReadableError'
                ? '摄像头正被其他应用占用。请关闭会议/相机应用后重试，或手动输入编号。'
                : '相机打不开（' + (name || '未知错误') + '）。请检查系统相机权限，或手动输入编号。';
        }
      });
  }

  function scanView() {
    var pts = [{ id: 'dongling', t: 'peak', n: '东灵山主峰 · 山顶打卡点', c: 'DLS-100' },
      { id: 'haohanpo', t: 'junction', n: '好汉坡 · 岔口扫码点位', c: 'HHP-02' },
      { id: 'dajuesi', t: 'junction', n: '大觉寺 · 起点标牌', c: 'DJS-01' }];
    return '<div class="scanbox" id="scanbox"><video id="scanVideo" playsinline muted autoplay aria-label="扫码相机预览"></video><div class="frame"></div><div class="laser"></div>' +
      '<div class="tip">把取景框对准标牌上的二维码</div></div>' +
      '<div class="scan-actions"><button class="btn coral" data-act="scan-camera">打开相机扫码</button>' +
      '<button class="btn ghost" data-act="scan-stop">关闭相机</button></div>' +
      '<div class="scan-state" id="scanState" role="status" aria-live="polite">需要 HTTPS 或 localhost，并允许浏览器使用相机。</div>' +
      '<div class="scan-art-card"><img src="images/home/scan-hikers.png" alt="山友沿着山路结伴徒步，远处是群山与湖泊" loading="lazy"></div>' +
      '<div class="hint" style="text-align:center;margin-top:-6px">这是演示版：点下面的按钮模拟扫到一块标牌。</div>' +
      pts.map(function (p) {
        return '<button class="rowlink" style="width:100%;text-align:left" data-act="sim" data-type="' + p.t + '" data-id="' + p.id + '">' +
          '<span class="em">' + U.icon('scan') + '</span><div class="tx"><b>' + esc(p.n) + '</b>' +
          '<span>编号 ' + p.c + '</span></div><span class="ar">›</span></button>';
      }).join('') +
      '<div class="card" style="margin-top:14px">' +
      '<div class="field" style="margin:0"><label>或者手动输入点位编号</label>' +
      '<input id="codeInput" type="text" placeholder="例如 QSD-02"></div>' +
      '<button class="btn blue" style="margin-top:12px" data-act="sim-code">确认点位</button></div>' +
      '<div class="hint">扫不到码时（标牌破损、没网）也能用编号打卡。</div>';
  }

  /* ==================== 到达页 ==================== */
  function arrivalView(pid) {
    var p = peak(pid);
    if (!p && pid.indexOf('p-') === 0) {
      if (_pointErrors[pid.slice(2)]) return '<div class="pad"><div class="empty">' +
        esc(_pointErrors[pid.slice(2)]) + '</div></div>';
      loadPointByCode(pid.slice(2));
      return '<div class="pad"><div class="empty">正在读取点位…</div></div>';
    }
    if (!p || !p.code) return '<div class="pad"><div class="empty">未找到这个扫码点位，请核对编号。</div></div>';
    hydratePeakCommunity(p);
    return (
      '<div class="hero tall">' + U.scene(p.id) +
      '<div class="floating"><a href="#/scan"><span class="pill">‹ 返回</span></a></div>' +
      '<div class="floating right"><span class="pill">' + esc(p.name) + ' · 打卡点</span></div></div>' +
      '<div class="pad">' +
      '<span class="seal">到此一游</span>' +
      '<h2 class="arrive-h">你到了，山友。</h2>' +
      '<p class="arrive-p">' + esc(p.name || '名称待定') +
      (p.alt ? ' · 海拔 ' + p.alt + ' m' : '') + ' · 打卡后生成本次到访凭证</p>' +
      /* 游客主路径：不登录、不填表，点了就拿到带时间戳的到此一游凭证 */
      '<button class="btn coral" data-act="guest-checkin" data-code="' + esc(p.code || '') + '">' +
      '我到了</button>' +
      '<div class="hint" style="text-align:center">不用注册，就能拿到带时间戳的凭证</div>' +
      '<a class="btn ghost" style="margin-top:9px" href="#/peaks/' + esc(p.id) + '">查看这座山</a>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="arrival-draft" data-code="' + esc(p.code) + '">' +
      '留一句给下一位</button>' +
      '<div class="sec-head"><h3>' + esc(p.name) + '留言板</h3><span class="more">全部 ›</span></div>' +
      commentsFor(p.id).slice(0, 2).map(commentCard).join('') +
      '<button class="btn ghost" data-act="arrival-draft" data-code="' + esc(p.code) + '">在留言板写一句</button>'
      + '</div>'
    );
  }

  /* ==================== 弹层 ==================== */
  function sheetCheckin(type, id) {
    var place = placeOf(type, id);
    U.openSheet(
      '<h3>留下我的到访卡</h3>' +
      '<div class="sh-sub">' + esc(place.name) + ' · ' + (type === 'peak' ? '山顶打卡点' : '岔路口路书点') + '</div>' +
      '<div class="field"><label>昵称</label><input id="ckName" type="text" value="' + esc(H.me.name) + '"></div>' +
      '<div class="field"><label>这次是</label><div class="tags-pick" id="ckTags">' +
      ['第一次来', '一个人', '和朋友', '带娃', '第 N 次'].map(function (t, i) {
        return '<button data-act="tag" data-val="' + t + '" class="' + (i === 0 && !beenThere(id) ? 'on' : '') + '">' + t + '</button>';
      }).join('') + '</div></div>' +
      (type === 'peak' ? '<div class="field"><label>这次用了多久（可选）</label>' +
        '<input id="ckTime" type="text" value="' + (S.pb[id] || '01:42') + '" placeholder="例如 01:42"></div>' : '') +
      '<button class="btn coral" data-act="submit-checkin" data-type="' + type + '" data-id="' + id + '">确认打卡</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">先不打卡</button>'
    );
  }

  function sheetVisitDone(type, id, visit) {
    var place = placeOf(type, id);
    var tags = visit.tags.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('');
    U.openSheet(
      '<h3 style="text-align:center">到访成功</h3>' +
      '<div class="sh-sub" style="text-align:center">' + esc(place.name) + ' · 你已经留下一张卡</div>' +
      '<div class="visitcard">' +
      '<div class="top">' + U.scene(id) + '<span class="seal">#' + visit.seq + '</span></div>' +
      '<div class="body"><h4>' + esc(H.me.name) + ' · 第 ' + visit.seq + ' 位到访</h4>' +
      '<div class="meta">' + esc(place.name) + (visit.time ? ' · 用时 ' + esc(visit.time) : '') + ' · 刚刚</div>' +
      '<div class="tags">' + tags + '</div></div></div>' +
      '<button class="btn blue" data-act="share">生成分享图</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">收进到访册</button>'
    );
  }

  function sheetDoc() {
    U.openSheet('<h3>关于难度</h3><div class="sh-sub">形状和颜色永远一起出现，色弱也能分辨</div>' +

      /* 先讲清楚这套难度是分两层算的：段是机器算的，线路是人判的。
         不讲清这一层，用户会拿"四个颜色"去理解整条线路，那就错了。 */
      '<div class="card" style="box-shadow:none;background:var(--blue-bg);padding:15px">' +
      '<div style="font-size:14.5px;font-weight:800;color:var(--blue-deep);margin-bottom:8px">' +
      '难度分两层看</div>' +
      '<div style="font-size:12.5px;color:#2B3568;line-height:1.7">' +
      '<b>① 单段难度 —— 机器算的。</b>把整条路线切成一段一段，每段只看两个数字：' +
      '这一段爬升多少米、坡有多陡（爬升 ÷ 水平距离）。两个数字各定一档，取高的那档上色。<br>' +
      '所以线条上的颜色是"<b>这一段难不难</b>"，不是"整条线难不难"。<br><br>' +
      '<b>② 线路综合难度 —— 人判断的。</b>一个颜色装不下它。要看' +
      '<b>平均完成时间、登顶难度、距离与累计爬升、路况、技术动作</b>这几项合起来——' +
      '由维护人给结论。<br>' +
      '所以线路卡片上不放单一难度色块，放的是<b>平均用时 + 大致卡路里 + 最难那一段的徽标 + 路况说明</b>；' +
      '线路列表里的那个形状，只代表<b>全线最难的一段</b>。' +
      '</div></div>' +

      '<div class="group-label" style="margin-top:16px">单段难度 · 四档</div>' +
      H.difficultyDoc.map(function (d) {
        return '<div class="card" style="box-shadow:none;background:#fff;padding:14px;display:flex;gap:14px;align-items:center">' +
          '<span class="shape" style="width:52px;height:52px;flex:0 0 auto">' + U.shapeSVG(d.key) + '</span>' +
          '<div><div style="font-size:14px;font-weight:800;margin-bottom:5px">' + esc(d.title) + '</div>' +
          '<div style="font-size:12.5px;color:#3C3F4E;line-height:1.6">' + esc(d.body) + '</div></div></div>';
      }).join('') +

      '<div class="group-label" style="margin-top:16px">线路综合难度 · 这五项一起看</div>' +
      '<div class="card" style="box-shadow:none;background:#fff;padding:6px 14px">' +
      H.routeFactors.map(function (f, i) {
        return '<div style="padding:11px 0' + (i ? ';border-top:1px solid var(--hair)' : '') + '">' +
          '<div style="font-size:13.5px;font-weight:800">' + esc(f.label) + '</div>' +
          '<div style="font-size:12.5px;color:#3C3F4E;line-height:1.6;margin-top:3px">' +
          esc(f.hint) + '</div></div>';
      }).join('') +
      '<div class="note" style="padding:0 0 13px">这几项不出一个总分，也不给一个颜色——' +
      '它们变成页面上那几行字：平均用时、大致卡路里、最难的一段、路况。</div></div>' +

      '<div class="group-label" style="margin-top:14px">别的地方怎么分级</div>' +
      H.gradeRefs.map(function (r) {
        return '<div class="card" style="box-shadow:none;background:#fff;padding:14px">' +
          '<div style="font-size:12px;font-weight:800;color:var(--blue);margin-bottom:4px">' + esc(r.region) + '</div>' +
          '<div style="font-size:14px;font-weight:800;margin-bottom:5px">' + esc(r.name) + '</div>' +
          '<div style="font-size:12.5px;color:#3C3F4E;line-height:1.6">' + esc(r.body) + '</div>' +
          (r.ladder ? '<div class="ladder">' + r.ladder.map(function (s) {
            return '<div><b>' + esc(s.k) + '</b><span>' + esc(s.t) + '</span></div>';
          }).join('') + '</div>' : '') +
          '</div>';
      }).join('') +
      '<div class="group-label">实体标牌上有什么</div>' +
      U.signage({ level: 'mid', alt: '海拔 2303 m', seq: 100 }, { code: 'DLS-100' }) +
      '<div class="hint">标牌 = 难度图形 + CHA 署名 + 海拔 + 可扫二维码。图形用形状区分，不依赖颜色。</div>' +
      '<button class="btn ghost" style="margin-top:6px" data-act="close">知道了</button>');
  }

  function sheetIntel(jid) {
    var j = junction(jid);
    U.openSheet('<h3>上报一条情报</h3><div class="sh-sub">' + esc(j.name) + ' · 让下一个走到这里的人少走错路</div>' +
      '<div class="field"><label>一句话情报</label><input id="inTitle" type="text" placeholder="例如：右边的岔路是作业道，别走"></div>' +
      '<div class="field"><label>补充说明</label><input id="inText" type="text" placeholder="例如：路口有蓝色标牌，跟着标牌走"></div>' +
      '<button class="btn coral" data-act="submit-intel" data-id="' + jid + '">提交，等待核验</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">取消</button>');
  }

  function sheetComment(type, id) {
    var p = placeOf(type, id);
    U.openSheet('<h3>写一句给下一位</h3><div class="sh-sub">会出现在「' + esc(p.name) + '」的留言板上</div>' +
      '<div class="field"><label>留言</label><input id="cmText" type="text" placeholder="例如：上面风大，记得带件外套。"></div>' +
      '<button class="btn coral" data-act="submit-comment" data-type="' + type + '" data-id="' + id + '">发布</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">取消</button>');
  }

  function sheetLetter(id) {
    var p = peak(id) || placeOf('peak', id);
    U.openSheet('<h3>写给未来的自己</h3><div class="sh-sub">到日子或者下次到 ' + esc(p.name) + ' 时解锁</div>' +
      '<div class="field"><label>想说点什么</label><input id="ltText" type="text" placeholder="例如：如果明年还来，希望你还在走。"></div>' +
      '<div class="field"><label>什么时候拆开</label><input id="ltDate" type="date"></div>' +
      '<button class="btn coral" data-act="submit-letter" data-id="' + id + '">封存这封信</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">取消</button>');
  }

  function sheetReadLetter(id) {
    var l = H.letters[Math.floor(Math.random() * H.letters.length)];
    U.openSheet('<div class="letter" style="margin-top:4px"><span class="stampmark"></span>' +
      '<div class="ltag">来自 ' + esc(l.from) + '</div>' +
      '<div class="line">' + esc(l.text) + '</div>' +
      '<div class="lsub">' + esc(l.when) + '</div></div>' +
      '<button class="btn coral" data-act="close">收下这句话</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="letter-write" data-id="' + id + '">我也留一句给下一位</button>');
  }

  function notFound() {
    return '<div class="empty"><span class="big">⛰</span>没有找到这个页面。<br>' +
      '<a href="#/" style="color:var(--blue);font-weight:700">回首页</a></div>';
  }

  /* ==================== 顶部栏与底部导航 ==================== */
  var TAB_TITLE = { trails: '路书', peaks: '占山为王', junctions: '占山为王', places: '占山为王', board: '留言版', messages: '通知', me: '我' };

  function messageEntry() {
    var unread = (H.notif || []).some(function (n) { return n.unread; }) ||
      (H.mySummits || []).some(function (n) { return n.unread; }) ||
      (H.followPeaks || []).some(function (n) { return n.unread; });
    return '<a class="iconbtn message-entry" href="#/messages" aria-label="消息' + (unread ? '，有未读消息' : '') + '" title="消息">' +
      U.icon('chat') + (unread ? '<span class="dot" aria-hidden="true"></span>' : '') + '</a>';
  }
  function scanEntry() {
    return '<a class="iconbtn scan-entry" href="#/scan" aria-label="扫一扫" title="扫一扫">' +
      U.icon('scan') + '</a>';
  }
  var TAB_SUB = { trails: 'TRAILBOOK', places: 'PLACES', board: 'MOUNTAIN NOTES', messages: 'MESSAGES', me: 'MY HIKES' };

  function renderTopbar(r) {
    var el = U.$('#topbar');
    if (r.name === 'home') {
      el.className = 'topbar home';
      el.innerHTML = '<a class="brand-tap" href="#/"><span class="brand"><b>' + H.appName + '</b><em>' + H.brandEn + '</em></span></a>' +
      '<div class="top-actions"><a class="iconbtn" href="#/trails" aria-label="搜索路线">' + U.icon('search') + '</a>' +
      messageEntry() + '</div>';
      return;
    }
    /* 工具栏只保留当前位置、返回与当前页真正可用的动作。 */
    var isTabPage = !!r.tab && r.name === r.tab;
    var parent = r.name.indexOf('me-') === 0 ? '#/me' : (r.parent || '#/');
    var backTo = parent === '#/' + r.name ? '#/' : parent;
    el.className = 'topbar';
    var leading = isTabPage
      ? '<a class="tb-brand" href="#/" aria-label="回主页"><img src="assets/brand/logo-mark.png" alt="">' +
        '<span>到此一游</span></a>'
      : '<a class="back" href="' + esc(backTo) + '" aria-label="返回">' + U.icon('back') + '</a>';
    var title = isTabPage ? (TAB_TITLE[r.tab] || '') : (r.title || '');
    el.innerHTML = '<div class="tb-bar">' + leading +
      (isTabPage ? '' : '<span class="tb-title">' + esc(title) + '</span>') +
      '<div class="top-actions">' + scanEntry() + (isTabPage ? messageEntry() : '') + '</div>' +
      '</div>';
  }

  function renderTabbar(tab) {
    var el = U.$('#tabbar');
    function cls(k) { return tab === k ? ' class="on" aria-current="page"' : ''; }
    el.innerHTML =
      '<a href="#/places" aria-label="占山为王"' + cls('places') + '>' + U.icon('hill') + '山头</a>' +
      '<a href="#/trails"' + cls('trails') + '>' + U.icon('book') + '路书</a>' +
      '<a href="#/board"' + cls('board') + '>' + U.icon('chat') + '留言版</a>' +
      '<a href="#/me"' + cls('me') + '>' + U.icon('me') + '我</a>';
  }

  /* ==================== 路由 ==================== */
  function parse() {
    var h = decodeURIComponent((location.hash || '#/').replace(/^#/, '')).split('?')[0];
    var parts = h.split('/').filter(Boolean);
    var r = { name: 'home', parts: parts };
    if (!parts.length) { r.name = 'home'; r.tab = null; return r; }
    switch (parts[0]) {
      case 'trails':
        if (parts[1]) { r.name = 'trail'; r.id = parts[1]; r.tab = 'trails'; r.parent = '#/trails'; }
        else { r.name = 'trails'; r.tab = 'trails'; }
        break;
      case 'places': r.name = 'places'; r.tab = 'places'; break;
      case 'peaks': r.name = parts[1] ? 'peak' : 'places'; r.id = parts[1]; r.tab = 'places'; r.parent = '#/peaks'; break;
      case 'junctions': r.name = parts[1] ? 'junction' : 'places'; r.id = parts[1]; r.tab = 'places'; r.parent = '#/junctions'; break;
      case 'messages': r.name = 'messages'; r.tab = 'messages'; break;
      case 'board': r.name = 'board'; r.tab = 'board'; break;
      case 'me':
        r.tab = 'me'; r.parent = '#/me';
        if (parts[1] === 'managed') {
          r.name = 'me-managed'; r.id = parts[2] || null;
        } else if (parts[1]) { r.name = 'me-' + parts[1]; } else { r.name = 'me'; }
        break;
      case 'king':
        r.parent = '#/places'; r.tab = 'places';
        if (parts[1] === 'apply') { r.name = 'king-apply'; r.id = null; }
        else if (parts[1] === 'application') { r.name = 'king-application'; r.id = parts[2] || null; }
        else { r.name = 'king-applications'; }
        break;
      case 'scan': r.name = 'scan'; break;
      case 'login':
        r.name = 'auth'; r.mode = 'login'; r.title = '登录'; r.tab = 'me'; r.parent = '#/me';
        break;
      case 'register':
        r.name = 'auth'; r.mode = 'register'; r.title = '注册'; r.tab = 'me'; r.parent = '#/me';
        break;
      case 'arrive': r.name = 'arrive'; r.id = parts[1] || ''; r.parent = '#/scan'; break;
      case 'admin':
        r.name = parts[1] === 'p' ? 'admin-p' : 'admin';
        r.id = parts[2] || null;
        r.parent = '#/admin';
        break;
      default: r.name = parts[0]; r.id = parts[2] || parts[1];
    }
    return r;
  }

  var TITLES = {
    scan: '扫一扫', arrive: '到达页', trail: '线路详情', peak: '山头', junction: '岔路',
    login: '登录', register: '注册',
    'me-visited': '我去过的地方', 'me-want': '我想去的地方', 'me-peak': '我的山头',
    'me-records': '我的纪录', 'me-applications': '我的维护申请', 'me-letters': '山间信箱',
    'me-activity': '发起活动', 'me-managed': '我管理的留言版',
    'king-apply': '统一申请', 'king-applications': '我的申请', 'king-application': '申请进度',
    messages: '通知',
    admin: '维护台', 'admin-p': '管理点位'
  };

  function render() {
    var r = parse();
    if (r.name !== 'scan') stopScanCamera();
    if (r.name === 'places' && r.parts[1] === 'junction') seg = 'junction';
    document.getElementById('app').classList.toggle('home-image', r.name === 'home');
    document.getElementById('app').dataset.page = r.name;
    if (r.name === 'peak' || r.name === 'junction' || r.name === 'trail') {
      var p = placeOf(r.name === 'peak' ? 'peak' : r.name === 'junction' ? 'junction' : 'trail', r.id);
      r.title = p ? p.name : '未找到';
    } else if (TITLES[r.name]) {
      r.title = TITLES[r.name] || (window.EXTRA_TITLES && window.EXTRA_TITLES[r.name]);
    }
    renderTopbar(r);
    renderTabbar(r.tab);

    var view = U.$('#view');
    var flush = (r.name === 'peak' || r.name === 'junction' || r.name === 'arrive');
    view.className = 'view' + (flush ? ' flush' : '') + (r.name === 'home' ? ' home-image-view' : '');

    var html = '';
    switch (r.name) {
      case 'home': html = homeView(); break;
      case 'trails': html = trailListView(); break;
      case 'trail': {
        var currentTrail = trail(r.id);
        if (currentTrail && !currentTrail.detailLoaded && window.API && window.API.loadRouteDetail) {
          if (!currentTrail.detailError) {
            window.API.loadRouteDetail(r.id).then(function () {
              if (parse().name === 'trail' && parse().id === r.id) render();
            }).catch(function () {
              currentTrail.detailError = true;
              if (parse().name === 'trail' && parse().id === r.id) render();
            });
          }
          html = '<div class="empty">' + (currentTrail.detailError
            ? '路书加载失败，请重试<br><button class="btn ghost" data-act="reload" style="margin-top:12px">重新加载</button>'
            : '正在加载路书…') + '</div>';
        } else {
          html = trailDetailView(r.id);
        }
        break;
      }
      case 'places': html = placesView(); break;
      case 'peak': html = peakView(r.id); break;
      case 'junction': html = junctionView(r.id); break;
      case 'messages': html = messagesView(); break;
      case 'board': html = boardView(); break;
      case 'me': html = meView(); break;
      case 'me-visited': html = meVisitedView(); break;
      case 'me-want': html = meWantView(); break;
      case 'me-peak': html = mePeakView(); break;
      case 'me-records': html = meRecordsView(); break;
      case 'me-applications': html = meApplicationsView(); break;
      case 'me-letters': html = meLettersView(); break;
      case 'me-activity': html = meActivityView(); break;
      case 'king-apply':
      case 'king-applications':
      case 'king-application':
      case 'me-managed':
        html = (window.KING_APP && window.KING_APP.view) ? window.KING_APP.view(r) : '<div class="empty">管理模块加载中…</div>';
        break;
      case 'scan': html = scanView(); break;
      case 'auth': html = authView(r.mode); break;
      case 'arrive': html = arrivalView(r.id); break;
      default: html = (window.EXTRA_VIEWS && window.EXTRA_VIEWS[r.name]) ? window.EXTRA_VIEWS[r.name](r) : notFound();
    }
    view.innerHTML = html;
    if (window.KING_APP && window.KING_APP.mount) window.KING_APP.mount(r);
    /* 留言瀑布流放到管理卡之后启动，先让获批用户看到自己的管理身份。 */
    if (r.name === 'board') setTimeout(loadBoardComments, 180);
    /* 每次渲染先把上一页的轮换定时器停掉，再按当前页启动（顺序不能反，否则刚启动就被清） */
    stopHomeAnim();
    stopListFeatured();

    if (r.name === 'trails') {
      startListFeatured();
      var input = document.getElementById('q');
      if (input) input.addEventListener('input', function () { q = this.value; pages.trails = 0; refreshTrailResults(); });
      if (window.API && window.API.loadRouteDetail) {
        var ordered = H.trails.slice().sort(function (a, b) { return b.visits7 - a.visits7; });
        var hotSlice = ordered.slice((pages.trailHot || 0) * CAROUSEL_PAGE, ((pages.trailHot || 0) + 1) * CAROUSEL_PAGE);
        /* 详情接口一次画 6 条会同时打几十个查询；Supabase 跨区时容易把 15 秒超时
           全部耗在排队上。这里最多并发 3 条，失败也标出来，不让卡片永远停在"读取地形…"。 */
        var detailQueue = hotSlice.slice();
        var loadNext = function () {
          var item = detailQueue.shift();
          if (!item) return Promise.resolve();
          return window.API.loadRouteDetail(item.id).catch(function () {
            item.detailError = true;
          }).then(function () {
            return loadNext();
          });
        };
        var workers = [];
        for (var wi = 0; wi < Math.min(3, hotSlice.length); wi++) workers.push(loadNext());
        Promise.all(workers)
          .then(function () {
            var current = parse(), carousel = document.getElementById('trailHotCarousel');
            if (current.name === 'trails' && carousel) carousel.innerHTML = hotSlice.map(trailCard).join('');
          });
      }
    }
    if (r.name === 'places') {
      startFootRotate();
      var pi = document.getElementById('pq');
      if (pi) pi.addEventListener('input', function () {
        pq = this.value;
        pages.peaks = pages.peakHot = pages.junctions = 0;
        render();
        var ni = document.getElementById('pq');       /* 重渲染后把焦点和光标放回去 */
        if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
      });
    }
    if (r.name === 'home') startFeaturedRotate();
    var reasonBox = document.getElementById('msReason');
    if (reasonBox) {
      var paint = function () {
        var el = document.getElementById('msReasonHint');
        if (el) el.textContent = reasonBox.value.trim().length + ' / 20 字' +
          (reasonBox.value.trim().length >= 20 ? ' ✓' : '');
      };
      reasonBox.addEventListener('input', paint); paint();
    }
    var expectBox = document.getElementById('msExpect');
    if (expectBox) {
      var paintExpect = function () {
        var el = document.getElementById('msExpectHint');
        if (el) el.textContent = expectBox.value.trim().length + ' / 10 字' +
          (expectBox.value.trim().length >= 10 ? ' ✓' : '');
      };
      expectBox.addEventListener('input', paintExpect); paintExpect();
    }

    var isTab = !!r.tab && r.name !== 'peak' && r.name !== 'junction' && r.name !== 'trail';
    if (lastRoute !== r.name + (r.id || '')) view.scrollTop = 0;
    lastRoute = r.name + (r.id || '');
  }
  var lastRoute = '';

  /* ==================== 事件 ==================== */
  var nearbySelection = null;
  var masterKind = 'solo';        /* 申请类型：solo 山大王（单人）· clan 山寨（多人） */
  var masterVisits = 4;           /* 一个月能去几次 */
  /* 定位与队列都在 checkin.js 里（计划 T4）；这里只做页面层的触发与反馈。 */
  function currentPosition() { return window.HIKES_CHECKIN.position(); }
  function syncPendingCheckins(force) {
    if (!navigator.onLine) return Promise.resolve(null);
    return window.HIKES_CHECKIN.flush({ force: !!force })
      .then(function (result) {
        if (result && (result.sent || result.failed || result.blocked)) { homeData = null; render(); }
        return result;
      })
      .catch(function () { return null; });
  }
  window.addEventListener('hikes:checkin-synced', function () { homeData = null; render(); });
  window.HIKES_CHECKIN.start();
  trkWireTrack();
  function on(act, fn) { return { act: act, fn: fn }; }

  document.addEventListener('change', function (e) {
    if (e.target.id === 'board-search') { boardQuery = e.target.value.trim(); render(); }
    if (e.target.id === 'board-peak-filter') { boardPeakFilter = e.target.value; render(); }
    if (e.target.matches('[data-act="board-sort"]')) { boardSort = e.target.value; render(); }
  });
  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'authForm') return;
    e.preventDefault();
    submitAuthPage(e.target);
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'masterSearch') {
      var list = document.getElementById('masterCandidates');
      if (list) list.innerHTML = masterCandidateRows(e.target.value.trim());
      return;
    }
    if (e.target.id !== 'arrivalPrivate' && e.target.id !== 'arrivalPublic') return;
    var save = document.querySelector('[data-act="arrival-draft-save"]');
    if (!save) return;
    rememberArrivalDraft(save.getAttribute('data-code'),
      (document.getElementById('arrivalPrivate') || {}).value || '',
      (document.getElementById('arrivalPublic') || {}).value || '');
  });

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) return;
    var act = t.getAttribute('data-act');
    /* 这三个属性放在最前面读：下面的分支（比如轨迹图缩放）要用它们 */
    var id = t.getAttribute('data-id');
    var type = t.getAttribute('data-type');
    var val = t.getAttribute('data-val');
    /* 统一申请入口：旧的自建山头 / 认领 / 协作入口全部收口到这一页。
       它们不再在浏览器里当场创建点位或授予身份。 */
    if (act === 'king-open' || act === 'king-new' || act === 'become-master' ||
        act === 'master-claim' || act === 'collaboration-open') {
      var targetCode = t.getAttribute('data-code') || '';
      var targetKind = t.getAttribute('data-kind') || 'peak';
      location.hash = '#/king/apply' + (targetCode ? '?target=' + encodeURIComponent(targetCode) :
        '?type=' + targetKind);
      return;
    }
    if (window.KING_APP && window.KING_APP.handleAction &&
        window.KING_APP.handleAction(act, t, { id: id, type: type, val: val })) return;
    if (act === 'retry-boot') { location.reload(); return; }
    if (act === 'auth-mode') {
      U.go('#/' + (val === 'register' ? 'register' : 'login'));
      return;
    }
    if (act === 'logout') {
      window.API.clearSession();
      syncMeIdentity(null);
      location.reload();
      return;
    }
    if (act === 'scan-camera') { startScanCamera(); return; }
    if (act === 'scan-stop') {
      stopScanCamera();
      var scanState = document.getElementById('scanState');
      if (scanState) scanState.textContent = '相机已关闭。可以重新打开，或手动输入编号。';
      return;
    }
    if (act === 'home-retry') { homeData = null; loadHomeData(); return; }
    if (act === 'receipts-retry') { myReceipts = null; myReceiptsError = false; loadMyReceipts(); return; }
    if (act === 'applications-retry') {
      myApplications = null; myApplicationsError = false; loadMyApplications(); return;
    }
    if (act === 'application-withdraw') {
      t.disabled = true;
      window.API.ja('/api/master-applications/' + id + '/withdraw', { method: 'POST', body: '{}' })
        .then(function () { myApplications = null; loadMyApplications(); U.toast('已撤回'); })
        .catch(function (e) { U.toast(e.message || '撤回失败'); })
        .then(function () { t.disabled = false; });
      return;
    }
    if (act === 'board-window') { boardWindow = val; boardReload(); return; }
    if (act === 'board-metric') { boardMetric = val; boardReload(); return; }
    if (act === 'board-retry') { boardReload(); return; }
    if (act === 'trk-zoom') {
      var trackId = t.getAttribute('data-id');
      if (val === 'reset') trkReset(trackId);
      else {
        var box = trkNode(trackId) && trkNode(trackId).getBoundingClientRect();
        trkZoomAt(trackId, val === 'in' ? 1.4 : 1 / 1.4,
                  box ? box.left + box.width / 2 : 0, box ? box.top + box.height / 2 : 0);
      }
      return;
    }
    if (act === 'peak-board-window') { peakBoardWindow = val; render(); return; }

    if (act === 'nearby') {
      t.disabled = true;
      var here = null;      /* 定位结果要在下一个 then 里显示精度，作用域提到外层 */
      currentPosition().then(function (pos) {
        here = pos;
        return window.API.nearbyPoints(pos);
      })
        .then(function (rows) {
          var labels = { peak: '山顶', trailhead: '山脚', junction: '岔路' };
          var body = rows.length ? '<div class="hint" style="margin:0 0 10px">只显示已进入可打卡范围的点位。</div>' +
            rows.map(function (p) {
              var place = p.name || p.code;
              var context = p.mountainName ? p.mountainName :
                (p.routeName ? p.routeName : '');
              return '<button class="nearby-choice" data-act="nearby-point" data-code="' +
                esc(p.code) + '"><span class="nearby-choice-type">' +
                esc(labels[p.kind] || '点位') + '</span><span class="nearby-choice-main"><b>' +
                esc(place) + '</b><small>' + esc(context) + '</small></span><span class="nearby-choice-distance">' +
                p.distanceM + ' 米<i>可打卡</i></span></button>';
            }).join('') +
            '<button class="btn ghost" style="margin-top:12px" data-act="nearby">不是这里，重新定位</button>' :
            '<div class="empty" style="padding:18px 8px"><b>附近没有可打卡点位</b><p>当前只显示 100 米内的山顶、150 米内的山脚或岔路。请靠近点位，或改用扫码。</p>' +
            '<div class="mini-actions"><button class="pill-btn acc" data-act="nearby">重新定位</button>' +
            '<a class="pill-btn" href="#/scan">扫码或输入编号</a></div></div>';
          U.openSheet('<h3>你到了哪一处？</h3><div class="sh-sub">定位精度 ±' +
            esc(here && here.accuracyM) + ' 米 · 确认后再进入到访记录</div>' + body);
        }).catch(function (error) { U.toast(error.message); })
        .then(function () { t.disabled = false; });
      return;
    }
    if (act === 'nearby-point') {
      nearbySelection = t.getAttribute('data-code');
      U.closeSheet();
      location.hash = '#/arrive/p-' + encodeURIComponent(nearbySelection);
      return;
    }

    if (act === 'peak-name') {
      var peakIdx = t.getAttribute('data-idx');
      var proposed = window.prompt('请输入山峰名称建议（提交后由线路关联山头维护人确认）');
      if (!proposed || !proposed.trim()) return;
      window.API.ja('/api/routes/' + encodeURIComponent(parse().id) + '/peaks/' + peakIdx + '/name-candidates', {
        method: 'POST', body: JSON.stringify({ name: proposed.trim() })
      }).then(function () { U.toast('名称建议已提交，等待维护人确认'); window.API.loadRouteDetail(parse().id, true).then(render); })
        .catch(function () { U.toast('提交失败，请登录后重试'); });
      return;
    }
    if (act === 'peak-name-review') {
      var idx = t.getAttribute('data-idx');
      window.API.ja('/api/routes/' + encodeURIComponent(parse().id) + '/peaks/' + idx + '/name-candidates/review', {
        method: 'POST', body: JSON.stringify({ candidate_id: Number(t.getAttribute('data-cid')), decision: 'accepted' })
      }).then(function () { U.toast('山峰名称已确认'); window.API.loadRouteDetail(parse().id, true).then(render); })
        .catch(function () { U.toast('确认失败，请刷新后重试'); });
      return;
    }
    if (act === 'peak-name-reject') {
      var idx = t.getAttribute('data-idx');
      window.API.ja('/api/routes/' + encodeURIComponent(parse().id) + '/peaks/' + idx + '/name-candidates/review', {
        method: 'POST', body: JSON.stringify({ candidate_id: Number(t.getAttribute('data-cid')), decision: 'rejected' })
      }).then(function () { U.toast('已驳回名称建议'); window.API.loadRouteDetail(parse().id, true).then(render); })
        .catch(function () { U.toast('操作失败，请刷新后重试'); });
      return;
    }
    if (act === 'checkpoint-add') {
      U.sheet('<h3>添加线路 CP</h3><div class="field"><label>名称 *</label><input id="cpName" maxlength="120" placeholder="例如：西大庄科补给点"></div>' +
        '<div class="field"><label>里程（km） *</label><input id="cpKm" type="number" min="0" max="'+esc(trail(parse().id).km)+'" step="0.01" placeholder="从起点累计里程"></div>' +
        '<div class="field"><label>补给类型（选填）</label><input id="cpSupply" maxlength="80" placeholder="水 / 食物 / 医疗"></div>' +
        '<div class="field"><label>备注（选填）</label><textarea id="cpNotes" maxlength="1000" placeholder="补给情况或现场说明"></textarea></div>' +
        '<div id="cpError" class="error"></div><button class="btn coral" data-act="checkpoint-submit" data-id="'+esc(parse().id)+'">保存 CP</button>');
      return;
    }
    if (act === 'checkpoint-submit') {
      var cpName = (document.getElementById('cpName') || {}).value || '';
      var cpKm = Number((document.getElementById('cpKm') || {}).value);
      var cpSupply = (document.getElementById('cpSupply') || {}).value || '';
      var cpNotes = (document.getElementById('cpNotes') || {}).value || '';
      var cpError = document.getElementById('cpError');
      if (!cpName.trim() || !Number.isFinite(cpKm)) { cpError.textContent = '名称和里程为必填项。'; return; }
      t.disabled = true;
      window.API.ja('/api/routes/' + encodeURIComponent(id) + '/checkpoints', {
        method: 'POST', body: JSON.stringify({ name: cpName.trim(), km: cpKm,
          supply_type: cpSupply.trim() || null, notes: cpNotes.trim() || null })
      }).then(function () { U.closeSheet(); U.toast('CP 已添加'); window.API.loadRouteDetail(id, true).then(render); })
        .catch(function (err) { cpError.textContent = err.message || '保存失败，请稍后重试'; })
        .then(function () { t.disabled = false; });
      return;
    }

    if (act === 'want') {
      e.preventDefault();
      var i = S.want.indexOf(id);
      if (i >= 0) { S.want.splice(i, 1); U.toast('已从想去移除'); }
      else { S.want.unshift(id); U.toast('已收藏到想去'); }
      persist();
      syncWant(id, i < 0);        /* 关注度要落库，见下面的注释 */
      if (parse().name === 'me-want') { render(); } else { repaintWant(); }
      return;
    }
    if (act === 'join') {
      var j = S.joined.indexOf(id);
      if (j >= 0) { S.joined.splice(j, 1); U.toast('已退出活动'); }
      else { S.joined.unshift(id); U.toast('已参加 · 出发前 2 小时会提醒你'); }
      persist(); render(); return;
    }
    if (act === 'clap') {
      if (S.claps[id]) { delete S.claps[id]; } else { S.claps[id] = 1; U.toast('击掌！'); }
      persist(); render(); return;
    }
    if (act === 'checkin') { sheetCheckin(type, id); return; }
    /* 游客打卡：不登录，直接拿带时间戳的到此一游凭证 */
    if (act === 'guest-checkin') {
      var gcode = t.getAttribute('data-code');
      if (!gcode) { U.toast('这个示例点位没有编号；扫真实二维码就有'); return; }
      t.disabled = true;
      var isNearby = nearbySelection === gcode;
      var actionId = t.getAttribute('data-client-uuid');
      if (!actionId) {
        actionId = crypto.randomUUID();
        t.setAttribute('data-client-uuid', actionId);
        t.setAttribute('data-occurred-at', new Date().toISOString());
      }
      var details = { source: isNearby ? 'nearby' : 'scan', clientUuid: actionId,
                      occurredAt: t.getAttribute('data-occurred-at') };
      /* 定位只在"附近打卡"这一次动作里取一次；重试时复用同一份 payload，
         否则每次重试都会换一个现场时间与坐标，破坏幂等（计划 T3/T4）。 */
      var cached = t.getAttribute('data-payload');
      var record = null;      /* 在 .then 回调里赋值，所以要在外层声明 */
      var payloadPromise = cached ? Promise.resolve(JSON.parse(cached)) :
        (isNearby ? currentPosition().then(function (pos) {
          return Object.assign(details, { lat: pos.lat, lng: pos.lng, accuracyM: pos.accuracyM });
        }) : Promise.resolve(details));
      payloadPromise.then(function (payload) {
        t.setAttribute('data-payload', JSON.stringify(payload));
        var knownPoint = H.peaks.filter(function (p) { return p.code === gcode && p.pointId; })[0] || {};
        record = {
          clientUuid: actionId, code: gcode, pointId: knownPoint.pointId || null,
          pointSnapshot: { code: gcode, name: knownPoint.name || gcode,
                           kind: knownPoint.type || null,
                           checkinRadiusM: knownPoint.checkinRadiusM || null },
          payload: payload, status: 'pending', attempts: 0,
          createdAt: new Date().toISOString()
        };
        return window.HIKES_CHECKIN.sendNow(record);
      }).then(function (outcome) {
        if (outcome.ok) { homeData = null; sheetGuestCard(outcome.visit); return; }
        var label = (H.peaks.filter(function (p) { return p.code === gcode; })[0] || {}).name || gcode;
        if (!outcome.retryable) {
          /* 服务器明确拒绝（不在半径内、精度不够、点位未开放……）：当场说清原因，
             不写队列 —— 写进去只会反复失败，还让用户以为"已经在传了"。 */
          U.openSheet('<h3>这次没能记上</h3><p>' + esc(outcome.message || '服务器拒绝了这次打卡') +
            '</p><p class="hint">没有产生到访记录。</p>');
          return;
        }
        return window.HIKES_CHECKIN.currentIdentity().then(function (identity) {
          record.identity = identity.key;
          record.lastError = outcome.message || '';
          record.lastErrorCode = outcome.code || '';
          return window.HIKES_CHECKIN.enqueue(record).then(function () {
            homeData = null;
            U.openSheet('<h3>已保存在本机，待同步</h3><p>' + esc(label) + ' · ' +
              esc(outcome.message || '网络还没确认这次打卡') + '</p>' +
              '<p class="hint">同步成功之前不显示正式序号；联网、回到前台或点下面的按钮都会重试。</p>' +
              '<button class="btn ghost" data-act="sync-checkins" data-force="1">立即重试</button>');
          }).catch(function () {
            U.toast('本机保存失败，这次打卡还没有记录，请保持页面打开后重试');
          });
        });
      }).catch(function (error) {
        U.toast(error.message || '打卡未完成，请重试');
      }).then(function () { t.disabled = false; });
      return;
    }
    if (act === 'sync-checkins') {
      t.disabled = true;
      syncPendingCheckins(t.getAttribute('data-force') === '1').then(function (result) {
        t.disabled = false;
        if (!result) { U.toast('现在没有网络，稍后会自动重试'); return; }
        var left = (result.remaining || {});
        if (result.sent) { U.closeSheet(); U.toast('已同步 ' + result.sent + ' 条记录'); }
        else if (!left.total) { U.closeSheet(); U.toast('本机没有待同步的记录了'); }
        else if (left.blocked) { U.toast('这些记录属于另一个身份：登录原来那个账号后才能传'); }
        else if (left.failed) { U.toast(left.failed + ' 条被服务器拒绝，原因已保留在本机'); }
        else { U.toast('还在等重试时间，稍后会自动再试'); }
      });
      return;
    }
    if (act === 'arrival-draft') { sheetArrivalDraft(t.getAttribute('data-code') || arrivalCode()); return; }
    if (act === 'arrival-draft-save' || act === 'arrival-draft-publish') {
      var code = t.getAttribute('data-code');
      var note = (document.getElementById('arrivalPrivate') || {}).value || '';
      var comment = (document.getElementById('arrivalPublic') || {}).value || '';
      var errorEl = document.getElementById('arrivalDraftError');
      if (!note.trim() && !comment.trim()) { errorEl.textContent = '请先写下纪念或留言。'; return; }
      if (act === 'arrival-draft-publish' && !comment.trim()) {
        errorEl.textContent = '请先写下要发布的留言。'; return;
      }
      rememberArrivalDraft(code, note, comment);
      t.disabled = true;
      window.API.token().then(function (tk) {
        var guest = !tk;
        var pendingKey = guest ? '' : 'hikes.arrival.publish.pending.' + arrivalDraftOwner() + ':' + code;
        var pendingValue = JSON.stringify([note.trim(), comment.trim()]);
        var publishUrl = '/api/me/arrival-drafts/' + encodeURIComponent(code) + '/publish';
        function finishPublish() {
          localStorage.removeItem(pendingKey);
          rememberArrivalDraft(code, note, '');
          var p = (H.peaks || []).filter(function (x) { return x.code === code; })[0];
          if (p) { p.commentsReady = false; hydratePeakCommunity(p); }
          U.closeSheet(); U.toast('已署名发布'); render();
        }
        function publish() {
          localStorage.setItem(pendingKey, pendingValue);
          return arrivalRequest(publishUrl, 'POST').then(finishPublish);
        }
        function save() {
          return arrivalRequest(guest ? '/api/guest/arrival-draft' : '/api/me/arrival-drafts',
            guest ? 'POST' : 'PUT', { code: code, privateNote: note, publicCommentDraft: comment }, guest)
            .then(function () {
            if (act === 'arrival-draft-save') {
              if (pendingKey) localStorage.removeItem(pendingKey);
              errorEl.textContent = guest ? '草稿已同步；注册后会并入账号。' : '草稿已同步到账号。';
              return;
            }
            if (guest) { sheetSignup('comment'); return; }
            return publish();
          });
        }
        if (act === 'arrival-draft-publish' && !guest &&
            localStorage.getItem(pendingKey) === pendingValue) {
          return arrivalRequest(publishUrl, 'POST').then(finishPublish)
            .catch(function (e) { if (e.status === 404) return save(); throw e; });
        }
        return save();
      }).catch(function (e) {
        if (errorEl && errorEl.isConnected) errorEl.textContent =
          (e instanceof TypeError || e.name === 'AbortError' || /身份不可用/.test(e.message))
            ? '网络未连通，草稿已保存在本机；联网后可重试。' : e.message;
      })
        .then(function () { t.disabled = false; });
      return;
    }
    if (act === 'arrival-auth') {
      var username = (document.getElementById('arrivalUser') || {}).value || '';
      var password = (document.getElementById('arrivalPassword') || {}).value || '';
      var email = (document.getElementById('arrivalEmail') || {}).value || '';
      var authError = document.getElementById('arrivalAuthError');
      var authMode = t.getAttribute('data-mode') === 'register' ? 'register' : 'login';
      if (!username.trim() || !password) { authError.textContent = '请填写用户名和密码。'; return; }
      if (authMode === 'register' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        authError.textContent = '注册需要填写有效邮箱。'; return;
      }
      t.disabled = true;
      var oldGuestToken = null;
      try { oldGuestToken = localStorage.getItem('hikes.guest.token'); } catch (e) { /* ignore */ }
      requestAuth(authMode, username.trim(), password, '', email.trim())
      .then(function (data) {
        if (authMode === 'register' && data.status === 'verification_sent') {
          authError.textContent = '验证邮件已发送，请打开邮件中的链接完成注册。你的游客记录仍保存在本设备。';
          t.disabled = true;
          return null;
        }
        return commitAuthSession(data, authMode, oldGuestToken, username.trim(), '');
      }).then(function (result) {
        if (!result) return;
        U.closeSheet();
        U.toast(result.draftSyncFailed ? '已登录；草稿保存在本机，联网后可重试' :
          '已登录，到访与草稿已保存');
        render();
        if (_collaborationAfterAuth) {
          var code = _collaborationAfterAuth;
          _collaborationAfterAuth = null;
          var button = document.querySelector('[data-act="collaboration-open"][data-code="' + code + '"]');
          if (button) button.click();
        }
      }).catch(function (e) {
        if (authError && authError.isConnected) authError.textContent =
          e.name === 'AbortError' ? '网络未确认结果。新账号可尝试登录；到访和草稿仍在本机。' : e.message;
      })
        .then(function () { t.disabled = false; });
      return;
    }
    /* 留言 / 起称呼 / 存记录：都要注册，统一走注册引导 */
    if (act === 'signup') { sheetSignup(t.getAttribute('data-why')); return; }
    if (act === 'submit-checkin') {
      var place = placeOf(type, id);
      var name = (document.getElementById('ckName') || {}).value || H.me.name;
      var timeEl = document.getElementById('ckTime');
      var time = timeEl ? timeEl.value.trim() : '';
      var tags = U.$$('#ckTags button.on').map(function (b) { return b.getAttribute('data-val'); });
      if (!tags.length) tags = ['第一次来'];
      var already = !!S.mySeqs[id];
      var seq = (place.seq || place.visits || 100) + (already ? 1 : 0);
      S.mySeqs[id] = (S.mySeqs[id] || 0) + 1;
      var wasWant = S.want.indexOf(id);
      if (wasWant >= 0) { S.want.splice(wasWant, 1); U.toast('已从「想去」移到「去过」'); }
      var visit = { id: id, type: type, name: place.name, seq: seq, when: '刚刚', time: time, tags: tags };
      S.visited = S.visited.filter(function (v) { return v.id !== id; });
      S.visited.unshift(visit);
      if (type === 'peak' && time && (!S.pb[id] || time < S.pb[id])) S.pb[id] = time;
      persist();
      sheetVisitDone(type, id, visit);
      return;
    }
    if (act === 'tag') { t.classList.toggle('on'); return; }
    /* 我要成为山大王（用户侧建点位）。
       注意：维护台里的「新建点位」是 admin.js 的 new-point，两回事，别混。 */
    /* 卡片自己在 data-kind 上标了山头还是岔路（我的山头页那颗按钮没标，按山头算） */
    if (act === 'king-new') {
      newPointSheet(t.getAttribute('data-kind') || 'peak');
      return;
    }
    if (act === 'new-point-submit') {
      newPointSend(t.getAttribute('data-kind') || 'peak', t);
      return;
    }
    if (act === 'close') { U.closeSheet(); render(); return; }
    /* 页面卡在旧代码上时的自救按钮（见 hotBoard 的空态） */
    if (act === 'reload') { location.reload(); return; }
    /* 首页功能入口：卡片链接使用原生 hash 导航，不走地点卡片事件。 */
    if (act === 'find-trail-list') {
      var search = document.getElementById('q');
      if (search) { search.scrollIntoView({ behavior: 'smooth', block: 'center' }); search.focus({ preventScroll: true }); }
      return;
    }
    if (act === 'goto-trail') { U.go('#/trails/' + id); return; }
    /* 消息页：维护人打开留言板管理 / 隐藏留言 / 提醒全部已读 */
    if (act === 'summit-board') { sheetSummitBoard(id); return; }
    /* 广告：维护人开面板 / 提交（提交后进待审队列） */
    if (act === 'ad-panel') { sheetAdPanel(t.getAttribute('data-code')); return; }
    if (act === 'ad-edit') {
      var existingAd = adPanelItems.filter(function (a) { return String(a.id) === t.getAttribute('data-id'); })[0];
      if (!existingAd) return;
      document.getElementById('adEditId').value = existingAd.id;
      document.getElementById('adTitle').value = existingAd.title || '';
      document.getElementById('adBody').value = existingAd.body || '';
      document.getElementById('adLink').value = existingAd.link || '';
      document.getElementById('adDays').value = existingAd.durationDays || 30;
      document.getElementById('adTitle').focus();
      return;
    }
    if (act === 'ad-submit' || act === 'ad-save-draft') {
      var acode = t.getAttribute('data-code');
      var editId = (document.getElementById('adEditId') || {}).value || '';
      var payload = {
        title: ((document.getElementById('adTitle') || {}).value || '').trim(),
        body: ((document.getElementById('adBody') || {}).value || '').trim() || null,
        link: ((document.getElementById('adLink') || {}).value || '').trim() || null,
        days: Number((document.getElementById('adDays') || {}).value) || 30
      };
      var adBase = '/api/points/' + encodeURIComponent(acode) + '/ads';
      t.disabled = true;
      var saveAd = editId
        ? window.API.ja(adBase + '/' + editId, { method: 'PATCH', body: JSON.stringify(payload) })
        : window.API.ja(adBase + (act === 'ad-save-draft' ? '/drafts' : ''),
          { method: 'POST', body: JSON.stringify(payload) });
      saveAd.then(function (saved) {
        if (act === 'ad-submit' && editId) {
          return window.API.ja(adBase + '/' + saved.id + '/submit', { method: 'POST' });
        }
        return saved;
      }).then(function () {
          U.toast(act === 'ad-save-draft' ? '草稿已保存' : '已提交，等系统审核'); sheetAdPanel(acode);
        })
        .catch(function (e) {
          U.toast(/403/.test(e.message) ? '只有这座山的维护人可以提交' : '提交失败，稍后再试');
        }).then(function () { t.disabled = false; });
      return;
    }
    if (act === 'hide-comment') {
      var pid = t.getAttribute('data-pid');
      var reason = prompt('隐藏理由（至少 8 字）');
      if (reason === null) return;
      if (reason.trim().length < 8) { U.toast('请填写至少 8 字理由'); return; }
      window.API.ja('/api/comments/' + id + '/hide', { method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }) })
        .then(function () { U.toast('已隐藏这条留言'); sheetSummitBoard(pid); })
        .catch(function () { U.toast('隐藏失败——只有维护人（或作者本人）能隐藏'); });
      return;
    }
    if (act === 'appeal-open') {
      U.openSheet('<h3>申请复核</h3><div class="sh-sub">说明这条留言为什么应恢复；原文只对你和平台审核员可见。</div>' +
        '<div class="field"><label>申诉理由</label><textarea id="appealReason" maxlength="500"></textarea></div>' +
        '<button class="btn coral" data-act="appeal-submit" data-id="' + id + '">提交申诉</button>' +
        '<button class="btn ghost" style="margin-top:9px" data-act="close">再想想</button>');
      return;
    }
    if (act === 'appeal-submit') {
      var appealReason = ((document.getElementById('appealReason') || {}).value || '').trim();
      if (appealReason.length < 8) { U.toast('请至少写 8 字申诉理由'); return; }
      t.disabled = true;
      window.API.ja('/api/comments/' + id + '/appeals', { method: 'POST',
        body: JSON.stringify({ reason: appealReason }) })
        .then(function () { return window.API.ja('/api/me/hidden-comments'); })
        .then(function (items) {
          H.hiddenComments = items; _hiddenCommentsLoaded = true;
          U.closeSheet(); render(); U.toast('申诉已提交，等待平台复核');
        }).catch(function () { U.toast('提交失败，理由仍在，请重试'); t.disabled = false; });
      return;
    }
    if (act === 'notif-seen') {
      window.API.ja('/api/me/notifications/seen', { method: 'POST' }).then(function () {
        return Promise.all([
          window.API.ja('/api/me/summits').catch(function () { return []; }),
          window.API.ja('/api/me/follows').catch(function () { return []; }),
          window.API.ja('/api/me/notifications').catch(function () { return []; })
        ]);
      }).then(function (r) {
        H.mySummits = r[0] || []; H.followPeaks = r[1] || []; H.notif = r[2] || [];
        U.toast('已标记为已读'); render();
      }).catch(function () { U.toast('标记失败，稍后再试'); });
      return;
    }
    if (act === 'hot-all') { sheetHotAll(); return; }
    if (act === 'records-all') { sheetRecords(); return; }
    if (act === 'summit-cell') { sheetSummitCell(t.getAttribute('data-code')); return; }
    if (act === 'pick-track') {
      var fi = document.getElementById('trkFile');
      if (fi) {
        fi.onchange = function () { uploadTrack(this.files && this.files[0]); };
        fi.click();
      } else { U.toast('先点开「我」→ 山径拼图'); }
      return;
    }
    if (act === 'track-peak') {
      var tid = +t.getAttribute('data-track'), ti = +t.getAttribute('data-i');
      var tr = (H.myTracks || []).filter(function (x) { return x.id === tid; })[0];
      var pk = tr && tr.peaks[ti];
      if (!pk) return;
      U.openSheet('<h3>' + esc(tr.name) + ' · 顶' + (ti + 1) + '</h3>' +
        '<div class="sh-sub">我们自己算出来的山顶，还没有名字</div>' +
        '<div class="card" style="box-shadow:none;background:var(--blue-bg);padding:14px;line-height:1.8">' +
        '海拔 <b>' + pk.ele + ' m</b><br>坐标 ' + pk.lat + ', ' + pk.lng + '<br>' +
        '相对高度 <b>' + pk.rel + ' m</b> · 距起点 ' + pk.km + ' km</div>' +
        '<div class="note" style="margin-top:12px;line-height:1.8">' +
        '它是**候选**，不是打卡。传轨迹只说明你走过这条线；' +
        '要让它变成真的，得有人到现场扫码——扫一次点亮，山脚和山顶都扫了才有登顶用时。</div>' +
        '<button class="btn ghost" style="margin-top:12px" data-act="close">知道了</button>');
      return;
    }
    /* 成为版主：不新建点位，去认领一个已经立好的山头 / 岔路，把它的留言板管起来 */
    if (act === 'become-master') {
      if (document.getElementById('npName')) {
        newPointDraft = {};
        ['Name', 'Intro', 'Area', 'Alt', 'Nick', 'Contact'].forEach(function (key) {
          newPointDraft[key] = document.getElementById('np' + key).value;
        });
        newPointDraft.kind = npKind;
      }
      sheetBecomeMaster(); return;
    }
    if (act === 'master-new-point') {
      newPointSheet(newPointDraft ? newPointDraft.kind : 'peak', !!newPointDraft); return;
    }
    if (act === 'new-point-resume') { newPointSheet(newPointDraft.kind, true); return; }
    if (act === 'master-application-status') {
      U.closeSheet(); U.go('#/me/applications'); render(); return;
    }
    if (act === 'share') { U.toast('已生成分享图（演示）'); U.closeSheet(); render(); return; }
    if (act === 'doc') { sheetDoc(); return; }
    if (act === 'intel-up') {
      S.intelUp[id] = !S.intelUp[id];
      persist(); render();
      U.toast(S.intelUp[id] ? '已确认这条情报' : '已取消确认');
      return;
    }
    if (act === 'intel-open') { sheetIntel(id); return; }
    if (act === 'submit-intel') {
      var title = (document.getElementById('inTitle') || {}).value || '';
      var text = (document.getElementById('inText') || {}).value || '';
      if (!title.trim()) { U.toast('先写一句情报'); return; }
      S.myIntel.unshift({ id: 'my' + Date.now(), jid: id, title: title.trim(), text: text.trim() || '—' });
      persist(); U.closeSheet(); render(); U.toast('已提交，等 3 个人确认');
      return;
    }
    if (act === 'comment-open') { sheetComment(type, id); return; }
    if (act === 'submit-comment') {
      var txt = (document.getElementById('cmText') || {}).value || '';
      if (!txt.trim()) { U.toast('先写点什么'); return; }
      S.myComments[id] = (S.myComments[id] || []).concat([{ when: '刚刚', text: txt.trim() }]);
      persist(); U.closeSheet(); render(); U.toast('已发布到留言板');
      return;
    }
    if (act === 'private-letter-retry') { privateLetters = null; loadPrivateLetters(); return; }
    if (act === 'leaderboard-settings') {
      window.API.ja('/api/me/leaderboard-settings').then(function (settings) {
        U.openSheet('<h3>上榜设置</h3><p>开启后，符合条件的成绩会显示昵称、日期与用时。</p>' +
          '<button class="btn coral" data-act="leaderboard-toggle" data-enabled="' +
          (settings.enabled ? 'false' : 'true') + '">' +
          (settings.enabled ? '退出公开用时榜' : '加入公开用时榜') + '</button>');
      }).catch(function () { U.toast('请先登录账号，再设置上榜'); });
      return;
    }
    if (act === 'leaderboard-toggle') {
      window.API.ja('/api/me/leaderboard-settings', { method: 'PATCH',
        body: JSON.stringify({ enabled: t.getAttribute('data-enabled') === 'true' }) })
        .then(function () { peakBoards = {}; U.closeSheet(); U.toast('上榜设置已保存'); })
        .catch(function () { U.toast('保存失败，请重试'); });
      return;
    }
    if (act === 'private-letter-new') {
      var options = H.peaks.filter(function (p) { return p.pointId && p.code; }).map(function (p) {
        return '<option value="' + p.pointId + '">' + esc(p.name || p.code) + '</option>';
      }).join('');
      U.openSheet('<h3>写给未来的自己</h3>' +
        '<div class="field"><label>想说的话</label><textarea id="privateLetterText" maxlength="2000"></textarea></div>' +
        '<div class="field"><label>解锁方式</label><select id="privateLetterMode">' +
        '<option value="date">到期解锁</option><option value="checkin">现场打卡解锁</option>' +
        '<option value="open">随时可看</option></select></div>' +
        '<div class="field"><label>到期年限（仅到期解锁）</label><select id="privateLetterYears">' +
        '<option value="5">5 年</option><option value="3">3 年</option><option value="1">1 年</option></select></div>' +
        '<div class="field"><label>目标地点（仅打卡解锁）</label><select id="privateLetterPoint">' + options + '</select></div>' +
        '<button class="btn coral" data-act="private-letter-save">封存这封信</button>');
      return;
    }
    if (act === 'private-letter-save') {
      var letterText = (document.getElementById('privateLetterText') || {}).value || '';
      var mode = (document.getElementById('privateLetterMode') || {}).value;
      var point = (document.getElementById('privateLetterPoint') || {}).value;
      if (!letterText.trim() || (mode === 'checkin' && !point)) {
        U.toast('请填写内容；打卡解锁还需选择目标点位'); return;
      }
      t.disabled = true;
      window.API.ja('/api/me/letters', { method: 'POST', body: JSON.stringify({
        text: letterText.trim(), mode: mode,
        years: mode === 'date' ? Number(document.getElementById('privateLetterYears').value) : null,
        pointId: mode === 'checkin' ? Number(point) : null
      }) }).then(function () { privateLetters = null; U.closeSheet(); loadPrivateLetters(); })
        .catch(function () { U.toast('保存失败，请登录后重试'); })
        .then(function () { t.disabled = false; });
      return;
    }
    if (act === 'private-letter-delete') {
      window.API.ja('/api/me/letters/' + id, { method: 'DELETE' })
        .then(function () { privateLetters = null; loadPrivateLetters(); })
        .catch(function () { U.toast('删除失败，请重试'); });
      return;
    }
    if (act === 'letter-open') { sheetReadLetter(id); return; }
    if (act === 'letter-write') { sheetLetter(id); return; }
    if (act === 'submit-letter') {
      var lt = (document.getElementById('ltText') || {}).value || '';
      var ld = (document.getElementById('ltDate') || {}).value || '';
      if (!lt.trim()) { U.toast('先写一句'); return; }
      var pk = peak(id);
      S.letters.unshift({ text: lt.trim(), date: ld || '明年今天', place: pk ? pk.name : '青山顶' });
      persist(); U.closeSheet(); render(); U.toast('已封存 · 到期会提醒你');
      return;
    }
    if (act === 'photo-ask') { U.toast('已发出合影请求 · 现场 30 分钟有效'); return; }
    if (act === 'walk-ask') { U.toast('已发出同行邀请'); return; }
    if (act === 'friend') {
      S.friends[id] = val; persist(); render();
      U.toast(val === 'acc' ? '已接受' : '已忽略');
      return;
    }
    if (act === 'seg') { seg = val; pf = 'all'; pq = ''; pages.peaks = pages.peakHot = pages.junctions = 0; render(); return; }
    if (act === 'board-vote') {
      t.disabled = true;
      window.API.ja('/api/comments/' + id + '/vote', {method:'POST', body:JSON.stringify({value:boardVotes[id] === val ? null : val})}).then(function (c) {
        boardVotes[id] = boardVotes[id] === val ? null : val;
        H.peaks.forEach(function (p) { (p.boardComments || []).forEach(function (item) { if (String(item.id) === id) { item.claps = c.like_count; item.bad = c.bad_count; } }); }); render();
      }).catch(function () { t.disabled = false; U.toast('操作失败，请确认已登录后重试'); }); return;
    }
    if (act === 'board-replies') {
      boardOpen[id] = !boardOpen[id]; render();
      if (boardOpen[id]) window.API.ja('/api/comments/' + id + '/replies').then(function (rows) { boardReplies[id] = rows; render(); }).catch(function () { U.toast('回复加载失败，请重试'); }); return;
    }
    if (act === 'board-reply-send') {
      var replyText = document.getElementById('reply-' + id).value.trim();
      if (!replyText) { U.toast('先写一句回复'); return; } t.disabled = true;
      window.API.ja('/api/comments/' + id + '/replies', {method:'POST',body:JSON.stringify({text:replyText})})
        .then(function () { return window.API.ja('/api/comments/' + id + '/replies'); })
        .then(function (rows) { boardReplies[id] = rows; render(); U.toast('回复已发送'); })
        .catch(function () { t.disabled = false; U.toast('发送失败，请确认已登录后重试'); }); return;
    }
    if (act === 'board-follow') { boardFollow = val || 'all'; render(); return; }
    if (act === 'board-sort') return;
    if (act === 'cover-open') {
      var coverSlug = t.getAttribute('data-id');
      U.openSheet('<h3>投稿真实封面</h3><div class="sh-sub">通过审核后才会显示在路书顶部；不会直接替换官方封面。</div>' +
        '<div class="field"><label>照片</label><input id="coverFile" type="file" accept="image/jpeg,image/png,image/webp"></div>' +
        '<div class="field"><label>拍摄者署名</label><input id="coverBy" maxlength="80" value="' + esc(H.me.name) + '"></div>' +
        '<div class="field"><label>拍摄时间 · 选填</label><input id="coverShot" type="date"></div>' +
        '<div class="field"><label>说明 · 选填</label><input id="coverCaption" maxlength="300" placeholder="例如：从南坡林道回望主峰"></div>' +
        '<label class="hint" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px">' +
        '<input id="coverLicense" type="checkbox" style="width:auto;margin-top:3px">' +
        '<span>我确认拥有这张照片的使用权，同意平台在路书页展示并保留署名。</span></label>' +
        '<div class="hint" id="coverError" style="color:#a13b30"></div>' +
        '<button class="btn coral" data-act="cover-submit" data-id="' + esc(coverSlug) + '">提交审核</button>' +
        '<button class="btn ghost" style="margin-top:9px" data-act="close">取消</button>');
      return;
    }
    if (act === 'cover-submit') {
      var coverSlug2 = t.getAttribute('data-id');
      var coverInput = document.getElementById('coverFile');
      var coverErr = document.getElementById('coverError');
      var coverFile = coverInput && coverInput.files && coverInput.files[0];
      var coverLicense = document.getElementById('coverLicense');
      if (!coverFile) { if (coverErr) coverErr.textContent = '先选择一张 JPEG / PNG / WebP 照片'; return; }
      if (!coverLicense || !coverLicense.checked) { if (coverErr) coverErr.textContent = '请确认照片使用权'; return; }
      var fd = new FormData();
      fd.append('file', coverFile);
      fd.append('photographer', (document.getElementById('coverBy') || {}).value || '');
      fd.append('shotAt', (document.getElementById('coverShot') || {}).value || '');
      fd.append('caption', (document.getElementById('coverCaption') || {}).value || '');
      fd.append('licenseConfirmed', 'true');
      t.disabled = true;
      apiToken().then(function (tk) {
        if (!tk) throw new Error('请先注册或登录');
        return fetch('/api/routes/' + encodeURIComponent(coverSlug2) + '/cover-submissions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + tk }, body: fd
        }).then(function (res) {
          return res.json().then(function (data) {
            if (!res.ok) {
              var info = data && data.detail && data.detail.error;
              throw new Error(info && info.message || '投稿失败');
            }
            return data;
          });
        });
      }).then(function () {
        U.closeSheet(); U.toast('封面投稿已提交，等待平台审核');
      }).catch(function (e) {
        if (coverErr) coverErr.textContent = e.message;
        t.disabled = false;
      });
      return;
    }
    /* 成为版主：不发编号、不发二维码，只接管这个山头的线上留言板 */
    if (act === 'master-claim') {
      var mcCode = t.getAttribute('data-code'), mcName = t.getAttribute('data-name');
      U.openSheet(
        '<h3>申请维护这座山</h3>' +
        '<div class="sh-sub">' + esc(mcName) + ' · ' + esc(mcCode) + '</div>' +
        '<div class="card" style="box-shadow:none;background:var(--blue-bg);padding:14px;' +
        'margin-bottom:14px"><div style="font-size:12.5px;color:#2B3568;line-height:1.75">' +
        '<b>维护人拿的是留言板，不是二维码。</b>二维码是标牌上的事——得实地印、实地贴。' +
        '这份申请会进审核队列，<b>3 天</b>内给答复；通过后你才能核验留言、置顶有用的内容。' +
        '想自己开一座新山、或者立一个岔路口拿二维码，走「成为山大王 / 我是NPC指路人」。' +
        '</div></div>' +
        '<div class="field"><label>申请类型</label>' +
        '<div class="tags-pick" id="msKind">' +
        '<button type="button" data-act="ms-kind" data-val="solo" class="on">山大王 · 单人独占</button>' +
        '<button type="button" data-act="ms-kind" data-val="clan">山寨 · 多人协作</button>' +
        '</div><div class="hint">山大王独占这座山；山寨允许多人一起维护，通过后协作入口保持开放。</div></div>' +
        '<div class="field"><label>为什么申请这座山 · 至少 20 字</label>' +
        '<textarea id="msReason" maxlength="1000" placeholder="例如：这条线我走了三年，雨季哪几段会塌、哪里能补水都清楚，想整理出来给后来的人。" style="min-height:92px"></textarea>' +
        '<div class="hint" id="msReasonHint">0 / 20 字</div></div>' +
        '<div class="field"><label>一个月大概能去几次</label>' +
        '<div class="tags-pick" id="msVisits">' +
        [['1', '1–2 次'], ['4', '3–5 次'], ['8', '6–10 次'], ['12', '10 次以上']].map(function (v, i) {
          return '<button type="button" data-act="ms-visits" data-val="' + v[0] + '"' +
            (i === 1 ? ' class="on"' : '') + '>' + v[1] + '</button>';
        }).join('') + '</div></div>' +
        '<div class="field"><label>成为维护人之后的期待 · 至少 10 字</label>' +
        '<textarea id="msExpect" maxlength="1000" placeholder="例如：把岔路口的指路牌补齐，冬天封路时第一时间标注。" style="min-height:72px"></textarea>' +
        '<div class="hint" id="msExpectHint">0 / 10 字</div></div>' +
        '<div class="hint" id="msApplyError" style="color:#c62828"></div>' +
        '<button class="btn coral" data-act="master-submit" data-code="' + esc(mcCode) +
        '" data-name="' + esc(mcName) + '">提交申请（3 天审核期）</button>' +
        '<button class="btn ghost" style="margin-top:9px" data-act="close">再想想</button>');
      masterKind = 'solo';
      return;
    }
    if (act === 'ms-kind') {
      masterKind = val;
      Array.prototype.forEach.call(t.parentNode.children, function (b) {
        b.className = b === t ? 'on' : '';
      });
      /* 山顶已经有人独占时，界面先把话说明白：只能申请协作 */
      var hint = document.getElementById('msApplyNote');
      if (hint) hint.textContent = val === 'clan' ? '山寨：多人一起维护，通过后协作入口保持开放。' : '';
      return;
    }
    if (act === 'ms-visits') {
      masterVisits = Number(val);
      Array.prototype.forEach.call(t.parentNode.children, function (b) {
        b.className = b === t ? 'on' : '';
      });
      return;
    }
    if (act === 'collaboration-open') {
      var cc = t.getAttribute('data-code');
      apiToken().then(function (tk) {
        if (!tk) { _collaborationAfterAuth = cc; sheetSignup('collaboration'); return; }
        return Promise.all([
          fetch('/api/points/' + encodeURIComponent(cc)).then(function (r) { return r.json(); }),
          window.API.ja('/api/me/collaboration-applications')
        ]).then(function (res) {
          var point = res[0], apps = res[1], boardId = point.boardId;
          if (!boardId) { U.toast('这块留言板暂不能申请协作'); return; }
          var mine = apps.filter(function (a) { return a.boardId === boardId; })[0];
          var current = H.peaks.filter(function (p) { return p.code === cc; })[0];
          if (current) { current.collaborationStatus = mine && mine.status; render(); }
          if (mine && mine.status === 'pending') {
            U.openSheet('<h3>协作申请审核中</h3><div class="sh-sub">平台核实后会更新状态。</div>' +
              '<button class="btn ghost" data-act="close">知道了</button>');
            return;
          }
          U.openSheet('<h3>申请维护协作</h3><div class="sh-sub">只申请这块山顶留言板；审核通过后可处理本板留言，不含广告权限。</div>' +
            (mine && mine.reviewNote ? '<div class="hint">上次反馈：' + esc(mine.reviewNote) + '</div>' : '') +
            '<div class="field"><label>熟悉的路况与能承担的维护工作</label>' +
            '<textarea id="collaborationMessage" maxlength="500"></textarea></div>' +
            '<button class="btn coral" data-act="collaboration-submit" data-board="' + boardId + '" data-code="' + esc(cc) + '">提交申请</button>' +
            '<button class="btn ghost" style="margin-top:9px" data-act="close">再想想</button>');
        });
      }).catch(function () { U.toast('申请状态读取失败，请稍后重试'); });
      return;
    }
    if (act === 'collaboration-submit') {
      var message = ((document.getElementById('collaborationMessage') || {}).value || '').trim();
      if (message.length < 8) { U.toast('请至少写 8 个字说明你能做什么'); return; }
      t.disabled = true;
      window.API.ja('/api/boards/' + encodeURIComponent(t.getAttribute('data-board')) + '/collaboration-applications', {
        method: 'POST', body: JSON.stringify({ message: message })
      }).then(function () {
        var cc = t.getAttribute('data-code');
        var current = H.peaks.filter(function (p) { return p.code === cc; })[0];
        if (current) current.collaborationStatus = 'pending';
        U.closeSheet(); render(); U.toast('申请已提交，等待平台审核');
      }).catch(function () { U.toast('提交失败，文字仍在，请重试'); t.disabled = false; });
      return;
    }
    if (act === 'master-submit') {
      var apCode = t.getAttribute('data-code'), apName = t.getAttribute('data-name') || apCode;
      var reason = ((document.getElementById('msReason') || {}).value || '').trim();
      var expect = ((document.getElementById('msExpect') || {}).value || '').trim();
      var errorEl = document.getElementById('msApplyError');
      if (reason.length < 20) { errorEl.textContent = '申请理由至少 20 个字（现在 ' + reason.length + ' 个）'; return; }
      if (expect.length < 10) { errorEl.textContent = '成为维护人后的期待至少 10 个字'; return; }
      t.disabled = true; t.textContent = '提交中…';
      window.API.ja('/api/master-applications', { method: 'POST', body: JSON.stringify({
        code: apCode, kind: masterKind, reason: reason, expectations: expect,
        visitsPerMonth: masterVisits
      }) }).then(function (d) {
        myApplications = null;
        U.openSheet('<h3>申请已提交</h3><div class="sh-sub">' + esc(apName) + ' · ' +
          (masterKind === 'clan' ? '山寨（多人协作）' : '山大王（单人独占）') + '</div>' +
          '<div class="card" style="box-shadow:none;background:var(--blue-bg);padding:14px">' +
          '<div style="font-size:12.5px;color:#2B3568;line-height:1.75">' +
          '审核期 <b>3 天</b>：通过后你才能核验留言、置顶有用内容。' +
          (masterKind === 'solo' ? '<br>同一个人只能有一份待审申请；同一座山通过一位山大王后，其它申请会自动收到说明。'
            : '<br>山寨允许多人一起维护，通过后协作入口保持开放。') +
          '<br>3 天内没人处理会自动失效，届时可以重新申请。</div></div>' +
          '<button class="btn coral" data-act="master-application-status">查看我的申请进度</button>');
      }).catch(function (e) {
        if (errorEl && errorEl.isConnected) errorEl.textContent = e.message || '提交失败，请稍后重试';
      }).then(function () { t.disabled = false; t.textContent = '提交申请（3 天审核期）'; });
      return;
    }
    if (act === 'claim') {
      var ck = t.getAttribute('data-key'), cn = t.getAttribute('data-name'),
          ckind = t.getAttribute('data-kind');
      var cjc = ckind === 'junction';
      U.openSheet(
        '<h3>' + (cjc ? '我是NPC指路人' : '占山为王') + '</h3>' +
        '<div class="sh-sub">' + esc(cn) + ' · ' +
        (cjc ? '认领后你就是这个岔路口的 NPC 指路人' : '认领后你成为这个点位的山大王') +
        '</div>' +
        '<div class="note" style="margin-bottom:14px;line-height:1.75">' +
        '认领后立刻拿到一个编号和二维码，<b>自己打印贴出去就能用</b>，不用等官方标牌。<br>' +
        (cjc ? '路过的人扫码就能看到你写的指路情报。<br>' : '') +
        '被扫 <b>40 次</b>（且分布在 7 个以上不同日子、你本人留过言）之后，' +
        '可以申领喷漆和二维码打孔卡。</div>' +
        '<div class="field"><label>你的昵称</label>' +
        '<input id="clNick" type="text" value="' + esc(H.me.name) + '"></div>' +
        '<div class="field"><label>联系方式 · 选填（微信号，用于寄物料）</label>' +
        '<input id="clContact" type="text" placeholder="例如 wx: agan"></div>' +
        '<button class="btn coral" data-act="claim-submit" data-key="' + esc(ck) +
        '" data-name="' + esc(cn) + '" data-kind="' + ckind + '">认领并生成二维码</button>' +
        '<button class="btn ghost" style="margin-top:9px" data-act="close">先不认领</button>');
      return;
    }
    if (act === 'claim-submit') {
      /* 这个局部变量原来叫 kb——和路书页的"距离档"过滤状态 kb 撞名了。
         var 是函数作用域，这个名字会遮蔽整个点击处理函数里的外层 kb，
         于是点「距离」筛选卡时 `kb = val` 其实写进了这个局部变量，
         筛选永远不生效（点上去一点反应都没有）。改名 ckey。 */
      var ckey = t.getAttribute('data-key'), kn = t.getAttribute('data-name'),
          kk = t.getAttribute('data-kind');
      var nick = (document.getElementById('clNick') || {}).value || H.me.name;
      var ct = (document.getElementById('clContact') || {}).value || null;
      t.disabled = true; t.textContent = '生成中…';
      claimSubmit(ckey, kn, kk, nick, ct, t);
      return;
    }
    if (act === 'seg-comments') {
      segComments(t.getAttribute('data-id'), t.getAttribute('data-no'));
      return;
    }
    if (act === 'seg-send') {
      segSend(t.getAttribute('data-id'), t);
      return;
    }
    if (act === 'filter-open') { filterKind = val; filterDraft = currentFilter(val); drawFilterSheet(); return; }
    if (act === 'filter-opt') { filterDraft[t.getAttribute('data-key')] = val; drawFilterSheet(); return; }
    if (act === 'filter-reset') {
      Object.keys(filterDraft).forEach(function (key) { filterDraft[key] = 'all'; });
      drawFilterSheet(); return;
    }
    if (act === 'filter-apply') {
      if (filterKind === 'trails') { kb = filterDraft.kb; ru = filterDraft.ru; rg = filterDraft.rg; }
      else { pf = filterDraft.pf; if (filterKind === 'peaks') { pd = filterDraft.pd; plv = filterDraft.plv; } }
      resetPages(); U.closeSheet(); render(); return;
    }
    if (act === 'page-prev' || act === 'page-next') {
      var dir = act === 'page-next' ? 1 : -1;
      pages[val] = Math.max(0, (pages[val] || 0) + dir);
      if (dir > 0) nextPageClicks++;
      render();
      var pageAnchor = document.getElementById(val === 'trails' ? 'trailResults' : 'page-' + val);
      if (pageAnchor) pageAnchor.scrollIntoView({ block: 'start' });
      if (dir > 0 && nextPageClicks > 3 && !browseSignupShown && !localStorage.getItem('hikes.auth.token')) {
        browseSignupShown = true;
        sheetSignup('browse');
      }
      return;
    }
    if (act === 'clear-filter') {
      q = ''; lv = 'all'; kb = 'all'; rg = 'all'; ru = 'all';
      resetPages(); render(); return;
    }
    if (act === 'meview') { meViewMode = val; render(); return; }
    if (act === 'sim') { U.go(type === 'peak' ? '#/arrive/' + id : '#/junctions/' + id); return; }
    if (act === 'goto-junction') { U.go('#/junctions/' + id); return; }
    if (act === 'sim-code') {
      var code = ((document.getElementById('codeInput') || {}).value || '').trim().toUpperCase();
      var hitJ = H.junctions.filter(function (j) { return j.code.toUpperCase() === code; })[0];
      if (hitJ) { U.go('#/junctions/' + hitJ.id); return; }
      if (code) { U.go('#/arrive/p-' + code); return; }
      U.toast('请输入点位编号');
      return;
    }
    if (act === 'submit-activity') {
      var title = (document.getElementById('actTitle') || {}).value || '';
      var date = (document.getElementById('actDate') || {}).value || '';
      var tm = (document.getElementById('actTime') || {}).value || '';
      var tr = (document.getElementById('actTrail') || {}).value || 'sanfeng';
      var note = (document.getElementById('actNote') || {}).value || '';
      if (!title.trim()) { U.toast('先起个标题'); return; }
      var d = date ? new Date(date) : new Date(Date.now() + 6 * 864e5);
      var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
      var t2 = trail(tr);
      S.myActs.unshift({ id: 'my' + Date.now(), day: String(d.getDate()), week: week, title: title.trim(),
        time: tm.trim() || '集合时间待定', level: t2.level, hours: t2.hours, host: 'me',
        note: note.trim() || '欢迎一起走', joined: 1, capacity: 10, trailId: tr });
      persist(); render(); U.toast('活动已发布 · 会出现在消息页');
      return;
    }
    if (act === 'del-act') {
      S.myActs = S.myActs.filter(function (a) { return a.id !== id; });
      persist(); render(); U.toast('已删除');
      return;
    }
    if (window.EXTRA_ACTIONS && window.EXTRA_ACTIONS[act]) {
      window.EXTRA_ACTIONS[act](t, { id: id, type: type, val: val });
      return;
    }
    if (act === 'reset') {
      ['visited', 'want', 'joined', 'claps', 'myComments', 'myIntel', 'intelUp',
        'letters', 'friends', 'pb', 'mySeqs', 'myActs', 'pointEdits', 'myPoints'].forEach(function (k) {
          try { localStorage.removeItem('hikes.v1.' + k); } catch (e) { }
        });
      U.toast('已恢复初始演示数据'); setTimeout(function () { location.reload(); }, 600);
      return;
    }
  });

  /* 分段留言：弹层里看别人对这一段的说明，也留一句 */
  function segComments(sid, no) {
    U.openSheet(
      '<h3>第 ' + esc(no) + ' 段</h3>' +
      '<div class="sh-sub">走这一段的人留下的话</div>' +
      '<div id="segList" style="min-height:52px"><div class="skel"></div></div>' +
      '<div class="field" style="margin-top:12px"><label>写一句给走这一段的人</label>' +
      '<input id="segTxt" type="text" maxlength="200" placeholder="例如：石阶有青苔，雨后很滑"></div>' +
      '<button class="btn coral" data-act="seg-send" data-id="' + sid + '">发布</button>' +
      '<button class="btn ghost" style="margin-top:9px" data-act="close">关闭</button>');
    loadSeg(sid);
  }
  function loadSeg(sid) {
    fetch('/api/segments/' + sid + '/comments')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var box = document.getElementById('segList');
        if (!box) return;
        box.innerHTML = d.items.length
          ? d.items.map(function (c) {
              return '<div class="comment" style="box-shadow:none;background:#fff;' +
                'border:1px solid var(--line)"><div class="ph">' +
                esc(c.nickname || '山友') + '</div><p>' + esc(c.text) + '</p></div>';
            }).join('')
          : '<div class="note">这一段还没有人留言。你是第一个走到的。</div>';
      })
      .catch(function () {
        var box = document.getElementById('segList');
        if (box) box.innerHTML = '<div class="note">留言加载失败</div>';
      });
  }
  function segSend(sid, btn) {
    var el = document.getElementById('segTxt');
    var txt = el ? el.value.trim() : '';
    if (!txt) { if (el) el.focus(); return; }
    btn.disabled = true;
    apiToken().then(function (tk) {
        if (!tk) throw new Error('请先注册或登录再留言');
        return fetch('/api/segments/' + sid + '/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tk },
          body: JSON.stringify({ text: txt })
        });
      })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) { U.toast('发布失败'); return; }
        if (el) el.value = '';
        loadSeg(sid);
        U.toast('已发布到这一段');
      })
      .catch(function () { btn.disabled = false; U.toast('发布失败'); });
  }

  /* 认领：使用当前账号令牌；未登录时不创建伪造身份。 */
  function claimSubmit(key, name, kind, nick, contact, btn) {
    apiToken().then(function (tk) {
        if (!tk) throw new Error('请先注册或登录，再申请维护');
        return fetch('/api/claims', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json',
                     'Authorization': 'Bearer ' + tk },
          body: JSON.stringify({ target_key: key, target_name: name, kind: kind,
                                 nickname: nick, contact: contact })
        }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); });
      })
      .then(function (x) {
        if (!x.ok) {
          var msg = (x.d.detail && x.d.detail.error && x.d.detail.error.message) || '认领失败';
          if (btn) { btn.disabled = false; btn.textContent = '认领并生成二维码'; }
          U.toast(msg);
          return;
        }
        var c = x.d;
        var cjc = kind === 'junction';
        U.openSheet(
          '<h3>' + (cjc ? '你是这个岔路口的 NPC 指路人了'
                        : '你是这个山头的王了') + '</h3>' +
          '<div class="sh-sub">' + esc(c.target_name) + ' · 编号 <b>' + esc(c.code) + '</b></div>' +
          '<div style="text-align:center;padding:8px 0 4px">' +
          '<img src="' + c.qrUrl + '" alt="二维码" style="width:190px;height:190px;' +
          'border:1px solid var(--line);border-radius:14px;background:#fff;padding:8px"></div>' +
          '<div class="note" style="text-align:center;margin-bottom:14px">' +
          '印出来贴在' + (cjc ? '岔路口' : '山上') +
          '就能用 · 短链 <b>' + esc(c.shortLink) + '</b></div>' +
          '<a class="btn coral" href="' + c.qrUrl + '" download="' + c.code + '.svg">下载二维码</a>' +
          '<div class="card" style="margin-top:14px;background:var(--blue-bg);box-shadow:none">' +
          '<div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0">' +
          '<span style="color:var(--blue-deep)">已被扫码</span><b>' + c.scanCount + ' 次</b></div>' +
          '<div class="progress" style="margin:8px 0 6px"><i style="width:' +
          Math.min(100, c.scanCount / 10 * 100) + '%"></i></div>' +
          '<div class="note" style="color:var(--blue-deep)">' +
          (c.canClaimKit ? '条件已满足，可以申领<b>喷漆和二维码打孔卡</b>了'
                         : '再被扫 ' + c.needForKit + ' 次（当前 ' + c.scanCount +
                           ' 次 / ' + c.scanDays + ' 天）可申领物料') +
          '</div></div>' +
          '<button class="btn ghost" style="margin-top:9px" data-act="close">知道了</button>');
      })
      .catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = '认领并生成二维码'; }
        U.toast('认领失败：' + e.message);
      });
  }

  function repaintWant() {
    U.$$('[data-act="want"]').forEach(function (b) {
      var on = isWant(b.getAttribute('data-id'));
      var onTxt = b.getAttribute('data-on'), offTxt = b.getAttribute('data-off');
      if (onTxt) b.textContent = on ? onTxt : offTxt;
      if (b.classList.contains('favbtn')) b.style.color = 'var(--coral)';
      else if (b.classList.contains('wanticon')) b.style.color = on ? 'var(--coral)' : '#C9C3B4';
      b.classList.toggle('on', on);
    });
  }

  U.$('#mask').addEventListener('click', function (e) {
    if (e.target.id === 'mask' || e.target.closest('[data-act="close-mask"]')) U.closeSheet();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') U.closeSheet(); });

  /* 等后端数据灌进 HIKES 之后再渲染（见 js/api.js） */
  function boot() {
    var ready = (window.API && window.API.ready) ? window.API.ready : Promise.resolve();
    var account = (window.API && window.API.loadAccount) ? window.API.loadAccount() : Promise.resolve(null);
    Promise.all([ready, account]).then(function () {
      syncMeIdentity(window.API && window.API.account);
      if (window.API && window.API.error) {
        /* 首页只依赖"我的摘要/凭证/待同步"这三块（各自独立加载），
           线路/热榜/社区请求挂了不该让首页变成一张错误页——先渲染首页，
           把重试入口放在顶部提示里（计划 T6：某块失败不让首页白屏）。 */
        if (parse().name === 'home' || parse().name === 'auth' || parse().name === 'me') {
          render();
          if (parse().name === 'home') {
            U.toast('线路数据暂时没加载出来，首页可以照常用；稍后重试即可');
          }
          return;
        }
        document.getElementById('view').innerHTML =
          '<div class="empty"><span class="big">⛰</span>点位暂时没有加载出来<br>' +
          '<button class="btn coral" data-act="retry-boot" style="margin-top:16px">重试</button></div>';
        return;
      }
      render();
    });
  }
  window.addEventListener('hashchange', render);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();

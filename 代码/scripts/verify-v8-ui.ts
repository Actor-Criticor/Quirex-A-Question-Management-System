/**
 * verify-v8-ui.ts — 真实浏览器验证 v8 那批改动
 *
 * 这一轮里最要紧的一条是**返回上一页**（上一轮只做了 router.back()，
 * 但页签/筛选/页码都在组件 state 里，所以回到的仍是默认视图）。这里用
 * 「在整卷第 2 页点进详情 → 返回 → URL 与列表都回到整卷第 2 页」来钉死它。
 *
 * 其余：侧栏位置（与搜索框平齐 / 左右留白相等 / 居中不受影响）、
 * 顶部那行统计已删除、整卷卡片没有占位符、整卷详情没有 PDF 阅读器、
 * 试题篮只剩一个导出按钮、弹窗标题预填时间戳、录入页文案与校验。
 *
 * 运行：先 npm run dev，再 npx tsx scripts/verify-v8-ui.ts
 */

import { Chrome } from './cdp';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';
const CDP_PORT = 9355;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    const line = detail ? `${name} — ${detail}` : name;
    failures.push(line);
    console.log(`  ✗ ${line}`);
  }
}

function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: res.status, data: { raw: text } };
  }
}

async function main(): Promise<void> {
  const chrome = new Chrome();
  const draftBefore = ((await api('GET', '/api/baskets')).data.draft ?? {}) as Record<string, unknown>;
  const beforeQids = (draftBefore.qids ?? []) as string[];

  const clickUntil = async (btnText: string, cond: string, tries = 12): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      await chrome.eval(
        `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(btnText)});
           if (b) b.click(); })()`
      );
      await new Promise((r) => setTimeout(r, 400));
      if (await chrome.eval<boolean>(cond)) return true;
    }
    return false;
  };

  /**
   * 点「返回上一页」。
   * 要先等按钮出现 —— 详情页在加载数据时渲染的是「载入中…」，那时候页面上没有返回按钮
   * （第一版就是没等，直接 `find(...).click()` 抛了 Uncaught，白跑一轮）。
   */
  const clickBack = async (): Promise<void> => {
    await chrome.waitFor<boolean>(
      `!![...document.querySelectorAll('button')].find(b => b.textContent.includes('返回上一页'))`,
      20000,
      '详情页返回按钮出现'
    );
    await chrome.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('返回上一页')).click()`
    );
  };

  try {
    await chrome.start(CDP_PORT);
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await api('POST', '/api/baskets', { action: 'clear' });

    // ============================================================
    section('#1 顶部那一行试题篮统计：删了');
    // ============================================================
    await chrome.goto(`${BASE}/`);
    await chrome.waitFor<boolean>(`document.querySelectorAll('article').length > 0`, 25000, '浏览页');
    const hasInline = await chrome.eval<boolean>(
      `(() => { const el = document.querySelector('[class*=basketInline]'); return !!el; })()`
    );
    check('★ 页面上已经没有那一行紧凑统计（basketInline 不存在）', !hasInline);
    check(
      '正文里也搜不到「试题篮 N 道」那种行',
      !/试题篮 \d+ 道/.test(await chrome.eval<string>(`document.body.innerText`)),
      (await chrome.eval<string>(`document.body.innerText`)).slice(0, 160)
    );

    // ============================================================
    section('#2 侧栏：与搜索框平齐 + 左右留白相等 + 不影响居中');
    // ============================================================
    const geom = await chrome.eval<{
      rail: { x: number; y: number; w: number };
      search: { y: number };
      cardCenter: number;
      contentCenter: number;
      colRight: number;
      clientWidth: number;
    } | null>(
      `(() => {
        const rail = document.querySelector('[class*=basketRail]');
        const search = document.querySelector('input[type=search], input[type=text]');
        const a = document.querySelector('article');
        if (!rail || !a) return null;
        const r = rail.getBoundingClientRect();
        const s = search ? search.getBoundingClientRect() : { y: r.y };
        const c = a.getBoundingClientRect();
        return { rail: { x: r.x, y: r.y, w: r.width }, search: { y: s.y },
                 cardCenter: Math.round(c.x + c.width / 2),
                 contentCenter: Math.round(document.documentElement.clientWidth / 2),
                 colRight: Math.round(c.right),
                 clientWidth: document.documentElement.clientWidth };
      })()`
    );
    check('侧栏与搜索框都拿到了（能测）', !!geom, JSON.stringify(geom));
    if (geom) {
      check(
        `侧栏顶部与搜索框平齐（差 ${Math.abs(Math.round(geom.rail.y - geom.search.y))}px）`,
        Math.abs(geom.rail.y - geom.search.y) <= 14,
        `rail.y=${Math.round(geom.rail.y)} search.y=${Math.round(geom.search.y)}`
      );
      // 「左右留白相等」= 题目列右边缘到侧栏左边的距离，与侧栏右边到内容区右边缘的距离
      const leftGap = Math.round(geom.rail.x - geom.colRight);
      const rightGap = Math.round(geom.clientWidth - (geom.rail.x + geom.rail.w));
      check(
        `★ 侧栏左右留白相等（左 ${leftGap} / 右 ${rightGap}）`,
        Math.abs(leftGap - rightGap) <= 6,
        `左=${leftGap} 右=${rightGap}`
      );
      check(
        `★ 题目列仍然居中（卡片中心 ${geom.cardCenter} / 内容区中心 ${geom.contentCenter}）`,
        Math.abs(geom.cardCenter - geom.contentCenter) <= 2
      );
    }
    // 藏掉侧栏再量一次：中心不变才说明它没参与排版
    const centerNoRail = await chrome.eval<number>(
      `(() => { const el = document.querySelector('[class*=basketRail]'); if (el) el.style.display='none';
         const a = document.querySelector('article'); const r = a.getBoundingClientRect();
         const v = Math.round(r.x + r.width/2);
         if (el) el.style.display=''; return v; })()`
    );
    check('★ 藏掉侧栏后卡片中心不变（它不占主列空间）', centerNoRail === geom?.cardCenter, `${centerNoRail} vs ${geom?.cardCenter}`);

    // ============================================================
    section('#3 整卷卡片：连占位符都没有');
    // ============================================================
    const onPaperTab = await clickUntil(
      '整卷',
      `document.querySelectorAll('article').length > 0 && document.querySelectorAll('article input[type=checkbox]').length === 0`
    );
    check('切到整卷页签', onPaperTab);
    const cardHead = await chrome.eval<string[]>(
      `(() => { const a = document.querySelector('article');
         const head = a.querySelector('div');
         return [...head.children].map(c => c.tagName + ':' + c.textContent.trim().slice(0, 8)); })()`
    );
    check(
      '★ 卡片头部第一个元素就是 qid（没有复选框、也没有 ▤ 占位符）',
      /^(SPAN|A):/.test(cardHead[0] ?? '') && !cardHead.some((h) => h.includes('▤')),
      JSON.stringify(cardHead)
    );
    check(
      '★ 整卷卡片里没有 input[type=checkbox]',
      (await chrome.eval<number>(`document.querySelectorAll('article input[type=checkbox]').length`)) === 0
    );

    // ============================================================
    section('#4 ★★ 返回上一页：整卷第 2 页 → 详情 → 返回 = 回到整卷第 2 页');
    // ============================================================
    // 先确认整卷确实有两页
    const papers = ((await api('GET', '/api/questions/search?kind=整卷&status=全部&size=200')).data
      .items ?? []) as Array<{ qid: string }>;
    check(`整卷有 ${papers.length} 份（>10 → 有第 2 页）`, papers.length > 10);

    // 翻到第 2 页。
    // 注意正则要**容忍空白**：分页条的 `.info` 是 flex 容器，里面的 <b> 数字被块级化，
    // 于是 innerText 会渲染成「第\n1\n/ 2 页」——视觉上是一行，但字符串里有换行。
    // 一开始我按「第 1 / 2 页」去匹配，结果永远匹配不上，白折腾了一轮。
    const PAGE_RE = `/第\\s*(\\d+)\\s*\\/\\s*(\\d+)\\s*页/`;
    const paged = await (async () => {
      for (let i = 0; i < 12; i++) {
        await chrome.eval(
          `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('下一页')); if (b && !b.disabled) b.click(); })()`
        );
        await new Promise((r) => setTimeout(r, 600));
        const p = await chrome.eval<string>(`document.body.innerText.match(${PAGE_RE})?.[1] ?? ''`);
        if (p === '2') return true;
      }
      return false;
    })();
    check('翻到整卷第 2 页', paged);
    const urlBefore = await chrome.eval<string>(`location.pathname + location.search`);
    check(
      `★ URL 记下了页签与页码：${urlBefore}`,
      /kind=%E6%95%B4%E5%8D%B7|kind=整卷/.test(urlBefore) && /page=2/.test(urlBefore),
      urlBefore
    );
    const firstQidBefore = await chrome.eval<string>(
      `document.querySelector('article .ma-mono')?.textContent?.trim() ?? ''`
    );

    // 点这份整卷的「详情」
    await chrome.eval(`document.querySelector('article a[href^="/question/"]').click()`);
    await chrome.waitFor<boolean>(`location.pathname.startsWith('/question/')`, 20000, '进入整卷详情');
    check('进到了整卷详情页', (await chrome.eval<string>(`location.pathname`)).startsWith('/question/'));
    check(
      '★ 整卷详情里没有 PDF 阅读器',
      !(await chrome.eval<string>(`document.body.innerText`)).includes('整卷 PDF')
    );

    // 返回
    await clickBack();
    await new Promise((r) => setTimeout(r, 1500));
    const urlAfter = await chrome.eval<string>(`location.pathname + location.search`);
    check('★★ 返回后 URL 与点进详情前**完全一致**', urlAfter === urlBefore, `前=${urlBefore} 后=${urlAfter}`);
    await chrome.waitFor<boolean>(`document.querySelectorAll('article').length > 0`, 20000, '列表回来');
    const listTxt = await chrome.eval<string>(`document.body.innerText`);
    check('★★ 列表回到了整卷页签（不是单题）', /整卷/.test(listTxt) && !/（单选题）/.test(listTxt), listTxt.slice(0, 160));
    const pagerNow = await chrome.eval<string>(
      `document.body.innerText.match(${PAGE_RE})?.[0]?.replace(/\\s+/g, ' ') ?? '(只有一页)'`
    );
    check(`★★ 分页停在第 2 页（${pagerNow}）`, /第\s*2\s*\//.test(pagerNow), pagerNow);
    const firstQidAfter = await chrome.eval<string>(
      `document.querySelector('article .ma-mono')?.textContent?.trim() ?? ''`
    );
    check(
      '★★ 第 2 页的第一条与点进详情前是同一份',
      firstQidAfter === firstQidBefore && !!firstQidAfter,
      `前=${firstQidBefore} 后=${firstQidAfter}`
    );

    // ============================================================
    section('#5 单题也能回到原来那一页（第 3 页）');
    // ============================================================
    await clickUntil('单题', `document.querySelectorAll('article input[type=checkbox]').length > 0`);
    const toPage3 = await (async () => {
      for (let i = 0; i < 20; i++) {
        const p = await chrome.eval<string>(`document.body.innerText.match(${PAGE_RE})?.[1] ?? '1'`);
        if (p === '3') return true;
        await chrome.eval(
          `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('下一页')); if (b && !b.disabled) b.click(); })()`
        );
        await new Promise((r) => setTimeout(r, 600));
      }
      return false;
    })();
    check('翻到单题第 3 页', toPage3);
    const u3 = await chrome.eval<string>(`location.pathname + location.search`);
    check(`URL 里有 page=3（${u3}）`, /page=3/.test(u3), u3);
    await chrome.eval(`document.querySelector('article a[href^="/question/"]').click()`);
    await chrome.waitFor<boolean>(`location.pathname.startsWith('/question/')`, 20000, '单题详情');
    await clickBack();
    await new Promise((r) => setTimeout(r, 1500));
    const u3back = await chrome.eval<string>(`location.pathname + location.search`);
    check('★★ 从单题详情返回 → 仍是第 3 页', u3back === u3 && /page=3/.test(u3back), `前=${u3} 后=${u3back}`);

    // ============================================================
    section('#6 试题篮：导出区只剩一个按钮；弹窗标题预填时间戳');
    // ============================================================
    const anyThree = ((await api('GET', '/api/questions/search?kind=单题&status=全部&size=3')).data
      .items ?? []) as Array<{ qid: string }>;
    await api('POST', '/api/baskets', { action: 'add', qids: anyThree.map((e) => e.qid) });
    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 25000, '试题篮');
    const boxTxt = await chrome.eval<string>(
      `(() => { const el = document.querySelector('[class*=exportBox]'); return el ? el.innerText : ''; })()`
    );
    // v10：按钮去掉了省略号
  check('★ 导出区只有「导出讲义」一个按钮', /^导出讲义$/.test(boxTxt.trim()), JSON.stringify(boxTxt));
    check('★ 导出区里没有「标题」「模板」摘要行', !/标题|模板/.test(boxTxt), JSON.stringify(boxTxt));
    check(
      '★ 说明文字也没了（不再有"弹出窗口里选模板…"）',
      !/弹出窗口里选模板/.test(await chrome.eval<string>(`document.body.innerText`))
    );

    // 先把上次留下的标题清掉 —— 标题是"记住"的，不清掉就看不到默认值。
    // 这一步本身也顺带验了「保存过的标题会一直留着」。
    await api('POST', '/api/baskets', { action: 'options', exportOptions: { title: '' } });
    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 25000, '试题篮');
    await chrome.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('导出讲义')).click()`
    );
    await chrome.waitFor<boolean>(`!!document.querySelector('[role=dialog]')`, 10000, '导出弹窗');
    const titleVal = await chrome.eval<string>(
      `document.querySelector('[role=dialog] input[type=text]').value`
    );
    check(
      `★ 标题没存过时，弹窗**预填当前时间戳**（${titleVal}）`,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(titleVal),
      titleVal
    );
    await chrome.eval(
      `(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '取消'); if (b) b.click(); })()`
    );
    await new Promise((r) => setTimeout(r, 500));

    // ============================================================
    section('#7 录入页：文案、图标、年份区间');
    // ============================================================
    await chrome.goto(`${BASE}/add`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('选择录入类型')`, 25000, '录入页');
    // ⚠️ 录入页在"没选类型"时**不渲染任何表单**（只有一句「先选一个录入类型」）。
    //    第一版直接去查题干输入框、当然查不到 —— 必须先点一个题型。
    const picked = await clickUntil('填空', `document.body.innerText.includes('题干')`);
    check('选「填空」后出现表单', picked);

    const addTxt = await chrome.eval<string>(`document.body.innerText`);
    check(
      '★ 题干输入框 placeholder = 粘贴题干',
      await chrome.eval<boolean>(
        `[...document.querySelectorAll('textarea')].some(t => t.placeholder === '粘贴题干')`
      ),
      JSON.stringify(await chrome.eval<string[]>(`[...document.querySelectorAll('textarea')].map(t => t.placeholder)`))
    );
    check(
      '★ 描述输入框 placeholder = 输入描述',
      await chrome.eval<boolean>(
        `[...document.querySelectorAll('textarea')].some(t => t.placeholder === '输入描述')`
      ),
      JSON.stringify(await chrome.eval<string[]>(`[...document.querySelectorAll('textarea')].map(t => t.placeholder)`))
    );
    check(
      '★ 没有「加图请在题干 / 答案文本框下面点…」那句',
      !/加图请在/.test(addTxt),
      addTxt.slice(0, 200)
    );
    check('★ 没有「按题型默认」', !/按题型默认/.test(addTxt));
    check(
      '★ 年份标签里写出了区间（1900–今年）',
      new RegExp(`年份（1900–${new Date().getFullYear()}）`).test(addTxt),
      addTxt.slice(0, 400)
    );
    check(
      // v10：那段"正文用 LaTeX 写…"的说明按你的要求删掉了
      '★ 正文语言那段说明已删（录入页不再有 LaTeX 教学段）',
      !/LaTeX/.test(addTxt),
      addTxt.slice(0, 400)
    );

    // 选项那一行的加图按钮：一个朴素的 ＋，不是 emoji（只有选择题才有那几行）
    const optPicked = await clickUntil('单选', `document.querySelectorAll('[class*=optionRow]').length > 0`);
    check('选「单选」后出现选项行', optPicked);
    const optBtns = await chrome.eval<string[]>(
      `(() => { const rows = [...document.querySelectorAll('[class*=optionRow]')];
         return rows.flatMap(r => [...r.querySelectorAll('button')].map(b => b.textContent.trim())); })()`
    );
    check(
      `★ 选项行的加图按钮是「＋」而不是 emoji（${optBtns.length} 个）`,
      optBtns.length > 0 && optBtns.every((t) => t === '＋'),
      JSON.stringify(optBtns)
    );
    const hasEmoji = await chrome.eval<boolean>(`/🖼/.test(document.body.innerText)`);
    check('★ 页面上已经没有 🖼 这个图标', !hasEmoji);
    check(
      '★ 知识点有 8 个的上限提示（n / 8）',
      await chrome.eval<boolean>(`/\\d+ \\/ ${8}/.test(document.body.innerText)`),
      (await chrome.eval<string>(`document.body.innerText`)).match(/\d+ \/ \d+/)?.[0] ?? '(没找到)'
    );

    // ============================================================
    section('#8 录入校验：知识点 ≤8 / 年份 ≤今年 / 选项 ≥3');
    // ============================================================
    // 年份 2100 走接口（界面拦在服务端同一处）
    const badYear = new FormData();
    badYear.set('kind', '单题');
    badYear.set('type', '填空');
    badYear.set('stem', '1+1=');
    badYear.set('year', '2100');
    const by = await fetch(`${BASE}/api/questions`, { method: 'POST', body: badYear });
    const byData = (await by.json()) as { error?: string };
    check('★ 年份 2100 被拒（上限是今年）', by.status === 400, JSON.stringify(byData));
    check(
      `错误信息里写了当前年份 ${new Date().getFullYear()}`,
      new RegExp(String(new Date().getFullYear())).test(String(byData.error)),
      String(byData.error)
    );

    // 选择题只填 2 个选项
    const badOpt = new FormData();
    badOpt.set('kind', '单题');
    badOpt.set('type', '单选');
    badOpt.set('stem', '下列正确的是');
    badOpt.set('optionA', '甲');
    badOpt.set('optionB', '乙');
    const bo = await fetch(`${BASE}/api/questions`, { method: 'POST', body: badOpt });
    const boData = (await bo.json()) as { error?: string };
    check('★ 选择题只填 2 个选项被拒', bo.status === 400, JSON.stringify(boData));
    check('错误信息说清了最少几个', /至少/.test(String(boData.error)), String(boData.error));

    // 四个全空（以前是能存的）
    const emptyOpt = new FormData();
    emptyOpt.set('kind', '单题');
    emptyOpt.set('type', '单选');
    emptyOpt.set('stem', '下列正确的是');
    const eo = await fetch(`${BASE}/api/questions`, { method: 'POST', body: emptyOpt });
    check('★ 四个选项全空也被拒（以前能存成"没有选项的单选题"）', eo.status === 400);

    // 知识点 9 个
    const manyK = new FormData();
    manyK.set('kind', '单题');
    manyK.set('type', '填空');
    manyK.set('stem', '1+1=');
    for (let i = 1; i <= 9; i++) manyK.append('knowledge', `知识点${i}`);
    const mk = await fetch(`${BASE}/api/questions`, { method: 'POST', body: manyK });
    const mkData = (await mk.json()) as { error?: string };
    check('★ 9 个知识点被拒', mk.status === 400, JSON.stringify(mkData));
    check('错误信息说清了上限 8', /最多 8 个/.test(String(mkData.error)), String(mkData.error));

    // 8 个可以（但会因为题干校验别的先过 —— 这里只验"没有被知识点这条拦住"）
    const okK = new FormData();
    okK.set('kind', '单题');
    okK.set('type', '填空');
    okK.set('stem', '');
    for (let i = 1; i <= 8; i++) okK.append('knowledge', `知识点${i}`);
    const okv = await fetch(`${BASE}/api/questions`, { method: 'POST', body: okK });
    const okData = (await okv.json()) as { error?: string };
    check(
      '★ 8 个知识点不会被"知识点上限"这条拦（拦的是题干为空，说明上限放行）',
      !/知识点最多/.test(String(okData.error)),
      String(okData.error)
    );
  } finally {
    await api('POST', '/api/baskets', { action: 'set', qids: beforeQids }).catch(() => {});
    console.log(`\n（已还原试题篮：${beforeQids.length} 道）`);
    await chrome.close();
  }
}

main()
  .then(() => {
    console.log(`\n${'='.repeat(56)}`);
    console.log(`通过 ${pass}，失败 ${fail}`);
    if (failures.length) {
      console.log('\n失败项：');
      for (const f of failures) console.log(`  · ${f}`);
    }
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('\n脚本自身出错：', e);
    process.exit(1);
  });

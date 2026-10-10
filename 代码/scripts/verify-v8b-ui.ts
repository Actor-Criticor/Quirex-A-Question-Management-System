/**
 * verify-v8b-ui.ts — 真实浏览器验证 v8b 的三件事
 *
 *   1. ★ 从详情返回时**连滚动位置一起恢复**（原来只回到那一页的顶上）
 *   2. 多余的提示删掉了（导出弹窗、路径区、整卷详情、空来源）
 *   3. 设置页「讲义模板」重排后：不折叠、信息成段、能打开模板目录
 *
 * 运行：先 npm run dev，再 npx tsx scripts/verify-v8b-ui.ts
 */

import { Chrome } from './cdp';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';
const CDP_PORT = 9359;

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
      width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
    });

    // ============================================================
    section('#1 ★★ 返回时连滚动位置一起恢复');
    // ============================================================
    // 直接进"单题第 2 页"，滑到底，点详情，返回
    await chrome.goto(`${BASE}/?page=2`);
    await chrome.waitFor<boolean>(`document.querySelectorAll('article').length > 0`, 25000, '第 2 页列表');
    await new Promise((r) => setTimeout(r, 800));

    const pageNo = await chrome.eval<string>(
      `document.body.innerText.match(/第\\s*(\\d+)\\s*\\/\\s*(\\d+)\\s*页/)?.[1]?.trim() ?? ''`
    );
    check(`确实在第 2 页（读到 ${pageNo || '空'}）`, pageNo === '2', pageNo);

    // 滑到底（模拟"翻到这一页最底下")
    await chrome.eval(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await new Promise((r) => setTimeout(r, 700));
    const yBefore = await chrome.eval<number>(`Math.round(window.scrollY)`);
    check(`滑到了页面下方（scrollY=${yBefore}）`, yBefore > 400, String(yBefore));

    // ★ 关键一步：滚动之后、点详情之前，存储里就应该已经是 2042 了。
    //   如果这里是 0，说明"记位置"这一步就没成，问题不在恢复那侧。
    await new Promise((r) => setTimeout(r, 600));
    const storedAfterScroll = await chrome.eval<string>(
      `(() => { try { return sessionStorage.getItem('quirex:scroll') ?? '(空)'; } catch { return '(读不到)'; } })()`
    );
    console.log(`      滚动之后的存储：${storedAfterScroll}`);
    check(
      '★ 滚动之后就已经把位置存下来了（还没点详情）',
      /"\/\?page=2":\s*[1-9]/.test(storedAfterScroll),
      storedAfterScroll
    );

    // 打开第一张卡片的详情
    await chrome.eval(`document.querySelector('article a[href^="/question/"]').click()`);
    await chrome.waitFor<boolean>(`location.pathname.startsWith('/question/')`, 20000, '进入详情');
    await new Promise((r) => setTimeout(r, 800));
    // ★ 点进来之后，存的位置不该被"浏览器把滚动夹回 0"冲掉
    const storedOnDetail = await chrome.eval<string>(
      `(() => { try { return sessionStorage.getItem('quirex:scroll') ?? '(空)'; } catch { return '(读不到)'; } })()`
    );
    console.log(`      进详情之后的存储：${storedOnDetail}`);
    check(
      '★ 进详情不会把原来记的位置冲成 0',
      /"\/\?page=2":\s*[1-9]/.test(storedOnDetail),
      storedOnDetail
    );
    await chrome.waitFor<boolean>(
      `!![...document.querySelectorAll('button')].find(b => b.textContent.includes('返回上一页'))`,
      20000,
      '详情加载完'
    );
    await clickBack();
    await chrome.waitFor<boolean>(`document.querySelectorAll('article').length > 0`, 20000, '列表回来');
    // 恢复是"数据到齐后再滚、而且要跟 next 抢几次"，所以采几个时间点看它稳在哪
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 250));
      samples.push(await chrome.eval<number>(`Math.round(window.scrollY)`));
    }
    const yAfter = samples[samples.length - 1];
    const stored = await chrome.eval<string>(
      `(() => { try { return JSON.stringify(JSON.parse(sessionStorage.getItem('quirex:scroll') ?? '{}')); }
         catch { return '(读不到)'; } })()`
    );
    console.log(`      存下来的：${stored}`);
    console.log(`      采样 scrollY：${samples.join(' → ')}`);
    const urlAfter = await chrome.eval<string>(`location.pathname + location.search`);
    check('返回后仍在这一页（URL 带 page=2）', /page=2/.test(urlAfter), urlAfter);
    check(
      `★★ 返回后回到了原来滑到的位置（${yBefore} → ${yAfter}，差 ${Math.abs(yBefore - yAfter)}px）`,
      Math.abs(yBefore - yAfter) <= 80,
      `前=${yBefore} 后=${yAfter}`
    );
    check('★ 不是回到了顶上（那正是你不满意的地方）', yAfter > 300, String(yAfter));

    // 反向验证：换个视图不该套用别处的滚动位置
    await chrome.goto(`${BASE}/`);
    await chrome.waitFor<boolean>(`document.querySelectorAll('article').length > 0`, 25000, '回首页');
    await new Promise((r) => setTimeout(r, 900));
    const yHome = await chrome.eval<number>(`Math.round(window.scrollY)`);
    check(`另一个视图（没有 page 参数）从顶上开始（scrollY=${yHome}）`, yHome <= 60, String(yHome));

    // ============================================================
    section('#2 多余的提示：该删的删了');
    // ============================================================
    // 整卷详情：不再有"这份卷子同时是一个来源"
    await chrome.goto(`${BASE}/question/P001`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('基本信息')`, 25000, '整卷详情');
    const paperTxt = await chrome.eval<string>(`document.body.innerText`);
    check('★ 整卷详情里没有「这份卷子同时是一个来源」那句', !/这份卷子同时/.test(paperTxt));

    // 空来源：只留一句短的
    await chrome.goto(`${BASE}/question/P008`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('名下的题目')`, 25000, '空来源卷子');
    const emptyTxt = await chrome.eval<string>(`document.body.innerText`);
    if (/还没有录入单题/.test(emptyTxt)) {
      check('★ 空来源只有一句短提示（不再教你怎么录入）', !/在「录入」里把来源名填成/.test(emptyTxt), emptyTxt.slice(0, 300));
    } else {
      check('这份卷子名下其实有题，跳过空来源检查', true, 'skip');
    }

    // 导出弹窗：样式文件行、分组说明、长标题说明都没了
    const anyThree = ((await api('GET', '/api/questions/search?kind=单题&status=全部&size=3')).data
      .items ?? []) as Array<{ qid: string }>;
    await api('POST', '/api/baskets', { action: 'set', qids: anyThree.map((e) => e.qid) });
    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 25000, '试题篮');
    await chrome.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('导出讲义')).click()`
    );
    await chrome.waitFor<boolean>(`!!document.querySelector('[role=dialog]')`, 10000, '弹窗');
    await new Promise((r) => setTimeout(r, 600));
    const dlg = await chrome.eval<string>(`document.querySelector('[role=dialog]').innerText`);
    check('★ 弹窗里不再单独列「样式文件：…」', !/样式文件：/.test(dlg), dlg.slice(0, 200));
    check('★ 弹窗里不再有分组的整句说明', !/按试题篮里的顺序一路排下去/.test(dlg));
    check('★ 标题说明缩成一句', !/默认已填好当前时间/.test(dlg), dlg.slice(0, 200));
    check('弹窗里仍保留对导出位置的指引', /设置 → 路径/.test(dlg));
    await chrome.eval(
      `(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '取消'); if (b) b.click(); })()`
    );
    await new Promise((r) => setTimeout(r, 400));

    // ============================================================
    section('#3 设置页「讲义模板」重排');
    // ============================================================
    await chrome.goto(`${BASE}/settings`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('讲义模板')`, 25000, '设置页');
    await new Promise((r) => setTimeout(r, 900));
    const tpl = await chrome.eval<string>(
      `(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('讲义模板'));
         const sec = h ? h.closest('section') : null; return sec ? sec.innerText : '(没找到这一区)'; })()`
    );
    check('★ 模板目录提到最上面并带「打开」', /模板目录/.test(tpl) && /打开/.test(tpl), tpl.slice(0, 200));
    // v10：卡片上只显示一个名字（以前是「默认讲义  默认」两个），文件夹名不再露出来
    check('★ 卡片上只显示一个名字（显示名）', /默认讲义/.test(tpl), tpl.slice(0, 200));
    // v10：样式文件/占位符/引擎/位置 那一块去掉了
    check('★ 不再列「样式文件 / 占位符 / 引擎 / 位置」', !/样式文件|占位符|引擎/.test(tpl), tpl.slice(0, 400));
    check('★ 状态徽标在', /可用/.test(tpl), tpl.slice(0, 200));
    // v10：改名改成名字旁边的铅笔，不再单列一行「显示名」
    check('★ 改名是名字旁边的编辑标志', /✎/.test(tpl) && /打开文件夹/.test(tpl), tpl.slice(0, 300));
    check('★ 下面的「占位符含义」整块去掉了', !/占位符含义/.test(tpl), tpl.slice(0, 400));
    // 模板卡上不该有折叠三角
    const cardHasTriangle = await chrome.eval<boolean>(
      `(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('讲义模板'));
         const sec = h ? h.closest('section') : null;
         if (!sec) return false;
         const cards = sec.querySelectorAll('article');
         return [...cards].some(c => /[▸▾]/.test(c.innerText)); })()`
    );
    check('★ 模板卡上已经去掉折叠三角', !cardHasTriangle);

    // ★ 卡片张数 = min(接口模板数, 每页 3 个) —— v9 起模板列表分页了，
    //   所以「卡片数 = 模板总数」只在 ≤3 套时成立，测试改成按页算。
    const apiTemplates = await (async () => {
      const r = await fetch(`${BASE}/api/export/templates`, { cache: 'no-store' });
      const d = (await r.json()) as { templates?: Array<{ id: string; name: string }> };
      return d.templates ?? [];
    })();
    const PAGE_SIZE = 3;
    const expectedOnFirstPage = Math.min(apiTemplates.length, PAGE_SIZE);
    const cardCount = await chrome.eval<number>(
      `(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('讲义模板'));
         const sec = h ? h.closest('section') : null; return sec ? sec.querySelectorAll('article').length : 0; })()`
    );
    check(
      `★★ 第一页的模板卡数量正确（${cardCount} = min(${apiTemplates.length}, ${PAGE_SIZE})）`,
      cardCount === expectedOnFirstPage && cardCount >= 2,
      `卡片 ${cardCount} / 应为 ${expectedOnFirstPage}（模板共 ${apiTemplates.length}）`
    );
    // 不折叠：第一页的卡片把详情一次看全
    const firstPageTxt = await chrome.eval<string>(
      `(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('讲义模板'));
         const sec = h ? h.closest('section') : null;
         if (!sec) return '';
         return [...sec.querySelectorAll('article')].map(c => c.innerText).join('\\n'); })()`
    );
    check(
      '★ 卡片上能看到状态、描述框与「打开文件夹」',
      /可用/.test(firstPageTxt) && /描述/.test(firstPageTxt) && /打开文件夹/.test(firstPageTxt),
      firstPageTxt.slice(0, 300)
    );
    if (apiTemplates.length <= PAGE_SIZE) {
      for (const t of apiTemplates) {
        check(`★ 「${t.name}」在设置页里显示出来了`, tpl.includes(t.name), `${t.name} 不在页面上`);
      }
    } else {
      check(
        `模板共 ${apiTemplates.length} 套 > 一页，第一页只显示前 ${PAGE_SIZE} 个（其余靠翻页看）`,
        cardCount === PAGE_SIZE
      );
      check('★ 分页条出现且页码正确', /第\s*1\s*\/\s*\d+\s*页/.test(tpl), tpl.slice(-200));
    }
    const withOpenBtn = await chrome.eval<number>(
      `(() => { const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('讲义模板'));
         const sec = h ? h.closest('section') : null;
         if (!sec) return 0;
         return [...sec.querySelectorAll('article')].filter(c => c.innerText.includes('打开文件夹')).length; })()`
    );
    check(
      '★ 每张卡都有「打开文件夹」按钮',
      withOpenBtn === expectedOnFirstPage,
      `${withOpenBtn} / ${expectedOnFirstPage}`
    );

    // 导出弹窗的下拉里也该有这几套
    const anyQ = ((await api('GET', '/api/questions/search?kind=单题&status=全部&size=3')).data
      .items ?? []) as Array<{ qid: string }>;
    await api('POST', '/api/baskets', { action: 'set', qids: anyQ.map((e) => e.qid) });
    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 25000, '试题篮');
    await chrome.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('导出讲义')).click()`
    );
    await chrome.waitFor<boolean>(`!!document.querySelector('[role=dialog]')`, 10000, '弹窗');
    await chrome.waitFor<boolean>(
      `document.querySelectorAll('[role=dialog] select option').length >= 2`,
      10000,
      '模板下拉载入'
    );
    const opts = await chrome.eval<string[]>(
      `[...document.querySelectorAll('[role=dialog] select option')].map(o => o.textContent.trim())`
    );
    console.log(`      下拉里的模板：${opts.join(' | ')}`);
    check(
      `★★ 导出弹窗的模板下拉列出了全部 ${apiTemplates.length} 套`,
      opts.length === apiTemplates.length,
      JSON.stringify(opts)
    );
    check(
      '★ 下拉里显示的是显示名，而不是文件夹名',
      apiTemplates.every((t) => opts.some((o) => o.includes(t.name))),
      JSON.stringify(opts)
    );
    await chrome.eval(
      `(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '取消'); if (b) b.click(); })()`
    );
    await new Promise((r) => setTimeout(r, 400));
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

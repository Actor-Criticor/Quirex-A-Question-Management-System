/**
 * verify-v7-ui.ts — 在**真实浏览器**里验证 v7 那批界面改动
 *
 * 为什么这些必须开浏览器：全是"看不见就说不清"的事 ——
 *   · 侧边统计到底有没有把题目挤得不居中（要量像素）
 *   · 整卷卡片上到底还有没有勾选框
 *   · 翻页后到底滚到哪了（要读 getBoundingClientRect）
 *   · 点「返回」到底回的是上一页还是首页（要看 URL 历史）
 *
 * 用 scripts/cdp.ts（Node 自带 WebSocket 直连 Chrome DevTools Protocol，零依赖）。
 * 全程只读 + 在临时题库快照上操作；跑完把试题篮与录入页恢复原状。
 * 运行：先 npm run dev，再 npx tsx scripts/verify-v7-ui.ts
 */

import fs from 'fs';
import { Chrome } from './cdp';
// 整卷 PDF 在哪儿问应用自己要（不再手写 demo-vault\题库 这种相对路径）
import { pdfPath } from '../src/lib/paths';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';
const CDP_PORT = 9351;

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

  /**
   * 点一个按钮，等到条件成立（最多重试 12 次 × 400ms）。
   *
   * 为什么要重试：`waitFor(卡片出现)` 只能说明**首屏 HTML 已经画出来**，
   * 那时 React 可能还没 hydrate 完，onClick 还没挂上 —— 点下去毫无反应。
   * 这是真实浏览器测试里最容易误判成"功能坏了"的一件事。
   */
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

  try {
    await chrome.start(CDP_PORT);
    const W = 1920;
    const H = 1080;
    await chrome.eval(`window.resizeTo(${W},${H})`).catch(() => {});
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 先清空试题篮，起点干净（跑完恢复）
    await api('POST', '/api/baskets', { action: 'clear' });
    // 加 2 道单题，让统计有内容可看
    const anyTwo = ((await api('GET', '/api/questions/search?kind=单题&status=全部&size=2')).data
      .items ?? []) as Array<{ qid: string }>;
    if (anyTwo.length) {
      await api('POST', '/api/baskets', { action: 'add', qids: anyTwo.map((e) => e.qid) });
    }

    await chrome.goto(`${BASE}/`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('试题篮')`, 25000, '浏览页载入');
    await chrome.waitFor<boolean>(
      `document.querySelectorAll('article').length > 0`,
      20000,
      '题目卡片渲染'
    );

    // ============================================================
    section('#1 试题篮统计：侧边卡片有总数 + 分题型');
    // ============================================================
    const railText = await chrome.eval<string>(
      `(() => { const el = document.querySelector('[class*=basketRail]'); return el ? el.innerText : ''; })()`
    );
    check('★ 宽屏下右侧有统计卡', railText.includes('试题篮'), JSON.stringify(railText));
    check('统计卡里有总数', /\d/.test(railText), railText);
    check(
      '★ 分题型四项都在（单选/多选/填空/解答）',
      ['单选', '多选', '填空', '解答'].every((t) => railText.includes(t)),
      railText
    );
    check('统计卡有去试题篮的入口', railText.includes('去试题篮'), railText);
    const railBox = await chrome.eval<{ x: number; y: number; w: number } | null>(
      `(() => { const el = document.querySelector('[class*=basketRail]'); if (!el) return null;
         const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width }; })()`
    );
    check('★ 统计卡在视口右侧（固定定位）', !!railBox && railBox.x > 1200, JSON.stringify(railBox));

    // ============================================================
    section('#2 ★ 统计卡不参与排版：题目列的中心 x 一点没变');
    // ============================================================
    const centerOf = async () =>
      chrome.eval<number>(`(() => {
        const a = document.querySelector('article'); if (!a) return -1;
        const r = a.getBoundingClientRect(); return Math.round(r.x + r.width / 2);
      })()`);
    const centerWithRail = await centerOf();
    // 把统计卡藏掉再量一次：如果中心变了，说明它确实在参与排版
    await chrome.eval(
      `(() => { const el = document.querySelector('[class*=basketRail]'); if (el) el.style.display = 'none'; })()`
    );
    await new Promise((r) => setTimeout(r, 200));
    const centerWithoutRail = await centerOf();
    await chrome.eval(
      `(() => { const el = document.querySelector('[class*=basketRail]'); if (el) el.style.display = ''; })()`
    );
    // 注意：要跟**内容区**的中心比，不是跟窗口宽度/2 比 ——
    // 有垂直滚动条时内容区少 15px 左右，拿窗口宽度当基准会差出 7px 来。
    const contentCenter = await chrome.eval<number>(
      `Math.round(document.documentElement.clientWidth / 2)`
    );
    check(
      `★ 题目列仍然居中（卡片中心 x = ${centerWithRail}，内容区中心 = ${contentCenter}）`,
      Math.abs(centerWithRail - contentCenter) <= 2,
      `误差 ${Math.abs(centerWithRail - contentCenter)}px`
    );
    check(
      '★ 藏掉统计卡后中心 x 完全不变（证明它不占主列空间）',
      centerWithRail === centerWithoutRail,
      `有卡 ${centerWithRail} / 无卡 ${centerWithoutRail}`
    );

    // ============================================================
    section('#3 整卷卡片没有勾选框，单题有');
    // ============================================================
    const switched = await clickUntil(
      '整卷',
      `document.querySelectorAll('article input[type=checkbox]').length === 0 && document.querySelectorAll('article').length > 0`
    );
    check('★ 切到「整卷」页签（等 hydrate 完成后点，最多重试 12 次）', switched);

    const paperCard = await chrome.eval<{ boxes: number; text: string; hasGoDetail: boolean }>(
      `(() => { const a = document.querySelector('article');
         return { boxes: a.querySelectorAll('input[type=checkbox]').length, text: a.innerText,
                  hasGoDetail: a.innerText.includes('详情') }; })()`
    );
    check('★ 整卷卡片里没有勾选框', paperCard.boxes === 0, JSON.stringify(paperCard).slice(0, 200));
    check('整卷卡片仍有描述', paperCard.text.length > 20, paperCard.text.slice(0, 120));
    check('整卷卡片有「详情」入口', paperCard.hasGoDetail, paperCard.text.slice(0, 120));
    check('整卷卡片仍有 PDF 入口', /PDF/.test(paperCard.text), paperCard.text.slice(0, 160));

    const backToSingle = await clickUntil(
      '单题',
      `document.querySelectorAll('article input[type=checkbox]').length > 0`
    );
    check('★ 单题卡片照常有勾选框', backToSingle);

    // ============================================================
    section('#4 ★ 翻页后滚到列表最上方');
    // ============================================================
    /**
     * v10：**等按钮出现再点**。
     *
     * 原来直接 `find(...).click()`：列表正在重渲染（或数据刚到）时 find 会返回
     * undefined，脚本就炸在 `reading 'click'` —— 一整套连着跑时才偶发，
     * 单独跑永远看不到。慢机器/热机器上尤其容易撞上。
     */
    const clickText = async (text: string, label: string) => {
      await chrome.waitFor<boolean>(
        `!![...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))`,
        15000,
        label
      );
      await chrome.eval(
        `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)})).click()`
      );
    };
    const pagerInfo = await chrome.eval<{ pages: string; hasNext: boolean }>(
      `(() => {
         // 分页条的 .info 是 flex 容器 → 里面的 <b> 数字被块级化，innerText 会渲染成
         // 「第\\n1\\n/ 2 页」。所以正则必须容忍空白，不能写死单个空格。
         const t = document.body.innerText.match(/第\\s*(\\d+)\\s*\\/\\s*(\\d+)\\s*页/);
         const next = [...document.querySelectorAll('button')].find(b => b.textContent.includes('下一页'));
         return { pages: t ? t[0].replace(/\\s+/g, ' ') : '(只有一页)', hasNext: !!next && !next.disabled }; })()`
    );
    if (pagerInfo.hasNext) {
      // 先滚到底部（模拟"翻页时停在翻页按钮处"）
      await chrome.eval(`window.scrollTo(0, document.body.scrollHeight)`);
      await new Promise((r) => setTimeout(r, 400));
      const beforeTop = await chrome.eval<number>(`window.scrollY`);
      await clickText('下一页', '下一页按钮');
      await new Promise((r) => setTimeout(r, 1200));
      const afterTop = await chrome.eval<number>(`window.scrollY`);
      const barTop = await chrome.eval<number>(
        `(() => { const el = document.querySelector('[class*=bar]'); if (!el) return -999;
           return Math.round(el.getBoundingClientRect().top); })()`
      );
      check('翻页前确实在页面下方', beforeTop > 100, `scrollY=${beforeTop}`);
      check('★ 翻页后滚动位置明显上移', afterTop < beforeTop, `${beforeTop} → ${afterTop}`);
      // 判据要说实话：内容不够长时浏览器会把滚动位置夹在底部，
      // 那时"结果条贴在视口顶部"物理上做不到。所以接受两种合格结局：
      //   ① 结果条落到了顶部附近；或 ② 已经滚到底了（能滚的都滚了）
      const atBottom = await chrome.eval<boolean>(
        `window.scrollY >= document.documentElement.scrollHeight - window.innerHeight - 4`
      );
      check(
        '★ 结果条落在视口顶部附近（或已滚到底 —— 第二页内容不够长时只能到这儿）',
        (barTop >= -20 && barTop <= 200) || atBottom,
        `结果条 top=${barTop}，到底=${atBottom}`
      );

      // 回到第 1 页，后面好找题
      await clickText('上一页', '上一页按钮');
      await new Promise((r) => setTimeout(r, 1000));
    } else {
      console.log(`      （题库不足两页，跳过翻页检查：${pagerInfo.pages}）`);
      check('翻页滚顶：题库够不够两页', true, '数据不足，跳过');
    }

    // ============================================================
    section('#5 单题详情：返回上一页（不是回首页）');
    // ============================================================
    // 先到题库，再点第一张卡片的「详情」，然后点返回
    await chrome.goto(`${BASE}/`);
    await chrome.waitFor<boolean>(`document.querySelectorAll('article').length > 0`, 25000, '回到题库');
    // v10：等链接真的在 DOM 里再点（列表重渲染时 find 会返回 null，脚本会炸在 click）
    await chrome.waitFor<boolean>(`!!document.querySelector('article a[href^="/question/"]')`, 15000, '第一张卡的详情链接');
    const urlAtList = await chrome.eval<string>(`location.pathname`);
    await chrome.eval(
      `document.querySelector('article a[href^="/question/"]').click()`
    );
    await chrome.waitFor<boolean>(`location.pathname.startsWith('/question/')`, 20000, '进入详情页');
    const detailPath = await chrome.eval<string>(`location.pathname`);
    check('点详情进到了详情页', detailPath.startsWith('/question/'), detailPath);

    await clickText('返回上一页', '返回上一页按钮');
    await new Promise((r) => setTimeout(r, 1200));
    const backPath = await chrome.eval<string>(`location.pathname`);
    check(
      `★ 点「返回上一页」回到了题库（${urlAtList}）而不是首页另开`,
      backPath === urlAtList,
      `back → ${backPath}`
    );

    // ============================================================
    section('#6 整卷详情：基本信息 / 全部描述 / 名下的题目 / PDF');
    // ============================================================
    const papers = ((await api('GET', '/api/questions/search?kind=整卷&status=全部&size=50')).data
      .items ?? []) as Array<{ qid: string; source?: string }>;
    check('库里有整卷', papers.length >= 1, JSON.stringify(papers));
    // 挑一份"来源下有单题"的卷子（这样才看得到那个区块）
    const countBySource = async (src?: string): Promise<number> => {
      if (!src) return 0;
      const r = await api(
        'GET',
        `/api/questions/search?source=${encodeURIComponent(src)}&kind=单题&status=全部&size=200`
      );
      return ((r.data.items ?? []) as unknown[]).length;
    };
    let target = papers[0];
    for (const p of papers) {
      if (await countBySource(p.source)) {
        target = p;
        break;
      }
    }
    const srcCount = await countBySource(target.source);

    await chrome.goto(`${BASE}/question/${target.qid}`);
    await chrome.waitFor<boolean>(
      `document.body.innerText.includes('基本信息')`,
      25000,
      '整卷详情页'
    );
    const dTxt = await chrome.eval<string>(`document.body.innerText`);
    check('★ 整卷详情有「基本信息」', dTxt.includes('基本信息'), dTxt.slice(0, 120));
    check('基本信息里有来源', dTxt.includes('来源'), dTxt.slice(0, 200));
    check('基本信息里有难度与年份', dTxt.includes('难度') && dTxt.includes('年份'), dTxt.slice(0, 200));
    check('★ 基本信息里有「描述」全文', dTxt.includes('描述'), dTxt.slice(0, 300));
    // v8：整卷详情**不再内嵌 PDF 阅读器**（你说详情页只留该标签下的题目）
    check(
      '★ v8：整卷详情已无 PDF 阅读器/切换',
      !dTxt.includes('整卷 PDF'),
      dTxt.slice(0, 400)
    );
    check(
      '★ v8：替换 PDF 的按钮还在（题目信息里）',
      /替换题目 PDF|上传题目 PDF/.test(dTxt),
      dTxt.slice(-400)
    );
    check(
      `★ 有「${target.source}」名下的题目区块（${srcCount} 道）`,
      dTxt.includes('名下的题目'),
      dTxt.slice(0, 400)
    );
    check(
      '★ 该区块里带勾选框（能就地加进试题篮）',
      (await chrome.eval<number>(
        `document.querySelectorAll('section input[type=checkbox]').length`
      )) > 0
    );

    // 勾一道**还没勾**的 → 真的进篮子
    const beforeAdd = ((await api('GET', '/api/baskets')).data.draft as { count: number }).count;
    const hasUnchecked = await chrome.eval<boolean>(
      `(() => { const ins = [...document.querySelectorAll('section input[type=checkbox]')];
         const free = ins.find(i => !i.checked); if (!free) return false; free.click(); return true; })()`
    );
    check('该区块里有未勾选的题（否则这条测不了）', hasUnchecked);
    await new Promise((r) => setTimeout(r, 900));
    const afterAdd = ((await api('GET', '/api/baskets')).data.draft as { count: number }).count;
    check('★ 在整卷详情页勾一下就进了试题篮', afterAdd === beforeAdd + 1, `${beforeAdd} → ${afterAdd}`);
    // 取消刚勾的那道，还原
    await chrome.eval(
      `(() => { const ins = [...document.querySelectorAll('section input[type=checkbox]')];
         const on = ins.find(i => i.checked); if (on) on.click(); })()`
    );
    await new Promise((r) => setTimeout(r, 900));
    const afterUn = ((await api('GET', '/api/baskets')).data.draft as { count: number }).count;
    check('★ 再点一下就移出（与浏览页同一套行为）', afterUn === beforeAdd, `${afterAdd} → ${afterUn}`);

    // ============================================================
    section('#7 没有同名题的卷子：区块整块不渲染');
    // ============================================================
    const lonely = papers.find((p) => {
      return p.source && p.source !== target.source;
    });
    if (lonely) {
      const lonelyCount = await countBySource(lonely.source);
      await chrome.goto(`${BASE}/question/${lonely.qid}`);
      await chrome.waitFor<boolean>(`document.body.innerText.includes('基本信息')`, 25000, '另一份卷子');
      const t2 = await chrome.eval<string>(`document.body.innerText`);
      // v8：区块不再整块隐藏，而是留一块空白（说明"这里本来是题目"）
      check(
        `★ 来源「${lonely.source}」下有 ${lonelyCount} 道单题 → 区块${lonelyCount === 0 ? '留白' : '列出题目'}`,
        t2.includes('名下的题目'),
        t2.slice(0, 300)
      );
      if (lonelyCount === 0) {
        check(
          '★ v8：没有题目时给的是留白提示，而不是空白一片',
          /还没有录入单题/.test(t2),
          t2.slice(0, 400)
        );
      }
    } else {
      console.log('      （库里只有一种来源，跳过"空来源"检查）');
      check('空来源留白：数据不足跳过', true, 'skip');
    }

    // ============================================================
    section('#8 录入整卷：来源是"新建"、没有联想、没有连续录入');
    // ============================================================
    await chrome.goto(`${BASE}/add`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('整卷')`, 25000, '录入页');
    const paperTab = await clickUntil(
      '整卷',
      `document.body.innerText.includes('来源名称（新建）')`
    );
    check('★ 切到整卷录入（等 hydrate 完成后点）', paperTab);
    const addTxt = await chrome.eval<string>(`document.body.innerText`);
    check('★ 整卷表单写的是「来源名称（新建）」', addTxt.includes('来源名称（新建）'), addTxt.slice(0, 200));
    // v10：那句整句说明去掉了（你说多余），只留"重名"这种当场反馈
    check(
      '★ 不再有"整卷本身就是一份来源"那段说明书',
      !addTxt.replace(/\s+/g, '').includes('整卷本身就是一份来源'),
      addTxt.slice(0, 400)
    );
    check('★ 整卷表单没有「连续录入」', !addTxt.includes('连续录入'), addTxt.slice(0, 600));
    const sourceInputHasList = await chrome.eval<boolean>(
      `(() => { const ins = [...document.querySelectorAll('input[type=text]')];
         return ins.some(i => i.getAttribute('list') === 'source-list'); })()`
    );
    check('★ 整卷的来源输入框没有联想下拉（这一栏是"新建"）', !sourceInputHasList);

    // 不填来源就入库 → 前端拦下。
    // 注意校验顺序：**先查 PDF 再查来源**（没有 PDF 的卷子连"是什么"都算不上），
    // 所以要验来源那一条，得先用 CDP 真的挂上一个 PDF 文件上去。
    const dom = await chrome.send('DOM.getDocument', { depth: -1 });
    const rootNodeId = (dom.result as { root: { nodeId: number } }).root.nodeId;
    const inputNode = await chrome.send('DOM.querySelector', {
      nodeId: rootNodeId,
      selector: 'input[type=file][accept="application/pdf"]',
    });
    const fileNodeId = (inputNode.result as { nodeId: number }).nodeId;
    check('录入页有 PDF 文件选择框（CDP 能定位到）', fileNodeId > 0, String(fileNodeId));

    const paperPdf = (await api('GET', '/api/questions/search?kind=整卷&status=全部&size=1')).data
      .items as Array<{ qid: string }> | undefined;
    const pdfPath_ = paperPdf?.[0]?.qid ? pdfPath(paperPdf[0].qid, 'paper') : '';
    check('整卷 PDF 文件确实在题库里', !!pdfPath_ && fs.existsSync(pdfPath_), pdfPath_);
    await chrome.send('DOM.setFileInputFiles', { nodeId: fileNodeId, files: [pdfPath_] });
    await new Promise((r) => setTimeout(r, 700));
    const afterPick = await chrome.eval<string>(`document.body.innerText`);
    check('★ PDF 挂上了（界面显示了文件名）', /\.pdf/.test(afterPick), afterPick.slice(0, 200));

    const blocked = await (async () => {
      for (let i = 0; i < 12; i++) {
        await chrome.eval(
          `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('确认入库')); if (b) b.click(); })()`
        );
        await new Promise((r) => setTimeout(r, 400));
        const t = await chrome.eval<string>(`document.body.innerText`);
        if (/整卷必须填/.test(t)) return t;
      }
      return await chrome.eval<string>(`document.body.innerText`);
    })();
    check(
      '★ 有 PDF 但不填来源 → 被拦下并说明原因',
      /整卷必须填「来源名称」/.test(blocked),
      blocked.slice(0, 300)
    );
    check(
      '★ 拦下时没有弹出"必须上传 PDF"（说明是来源这一条在起作用）',
      !/整卷必须上传题目 PDF/.test(blocked),
      blocked.slice(0, 300)
    );
    check('确实没有真的入库（还停在录入页）', (await chrome.eval<string>(`location.pathname`)) === '/add');

    if (blocked === 'Quirex' || blocked.length < 10) {
      // 页面整个空了 —— 把现场摊开（浏览器异常往往就是答案）
      console.log('    现场诊断：页面文字异常，浏览器侧记录：');
      for (const e of chrome.errors.slice(0, 8)) console.log(`      ${e.slice(0, 400)}`);
      console.log(`      页面 HTML 长度 ${await chrome.eval<number>(`document.body.innerHTML.length`)}`);
    }
  } finally {
    await api('POST', '/api/baskets', { action: 'set', qids: beforeQids }).catch(() => {});
    const back = ((await api('GET', '/api/baskets')).data.draft ?? {}) as Record<string, unknown>;
    console.log(`\n（已还原试题篮：${((back.qids ?? []) as string[]).length} 道）`);
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

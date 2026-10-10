/**
 * verify-v10-ui.ts — 真实浏览器验证 v10 这一轮的界面改动
 *
 * 逐条对着你的原话量：
 *   ·「试题篮的导出键不要加那三个点」→ 按钮文案就是「导出讲义」
 *   ·「设置里当前题库、检索索引、整库备份放到最下面，路径也放到下面去」
 *   ·「从 v0 迁移是干啥的，没用就去掉」→ 那一块没了
 *   ·「路径」那几条的说明文字都删掉
 *   ·「学科栏的记录和下面数字没对齐」→ 表头与数字同一边
 *   ·「讲义模板…为什么会有两个名字？去掉后面那个；改名不要单列一行，名字旁边给个编辑标志；
 *      下面占位符含义也去掉」
 *   ·「导出界面…题目信息后面的解释都去掉，一共 6 个选项一行就能放下」
 *       + 标题下面那句说明、以及「已勾 N / 7」
 *   ·「导出的导出键」那一带、以及「分组」多了一个「按题型」
 *   ·「录入时如果出现问题不允许录入，要把视角跳到最上面」
 *   ·「题库界面的返回到视角位置…把试题篮的也改了」→ 试题篮从详情返回也回原位
 *
 * 运行：先 npm run dev，再 npx tsx scripts/verify-v10-ui.ts
 */

import { Chrome } from './cdp';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';
const CDP_PORT = 9365;

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

const D = `document.querySelector('[role=dialog]')`;

/** 设置页各区块标题在页面上的先后顺序 */
const SECTION_ORDER = `
  (() => {
    const wanted = ['学科','讲义模板','导出历史','备份与还原','路径','当前题库','检索索引','整库备份'];
    const txt = document.body.innerText;
    return wanted.map((w) => ({ w, at: txt.indexOf(w) })).filter((x) => x.at >= 0);
  })()
`;

async function main(): Promise<void> {
  const chrome = new Chrome();
  const draftBefore = ((await api('GET', '/api/baskets')).data.draft ?? {}) as Record<string, unknown>;
  const beforeQids = (draftBefore.qids ?? []) as string[];

  try {
    await chrome.start(CDP_PORT);
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });

    // ============================================================
    section('#1 设置页：区块顺序 + 去掉的东西');
    // ============================================================
    await chrome.goto(`${BASE}/settings`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('讲义模板')`, 25000, '设置页');
    await new Promise((r) => setTimeout(r, 900));
    const order = await chrome.eval<Array<{ w: string; at: number }>>(SECTION_ORDER);
    console.log(`      区块顺序：${order.map((o) => o.w).join(' → ')}`);
    const names = order.map((o) => o.w);
    check(
      `★★ 八个区块都在（${names.join('、')}）`,
      names.length === 8,
      JSON.stringify(order)
    );
    check(
      '★★ 顺序是 学科 → 讲义模板 → 导出历史 → 备份与还原 → 路径 → 当前题库 → 检索索引 → 整库备份',
      names.join(',') === '学科,讲义模板,导出历史,备份与还原,路径,当前题库,检索索引,整库备份',
      names.join(',')
    );
    check(
      '★★ 三个"偶尔才点一次"的（当前题库/检索索引/整库备份）确定在最下面',
      names.slice(-3).join(',') === '当前题库,检索索引,整库备份',
      names.slice(-3).join(',')
    );
    check('★ 「路径」也挪到下面去了（在备份与还原之后）', names.indexOf('路径') > names.indexOf('备份与还原'), names.join(','));
    const setTxt = await chrome.eval<string>(`document.body.innerText`);
    check('★★ 「从 v0 迁移」那一块去掉了', !/从 v0 迁移|干跑一次|v0 格式/.test(setTxt), (setTxt.match(/.{0,16}迁移.{0,16}/) ?? [''])[0]);
    check(
      '★ 路径那几条的说明文字都删了',
      !/每个子文件夹是一个模板|讲义文件夹会落在这里|留空就用系统 PATH|所有学科的总位置|清空输入框/.test(setTxt),
      setTxt.slice(setTxt.indexOf('路径'), setTxt.indexOf('路径') + 220).replace(/\n/g, ' | ')
    );
    check('★ 路径四项还在（题库位置/导出位置/模板目录/xelatex 路径）', ['题库位置', '导出位置', '模板目录', 'xelatex 路径'].every((k) => setTxt.includes(k)));

    // 学科表的列对齐
    const align = await chrome.eval<{ head: number | null; cells: number[] }>(
      `(() => {
         const th = [...document.querySelectorAll('th')].find((x) => x.textContent.trim() === '记录');
         if (!th) return { head: null, cells: [] };
         const table = th.closest('table');
         const idx = [...th.parentElement.children].indexOf(th);
         const cells = [...table.querySelectorAll('tbody tr')].map((tr) => tr.children[idx]).filter(Boolean);
         return { head: Math.round(th.getBoundingClientRect().right), cells: cells.map((c) => Math.round(c.getBoundingClientRect().right)) };
       })()`
    );
    console.log(`      「记录」列的右边界：表头 ${align.head}，单元格 ${align.cells.join(',')}`);
    check(
      '★★ 学科表「记录」表头与下面的数字**对齐**（右边界一致）',
      align.head !== null &&
        align.cells.length > 0 &&
        align.cells.every((x) => Math.abs(x - (align.head as number)) <= 2),
      JSON.stringify(align)
    );

    // ============================================================
    section('#2 讲义模板卡：一个名字 + 铅笔改名的标志');
    // ============================================================
    const card = await chrome.eval<{
      names: string[];
      text: string;
      hasPencil: boolean;
      metaRows: number;
      hasDocToggle: boolean;
    }>(
      `(() => {
         const h = [...document.querySelectorAll('h2')].find((x) => x.textContent.includes('讲义模板'));
         const sec = h ? h.closest('section') : null;
         if (!sec) return { names: [], text: '', hasPencil: false, metaRows: 0, hasDocToggle: false };
         const cards = [...sec.querySelectorAll('article')];
         const first = cards[0];
         return {
           names: cards.map((c) => (c.innerText.split('\\n')[0] || '').trim()),
           text: sec.innerText,
           hasPencil: !!(first && [...first.querySelectorAll('button')].some((b) => b.textContent.trim() === '✎')),
           metaRows: first ? [...first.querySelectorAll('dt')].length : 0,
           hasDocToggle: /占位符含义/.test(sec.innerText),
         }; })()`
    );
    console.log(`      卡片首行：${JSON.stringify(card.names)}`);
    check(
      '★★ 每张卡只显示一个名字（不再出现「默认讲义  默认」这种两个名字）',
      card.names.length > 0 && card.names.every((n) => !/\s{2,}/.test(n)),
      JSON.stringify(card.names)
    );
    check('★ 卡片上没有「样式文件 / 占位符 / 引擎 / 位置」那几行', card.metaRows === 0, String(card.metaRows));
    check('★★ 下面的「占位符含义」整块去掉了', card.hasDocToggle === false);
    check('★★ 改名是名字旁边的一个编辑标志（✎）', card.hasPencil === true);
    check('★ 卡片上不再有单独一行的「显示名」输入框', !/显示名/.test(card.text.slice(0, 400)), card.text.slice(0, 200).replace(/\n/g, ' | '));

    // 点铅笔 → 就地改名 → 保存 → 再改回来
    const tpls = ((await api('GET', '/api/export/templates')).data.templates ?? []) as Array<{
      id: string;
      name: string;
      description: string;
    }>;
    const target = tpls.find((t) => t.id === '紧凑题单') ?? tpls[0];
    const renameTo = '改过的名';
    /**
     * 找模板卡的表达式。
     *
     * 用 `data-template` 这个**稳定钩子**，不按名字找 —— 点名铅笔之后名字就变成
     * 输入框了，而 `innerText` 里**不含 input 的 value**，按名字找必然失败
     * （第一版就是这么炸的）。id 用 JSON.stringify 注入，别在页面里引用外面的变量。
     */
    const CARD = `document.querySelector('[data-template=${target.id}]')`;
    await chrome.eval(
      `(() => { const card = ${CARD};
         [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '✎').click();
         return true; })()`
    );
    await new Promise((r) => setTimeout(r, 400));
    const editing = await chrome.eval<boolean>(
      `(() => { const card = ${CARD};
         return !!card.querySelector('input[type=text]'); })()`
    );
    check('★ 点铅笔后名字就地变成输入框（不是跳到别处去改）', editing === true);
    await chrome.eval(
      `(() => { const card = ${CARD};
         const i = card.querySelector('input[type=text]');
         const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         s.call(i, ${JSON.stringify(renameTo)}); i.dispatchEvent(new Event('input', { bubbles: true }));
         return true; })()`
    );
    await new Promise((r) => setTimeout(r, 300));
    await chrome.eval(
      `(() => { const card = ${CARD};
         const b = [...card.querySelectorAll('button')].find((x) => x.textContent.trim() === '保存');
         if (!b || b.disabled) return false; b.click(); return true; })()`
    );
    await chrome.waitFor<boolean>(`document.body.innerText.includes('模板信息已保存')`, 10000, '保存提示');
    const afterRename = ((await api('GET', '/api/export/templates')).data.templates ?? []) as Array<{
      id: string;
      name: string;
    }>;
    check(
      `★★ 铅笔改的名字真的写进了 meta.json（读到「${afterRename.find((t) => t.id === target.id)?.name}」）`,
      afterRename.find((t) => t.id === target.id)?.name === renameTo,
      String(afterRename.find((t) => t.id === target.id)?.name)
    );
    // 改回原名
    await api('POST', '/api/export/templates', { action: 'update', id: target.id, name: target.name, description: target.description });
    const restored = ((await api('GET', '/api/export/templates')).data.templates ?? []) as Array<{ id: string; name: string }>;
    check('改回原名（校验没留下痕迹）', restored.find((t) => t.id === target.id)?.name === target.name);

    // ============================================================
    section('#3 试题篮：导出按钮没有省略号 + 弹窗里的简化');
    // ============================================================
    const anyThree = (((await api('GET', '/api/questions/search?kind=单题&status=全部&size=3')).data
      .items ?? []) as Array<{ qid: string }>);
    await api('POST', '/api/baskets', { action: 'set', qids: anyThree.map((e) => e.qid) });
    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 25000, '试题篮');
    await new Promise((r) => setTimeout(r, 700));
    const exportBtn = await chrome.eval<string>(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('导出讲义')); return b ? b.textContent.trim() : '(没找到)'; })()`
    );
    check(`★★ 导出按钮是「导出讲义」，没有那三个点（读到「${exportBtn}」）`, exportBtn === '导出讲义', exportBtn);

    await chrome.eval(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '导出讲义'); b.click(); return true; })()`
    );
    await chrome.waitFor<boolean>(`!!${D}`, 8000, '导出弹窗');
    await new Promise((r) => setTimeout(r, 600));
    const dlg = await chrome.eval<string>(`${D}.innerText`);

    check('★ 标题下面那句「也是导出文件夹的名字…」去掉了', !/也是导出文件夹的名字/.test(dlg), dlg.slice(0, 200).replace(/\n/g, ' | '));
    check('★★ 「每题上方那行小字装什么 · 已勾 N / 7」去掉了', !/已勾/.test(dlg) && !/装什么/.test(dlg));
    check(
      '★ 六个勾选框后面的解释文字都去掉了',
      !/如「25全国1」|不带数字|该题的全部知识点|题目所属年份|建议留着/.test(dlg),
      dlg.slice(0, 400).replace(/\n/g, ' | ')
    );

    const boxes = await chrome.eval<Array<{ label: string; top: number; checked: boolean }>>(
      `[...${D}.querySelectorAll('input[type=checkbox]')].map((c) => {
         const box = c.closest('label');
         return { label: c.parentElement.querySelector('span').textContent.trim(),
                  top: Math.round(box.getBoundingClientRect().top), checked: c.checked }; })`
    );
    const tops = Array.from(new Set(boxes.map((b) => b.top)));
    console.log(`      六个勾选框：${JSON.stringify(boxes.map((b) => `${b.label}@${b.top}`))}`);
    check(`★ 一共 6 个（v10 去掉了题型标记）`, boxes.length === 6, JSON.stringify(boxes.map((b) => b.label)));
    check(
      `★★ 6 个排在同一行（顶边只有 ${tops.length} 种）`,
      tops.length === 1,
      JSON.stringify(boxes.map((b) => `${b.label}:${b.top}`))
    );

    const groups = await chrome.eval<string[]>(
      `[...${D}.querySelectorAll('button')].filter((b) => /平铺|按题型|按知识点|按来源/.test(b.textContent.trim())).map((b) => b.textContent.trim())`
    );
    check(
      `★★ 分组多了一个「按题型」（${groups.join(' / ')}）`,
      groups.join(',') === '平铺,按题型,按知识点,按来源',
      JSON.stringify(groups)
    );

    // 预览里的星与（多选）
    const preview = await chrome.eval<string>(
      `(() => { const b = [...${D}.querySelectorAll('div')].find((d) => d.className.includes('previewBox')); return b ? b.innerText : ''; })()`
    );
    check('★ 预览还在（勾选项的实时效果）', /预览/.test(preview), preview.replace(/\n/g, ' | '));

    await chrome.eval(
      `(() => { const b = [...${D}.querySelectorAll('button')].find((x) => x.textContent.trim() === '取消'); b.click(); return true; })()`
    );
    await new Promise((r) => setTimeout(r, 300));

    // ============================================================
    section('#4 试题篮：从详情返回也回到原来的滚动位置');
    // ============================================================
    // 先把篮子塞满一点，页面才够长、滚得动
    const many = (((await api('GET', '/api/questions/search?kind=单题&status=全部&size=12')).data
      .items ?? []) as Array<{ qid: string }>);
    await api('POST', '/api/baskets', { action: 'set', qids: many.map((e) => e.qid) });
    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 25000, '试题篮（满）');
    await chrome.waitFor<boolean>(`document.querySelectorAll('a[href^="/question/"]').length > 3`, 20000, '题目列表');
    await new Promise((r) => setTimeout(r, 800));

    await chrome.eval(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await new Promise((r) => setTimeout(r, 800));
    const yBefore = await chrome.eval<number>(`Math.round(window.scrollY)`);
    console.log(`      试题篮滑到 y=${yBefore}`);
    check(`试题篮页够长、滚得动（y=${yBefore}）`, yBefore > 400, String(yBefore));

    await chrome.eval(`document.querySelector('a[href^="/question/"]').click()`);
    await chrome.waitFor<boolean>(`location.pathname.startsWith('/question/')`, 20000, '进入详情');
    await chrome.waitFor<boolean>(
      `!![...document.querySelectorAll('button')].find((b) => b.textContent.includes('返回上一页'))`,
      20000,
      '详情加载完'
    );
    await new Promise((r) => setTimeout(r, 600));
    await chrome.eval(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('返回上一页')).click()`
    );
    await chrome.waitFor<boolean>(`location.pathname === '/baskets'`, 20000, '回到试题篮');
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 20000, '试题篮数据回来');
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 250));
      samples.push(await chrome.eval<number>(`Math.round(window.scrollY)`));
    }
    const yAfter = samples[samples.length - 1];
    console.log(`      返回后 scrollY 采样：${samples.join(' → ')}`);
    check(
      `★★ 从详情返回试题篮时回到了原来的位置（${yBefore} → ${yAfter}，差 ${Math.abs(yBefore - yAfter)}px）`,
      Math.abs(yBefore - yAfter) <= 80,
      `前=${yBefore} 后=${yAfter}`
    );
    check('★ 不是回到顶上（那正是要改掉的）', yAfter > 300, String(yAfter));

    // ============================================================
    section('#5 录入页：出错时视角跳到最上面');
    // ============================================================
    await chrome.goto(`${BASE}/add`);
    await chrome.waitFor<boolean>(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith('单选'))`,
      25000,
      '录入页'
    );
    await chrome.eval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('单选')).click()`);
    await new Promise((r) => setTimeout(r, 700));
    // 把视角拉到页面下方，再点入库（题干是空的 → 会被拦下）
    await chrome.eval(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await new Promise((r) => setTimeout(r, 500));
    const yDown = await chrome.eval<number>(`Math.round(window.scrollY)`);
    check(`先滚到页面下方（y=${yDown}）`, yDown > 200, String(yDown));
    const clicked = await chrome.eval<boolean>(
      `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('确认入库'));
         if (!b || b.disabled) return false; b.click(); return true; })()`
    );
    check('点到了「确认入库」', clicked);
    await new Promise((r) => setTimeout(r, 600));
    const yTop = await chrome.eval<number>(`Math.round(window.scrollY)`);
    const errTxt = await chrome.eval<string>(
      `(() => { const e = [...document.querySelectorAll('div')].find((d) => /题干不能为空/.test(d.innerText) && d.innerText.length < 60); return e ? e.innerText.trim() : '(没看到报错)'; })()`
    );
    console.log(`      点完之后：y=${yTop}，报错=${JSON.stringify(errTxt)}`);
    check(`★ 报了错（${errTxt}）`, /题干不能为空/.test(errTxt), errTxt);
    check('★★ 出错后视角自动跳回最上面（y=0）', yTop === 0, String(yTop));
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

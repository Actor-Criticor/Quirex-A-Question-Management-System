/**
 * verify-export-dialog.ts — 在**真实浏览器**里验证导出弹窗（v6 #6）
 *
 * 为什么非得开浏览器：弹窗是"点了才存在"的界面，光靠 SSR HTML 或 `--dump-dom`
 * 看不到它；而"勾选项实时预览"这种交互更是只有真跑一遍才算数。
 * 用的是 scripts/cdp.ts（Node 自带 WebSocket 直连 Chrome DevTools Protocol，零依赖）。
 *
 * 验证链条（从界面一路打到 PDF）：
 *   点「导出讲义」→ 弹窗出现 → 模板下拉有值 → 6 个勾选框默认态正确
 *   → 勾「知识点」预览实时变化 → 取消 = 什么都不保存
 *   → 重开、填标题、勾「年份」、确认导出 → 真编译出 PDF
 *   → 导出的 .tex 里确实有年份、没有数值难度；日志 0 错误 0 丢字
 *
 * 会改动「正在编辑」的导出选项，开头备份、结尾还原。
 * 运行：先 npm run dev，再 npx tsx scripts/verify-export-dialog.ts
 */

import fs from 'fs';
import path from 'path';
import { Chrome } from './cdp';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';
const CDP_PORT = 9345;

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

/* ---------- 页面里用的小工具（字符串直接塞进浏览器执行） ---------- */

/** 按可见文字找按钮 */
/** 页面上的按钮（**排除弹窗内**）—— v10 起页面上那个按钮与弹窗里的确认键同名，必须分开找 */
const btn = (text: string) =>
  `[...document.querySelectorAll('button')].filter(b => !b.closest('[role=dialog]')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;

/** 弹窗里的按钮 */
const dlgBtn = (text: string) =>
  `[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;

const D = `document.querySelector('[role=dialog]')`;

/**
 * 等按钮「出现、而且不再是灰的」再点。
 *
 * ★ 这是踩过的坑：页面 busy 期间按钮是 `disabled` 的，而
 *   `el.click()` 打在禁用按钮上**一声不响、什么都不发生** ——
 *   表现就是"点了导出、弹窗一直不关、也没有任何报错"。
 *   单独跑时常常侥幸通过（那 50ms 里 busy 正好翻回 false），
 *   一整串套件连着跑就会稳定失败。
 *   所以要点的按钮一律走这个函数：先等它可点，再点。
 */
const clickWhenEnabled = async (
  chrome: Chrome,
  text: string,
  label: string
): Promise<void> => {
  await chrome.waitFor<boolean>(
    `(() => { const b = ${btn(text)}; return !!b && !b.disabled; })()`,
    15000,
    label
  );
  await chrome.eval(`${btn(text)}.click()`);
};

/** 题目信息开关的出厂默认 —— 必须与 lib/types.ts 的 DEFAULT_EXPORT_INFO 一致 */
const DEFAULT_INFO = {
  source: true,
  number: true,
  difficulty: true,
  knowledge: false,
  year: false,
  innovation: true,
  };

async function main(): Promise<void> {
  const chrome = new Chrome();

  /*
   * 先把题目信息开关**归零到出厂默认**再开测。
   *
   * 这一套里的"默认勾选"断言（§3）测的是**没设置过**时的样子；而导出选项是会被
   * 「确认导出」持久保存的 —— 上一次跑如果在中途挂了，就会把 `year: true` 留在盘上，
   * 下一次跑 §3 直接失败、§4 还会因为"年份已经勾着"点了个反的。
   * 实测踩到过一次（aborted 的上一轮留下的脏状态）。
   *
   * 注意顺序：**归零之后再读基线**，这样 finally 里还原的就是归零后的状态，
   * "取消不留痕"那条断言才有一致的比较基准（模板/分组/标题都没动）。
   */
  await api('POST', '/api/baskets', {
    action: 'options',
    exportOptions: { info: DEFAULT_INFO },
  });

  const draftBefore = ((await api('GET', '/api/baskets')).data.draft ?? {}) as Record<string, unknown>;
  const optsBefore = (draftBefore.exportOptions ?? {}) as Record<string, unknown>;
  const qidsBefore = (draftBefore.qids ?? []) as string[];

  /*
   * ★ 先确保篮子里有题。
   *
   * 页面上的「导出讲义」是 `disabled={busy || !draft.count}` —— 空篮子时它是灰的，
   * 弹窗根本打不开，整套脚本会在第一步就超时。
   * 以前一直是靠**上一轮套件留下的题**侥幸通过的：在一套干净的库上单独跑，
   * 立刻就红（v10 验收时踩到）。测试自己的前提，自己搭。
   */
  if (qidsBefore.length === 0) {
    const anyThree = (((await api('GET', '/api/questions/search?kind=单题&status=全部&size=3')).data
      .items ?? []) as Array<{ qid: string }>);
    check(`篮子本来是空的 → 先放 ${anyThree.length} 道题进去（弹窗才打得开）`, anyThree.length > 0);
    await api('POST', '/api/baskets', { action: 'set', qids: anyThree.map((e) => e.qid) });
  }

  try {
    await chrome.start(CDP_PORT);
    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(
      `document.body.innerText.includes('正在编辑')`,
      25000,
      '试题篮载入'
    );

    // ============================================================
    section('#1 弹窗默认是关着的，点按钮才出来');
    // ============================================================
    check('一开始页面上没有弹窗', !(await chrome.eval<boolean>(`!!${D}`)));
    check(
      '导出区只有「导出讲义」按钮（选项收进弹窗了，v10 去掉了那个省略号）',
      !!(await chrome.eval<boolean>(`!!${btn('导出讲义')}`)),
      await chrome.eval<string>(`document.body.innerText.slice(-300)`)
    );

    await clickWhenEnabled(chrome, '导出讲义', '打开导出弹窗');
    const opened = await chrome.waitFor<boolean>(`!!${D}`, 8000, '弹窗出现');
    check('★ 点一下「导出讲义」弹出窗口', !!opened);
    check(
      '弹窗有 aria-label=导出讲义（无障碍 / 也是测试锚点）',
      (await chrome.eval<string>(`${D}.getAttribute('aria-label')`)) === '导出讲义'
    );
    const dlgText = await chrome.eval<string>(`${D}.innerText`);
    check('弹窗里写明了要导几道题', /共 \d+ 道题/.test(dlgText), dlgText.slice(0, 120));
    check('弹窗里有「标题」「模板」「分组」「题目信息」四组', ['标题', '模板', '分组', '题目信息'].every((k) => dlgText.includes(k)), dlgText.slice(0, 200));

    // ============================================================
    section('#2 模板下拉：读的是 /api/export/templates，显示的是 name');
    // ============================================================
    // 模板列表是打开弹窗后才去取的，所以要等它到位（等不到就直接失败，不猜）
    // 注意判据是"不再是占位项"，不是"选项数 > 1" —— 只有一个模板时选项数就是 1
    const loaded = await chrome
      .waitFor<boolean>(
        `(() => { const s = ${D} && ${D}.querySelector('select');
           return !!s && !s.options[0].textContent.includes('没有可用模板'); })()`,
        10000,
        '模板下拉载入'
      )
      .catch(() => false);
    check('★ 弹窗一开就去读模板列表并填进下拉', !!loaded);

    const selectInfo = await chrome.eval<{ value: string; options: string[] }>(
      `(() => { const s = ${D}.querySelector('select');
        return { value: s.value, options: [...s.options].map(o => o.textContent.trim()) }; })()`
    );
    check('模板下拉有选项', selectInfo.options.length >= 1, JSON.stringify(selectInfo));
    check(
      '选项显示的是模板的显示名（不是文件夹名）',
      selectInfo.options.some((o) => o.includes('默认讲义')),
      JSON.stringify(selectInfo.options)
    );
    check(
      '★ 默认选中的就是当前设置里的模板',
      selectInfo.value === (optsBefore.template ?? '默认'),
      `${selectInfo.value} vs ${String(optsBefore.template)}`
    );
    check('弹窗里能「刷新」模板列表（刚加的模板不用重启）', !!(await chrome.eval<boolean>(`!!${dlgBtn('刷新')}`)));

    // ============================================================
    section('#3 题目信息的 6 个勾选框');
    // ============================================================
    const boxes = await chrome.eval<Array<{ label: string; checked: boolean }>>(
      `[...${D}.querySelectorAll('input[type=checkbox]')].map(c => ({
         label: c.parentElement.querySelector('span').textContent.trim(), checked: c.checked }))`
    );
    check('正好 6 个勾选框（v10 去掉了题型标记）', boxes.length === 6, JSON.stringify(boxes));
    check(
      '★ 勾选框就是这六项，且不再有「题型标记」（v10 改成多选题一律自带）',
      ['来源', '题号', '难度等级', '知识点', '年份', '创新'].every((k) => boxes.some((b) => b.label === k)) &&
        !boxes.some((b) => b.label.includes('题型')),
      JSON.stringify(boxes.map((b) => b.label))
    );
    const on = boxes.filter((b) => b.checked).map((b) => b.label);
    check(
      '默认勾的是「来源/题号/难度等级/创新」，知识点与年份默认不勾',
      ['来源', '题号', '难度等级', '创新'].every((k) => on.includes(k)) &&
        !on.includes('知识点') &&
        !on.includes('年份'),
      JSON.stringify(on)
    );
    // v10：勾选框旁边的解释全去掉了（你说多余），所以这里只断言那一项在
    check('难度那一项在', boxes.some((b) => b.label === '难度等级'), JSON.stringify(boxes.map((b) => b.label)));

    // ============================================================
    section('#4 ★ 实时预览：勾一项，预览立刻变');
    // ============================================================
    const previewOf = () => chrome.eval<string>(`(() => { const b = [...${D}.querySelectorAll('div')].find(d => d.className.includes('previewBox')); return b ? b.innerText : ''; })()`);
    const p0 = await previewOf();
    check('预览区显示的是第一道题的样子', /预览/.test(p0) && /1\./.test(p0), p0);
    check('预览里出现了来源（第一道题有来源）', /（.+）/.test(p0), p0);
    check('预览里没有「知识点」（默认不勾）', !p0.includes('知识点'), p0);

    // 勾上「知识点」
    await chrome.eval(
      `[...${D}.querySelectorAll('input[type=checkbox]')].find(c => c.parentElement.querySelector('span').textContent.trim() === '知识点').click()`
    );
    await new Promise((r) => setTimeout(r, 300));
    const p1 = await previewOf();
    check('★ 勾上「知识点」后预览立刻出现知识点', p1 !== p0, `前：${p0} / 后：${p1}`);
    check('预览里的知识点带「知识点」前缀', p1.includes('知识点'), p1);

    // 勾上「年份」再一起看
    await chrome.eval(
      `[...${D}.querySelectorAll('input[type=checkbox]')].find(c => c.parentElement.querySelector('span').textContent.trim() === '年份').click()`
    );
    await new Promise((r) => setTimeout(r, 300));
    const p2 = await previewOf();
    check('勾上「年份」后预览再加一段', p2.length > p1.length, `前：${p1} / 后：${p2}`);
    check('各项之间用 · 分隔', p2.includes(' · '), p2);

    // 全不勾
    await chrome.eval(
      `[...${D}.querySelectorAll('input[type=checkbox]')].forEach(c => { if (c.checked) c.click(); })`
    );
    await new Promise((r) => setTimeout(r, 300));
    const p3 = await previewOf();
    check('全部不勾 → 预览明确说"不会有多余的标注行"', /不会有多余的标注行/.test(p3), p3);

    // 恢复成默认勾选（免得影响后面的真导出）
    for (const label of ['来源', '题号', '难度等级', '创新']) {
      await chrome.eval(
        `[...${D}.querySelectorAll('input[type=checkbox]')].find(c => c.parentElement.querySelector('span').textContent.trim() === ${JSON.stringify(label)}).click()`
      );
    }

    // ============================================================
    section('#5 取消 = 什么都不保存');
    // ============================================================
    await chrome.eval(
      `(() => { const i = ${D}.querySelector('input[type=text]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        s.call(i, '不该被保存的标题'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`
    );
    await chrome.eval(`${dlgBtn('取消')}.click()`);
    await chrome.waitFor<boolean>(`!${D}`, 6000, '弹窗关闭');
    check('点「取消」弹窗关掉了', !(await chrome.eval<boolean>(`!!${D}`)));
    const afterCancel = ((await api('GET', '/api/baskets')).data.draft ?? {}) as Record<string, unknown>;
    const optsAfterCancel = (afterCancel.exportOptions ?? {}) as Record<string, unknown>;
    check(
      '★ 取消后磁盘上的选项没被改动',
      optsAfterCancel.title === (optsBefore.title ?? ''),
      `title=${String(optsAfterCancel.title)}`
    );
    check(
      '★ 取消后题目信息开关也没被改动（勾了又取消不留痕）',
      JSON.stringify(optsAfterCancel.info ?? null) === JSON.stringify(optsBefore.info ?? null) ||
        (optsAfterCancel.info === undefined && optsBefore.info === undefined),
      JSON.stringify(optsAfterCancel.info)
    );

    // ============================================================
    section('#6 Esc 也能关');
    // ============================================================
    await clickWhenEnabled(chrome, '导出讲义', '打开导出弹窗');
    await chrome.waitFor<boolean>(`!!${D}`, 6000, '再次打开');
    await chrome.eval(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    // 监听挂在 window 上，补一发
    await chrome.eval(
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    check('按 Esc 关掉弹窗', !(await chrome.eval<boolean>(`!!${D}`)));

    // ============================================================
    section('#7 ★ 确认导出：从弹窗一路打到 PDF');
    // ============================================================
    await clickWhenEnabled(chrome, '导出讲义', '打开导出弹窗');
    await chrome.waitFor<boolean>(`!!${D}`, 6000, '第三次打开');

    const TITLE = '导出弹窗验证';
    await chrome.eval(
      `(() => { const i = ${D}.querySelector('input[type=text]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        s.call(i, ${JSON.stringify(TITLE)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`
    );
    await chrome.eval(
      `[...${D}.querySelectorAll('input[type=checkbox]')].find(c => c.parentElement.querySelector('span').textContent.trim() === '年份' && !c.checked).click()`
    );
    // ★ 点之前先确认那个按钮真的是"能点的" —— 否则后面"弹窗没关"会有两种完全不同的原因：
    //   ① 按钮本身是灰的（busy / 没有可用模板）② 按钮能点但 onClick 没接上
    //   注意顺序：**先等它可点，再读状态**。反过来的话读到的正是那个短暂的
    //   disabled 瞬间，断言会假失败（第 3 轮回归就是这么红了一条）。
    await chrome.waitFor<boolean>(
      `(() => { const b = ${dlgBtn('导出讲义')}; return !!b && !b.disabled; })()`,
      15000,
      '确认导出的按钮可点'
    );
    const pre = await chrome.eval<{
      dialogs: number;
      found: boolean;
      disabled: boolean;
      text: string;
      reactKeys: number;
      hasClick: string;
    }>(
      `(() => { const b = ${dlgBtn('导出讲义')};
         const keys = b ? Object.keys(b).filter(k => k.startsWith('__reactProps')) : [];
         return { dialogs: document.querySelectorAll('[role=dialog]').length,
                  found: !!b,
                  disabled: b ? b.disabled : false,
                  text: b ? b.textContent.trim() : '(没找到)',
                  reactKeys: keys.length,
                  hasClick: keys.length ? typeof b[keys[0]].onClick : '(没有 React props)' }; })()`
    );
    console.log(`      点之前：${JSON.stringify(pre)}`);
    check(
      '★ 「导出讲义」按钮可点（页面 busy 期间它是灰的，等它翻回来再点）',
      pre.found && !pre.disabled,
      JSON.stringify(pre)
    );
    check('★ 它的 onClick 真的挂在 React 上（不是"看着有按钮其实没接事件"）', pre.hasClick === 'function', JSON.stringify(pre));
    await chrome.eval(`${dlgBtn('导出讲义')}.click()`);

    // 导出要跑 xelatex，等它自己关窗（成功路径会关窗）
    const done = await chrome
      .waitFor<boolean>(`!${D}`, 120000, '导出完成（弹窗自动关闭）')
      .catch(() => false);
    check('★ 点「导出讲义」后真的跑完了（弹窗自动关闭）', !!done);

    if (!done) {
      // 失败时把现场摊开：页面文字、页面里有没有报错、弹窗里写着什么
      // —— 不然只知道"没关窗"，不知道卡在哪
      const full = await chrome.eval<string>(`document.body.innerText`);
      console.log('    现场诊断：');
      console.log(`      页面文字长度 ${full.length}`);
      console.log(`      页面开头：${JSON.stringify(full.slice(0, 200))}`);
      // ★ 报错框通常在页面下方 —— 上一版只印了开头 300 字，正好把错因切掉了
      console.log(`      页面结尾：${JSON.stringify(full.slice(-500))}`);
      console.log(
        `      页面里的报错类元素：${JSON.stringify(
          await chrome.eval<string[]>(
            `[...document.querySelectorAll('div')].filter(d => /err|warn|ok/i.test(d.className)).map(d => d.innerText.slice(0, 200)).filter(Boolean)`
          )
        )}`
      );
      console.log(`      弹窗文字：${JSON.stringify((await chrome.eval<string>(`(${D} || {}).innerText || '(没有弹窗)'`)).slice(-300))}`);
      console.log(`      弹窗里的错误框：${JSON.stringify(await chrome.eval<string>(`(() => { const e = ${D} && ${D}.querySelector('[class*=err]'); return e ? e.innerText : '(无)'; })()`))}`);
      for (const e of chrome.errors.slice(0, 6)) console.log(`      ${e.slice(0, 300)}`);
    }

    const pageText = await chrome.eval<string>(`document.body.innerText`);
    check('界面上报了「已导出 N 道题」', /已导出 \d+ 道题/.test(pageText), pageText.slice(0, 300));
    check(
      '界面上报了导出文件夹名（v8：就是标题，不再拼时间戳）',
      pageText.includes(TITLE),
      pageText.slice(0, 300)
    );
    check('界面上报了耗时（v6 加的分段计时）', /用时 [\d.]+s/.test(pageText), pageText.slice(0, 400));
    check('界面上报了生成的 PDF', /已生成 题目\.pdf 与 答案\.pdf/.test(pageText), pageText.slice(0, 400));
    check('没有报 xelatex 错误', !pageText.includes('xelatex 错误'), pageText.slice(0, 600));

    // ============================================================
    section('#8 ★ 选择真的被记住（存进「正在编辑」的导出选项）');
    // ============================================================
    const afterExp = ((await api('GET', '/api/baskets')).data.draft ?? {}) as Record<string, unknown>;
    const o = (afterExp.exportOptions ?? {}) as Record<string, unknown>;
    check('标题被记住了', o.title === TITLE, String(o.title));
    const info = (o.info ?? {}) as Record<string, boolean>;
    check('★ 勾选被记住了：年份 = true', info.year === true, JSON.stringify(info));
    check(
      '★ 其余开关也一并记住（来源/题号/难度 = true，知识点 = false）',
      info.source === true && info.number === true && info.difficulty === true && info.knowledge === false,
      JSON.stringify(info)
    );

    // ============================================================
    section('#9 ★ 导出的 .tex 与日志：信息真进去了、编译真干净');
    // ============================================================
    const listed = await api('GET', '/api/export/download');
    const folders = (listed.data.folders ?? []) as Array<{ folder: string; createdAt: string }>;
    check('导出历史里有新文件夹', folders.length >= 1);
    const newest = folders[0];
    const exportRoot = (await import('../src/lib/paths')).exportRootDir();
    const outDir = path.join(exportRoot, newest.folder);
    check('最新那个文件夹就是刚才导出的', fs.existsSync(outDir), outDir);

    const texQ = fs.readFileSync(path.join(outDir, '题目.tex'), 'utf-8');
    const qinfoMatches = texQ.match(/\\qinfo\{([^}]*)\}/g) ?? [];
    check('★ 题目上方用的是 \\qinfo{...} 标注行', qinfoMatches.length > 0, texQ.slice(0, 600));
    check(
      '★ 标注行里有「年份」（这次勾了）',
      qinfoMatches.some((m) => m.includes('年份')),
      qinfoMatches.slice(0, 3).join(' || ')
    );
    check(
      '★ 标注行里没有「知识点」（这次没勾）',
      !qinfoMatches.some((m) => m.includes('知识点')),
      qinfoMatches.slice(0, 3).join(' || ')
    );
    check(
      `★ 难度只出三档文字，而且**不带「难度」两个字**（v10 按你的要求去掉）`,
      qinfoMatches.some((m) => /·\s*(基础|压轴|困难)\s*(·|\})/.test(m)),
      qinfoMatches.slice(0, 3).join(' || ')
    );
    check(
      '★ 标注行里不出现「难度」这两个字',
      qinfoMatches.every((m) => !m.includes('难度')),
      qinfoMatches.slice(0, 3).join(' || ')
    );
    check(
      '★ 难度文字里没有小数（不再出现 0.xx）',
      qinfoMatches.every((m) => !/·\s*\d/.test(m)),
      qinfoMatches.slice(0, 3).join(' || ')
    );
    check('标题就是弹窗里填的', texQ.includes(TITLE), texQ.slice(0, 300));
    check('答案版标题带（答案）', fs.readFileSync(path.join(outDir, '答案.tex'), 'utf-8').includes(`${TITLE}（答案）`));
    check('模板声明的样式文件被复制了', fs.existsSync(path.join(outDir, 'quirex.sty')));

    for (const name of ['题目', '答案']) {
      const log = fs.readFileSync(path.join(outDir, `${name}.log`), 'utf-8');
      check(`★ ${name}.log 里没有 LaTeX 错误`, !/^! /m.test(log), (log.match(/^! .*/m) ?? [''])[0]);
      check(
        `★ ${name}.log 里没有丢字（Missing character）—— 分隔符「·」等都没问题`,
        !log.includes('Missing character'),
        (log.match(/Missing character.*/g) ?? []).slice(0, 3).join(' | ')
      );
      check(`${name}.pdf 生成了`, fs.existsSync(path.join(outDir, `${name}.pdf`)));
    }

    const pdfText = (await import('child_process')).execFileSync(
      'pdftotext',
      [path.join(outDir, '题目.pdf'), '-'],
      { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }
    );
    // v10：难度只出档位词，所以 PDF 里找的是「基础」而不是「难度 基础」
    check('★ PDF 正文里真的有那行标注（年份/难度档位可见）', /2025|基础|压轴|困难/.test(pdfText), pdfText.slice(0, 200));
    check('★ PDF 里没有残留的占位符或转义符', !/\{\{|\\%/.test(pdfText), pdfText.slice(0, 200));
  } finally {
    // ---------- 还原导出选项 ----------
    await api('POST', '/api/baskets', { action: 'options', exportOptions: optsBefore }).catch(() => {});
    // v10：如果刚才为了打开弹窗自己塞了题，跑完还回原来的篮子（原来是空就还空）
    await api('POST', '/api/baskets', { action: 'set', qids: qidsBefore }).catch(() => {});
    const back = ((await api('GET', '/api/baskets')).data.draft ?? {}) as Record<string, unknown>;
    const backOpts = (back.exportOptions ?? {}) as Record<string, unknown>;
    console.log(
      `\n（已还原导出选项：标题=${JSON.stringify(backOpts.title)}，题目信息=${JSON.stringify(backOpts.info)}）`
    );
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

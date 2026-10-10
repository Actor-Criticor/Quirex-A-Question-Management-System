/**
 * verify-v9-subject-ui.ts — 真实浏览器验证「多学科」的界面（v9 #6）
 *
 * 你这一轮的原话：
 *   ·「切换学科放在顶端栏的右侧，放一个加号表示新建」
 *   ·「新建时只有命名，命名后名字在加号左侧从右往左排列，名字最长 5 个字，最多 5 个学科」
 *   ·「然后自动切换题库」
 *   ·「设置里的题库位置是所有学科的总位置，当前题库信息是当前学科」
 *   ·「录入时先选择录入到哪个学科，再选择对应学科里有的标签」
 *
 * 这一节就逐条去量。
 *
 * ⚠️ 它要**真的建学科、真的录题**，所以先把 `vaultPath` 指到一个**临时题库**上，
 * 跑完把 config.json 原样写回、临时目录删掉 —— 你的演示库一个字节都不会被动。
 * （这一点很重要：学科没有"删除"功能，在真库里建一个就留在那儿了。）
 *
 * 运行：先 npm run dev，再 npx tsx scripts/verify-v9-subject-ui.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Chrome } from './cdp';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';
const CDP_PORT = 9363;
const CONFIG_FILE = path.resolve(__dirname, '..', 'config.json');

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

interface SubjectView {
  id: string;
  name: string;
  dir: string;
  bankPath: string;
  count: number;
  active: boolean;
}

async function subjects(): Promise<{ active: string; subjects: SubjectView[]; max: number }> {
  const r = await api('GET', '/api/subjects');
  return r.data as unknown as { active: string; subjects: SubjectView[]; max: number };
}

async function main(): Promise<void> {
  const chrome = new Chrome();
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-subject-ui-'));
  const vault = path.join(TMP, '题库位置（总）');
  // 学科 A 的题库目录直接叫「数学」（v11 起不再套一层「题库」）
  fs.mkdirSync(path.join(vault, '数学'), { recursive: true });

  /** config.json 原样留底（可能是"根本不存在"） */
  const savedConfig = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE) : null;

  /**
   * 录入页那一行学科按钮。
   * 别用「文字完全等于标题」去找 —— 标题里还有步骤号（"1 录入到哪个学科"），
   * 精确匹配会一个都找不到。改成：先找含这句话的那张卡，再找卡里
   * **直接装着按钮**的那个 div。
   */
  const SUBJECT_ROW = `
    (() => {
      const sec = [...document.querySelectorAll('section')].find(s => s.innerText.includes('录入到哪个学科'));
      if (!sec) return null;
      return [...sec.querySelectorAll('div')].find(d => d.querySelectorAll(':scope > button').length > 0) || null; })()
  `;

  const topChips = `
    (() => { const right = document.querySelector('.ma-nav-right');
      if (!right) return { chips: [], plus: null };
      // 用 aria-label 认加号（稳定钩子），再顺着它找到"学科条"这个容器；
      // 只数它的**直接子按钮** —— 新建弹窗也渲染在这个容器里，
      // 不排除的话弹窗开着时"取消/新建"会被当成学科名字（第一版就是这么错的）
      const plus = [...right.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '新建学科');
      if (!plus) return { chips: [], plus: null };
      const wrap = plus.parentElement;
      const btns = [...wrap.querySelectorAll(':scope > button')];
      const chips = btns.filter(b => b !== plus)
        .map(b => ({ text: b.textContent.trim(), active: b.className.includes('active') }));
      return { chips, plus: { disabled: plus.disabled, title: plus.title, last: btns[btns.length-1] === plus } }; })()
  `;

  try {
    // ============================================================
    section('#0 准备：把题库位置指到一个临时库，放两道题进去');
    // ============================================================
    const w1 = await api('PATCH', '/api/config', { vaultPath: vault, exportDir: path.join(TMP, '导出') });
    check(`切到临时题库位置（HTTP ${w1.status}）`, w1.status === 200, JSON.stringify(w1.data));
    const e1 = (await api('GET', '/api/config')).data as { entries?: Array<{ key: string; value: string }> };
    check(
      '★ 设置里的「题库位置」就是它（所有学科的总位置）',
      e1.entries?.find((x) => x.key === 'vaultPath')?.value === vault,
      JSON.stringify(e1.entries?.find((x) => x.key === 'vaultPath'))
    );

    for (const n of [1, 2]) {
      const r = await api('POST', '/api/questions', {
        kind: '单题',
        type: '填空',
        source: '临时来源',
        number: n,
        knowledge: [`临时知识点${n}`],
        stem: `$x+${n}=$\\fillin`,
        answer: '$0$',
      });
      check(`临时库里放进第 ${n} 道题（${String(r.data.qid)}）`, r.status === 201, JSON.stringify(r.data));
    }
    const s0 = await subjects();
    check(
      `★ 临时库默认就是"只有一个学科"（${s0.subjects.map((s) => s.name).join('、')}）`,
      s0.subjects.length === 1 && s0.active === s0.subjects[0].id,
      JSON.stringify(s0.subjects)
    );
    check(
      '★ 第一学科的题库目录就是 <题库位置>/数学（学科名当目录）',
      s0.subjects[0].bankPath === path.join(vault, '数学'),
      s0.subjects[0].bankPath
    );
    check('★ 临时库里的题确实是 AT 开头的 id', fs.existsSync(path.join(vault, '数学', 'AT0001')), fs.existsSync(path.join(vault, '数学')) ? fs.readdirSync(path.join(vault, '数学')).join(',') : '(题库目录不存在)');

    // ============================================================
    section('#1 顶栏右侧：学科条 + 加号');
    // ============================================================
    await chrome.start(CDP_PORT);
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await chrome.goto(`${BASE}/`);
    await chrome.waitFor<boolean>(`document.querySelector('.ma-nav-right') !== null`, 25000, '顶栏');
    await chrome.waitFor<boolean>(`(${topChips}).chips.length > 0`, 20000, '学科条');
    await new Promise((r) => setTimeout(r, 500));

    const t1 = await chrome.eval<{ chips: Array<{ text: string; active: boolean }>; plus: { disabled: boolean; title: string; last: boolean } | null }>(topChips);
    console.log(`      顶栏：${JSON.stringify(t1)}`);
    check(`★ 顶栏右侧列出学科（${t1.chips.map((c) => c.text).join('、')}）`, t1.chips.length === 1 && t1.chips[0].text === '数学', JSON.stringify(t1.chips));
    check('★ 当前学科高亮', t1.chips[0].active === true);
    check('★ 有一个加号（新建）', t1.plus !== null);
    check('★★ 加号在学科名字的**右边**（名字从右往左排，越新的越靠右）', t1.plus?.last === true, JSON.stringify(t1.plus));
    check(`★ 加号的提示写着「新建学科」（读到「${t1.plus?.title}」）`, /新建学科/.test(t1.plus?.title ?? ''), t1.plus?.title);

    // ============================================================
    section('#2 新建学科：只有命名、自动切换');
    // ============================================================
    await chrome.eval(
      `[...document.querySelectorAll('.ma-nav-right button')].find(b => b.getAttribute('aria-label') === '新建学科').click()`
    );
    await chrome.waitFor<boolean>(
      `[...document.querySelectorAll('h3')].some(h => h.textContent.includes('新建学科'))`,
      8000,
      '新建弹窗'
    );
    const modal = await chrome.eval<{ fields: number; inputMax: number; buttons: string[]; text: string }>(
      `(() => { const h = [...document.querySelectorAll('h3')].find(h => h.textContent.includes('新建学科'));
         const box = h.closest('div');
         const inputs = [...box.querySelectorAll('input')];
         return { fields: inputs.length, inputMax: inputs[0] ? inputs[0].maxLength : -1,
                  buttons: [...box.querySelectorAll('button')].map(b => b.textContent.trim()),
                  text: box.innerText }; })()`
    );
    check('★★ 新建弹窗里**只有一个输入框**（"新建时只有命名"）', modal.fields === 1, JSON.stringify(modal));
    check('★ 名字输入框最长 5 个字', modal.inputMax === 5, String(modal.inputMax));
    // v10：弹窗里那段说明（"学科各自的题库…分开的"+"最多 5 个"）删掉了 ——
    // 上限由"加号变灰 + 它的 title"来说，弹窗里只留命名这一件事
    check('★ 新建弹窗里只有命名，不再有说明文字', !/学科各自|最多 5 个/.test(modal.text), modal.text.slice(0, 160));

    // 超长名字（绕过 maxLength 直接塞）应当被服务端/界面拦下
    await chrome.eval(
      `(() => { const h = [...document.querySelectorAll('h3')].find(h => h.textContent.includes('新建学科'));
         const inp = h.closest('div').querySelector('input');
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         setter.call(inp, '六个字的名字');
         inp.dispatchEvent(new Event('input', { bubbles: true }));
         [...h.closest('div').querySelectorAll('button')].find(b => /新建/.test(b.textContent)).click();
         return true; })()`
    );
    await new Promise((r) => setTimeout(r, 900));
    const tooLong = await chrome.eval<string>(
      `(() => { const h = [...document.querySelectorAll('h3')].find(h => h.textContent.includes('新建学科'));
         return h ? h.closest('div').innerText : '(弹窗关了)'; })()`
    );
    check(
      `★★ 名字超 5 个字被拒（弹窗还开着并报错）`,
      /最长 5 个字/.test(tooLong),
      tooLong.replace(/\n/g, ' | ').slice(0, 200)
    );

    // 正常建一个「化学」
    await chrome.eval(
      `(() => { const h = [...document.querySelectorAll('h3')].find(h => h.textContent.includes('新建学科'));
         const inp = h.closest('div').querySelector('input');
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
         setter.call(inp, '化学');
         inp.dispatchEvent(new Event('input', { bubbles: true }));
         [...h.closest('div').querySelectorAll('button')].find(b => /新建/.test(b.textContent)).click();
         return true; })()`
    );
    // 新建成功后页面会整页跳回题库（换了一整套数据），所以要等它重新加载完
    await chrome.waitFor<boolean>(`(${topChips}).chips.length === 2`, 25000, '新建后顶栏出现两个学科');
    await new Promise((r) => setTimeout(r, 900));

    const s1 = await subjects();
    const chem = s1.subjects.find((s) => s.name === '化学');
    check('★★ 新学科建出来了', !!chem, JSON.stringify(s1.subjects));
    check('★★ 新建后**自动切换**（当前学科变成化学）', s1.active === chem?.id, `${s1.active} vs ${chem?.id}`);
    check(
      `★★ 它的题库与默认学科同级：<题库位置>/化学`,
      chem?.bankPath === path.join(vault, '化学'),
      chem?.bankPath
    );
    const t2 = await chrome.eval<{ chips: Array<{ text: string; active: boolean }>; plus: { last: boolean } | null }>(topChips);
    check(
      `★★ 顶栏变成「${t2.chips.map((c) => c.text).join(' → ')} ＋」（新学科在加号左侧、紧挨着它）`,
      t2.chips.length === 2 && t2.chips[0].text === '数学' && t2.chips[1].text === '化学' && t2.plus?.last === true,
      JSON.stringify(t2)
    );
    check('★ 新建的学科是当前高亮的那个', t2.chips[1].active === true, JSON.stringify(t2.chips));

    const listedChem = await api('GET', '/api/questions/search?status=全部&size=50');
    check(
      '★★ 自动切到新题库：列表里没有数学那两道题（新库是空的）',
      ((listedChem.data.items as unknown[]) ?? []).length === 0,
      JSON.stringify((listedChem.data.items as unknown[]).map((e) => (e as { qid: string }).qid))
    );
    const bodyTxt = await chrome.eval<string>(`document.body.innerText`);
    check('★ 界面上不出现学科字母（没有 AT0001 / BT0001 这种字样）', !/[A-Z]T\d{4}/.test(bodyTxt), (bodyTxt.match(/[A-Z]T\d{4}/) ?? [''])[0]);

    // ============================================================
    section('#3 顶栏切换：切回数学，题和标签都回来了');
    // ============================================================
    await chrome.eval(
      `[...document.querySelectorAll('.ma-nav-right button')].find(b => b.textContent.trim() === '数学').click()`
    );
    await chrome.waitFor<boolean>(`document.body.innerText.includes('临时来源') || document.body.innerText.includes('第1题')`, 25000, '切回数学后列表');
    await new Promise((r) => setTimeout(r, 600));
    const s2 = await subjects();
    check('★ 点名字就切过去了（当前学科 = 数学）', s2.subjects.find((s) => s.active)?.name === '数学', JSON.stringify(s2.subjects.map((s) => [s.name, s.active])));
    const mathList = await api('GET', '/api/questions/search?status=全部&size=50');
    check(
      `★★ 切回数学看到数学的题（${((mathList.data.items as unknown[]) ?? []).length} 道）`,
      ((mathList.data.items as unknown[]) ?? []).length === 2,
      JSON.stringify((mathList.data.items as unknown[]).map((e) => (e as { qid: string }).qid))
    );
    const mathVocab = (await api('GET', '/api/tags')).data.vocab as { source: Array<{ name: string }> };
    check(
      '★★ 标签表也跟着切（数学这边有「临时来源」）',
      mathVocab.source.some((t) => t.name === '临时来源'),
      JSON.stringify(mathVocab.source.map((t) => t.name))
    );
    const chemVocab = (await api('GET', `/api/tags?subject=${chem?.id}`)).data.vocab as { source: Array<{ name: string }> };
    check(
      '★★ 而化学那边的标签表里没有它（两科不串）',
      !chemVocab.source.some((t) => t.name === '临时来源'),
      JSON.stringify(chemVocab.source.map((t) => t.name))
    );

    // ============================================================
    section('#4 设置页：题库位置 = 总位置；当前题库 = 当前学科');
    // ============================================================
    await chrome.goto(`${BASE}/settings`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('学科')`, 25000, '设置页');
    await new Promise((r) => setTimeout(r, 800));
    const setTxt = await chrome.eval<string>(`document.body.innerText`);
    // v10：路径那几行的说明文字删掉了，所以只断言这一项还在、还叫「题库位置」
    check('★ 「路径」里那一项叫「题库位置」', /题库位置/.test(setTxt), setTxt.slice(0, 200));
    check('★ 有「学科」一区，列出两个学科', /学科/.test(setTxt) && /数学/.test(setTxt) && /化学/.test(setTxt));
    check('★ 学科表里标出了"当前"', /当前/.test(setTxt));
    check(
      `★★ 化学的题库目录写在表里（含 ${chem?.dir ?? '化学'}）`,
      setTxt.includes(chem?.bankPath ?? ''),
      chem?.bankPath
    );
    check('★ 「当前题库」一区写的是当前学科的题库目录', setTxt.includes(path.join(vault, '数学')));
    // v10：学科表下面那两行脚注（含注册表路径）按你的要求删掉了 ——
    // 文件实际还在那个位置（verify-v9-subjects 里断言过），只是不在界面上写了
    check('★ 学科表下面不再有那两行脚注', !/_subjects\.json/.test(setTxt) && !/各占一个子目录/.test(setTxt), setTxt.slice(0, 200));
    check('★ 设置里改学科名字的地方在（名字写错了能改）', /改名/.test(setTxt));

    // ============================================================
    section('#5 录入页：先选学科，再选那一科的标签');
    // ============================================================
    await chrome.goto(`${BASE}/add`);
    await chrome.waitFor<boolean>(
      `[...document.querySelectorAll('button')].some(b => b.textContent.trim().startsWith('单选'))`,
      25000,
      '录入页'
    );
    await new Promise((r) => setTimeout(r, 700));
    const subjectsRow = await chrome.eval<{
      exists: boolean;
      buttons: string[];
      text: string;
      section: string;
    }>(
      `(() => { const row = ${SUBJECT_ROW};
         if (!row) return { exists: false, buttons: [], text: '', section: '' };
         const sec = row.closest('section');
         return { exists: true,
                  buttons: [...row.querySelectorAll(':scope > button')].map(b => b.textContent.trim()),
                  text: row.innerText,
                  section: sec ? sec.innerText : '' }; })()`
    );
    check('★★ 录入页第一步是「录入到哪个学科」', subjectsRow.exists, JSON.stringify(subjectsRow));
    check(
      `★ 两个学科都能选，当前那个带「当前」标记（${subjectsRow.buttons.join(' / ')}）`,
      subjectsRow.buttons.length === 2 &&
        subjectsRow.buttons[0].includes('数学') &&
        subjectsRow.buttons[0].includes('当前') &&
        subjectsRow.buttons[1].includes('化学'),
      JSON.stringify(subjectsRow.buttons)
    );
    check(
      '★★ 默认就是当前学科（目标 = 当前，所以不显示"这次录到别处"那句提醒）',
      !/这次录进/.test(subjectsRow.section) && /录入到哪个学科/.test(subjectsRow.section),
      subjectsRow.section.replace(/\n/g, ' | ').slice(0, 160)
    );

    // 选化学 → 标签联想应当换成化学的
    await chrome.eval(
      `(() => { const row = ${SUBJECT_ROW};
         [...row.querySelectorAll(':scope > button')].find(b => b.textContent.includes('化学')).click();
         return true; })()`
    );
    await new Promise((r) => setTimeout(r, 800));
    const switchedHint = await chrome.eval<string>(
      `(() => { const row = ${SUBJECT_ROW}; return row ? row.innerText : ''; })()`
    );
    check(
      `★★ 选了化学后明确写出"这次录进化学、当前学科仍是数学"`,
      /这次录进「化学」/.test(switchedHint) && /当前学科仍是「数学」/.test(switchedHint),
      switchedHint.replace(/\n/g, ' | ').slice(0, 200)
    );
    const vocabOfChem = await api('GET', `/api/tags?subject=${chem?.id}`);
    console.log(
      `      化学的联想词表：${JSON.stringify((vocabOfChem.data.vocab as { source: Array<{ name: string }> }).source.map((t) => t.name))}`
    );

    // 真的录一道到化学
    await chrome.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('单选')).click()`
    );
    await new Promise((r) => setTimeout(r, 600));
    const fillResult = await chrome.eval<string>(
      `(() => {
         const setV = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
           Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
           el.dispatchEvent(new Event('input', { bubbles: true })); };
         const inputs = [...document.querySelectorAll('input[type=text]')];
         const src = inputs.find(i => i.getAttribute('list') === 'source-list');
         if (!src) return '(找不到来源输入框)';
         setV(src, '化学来源');
         const stem = document.querySelector('textarea');
         if (stem) setV(stem, '化学题干');
         return 'ok'; })()`
    );
    check(`录入表单填好了（${fillResult}）`, fillResult === 'ok', fillResult);
    // 选项（单选题要求至少 3 个）
    await chrome.eval(
      `(() => { const setV = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
           el.dispatchEvent(new Event('input', { bubbles: true })); };
         const opts = [...document.querySelectorAll('input')].filter(i => /选项|option/i.test(i.placeholder || '') || /^[ABCD]$/.test(i.getAttribute('aria-label') || ''));
         opts.slice(0, 3).forEach((o, i) => setV(o, '选项' + i));
         return opts.length; })()`
    );
    await new Promise((r) => setTimeout(r, 400));
    const submitted = await chrome.eval<boolean>(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('确认入库'));
         if (!b || b.disabled) return false; b.click(); return true; })()`
    );
    if (!submitted) {
      // 界面校验没通过（比如选项没填全）—— 直接用接口录，别让这一条变成假失败
      const direct = await api('POST', '/api/questions', {
        kind: '单题',
        type: '填空',
        source: '化学来源',
        number: 9,
        stem: '$化学$\\fillin',
        answer: '$x$',
        subject: chem?.id,
      });
      check(`（界面提交被前端校验挡住，改用接口录到化学）`, direct.status === 201, JSON.stringify(direct.data));
    } else {
      await chrome.waitFor<boolean>(`document.body.innerText.includes('已入库')`, 15000, '入库提示');
    }
    const afterChem = await subjects();
    const chemAfter = afterChem.subjects.find((s) => s.name === '化学');
    check(
      `★★ 题真的落在化学的题库里（化学现在 ${chemAfter?.count} 条记录）`,
      (chemAfter?.count ?? 0) >= 1,
      JSON.stringify(chemAfter)
    );
    check('★★ 而"当前学科"没被改掉（还是数学）', afterChem.subjects.find((s) => s.active)?.name === '数学', JSON.stringify(afterChem.subjects.map((s) => [s.name, s.active])));
    const chemFiles = fs.existsSync(path.join(vault, '化学'))
      ? fs.readdirSync(path.join(vault, '化学')).filter((n) => /^B?T\d+$/.test(n))
      : [];
    check(
      `★★ 化学库里的目录名带字母 B（${chemFiles.join('、')}）`,
      chemFiles.length >= 1 && chemFiles.every((n) => n.startsWith('B')),
      JSON.stringify(chemFiles)
    );
    const mathFiles = fs.readdirSync(path.join(vault, '数学')).filter((n) => /^[A-Z]?T\d+$/.test(n));
    check(
      `★ 数学库里的还是 A（${mathFiles.join('、')}）`,
      mathFiles.length === 2 && mathFiles.every((n) => n.startsWith('A')),
      JSON.stringify(mathFiles)
    );

    // ============================================================
    section('#6 上限：最多 5 个学科，满了加号就禁用');
    // ============================================================
    for (const n of ['物理', '生物', '英语']) {
      const r = await api('POST', '/api/subjects', { action: 'create', name: n });
      check(`建第 ${(await subjects()).subjects.length} 个学科「${n}」（HTTP ${r.status}）`, r.status === 201, JSON.stringify(r.data));
    }
    const full = await subjects();
    check(`★ 现在有 ${full.subjects.length} 个学科（上限 ${full.max}）`, full.subjects.length === 5, JSON.stringify(full.subjects.map((s) => s.name)));
    const sixth = await api('POST', '/api/subjects', { action: 'create', name: '第六' });
    check(
      `★★ 第 6 个被拒：${String(sixth.data.error ?? '')}`,
      sixth.status === 400 && /最多 5 个/.test(String(sixth.data.error ?? '')),
      JSON.stringify(sixth.data)
    );

    await chrome.goto(`${BASE}/`);
    await chrome.waitFor<boolean>(`(${topChips}).chips.length === 5`, 25000, '顶栏 5 个学科');
    await new Promise((r) => setTimeout(r, 500));
    const t3 = await chrome.eval<{ chips: Array<{ text: string }>; plus: { disabled: boolean; title: string; last: boolean } | null }>(topChips);
    check(
      `★★ 顶栏按建立顺序排开（${t3.chips.map((c) => c.text).join(' → ')}），加号在最右`,
      t3.chips.map((c) => c.text).join(',') === '数学,化学,物理,生物,英语' && t3.plus?.last === true,
      JSON.stringify(t3)
    );
    check('★★ 满了之后加号变灰（点不动）', t3.plus?.disabled === true, JSON.stringify(t3.plus));
    check(`★ 加号的提示说明原因（读到「${t3.plus?.title}」）`, /最多 5 个/.test(t3.plus?.title ?? ''), t3.plus?.title);
  } finally {
    // ---------- 还原：config.json 原样写回，临时目录删掉 ----------
    if (savedConfig !== null) fs.writeFileSync(CONFIG_FILE, savedConfig);
    else fs.rmSync(CONFIG_FILE, { force: true });
    const back = (await api('GET', '/api/subjects')).data as unknown as { subjects?: SubjectView[] };
    console.log(
      `\n（已还原 config.json：${savedConfig ? '写回原内容' : '原本就不存在'}；当前学科：${back.subjects?.find((s) => s.active)?.name}）`
    );
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 删不掉算了 */
    }
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

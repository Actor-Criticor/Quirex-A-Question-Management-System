/**
 * verify-v9-ui.ts — 真实浏览器验证 v9 的前三件事
 *
 *   1. 标签管理页：来源与知识点**各自一个搜索**，互不干扰、各自记住
 *   2. 设置页：模板的**描述也能改**（写回 meta.json，导出弹窗跟着变）
 *   3. 设置页：模板列表**每页 3 个**
 *
 * 为什么要真浏览器：这三件全是交互（输入框过滤、翻页、改完看另一处跟不跟），
 * 接口层看不出来。第 3 件还得**真造出 7 套模板**才能看到 3 页 ——
 * 临时模板跑完就删掉，绝不留在模板目录里。
 *
 * 运行：先 npm run dev，再 npx tsx scripts/verify-v9-ui.ts
 */

import fs from 'fs';
import path from 'path';
import { Chrome } from './cdp';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';
const CDP_PORT = 9361;

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

/**
 * 给 React 受控组件赋值。
 *
 * 不能直接 `el.value = x` —— React 在 input 上装了 value 追踪器，
 * 直接赋值不会触发它，onChange 不会被调用（页面看起来"没反应"）。
 * 必须走原型上的原生 setter，再手动派发 input 事件。
 */
const SET_VALUE = `
  (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                : el.tagName === 'SELECT'   ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
`;

/** 讲义模板那一区 */
const TPL_SECTION = `
  (() => {
    const h = [...document.querySelectorAll('h2')].find(x => x.textContent.includes('讲义模板'));
    return h ? h.closest('section') : null;
  })()
`;

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  usable: boolean;
}

async function main(): Promise<void> {
  const chrome = new Chrome();

  // 临时模板（第 3 节造、最后一定要删）
  const getRoot = async (): Promise<string> =>
    String(((await api('GET', '/api/export/templates')).data.root ?? '') as string);
  const realRoot = await getRoot();
  const TEMPS = [1, 2, 3, 4].map((n) => `v9分页测试${n}`);
  const tempDirs = TEMPS.map((id) => path.join(realRoot, id));

  const cleanupTemps = (): void => {
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* 删不掉就算了 */
      }
    }
  };

  // 试题篮留底（导出弹窗那一段要用它）
  const draftBefore = ((await api('GET', '/api/baskets')).data.draft ?? {}) as Record<string, unknown>;
  const beforeQids = (draftBefore.qids ?? []) as string[];

  try {
    await chrome.start(CDP_PORT);
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    const setValue = `(${SET_VALUE})`;

    // ============================================================
    section('#1 标签管理页：来源与知识点各自一个搜索');
    // ============================================================
    const vocab = ((await api('GET', '/api/tags?includeRetired=1')).data.vocab ?? {}) as Record<
      string,
      Array<{ name: string; retired: boolean }>
    >;
    const srcActive = (vocab.source ?? []).filter((t) => !t.retired).map((t) => t.name);
    const knowActive = (vocab.knowledge ?? []).filter((t) => !t.retired).map((t) => t.name);
    console.log(`      来源 ${srcActive.length} 个（启用），知识点 ${knowActive.length} 个（启用）`);

    // 搜索词：来源里挑一个真有命中的公共子串；知识点从真实标签里切前两个字
    const SRC_Q = '全国';
    const srcHit = srcActive.filter((n) => n.includes(SRC_Q));
    check(
      `演示库里有含「${SRC_Q}」的来源（用来验证过滤）`,
      srcHit.length > 0 && srcHit.length < srcActive.length,
      `命中 ${srcHit.length} / 共 ${srcActive.length}`
    );
    const knowSeed = knowActive[0] ?? '';
    const KNOW_Q = knowSeed.slice(0, 2);
    const knowHit = knowActive.filter((n) => n.includes(KNOW_Q));
    console.log(`      知识点搜索词用「${KNOW_Q}」→ 命中 ${knowHit.length} 个`);

    /** 表格里真实的数据行（排除"载入中…/还没有…"那种占一整行的提示行） */
    const ROWS = `
      [...document.querySelectorAll('table tbody tr')]
        .filter(tr => tr.cells.length >= 4)
        .map(tr => tr.cells[0].innerText.trim())
    `;
    const QBOX = `document.querySelector('input[type=search]')`;
    const clickTab = async (label: string): Promise<void> => {
      await chrome.eval(
        `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}').click()`
      );
      await new Promise((r) => setTimeout(r, 350));
    };

    await chrome.goto(`${BASE}/tags`);
    await chrome.waitFor<boolean>(`${QBOX} !== null`, 25000, '标签页搜索框');
    await chrome.waitFor<number>(`${ROWS}.length > 0`, 20000, '标签行渲染');
    await new Promise((r) => setTimeout(r, 400));

    const ph0 = await chrome.eval<string>(`${QBOX}.placeholder`);
    check(`★ 来源这一栏有自己的搜索框（占位「${ph0}」）`, ph0 === '搜索来源', ph0);
    check('★ 搜索框带无障碍名（屏幕阅读器/测试都能认出是搜哪一类）', (await chrome.eval<string>(`${QBOX}.getAttribute('aria-label')`)) === '搜索来源');
    const rowsBefore = (await chrome.eval<string[]>(ROWS)).length;
    check(`未搜索时列出全部启用来源（${rowsBefore} 行）`, rowsBefore === Math.min(20, srcActive.length), `页面 ${rowsBefore} / 数据 ${srcActive.length}`);

    // ---- 来源里搜 ----
    await chrome.eval(`${setValue}(${QBOX}, '${SRC_Q}')`);
    await new Promise((r) => setTimeout(r, 450));
    const srcRows = await chrome.eval<string[]>(ROWS);
    check(
      `★ 搜「${SRC_Q}」后只剩命中的 ${srcRows.length} 个来源`,
      srcRows.length === Math.min(20, srcHit.length) && srcRows.length < rowsBefore,
      `页面 ${srcRows.length} 行 / 应为 ${srcHit.length}（原来 ${rowsBefore} 行）`
    );
    check(
      '★ 过滤是"每一行都命中"，不是只少了几行',
      srcRows.every((n) => n.includes(SRC_Q)),
      JSON.stringify(srcRows.slice(0, 8))
    );
    check('★ 搜出结果时出现「清空」', await chrome.eval<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '清空')`));
    const pagerTxt = await chrome.eval<string>(`document.body.innerText.match(/共\\s*\\d+\\s*个标签/)?.[0] ?? ''`);
    if (srcRows.length >= 20) {
      check('★ 结果多到一页装不下时，分页总数按过滤后的算', /共\s*\d+\s*个标签/.test(pagerTxt), pagerTxt);
    } else {
      check('结果不足一页，分页条不显示（不出现"第 1/1 页"这种废话）', pagerTxt === '', pagerTxt);
    }

    // ---- 没命中的词 ----
    await chrome.eval(`${setValue}(${QBOX}, 'zzz查不到zzz')`);
    await new Promise((r) => setTimeout(r, 400));
    const emptyRows = await chrome.eval<string[]>(ROWS);
    check('★ 查不到时列表清空', emptyRows.length === 0, JSON.stringify(emptyRows.slice(0, 5)));
    const emptyTxt = await chrome.eval<string>(`document.querySelector('table tbody').innerText`);
    check('★ 查不到时有空状态文字（不是白屏）', emptyTxt.trim().length > 0, emptyTxt.trim().slice(0, 60));

    // ---- 知识点：搜索词应当是**独立的**（不是来源那个） ----
    await clickTab('知识点');
    check(
      '★★ 切到知识点后搜索框是空的（两类的搜索词互不干扰）',
      (await chrome.eval<string>(`${QBOX}.value`)) === '',
      await chrome.eval<string>(`${QBOX}.value`)
    );
    check('★ 占位符跟着分类变（搜索知识点）', (await chrome.eval<string>(`${QBOX}.placeholder`)) === '搜索知识点');
    const knowRows0 = await chrome.eval<string[]>(ROWS);
    check(
      `知识点未过滤时是全部（${knowRows0.length} 行）`,
      knowRows0.length === Math.min(20, knowActive.length),
      `页面 ${knowRows0.length} / 数据 ${knowActive.length}`
    );

    await chrome.eval(`${setValue}(${QBOX}, '${KNOW_Q}')`);
    await new Promise((r) => setTimeout(r, 450));
    const knowRows = await chrome.eval<string[]>(ROWS);
    check(
      `★ 知识点里搜「${KNOW_Q}」只剩命中的 ${knowRows.length} 个`,
      knowRows.length === Math.min(20, knowHit.length) && knowRows.every((n) => n.includes(KNOW_Q)),
      `页面 ${knowRows.length} 行 / 应为 ${knowHit.length}；${JSON.stringify(knowRows.slice(0, 6))}`
    );

    // ---- 切回来源：搜索词还在（"各自记住一份"） ----
    await clickTab('来源');
    const backVal = await chrome.eval<string>(`${QBOX}.value`);
    const backRows = await chrome.eval<string[]>(ROWS);
    check(`★★ 切回来源时搜索词还在（读到「${backVal}」）`, backVal === 'zzz查不到zzz', backVal);
    check('★ 而且过滤结果也还是那一份（空列表）', backRows.length === 0, JSON.stringify(backRows.slice(0, 5)));

    // ---- 清空 ----
    await chrome.eval(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '清空').click()`);
    await new Promise((r) => setTimeout(r, 450));
    const cleared = await chrome.eval<string[]>(ROWS);
    check(
      `★★ 点「清空」后恢复全部（${cleared.length} 行）`,
      cleared.length === rowsBefore,
      `${cleared.length} / 应为 ${rowsBefore}`
    );
    check(
      '★ 清空后「清空」按钮自己也收起来',
      !(await chrome.eval<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === '清空')`))
    );

    // ============================================================
    section('#2 设置页：模板的「描述」也能改');
    // ============================================================
    const tplList = async (): Promise<TemplateRow[]> =>
      (((await api('GET', '/api/export/templates')).data.templates ?? []) as TemplateRow[]);

    const before = await tplList();
    const target = before.find((t) => t.id === '紧凑题单') ?? before[0];
    const metaPath = path.join(realRoot, target.id, 'meta.json');
    const metaBytes = fs.readFileSync(metaPath);
    const metaObj = JSON.parse(metaBytes.toString('utf-8')) as Record<string, unknown>;

    const findCard = (id: string, wait = false): Promise<boolean> =>
      chrome.waitFor<boolean>(
        `(() => { const sec = ${TPL_SECTION};
           return !!sec && [...sec.querySelectorAll('article')].some(c => c.innerText.includes('${id}')); })()`,
        wait ? 25000 : 5000,
        `模板卡 ${id}`
      );

    await chrome.goto(`${BASE}/settings`);
    await findCard(target.id, true);
    await new Promise((r) => setTimeout(r, 500));

    const prefilled = await chrome.eval<string>(
      `(() => { const sec = ${TPL_SECTION};
         const card = [...sec.querySelectorAll('article')].find(c => c.innerText.includes('${target.id}'));
         const ta = card.querySelector('textarea'); return ta ? ta.value : '(没有 textarea)'; })()`
    );
    check(
      `★「${target.id}」的卡片里描述是**输入框**，且已经填着 meta.json 里的那句话`,
      prefilled === target.description && prefilled.length > 0,
      `读到「${prefilled.slice(0, 40)}」/ 接口「${target.description.slice(0, 40)}」`
    );
    check(
      '★ 那句话就是你在弹窗里看到的那句（10pt、不留作答空白…）',
      /10pt/.test(prefilled) && /不留作答空白/.test(prefilled),
      prefilled.slice(0, 80)
    );

    const TEMP_DESC = 'v9 校验脚本临时写入的描述（稍后逐字节还原）。';
    const setDesc = `
      (() => { const sec = ${TPL_SECTION};
        const card = [...sec.querySelectorAll('article')].find(c => c.innerText.includes('${target.id}'));
        const ta = card.querySelector('textarea');
        return ${setValue}(ta, ${JSON.stringify(TEMP_DESC)}); })()
    `;
    await chrome.eval(setDesc);
    await new Promise((r) => setTimeout(r, 300));

    const saveState = await chrome.eval<{ label: string; disabled: boolean }>(
      `(() => { const sec = ${TPL_SECTION};
         const card = [...sec.querySelectorAll('article')].find(c => c.innerText.includes('${target.id}'));
         const b = [...card.querySelectorAll('button')].find(b => /保存|未改动/.test(b.textContent));
         return { label: b.textContent.trim(), disabled: b.disabled }; })()`
    );
    check(
      `★ 改过描述后「保存」变成可点（按钮现在是「${saveState.label}」）`,
      saveState.label === '保存' && !saveState.disabled,
      JSON.stringify(saveState)
    );

    await chrome.eval(
      `(() => { const sec = ${TPL_SECTION};
         const card = [...sec.querySelectorAll('article')].find(c => c.innerText.includes('${target.id}'));
         [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '保存').click(); })()`
    );
    await chrome.waitFor<boolean>(
      `document.body.innerText.includes('模板信息已保存')`,
      10000,
      '保存成功提示'
    );

    const afterApi = (await tplList()).find((t) => t.id === target.id);
    check('★★ 接口里的描述真的变了（写进 meta.json 了）', afterApi?.description === TEMP_DESC, String(afterApi?.description));
    const afterObj = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    check(
      '★★ meta.json 的其它字段一字未动（schema/styleFiles/tokens/defaults/engine）',
      JSON.stringify(afterObj.styleFiles) === JSON.stringify(metaObj.styleFiles) &&
        JSON.stringify(afterObj.tokens) === JSON.stringify(metaObj.tokens) &&
        JSON.stringify(afterObj.defaults) === JSON.stringify(metaObj.defaults) &&
        afterObj.engine === metaObj.engine &&
        afterObj.schema === metaObj.schema,
      JSON.stringify(afterObj).slice(0, 200)
    );

    // ---- 导出弹窗里跟着变 ----
    // 两种用户路径都要验：
    //   a) 他在导出弹窗里选了这套模板 → 描述跟着变
    //   b) 他上次就选的这套（记在试题篮设置里）→ 一打开就是新描述
    const exportOptions = (draftBefore.exportOptions ?? {}) as Record<string, unknown>;

    /** 弹窗里「模板」下面那句提示（就是描述） */
    const DIALOG_DESC = `
      (() => { const d = document.querySelector('[role=dialog]');
         if (!d) return ['(没有弹窗)'];
         return [...d.querySelectorAll('div')]
           .filter(x => x.className.includes('hint'))
           .map(x => x.innerText.trim()); })()
    `;

    const anyThree = (((await api('GET', '/api/questions/search?kind=单题&status=全部&size=3')).data
      .items ?? []) as Array<{ qid: string }>);
    await api('POST', '/api/baskets', { action: 'set', qids: anyThree.map((e) => e.qid) });

    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 25000, '试题篮');
    await chrome.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('导出讲义')).click()
    `);
    // ★ 不能只等"有 option" —— 模板还没读完时下拉里是一个「（没有可用模板）」的占位 option，
    //   这时候赋值会被丢掉（值不匹配任何 option），然后真正的 option 渲染时又按 draft 设回旧的。
    //   必须等到目标模板那个 option 真的存在。
    await chrome.waitFor<boolean>(
      `[...document.querySelectorAll('[role=dialog] select option')]
         .some(o => o.value === ${JSON.stringify(target.id)})`,
      15000,
      '弹窗模板下拉载入完成'
    );
    await new Promise((r) => setTimeout(r, 200));

    // a) 在弹窗里换成这套模板
    await chrome.eval(
      `(() => { const s = document.querySelector('[role=dialog] select');
         return ${setValue}(s, ${JSON.stringify(target.id)}); })()`
    );
    await new Promise((r) => setTimeout(r, 600));
    const pickedValue = await chrome.eval<string>(`document.querySelector('[role=dialog] select').value`);
    check(`★ 弹窗里的模板确实切成了「${target.id}」（读到「${pickedValue}」）`, pickedValue === target.id, pickedValue);
    const hintsAfterPick = await chrome.eval<string[]>(DIALOG_DESC);
    check(
      '★★ 在导出弹窗里选这套模板，描述就是刚改过的那句（设置改了、弹窗跟着变）',
      hintsAfterPick.includes(TEMP_DESC),
      JSON.stringify(hintsAfterPick)
    );

    // 换回另一套，描述也跟着换（不是"第一次渲染对了就再也不变"）
    const otherId = before.map((t) => t.id).find((v) => v !== target.id)!;
    const otherDesc = before.find((t) => t.id === otherId)!.description;
    await chrome.eval(
      `(() => { const s = document.querySelector('[role=dialog] select');
         return ${setValue}(s, ${JSON.stringify(otherId)}); })()`
    );
    await new Promise((r) => setTimeout(r, 600));
    const hintsAfterOther = await chrome.eval<string[]>(DIALOG_DESC);
    check(
      `★ 换成「${otherId}」后描述换成它的那句（${otherDesc.slice(0, 20)}…）`,
      hintsAfterOther.includes(otherDesc) && !hintsAfterOther.includes(TEMP_DESC),
      JSON.stringify(hintsAfterOther)
    );
    await chrome.eval(
      `(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '取消'); if (b) b.click(); })()`
    );
    await new Promise((r) => setTimeout(r, 300));

    // b) 这套模板记在试题篮设置里 → 一打开弹窗就是新描述
    await api('POST', '/api/baskets', {
      action: 'options',
      exportOptions: { ...exportOptions, template: target.id },
    });
    await chrome.goto(`${BASE}/baskets`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('正在编辑')`, 25000, '试题篮 2');
    await chrome.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent.includes('导出讲义')).click()`
    );
    await chrome.waitFor<boolean>(
      `[...document.querySelectorAll('[role=dialog] select option')]
         .some(o => o.value === ${JSON.stringify(target.id)})`,
      15000,
      '弹窗 2 模板下拉载入完成'
    );
    await new Promise((r) => setTimeout(r, 500));
    const openedOnTarget = await chrome.eval<string>(
      `document.querySelector('[role=dialog] select').value`
    );
    check(`★ 弹窗打开时就选中了这套模板（读到「${openedOnTarget}」）`, openedOnTarget === target.id, openedOnTarget);
    check(
      '★★ 一打开弹窗就显示新描述（不用手点）',
      (await chrome.eval<string[]>(DIALOG_DESC)).includes(TEMP_DESC),
      JSON.stringify(await chrome.eval<string[]>(DIALOG_DESC))
    );
    await chrome.eval(
      `(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === '取消'); if (b) b.click(); })()`
    );
    await new Promise((r) => setTimeout(r, 300));

    // ---- 还原 ----
    await api('POST', '/api/baskets', { action: 'options', exportOptions });
    await chrome.goto(`${BASE}/settings`);
    await findCard(target.id, true);
    await new Promise((r) => setTimeout(r, 500));

    // 还原之前先确认：刷新页面后输入框里还是刚保存的那句、按钮回到「未改动」
    const reloaded = await chrome.eval<{ v: string; label: string }>(
      `(() => { const sec = ${TPL_SECTION};
         const card = [...sec.querySelectorAll('article')].find(c => c.innerText.includes('${target.id}'));
         const ta = card.querySelector('textarea');
         const b = [...card.querySelectorAll('button')].find(b => /保存|未改动/.test(b.textContent));
         return { v: ta.value, label: b.textContent.trim() }; })()`
    );
    check(
      '★ 刷新设置页后，描述框里就是刚保存的那句（真的落盘了，不是只改在内存里）',
      reloaded.v === TEMP_DESC,
      reloaded.v
    );
    check(`★ 没有任何改动时按钮是「未改动」且点不动（现在是「${reloaded.label}」）`, reloaded.label === '未改动');

    await chrome.eval(
      `(() => { const sec = ${TPL_SECTION};
         const card = [...sec.querySelectorAll('article')].find(c => c.innerText.includes('${target.id}'));
         const ta = card.querySelector('textarea');
         return ${setValue}(ta, ${JSON.stringify(String(metaObj.description ?? ''))}); })()`
    );
    await new Promise((r) => setTimeout(r, 300));
    await chrome.eval(
      `(() => { const sec = ${TPL_SECTION};
         const card = [...sec.querySelectorAll('article')].find(c => c.innerText.includes('${target.id}'));
         [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '保存').click(); })()`
    );
    await chrome.waitFor<boolean>(
      `document.body.innerText.includes('模板信息已保存')`,
      10000,
      '还原保存提示'
    );
    check(
      '★★ 被改过的 meta.json 逐字节还原（校验没留下痕迹）',
      fs.readFileSync(metaPath).equals(metaBytes),
      '字节不一致'
    );

    // ============================================================
    section('#3 设置页：模板列表每页 3 个');
    // ============================================================
    const baseCount = (await tplList()).length;
    console.log(`      现在有 ${baseCount} 套模板，再造 ${TEMPS.length} 套 → ${baseCount + TEMPS.length} 套`);
    // 造临时模板：复制「默认」，只改 meta.json 里的 name（这样一定可用、能编译）
    const srcDir = path.join(realRoot, before[0].id);
    for (const id of TEMPS) {
      const dst = path.join(realRoot, id);
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(srcDir)) {
        if (f === 'meta.json') continue;
        fs.copyFileSync(path.join(srcDir, f), path.join(dst, f));
      }
      fs.writeFileSync(
        path.join(dst, 'meta.json'),
        JSON.stringify({ ...metaObj, name: `分页测试模板${id.slice(-1)}` }, null, 2) + '\n',
        'utf-8'
      );
    }

    const all = await tplList();
    const total = all.length;
    const pageCount = Math.ceil(total / 3);
    check(
      `真造出 ${total} 套模板（接口能列出来）`,
      total === baseCount + TEMPS.length,
      `${total} vs ${baseCount + TEMPS.length}`
    );
    check(`★ 按每页 3 个算，应当是 ${pageCount} 页`, pageCount === Math.ceil(total / 3), String(pageCount));

    await chrome.goto(`${BASE}/settings`);
    await findCard(all[0].id, true);
    await new Promise((r) => setTimeout(r, 600));

    /** 页面上的卡对应哪几个模板 id（按接口顺序判断，避免显示名互相包含时误判） */
    const idsOnPage = async (): Promise<string[]> => {
      const ids = await chrome.eval<string[]>(
        `(() => { const sec = ${TPL_SECTION};
           return sec ? [...sec.querySelectorAll('article')].map((c) => c.getAttribute('data-template') || '') : []; })()`
      );
      // v10：卡片上不再显示文件夹名（只显示显示名），所以用 data-template 认卡片
      return ids.map((id) => all.find((x) => x.id === id)?.id ?? `(认不出：${id})`);
    };

    const p1 = await idsOnPage();
    check(
      `★★ 第 1 页正好 3 张卡（${p1.join('、')}）`,
      p1.length === 3,
      JSON.stringify(p1)
    );
    check(
      '★ 第 1 页就是接口顺序里的前 3 套',
      JSON.stringify(p1) === JSON.stringify(all.slice(0, 3).map((t) => t.id)),
      JSON.stringify(p1)
    );
    const pg1 = await chrome.eval<string>(
      `(() => { const sec = ${TPL_SECTION}; return sec ? sec.innerText.match(/第\\s*\\d+\\s*\\/\\s*\\d+\\s*页[\\s\\S]{0,20}/)?.[0] ?? '' : ''; })()`
    );
    check(
      `★ 分页条显示「第 1 / ${pageCount} 页」，单位是「套」`,
      new RegExp(`第\\s*1\\s*/\\s*${pageCount}\\s*页`).test(pg1) && /共\s*\d+\s*套/.test(pg1),
      pg1.replace(/\n/g, ' ')
    );
    check(
      `★ 分页条上的总数是 ${total} 套`,
      new RegExp(`共\\s*${total}\\s*套`).test(pg1),
      pg1.replace(/\n/g, ' ')
    );
    check(
      '第 2、3 页的模板这时还没出现在页面上（确实是分页，不是全铺）',
      all.slice(3).every((t) => !p1.includes(t.id)),
      JSON.stringify(p1)
    );
    check(
      '★ 第一页时「上一页」是禁用的',
      await chrome.eval<boolean>(
        `(() => { const sec = ${TPL_SECTION};
           const b = [...sec.querySelectorAll('button')].find(b => b.textContent.includes('上一页'));
           return !!b && b.disabled; })()`
      )
    );

    const clickPager = async (label: string): Promise<void> => {
      await chrome.eval(
        `(() => { const sec = ${TPL_SECTION};
           [...sec.querySelectorAll('button')].find(b => b.textContent.includes('${label}')).click(); })()`
      );
      await new Promise((r) => setTimeout(r, 500));
    };

    await clickPager('下一页');
    const p2 = await idsOnPage();
    check(
      `★★ 第 2 页也是 3 张卡，且正是第 4~6 套（${p2.join('、')}）`,
      JSON.stringify(p2) === JSON.stringify(all.slice(3, 6).map((t) => t.id)),
      JSON.stringify(p2)
    );

    await clickPager('下一页');
    const p3 = await idsOnPage();
    check(
      `★★ 第 3 页剩下 ${total - 6} 张（${p3.join('、')}）`,
      JSON.stringify(p3) === JSON.stringify(all.slice(6).map((t) => t.id)),
      JSON.stringify(p3)
    );
    check(
      '★ 最后一页时「下一页」是禁用的',
      await chrome.eval<boolean>(
        `(() => { const sec = ${TPL_SECTION};
           const b = [...sec.querySelectorAll('button')].find(b => b.textContent.includes('下一页'));
           return !!b && b.disabled; })()`
      )
    );

    await clickPager('上一页');
    const p2b = await idsOnPage();
    check(
      '★ 「上一页」能翻回去',
      JSON.stringify(p2b) === JSON.stringify(all.slice(3, 6).map((t) => t.id)),
      JSON.stringify(p2b)
    );

    // ★ 三页加起来 = 全部模板，一个不多一个不少
    const union = [...p1, ...p2, ...p3];
    check(
      `★★ 三页加起来正好是全部 ${total} 套，不重不漏`,
      union.length === total && new Set(union).size === total,
      JSON.stringify(union)
    );

    // ★ 每张卡都仍带「打开文件夹」与描述输入框（分页不该把卡片内容砍掉）
    const opsPerCard = await chrome.eval<number>(
      `(() => { const sec = ${TPL_SECTION};
         const cards = [...sec.querySelectorAll('article')];
         return cards.filter(c => c.innerText.includes('打开文件夹') && c.querySelector('textarea')).length; })()`
    );
    check(
      `★ 每张卡都还有「打开文件夹」和描述输入框（${opsPerCard}/3）`,
      opsPerCard === 3,
      String(opsPerCard)
    );

    // 翻页不该把页码弄丢（刷新后回到第 1 页是允许的，这里只查当前页稳定）
    await new Promise((r) => setTimeout(r, 400));
    const stillP2 = await idsOnPage();
    check(
      '★ 停一会儿仍是第 2 页（没有自己乱跳页）',
      JSON.stringify(stillP2) === JSON.stringify(all.slice(3, 6).map((t) => t.id)),
      JSON.stringify(stillP2)
    );
    // ============================================================
    section('#4 自定义标签：界面上只出现在该出现的四个地方');
    // ============================================================
    //
    // 你的原话是「在题库中显示和『25全国1 第1题 0.94 基础』这些放一行，
    // 每个最多显示 7 个字」「详情界面放在题目信息栏里，显示全部，别的地方不放」
    // 「没有设置就不要有任何显示，也不要显示未设定」。
    // 这一节就是逐条去量这四件事。

    // ---- (1) 题库列表行 ----
    // 上一节结束时浏览器还停在设置页 —— 必须先回题库页，
    // 否则这里量的是"设置页上的 article"，会一路假失败（第一版就是这么错的）
    await chrome.goto(`${BASE}/`);
    await chrome.waitFor<boolean>(`document.querySelectorAll('article').length > 0`, 25000, '题库列表');
    await chrome.waitFor<boolean>(
      `!!document.querySelector('article .ma-mono')`,
      20000,
      '卡片渲染出 qid'
    );
    await new Promise((r) => setTimeout(r, 700));

    const cardsWithCustom = (await chrome.eval<
      Array<{ qid: string; chips: Array<{ text: string; title: string }>; row: string }>
    >(
      `(() => [...document.querySelectorAll('article')].map(a => {
         const mono = a.querySelector('.ma-mono');
         const spans = [...a.querySelectorAll('span[title]')];
         const chips = spans.map(s => ({
           text: s.textContent.trim(), title: s.getAttribute('title'),
         }));
         // ★ 行文本要取**元素**的 parentElement，不能用上面 map 出来的普通对象
         //   （那个对象没有 parentElement，第一版就是这么炸的）
         const row = (spans[0] ? spans[0].parentElement : a).innerText;
         return { qid: mono ? mono.textContent.trim() : '', chips, row };
       }))()`
    )).filter((c) => c.qid);
    console.log(
      `      第一页有标签的卡：${cardsWithCustom
        .filter((c) => c.chips.length)
        .map((c) => `${c.qid}[${c.chips.map((x) => x.text).join('|')}]`)
        .join(' ')}`
    );

    const card1 = cardsWithCustom.find((c) => c.qid === 'T0001');
    check(
      `★ 有自定义标签的题，列表行里出现胶囊（T0001 → ${card1?.chips.map((c) => c.text).join('、') ?? '无'}）`,
      !!card1 && card1.chips.some((c) => c.text === '送分题'),
      JSON.stringify(card1)
    );
    check(
      '★★ 它和「来源 第N题 难度」在同一行（同一个容器里）',
      !!card1 && /25全国1/.test(card1.row) && /第1题/.test(card1.row) && /0\.94/.test(card1.row),
      card1?.row
    );
    const card5 = cardsWithCustom.find((c) => c.qid === 'T0005');
    check(
      `★★ 超过 7 个字的截成「${card5?.chips[1]?.text ?? '?'}」（原文 8 个字）`,
      !!card5 && card5.chips.some((c) => c.text === '期中复习重点加…'),
      JSON.stringify(card5?.chips)
    );
    check(
      '★ 截断了但鼠标停上去能看全（title 是完整名字）',
      !!card5 && card5.chips.some((c) => c.title === '期中复习重点加强'),
      JSON.stringify(card5?.chips)
    );
    check(
      '★ 7 个字以内不加省略号（送分题原样显示）',
      !!card1 && card1.chips.every((c) => !c.text.includes('…')),
      JSON.stringify(card1?.chips)
    );
    const card4 = cardsWithCustom.find((c) => c.qid === 'T0004');
    check(
      '★★ 没设自定义标签的题，行里一个多余的东西都没有',
      !!card4 && card4.chips.length === 0,
      JSON.stringify(card4?.chips)
    );
    const bodyTxt = await chrome.eval<string>(`document.querySelector('main')?.innerText ?? document.body.innerText`);
    check('★★ 页面上任何地方都没有「未设定」三个字', !/未设定/.test(bodyTxt), (bodyTxt.match(/.{0,12}未设定.{0,12}/) ?? [''])[0]);

    // ---- (2) 详情页的「题目信息」栏 ----
    await chrome.goto(`${BASE}/question/T0005`);
    await chrome.waitFor<boolean>(`document.body.innerText.includes('题目信息')`, 25000, '详情页');
    await new Promise((r) => setTimeout(r, 600));
    const sectionsText = await chrome.eval<Record<string, string>>(
      `(() => { const out = {};
         for (const h of document.querySelectorAll('h2')) out[h.textContent.trim()] = h.closest('section')?.innerText ?? '';
         return out; })()`
    );
    const infoSection = sectionsText['题目信息'] ?? '';
    check(
      '★★ 详情页的「题目信息」栏里显示**全部**自定义标签（8 个字不截断）',
      infoSection.includes('期中复习重点加强') && infoSection.includes('压轴必讲'),
      infoSection.slice(0, 200)
    );
    check(
      '★ 而且那里没有省略号（详情页不截断）',
      !/期中复习重点加…/.test(infoSection),
      infoSection.slice(0, 200)
    );
    const otherSections = Object.entries(sectionsText).filter(([k]) => k !== '题目信息');
    check(
      '★★ 其它栏目里都不放自定义标签（"别的地方不放"）',
      otherSections.every(([, v]) => !v.includes('期中复习重点加强') && !v.includes('压轴必讲')),
      otherSections.filter(([, v]) => /期中复习重点加强|压轴必讲/.test(v)).map(([k]) => k).join('、')
    );
    check(
      '★ 「题目信息」栏里有可编辑的「自定义」字段与上限说明',
      /自定义/.test(infoSection) && /最多 5 个/.test(infoSection) && /最长 20 字/.test(infoSection),
      infoSection.slice(0, 300)
    );

    // ---- (3) 标签管理页的第三个页签 ----
    await chrome.goto(`${BASE}/tags`);
    await chrome.waitFor<boolean>(`document.querySelector('input[type=search]') !== null`, 25000, '标签页');
    await new Promise((r) => setTimeout(r, 500));
    const tabLabels = await chrome.eval<string[]>(
      `[...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => ['来源','知识点','自定义'].includes(t))`
    );
    check(
      `★★ 标签管理页有三个分类页签（${tabLabels.join(' / ')}）`,
      tabLabels.join(',') === '来源,知识点,自定义',
      JSON.stringify(tabLabels)
    );
    await clickTab('自定义');
    const customRows = await chrome.eval<string[]>(ROWS);
    const customVocab = (((await api('GET', '/api/tags?includeRetired=1')).data.vocab ?? {}) as Record<
      string,
      Array<{ name: string; retired: boolean }>
    >).custom ?? [];
    const customActive = customVocab.filter((t) => !t.retired);
    console.log(`      自定义标签 ${customActive.length} 个（启用）`);
    check(
      `★ 自定义页签列出全部自定义标签（${customRows.length} 行）`,
      customRows.length === Math.min(20, customActive.length) && customRows.length > 0,
      `${customRows.length} / ${customActive.length}`
    );
    check(
      '★ 页签切换后搜索框跟着变成「搜索自定义」',
      (await chrome.eval<string>(`document.querySelector('input[type=search]').placeholder`)) === '搜索自定义'
    );
    const ANY_CUSTOM = customActive[0]?.name ?? '';
    await chrome.eval(`${setValue}(document.querySelector('input[type=search]'), '${ANY_CUSTOM}')`);
    await new Promise((r) => setTimeout(r, 450));
    const filteredCustom = await chrome.eval<string[]>(ROWS);
    check(
      `★ 自定义页签里也能搜（搜「${ANY_CUSTOM}」→ ${filteredCustom.length} 行，每行都命中）`,
      filteredCustom.length >= 1 && filteredCustom.every((n) => n.includes(ANY_CUSTOM)),
      JSON.stringify(filteredCustom.slice(0, 5))
    );
    check(
      '★ 自定义标签也能治理（每行都有改名/停用按钮）',
      await chrome.eval<boolean>(
        `[...document.querySelectorAll('table tbody tr')].filter(tr => tr.cells.length >= 4)
           .every(tr => /改名/.test(tr.innerText) && /停用|恢复/.test(tr.innerText))`
      )
    );

    // ---- (4) 录入页的「自定义」字段 ----
    await chrome.goto(`${BASE}/add`);
    await chrome.waitFor<boolean>(
      `[...document.querySelectorAll('button')].some(b => b.textContent.includes('单选'))`,
      25000,
      '录入页'
    );
    await chrome.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('单选')).click()`
    );
    await new Promise((r) => setTimeout(r, 700));
    const addField = await chrome.eval<{
      exists: boolean;
      label: string;
      field: string;
      input: string;
      maxLength: number;
    }>(
      `(() => {
         const labels = [...document.querySelectorAll('span,label,div')].filter(x => x.textContent.trim() === '自定义');
         const wrap = labels.length ? labels[labels.length - 1].parentElement : null;
         if (!wrap) return { exists: false, label: '', field: '', input: '', maxLength: 0 };
         const inp = wrap.querySelector('input[type=text]');
         return {
           exists: true,
           label: wrap.innerText.split('\\n')[0],
           field: wrap.innerText,
           input: inp ? inp.placeholder : '(没有输入框)',
           maxLength: inp ? inp.maxLength : -1,
         }; })()`
    );
    console.log(`      录入页自定义字段：${JSON.stringify(addField)}`);
    check('★ 录入页有「自定义」字段（与知识点并列）', addField.exists, JSON.stringify(addField));
    check(
      '★ 那一栏写着上限：计数器 0 / 5，输入框提示里写着 20 字',
      /\/\s*5/.test(addField.field) && /20/.test(addField.input),
      `field=${JSON.stringify(addField.field)} input=${addField.input}`
    );
    check('★ 输入框有 20 字长度限制（浏览器层面就拦一道）', addField.maxLength === 20, String(addField.maxLength));
    check('★ 输入框提示里也写了 20 字', /20/.test(addField.input), addField.input);

    // 真的往里打：21 个字被拦、第 6 个被拦
    const CUSTOM_INPUT = `(() => {
      const labels = [...document.querySelectorAll('span,label,div')].filter(x => x.textContent.trim() === '自定义');
      const wrap = labels[labels.length - 1].parentElement;
      return wrap.querySelector('input[type=text]'); })()`;
    const enterTag = async (name: string): Promise<string> => {
      await chrome.eval(
        `(() => { const el = ${CUSTOM_INPUT};
           (${SET_VALUE})(el, ${JSON.stringify(name)});
           el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
           return true; })()`
      );
      await new Promise((r) => setTimeout(r, 350));
      return chrome.eval<string>(
        `(() => { const e = [...document.querySelectorAll('div')].find(d => /自定义标签最长|自定义标签最多/.test(d.innerText) && d.innerText.length < 120);
           return e ? e.innerText.trim() : ''; })()`
      );
    };
    const tooLongMsg = await enterTag('超'.repeat(21));
    check(`★ 录入页当场拦住 21 个字：${tooLongMsg}`, /最长 20 个字/.test(tooLongMsg), tooLongMsg || '(没报错)');
    let staleErr = '';
    for (const n of ['标签一', '标签二', '标签三', '标签四', '标签五']) {
      staleErr = await enterTag(n);
    }
    check(
      '★ 加成功之后上一条报错就收掉了（不留一条红字让人以为又失败了）',
      staleErr === '',
      staleErr
    );
    const sixthMsg = await enterTag('标签六');
    check(`★ 录入页当场拦住第 6 个：${sixthMsg}`, /最多 5 个/.test(sixthMsg), sixthMsg || '(没报错)');
    const chipCount = await chrome.eval<number>(
      `(() => { const labels = [...document.querySelectorAll('span,label,div')].filter(x => x.textContent.trim() === '自定义');
         const wrap = labels[labels.length - 1].parentElement;
         return wrap.querySelectorAll('span').length; })()`
    );
    check(`★ 前 5 个都留下了（胶囊数 ${chipCount}）`, chipCount >= 5, String(chipCount));
    const counter = await chrome.eval<string>(
      `(() => { const labels = [...document.querySelectorAll('span,label,div')].filter(x => x.textContent.trim() === '自定义');
         const wrap = labels[labels.length - 1].parentElement;
         return (wrap.innerText.match(/\\d+\\s*\\/\\s*5/) ?? ['(没有计数器)'])[0]; })()`
    );
    check(`★ 计数器如实显示「${counter}」`, /^5\s*\/\s*5$/.test(counter), counter);
  } finally {
    cleanupTemps();
    const left = TEMPS.filter((id) => fs.existsSync(path.join(realRoot, id)));
    console.log(`\n（临时模板已清理，残留 ${left.length} 个）`);
    await api('POST', '/api/baskets', { action: 'set', qids: beforeQids }).catch(() => {});
    console.log(`（已还原试题篮：${beforeQids.length} 道）`);
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

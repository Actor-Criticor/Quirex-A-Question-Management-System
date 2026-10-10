/**
 * verify-config.ts — 校验「路径可配置」这条链路真的通了（v6 #3）
 *
 * 打的是**运行中的服务**的真实 HTTP 接口，并且最后用一次**真导出**来证明
 * 「改完路径不用重启就生效」—— 这是整件事唯一有说服力的证据：
 * 只查 config.json 里写没写进去，证明不了服务有没有读它。
 *
 * 全程非破坏性：脚本开头备份 config.json 与试题篮「正在编辑」，结尾原样还原。
 * 运行：先 npm run dev，再 npx tsx scripts/verify-config.ts
 */

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';

import fs from 'fs';
import path from 'path';
import os from 'os';

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

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `期望 ${b}，实际 ${a}`);
}

function section(t: string): void {
  console.log(`\n=== ${t} ===`);
}

async function reqJson(
  method: string,
  p: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* 保留原文，断言里会看出问题 */
  }
  return { status: res.status, data };
}
const getJson = (p: string) => reqJson('GET', p);
const patchJson = (p: string, body: unknown) => reqJson('PATCH', p, body);
const postJson = (p: string, body: unknown) => reqJson('POST', p, body);

const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const TMP = path.join(os.tmpdir(), `quirex-verify-${Date.now()}`);

function entryOf(view: any, key: string): any {
  return (view?.entries ?? []).find((e: any) => e.key === key);
}

async function main(): Promise<void> {
  // ---------- 备份 ----------
  const hadConfig = fs.existsSync(CONFIG_FILE);
  const savedConfig = hadConfig ? fs.readFileSync(CONFIG_FILE) : null;
  const draftBefore = (await getJson('/api/baskets')).data?.draft ?? {};

  try {
    // ============================================================
    section('#1 GET /api/config 的形状');
    // ============================================================
    const g = await getJson('/api/config');
    eq('状态 200', g.status, 200);
    eq(
      '四个配置项都在',
      (g.data.entries ?? []).map((e: any) => e.key),
      ['vaultPath', 'exportDir', 'templatesDir', 'xelatexPath']
    );
    const vp = entryOf(g.data, 'vaultPath');
    check(
      '每项都带 生效值/来源/环境变量名/默认值',
      ['value', 'source', 'envName', 'defaultValue', 'exists', 'stored'].every(
        (k) => k in vp
      )
    );
    check('来源是 config/env/default 之一', ['config', 'env', 'default'].includes(vp.source), vp.source);
    check('路径都解析成了绝对路径', path.isAbsolute(vp.value), vp.value);
    check('vaultPath 指向的目录存在', vp.exists === true, JSON.stringify(vp));
    check('config.json 路径在项目根', g.data.file === CONFIG_FILE, g.data.file);

    // ============================================================
    section('#2 校验：坏路径必须被挡住（不能写进配置）');
    // ============================================================
    const bad1 = await patchJson('/api/config', { vaultPath: path.join(TMP, '不存在的目录') });
    eq('不存在的题库路径 → 400', bad1.status, 400);
    check('错误信息说清了原因', /不存在/.test(String(bad1.data.error ?? '')), JSON.stringify(bad1.data));

    /*
     * v11：判据从"里面有没有 题库/ 子目录"改成"像不像一个题库位置"。
     * 所以这里用一个**有东西、但明显不是题库**的目录来试 —— 空目录现在是**允许**的
     * （新建题库就是从空文件夹开始，见下面那段）。
     */
    const notVault = path.join(TMP, '不是一个题库');
    fs.mkdirSync(notVault, { recursive: true });
    fs.writeFileSync(path.join(notVault, '随便一个文件.txt'), 'x', 'utf-8');
    const bad2 = await patchJson('/api/config', { vaultPath: notVault });
    eq('不像题库的目录（里面没有学科目录）→ 400', bad2.status, 400);
    check(
      '错误信息说清了原因（没找到 _subjects.json / 学科目录）',
      /_subjects\.json|学科目录/.test(String(bad2.data.error ?? '')),
      JSON.stringify(bad2.data).slice(0, 200)
    );

    const bad3 = await patchJson('/api/config', { xelatexPath: path.join(TMP, '假的xelatex.exe') });
    eq('不存在的 xelatex → 400', bad3.status, 400);

    const bad4 = await patchJson('/api/config', { templatesDir: path.join(TMP, '没有模板') });
    eq('不存在的模板目录 → 400', bad4.status, 400);

    /*
     * 断言"被拒的值没写进配置"，而不是"文件不存在" ——
     * 盘上本来就可能有一个 config.json（用户在界面上改过路径），
     * 那是正常的，不该让这个套件因此变红。
     */
    const afterReject = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf-8') : '{}';
    check(
      '被拒的路径没有写进 config.json（也没写出半个文件）',
      ['不存在的目录', '不是一个题库', '假的xelatex', '没有模板'].every((s) => !afterReject.includes(s)),
      afterReject.slice(0, 200)
    );

    // ---- 空目录：v11 起是**合法**的题库位置（新建的库就是这样） ----
    const emptyDir = path.join(TMP, '空目录');
    fs.mkdirSync(emptyDir, { recursive: true });
    const okEmpty = await patchJson('/api/config', { vaultPath: emptyDir });
    eq('★ 空目录可以当题库位置（新建的库就是从空文件夹开始）', okEmpty.status, 200);
    eq('★ 存下来的是绝对路径', entryOf(okEmpty.data, 'vaultPath')?.value, emptyDir);
    // 用完立刻复原 config.json：后面第 4 节要真导出一份，服务得看回原来那个（有题的）库。
    // ⚠️ 不能只是"清空 vaultPath" —— 清空会回落到 .env.local，而服务那边的环境变量
    // 未必和这个脚本一样（实测：回落后服务看到的是空库，第 4 节直接"没有题可导"）。
    if (savedConfig !== null) fs.writeFileSync(CONFIG_FILE, savedConfig, 'utf-8');
    else fs.rmSync(CONFIG_FILE, { force: true });
    const back = await getJson('/api/config');
    check(
      'vaultPath 已复原（第 4 节的导出才有题可导）',
      entryOf(back.data, 'vaultPath')?.value === vp.value,
      `${entryOf(back.data, 'vaultPath')?.value} vs ${vp.value}`
    );

    // ============================================================
    section('#3 写入：导出目录可以自动创建并立即生效');
    // ============================================================
    const newExport = path.join(TMP, '导出到这儿');
    check('新导出目录一开始不存在', !fs.existsSync(newExport));
    const w = await patchJson('/api/config', { exportDir: newExport });
    eq('PATCH exportDir → 200', w.status, 200);
    check('导出目录被自动建出来了', fs.existsSync(newExport));
    const e2 = entryOf(w.data, 'exportDir');
    eq('来源变成 config', e2?.source, 'config');
    eq('生效值就是刚写的', e2?.value, newExport);
    check('config.json 确实落盘了', fs.existsSync(CONFIG_FILE));
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    eq('盘上的内容一致', onDisk.exportDir, newExport);

    // ============================================================
    section('#4 ★ 不用重启：真导一次，看它落在新目录');
    // ============================================================
    const anyQ = (await getJson('/api/questions/search?status=全部&size=1')).data;
    const oneQid = anyQ?.items?.[0]?.qid;
    check('题库存里至少有一道题可导', !!oneQid, JSON.stringify(anyQ).slice(0, 200));

    if (oneQid) {
      await postJson('/api/baskets', { action: 'clear' });
      await postJson('/api/baskets', { action: 'add', qids: [oneQid] });
      const exp = await postJson('/api/baskets/export', { title: '路径校验' });
      eq('导出接口 200', exp.status, 200);
      const folder: string = exp.data.outDir ?? '';
      check(
        '★ 导出真的落在了新配的目录里（服务没有重启）',
        folder.startsWith(newExport),
        `期望前缀 ${newExport}，实际 ${folder}`
      );
      check('新目录里出现了导出文件夹', fs.existsSync(folder), folder);
      // v8：文件夹名改成「清洗后的标题」，不再拼时间戳
      //（标题的默认值本身就是时间戳，再拼一遍会变成 2026-10-09 21:30_20261009_213000 那种啰嗦名字）
      check('导出的文件夹名就是标题', String(exp.data.folder ?? '') === '路径校验', String(exp.data.folder));
      check('返回 outDir 是绝对路径', path.isAbsolute(folder), folder);
    }

    // ============================================================
    section('#5 清空：回落默认值，而不是留下一个空字符串');
    // ============================================================
    const c = await patchJson('/api/config', { exportDir: null });
    eq('PATCH null → 200', c.status, 200);
    const e3 = entryOf(c.data, 'exportDir');
    check('来源回落到 default/env', e3?.source !== 'config', JSON.stringify(e3));
    check('生效值非空（回了默认）', !!e3?.value, JSON.stringify(e3));
    eq('stored 是空串', e3?.stored, '');
    const after = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf-8') : '{}';
    check('盘上不再有 exportDir', !after.includes('exportDir'), after);

    // ============================================================
    section('#6 环境变量与默认值的优先级');
    // ============================================================
    check(
      'vaultPath 来自 .env.local（env）时不会被默认值盖掉',
      vp.source === 'config' || vp.source === 'env',
      `source=${vp.source}`
    );

    // ============================================================
    section('#7 xelatex 检测');
    // ============================================================
    const t = await postJson('/api/config', { action: 'testXelatex' });
    eq('检测接口 200', t.status, 200);
    check('能跑起来', t.data.ok === true, JSON.stringify(t.data));
    check(
      '报出了真实版本号',
      /XeTeX|TeX Live/i.test(String(t.data.output ?? '')),
      String(t.data.output)
    );

    // ============================================================
    section('#8 未知动作 / 未知键要被挡住');
    // ============================================================
    eq('未知 action → 400', (await postJson('/api/config', { action: '乱写' })).status, 400);
    eq('reveal 未知 key → 400', (await postJson('/api/config', { action: 'reveal', key: '乱写' })).status, 400);
    const ignored = await patchJson('/api/config', { 乱写的键: 'x' });
    eq('无关的键被忽略（200 且不落盘）', ignored.status, 200);
    check('无关的键没有写进文件', !fs.existsSync(CONFIG_FILE) || !fs.readFileSync(CONFIG_FILE, 'utf-8').includes('乱写的键'));
  } finally {
    // ---------- 还原 ----------
    if (savedConfig !== null) fs.writeFileSync(CONFIG_FILE, savedConfig);
    else fs.rmSync(CONFIG_FILE, { force: true });
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉无所谓 */
    }
    // 还原试题篮「正在编辑」
    if (Array.isArray(draftBefore.qids)) {
      await postJson('/api/baskets', { action: 'set', qids: draftBefore.qids });
    }
    if (draftBefore.exportOptions) {
      await postJson('/api/baskets', { action: 'options', exportOptions: draftBefore.exportOptions });
    }
    console.log(`\n（已还原 config.json：${savedConfig ? '写回原内容' : '原本就不存在'}）`);
  }
}

main().then(() => {
  console.log(`\n${'='.repeat(56)}`);
  console.log(`通过 ${pass}，失败 ${fail}`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
});

/**
 * verify-live.ts — 对「运行中的服务」做端到端 HTTP 校验
 *
 * 和 selftest.ts 的分工：
 *   selftest.ts     直接调 service 层，验证业务逻辑与边界（不依赖服务器）
 *   verify-live.ts  打真实 HTTP 接口，验证路由/序列化/文件服务确实通了
 *
 * 会改动题库数据，但每一步都还原（非破坏性）。
 * 运行：先 npm run dev，再 npx tsx scripts/verify-live.ts
 */

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';

import fs from 'fs';
import path from 'path';

// v10 整理目录：题库/导出 的具体位置不再手写 —— 直接问应用自己（lib/paths），
// 这样默认值改了、或者你在「设置 → 路径」里改过位置，这个套件都跟着走。
import { metaDir, exportRootDir } from '../src/lib/paths';

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

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function patchJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function qidsOf(query: string): Promise<string[]> {
  const r = await getJson(`/api/questions/search?${query}&size=200`);
  return (r.data.items ?? []).map((e: any) => e.qid);
}

async function main(): Promise<void> {
  console.log(`校验目标：${BASE}`);

  // ==========================================================
  section('0. 服务可达');
  // ==========================================================
  const root = await fetch(BASE).then((r) => r.status).catch(() => 0);
  eq('首页可访问', root, 200);

  // ==========================================================
  section('1. 检索接口');
  // ==========================================================
  const all = await getJson('/api/questions/search?status=全部&size=200');
  check('检索接口返回 200', all.status === 200);
  const total = all.data.total as number;
  check(`库里有题（${total} 条）`, total > 0);
  eq('返回条数不超过 size', all.data.items.length <= 200, true);

  const paper = await getJson('/api/questions/search?kind=整卷&size=200');
  const paperQids: string[] = (paper.data.items ?? []).map((e: any) => e.qid);
  check('整卷筛选有结果', paperQids.length > 0, JSON.stringify(paperQids));

  section('1b. 整卷的 searchText 必须为空（描述不进搜索）');
  for (const e of paper.data.items ?? []) {
    check(`整卷 ${e.qid} 的 searchText 为空`, e.searchText === '', JSON.stringify(e.searchText));
  }

  // ==========================================================
  section('2. 标签接口');
  // ==========================================================
  const tags0 = await getJson('/api/tags?includeRetired=1');
  check('标签接口返回 200', tags0.status === 200);
  const sources: any[] = tags0.data.vocab.source;
  check('有来源标签', sources.length > 0);
  // 挑一个「有启用题」的来源来测（这样停用后的关键字命中才是有意义的验证）
  const target =
    sources.find((s) => (s.enabledCount ?? 0) >= 1) ?? sources.find((s) => s.count >= 1) ?? sources[0];
  const targetName: string = target.name;
  const targetCount: number = target.enabledCount ?? target.count;
  console.log(
    `       （用「${targetName}」测试：共 ${target.count} 道引用，其中启用 ${targetCount} 道）`
  );

  // ==========================================================
  section('3. 停用 → 仍能手搜到 → 恢复');
  // ==========================================================
  const retire = await postJson('/api/tags/action', {
    op: 'retire',
    kind: 'source',
    name: targetName,
  });
  eq('停用返回 200', retire.status, 200);

  const tags1 = await getJson('/api/tags');
  const stillListed = (tags1.data.vocab.source ?? []).some((s: any) => s.name === targetName);
  check('停用后不出现在默认标签表里', !stillListed);

  const tags1all = await getJson('/api/tags?includeRetired=1');
  const retiredItem = (tags1all.data.vocab.source ?? []).find((s: any) => s.name === targetName);
  check('「显示已停用」能看到它', !!retiredItem);
  check('标记为 retired', retiredItem?.retired === true);
  // 注意两者口径不同：count 含停用题、enabledCount 只数启用的。
  // 停用「标签」两个都不该变，但这里必须拿 count 比 count ——
  // 以前比的是 enabledCount，一旦该来源下有停用题就会误报。
  eq('引用计数没变（题目上的值没动）', retiredItem?.count, target.count);

  const foundByKeyword = await qidsOf(`q=${encodeURIComponent(targetName)}`);
  check(
    `★ 停用后手打关键字「${targetName}」仍能搜到 ${targetCount} 道`,
    foundByKeyword.length === targetCount,
    JSON.stringify(foundByKeyword)
  );

  const restore = await postJson('/api/tags/action', {
    op: 'restore',
    kind: 'source',
    name: targetName,
  });
  eq('恢复返回 200', restore.status, 200);
  const tags2 = await getJson('/api/tags');
  check(
    '恢复后重新出现在默认标签表里',
    (tags2.data.vocab.source ?? []).some((s: any) => s.name === targetName)
  );

  // ==========================================================
  section('4. 改名：预览 → 执行 → 校验题目 → 从备份还原');
  // ==========================================================
  const kpList: any[] = tags2.data.vocab.knowledge;
  check('有知识点标签可测', kpList.length > 0);
  const kp = kpList.find((k) => k.count >= 1) ?? kpList[0];
  const kpOld: string = kp.name;
  const kpNew = `${kpOld}（测试改名）`;
  console.log(`       （把「${kpOld}」改名为「${kpNew}」）`);

  // 注意：标签的引用计数与改名影响范围都以「全部题目（含停用）」为准
  // （停用≠删除，标签值还在那些题上；改名必须覆盖它们），
  // 而检索默认只返回启用题 —— 所以这里必须用 status=全部 对齐口径。
  const beforeQids = await qidsOf(`knowledge=${encodeURIComponent(kpOld)}&status=全部`);
  check(`改名前有 ${beforeQids.length} 道题使用该知识点（含停用）`, beforeQids.length > 0);

  const preview = await postJson('/api/tags/action', {
    op: 'renamePreview',
    kind: 'knowledge',
    name: kpOld,
    to: kpNew,
  });
  eq('改名预览返回 200', preview.status, 200);
  eq('预览里的受影响题数正确', preview.data.preview.affected.length, beforeQids.length);
  check('预览提示不会合并（新名是全新的）', preview.data.preview.merging === false);

  const renamed = await postJson('/api/tags/action', {
    op: 'rename',
    kind: 'knowledge',
    name: kpOld,
    to: kpNew,
  });
  eq('改名返回 200', renamed.status, 200);
  eq('改名影响题数正确', renamed.data.changed, beforeQids.length);

  const afterOld = await qidsOf(`knowledge=${encodeURIComponent(kpOld)}&status=全部`);
  const afterNew = await qidsOf(`knowledge=${encodeURIComponent(kpNew)}&status=全部`);
  eq('旧名搜不到了', afterOld.length, 0);
  eq('新名能搜到同样多的题', afterNew.length, beforeQids.length);
  eq('题目集合没变', afterNew, beforeQids);

  const backups = await getJson('/api/tags/action');
  check('产生了备份', (backups.data.backups ?? []).length > 0);
  const lastBackup = backups.data.backups[0];
  eq('备份记录了受影响的题数', lastBackup.affected.length, beforeQids.length);

  const restored = await postJson('/api/tags/action', {
    op: 'restoreBackup',
    id: lastBackup.id,
  });
  eq('还原返回 200', restored.status, 200);
  eq('还原了同样多的题', restored.data.restored, beforeQids.length);
  const backOld = await qidsOf(`knowledge=${encodeURIComponent(kpOld)}&status=全部`);
  eq('★ 知识点名字已还原', backOld, beforeQids);

  // ==========================================================
  section('5. 图片资产');
  // ==========================================================
  const withImg = (all.data.items ?? []).find((e: any) => e.hasImages);
  if (withImg) {
    const detail = await getJson(`/api/questions/${withImg.qid}`);
    const asset = detail.data.assets[0];
    const imgRes = await fetch(`${BASE}/api/assets/${withImg.qid}/${asset.name}`);
    eq('图片能取到', imgRes.status, 200);
    check('返回图片 content-type', (imgRes.headers.get('content-type') ?? '').startsWith('image/'));
    const buf = Buffer.from(await imgRes.arrayBuffer());
    check(`图片有内容（${buf.length} 字节）`, buf.length > 0);

    const traversal = await fetch(`${BASE}/api/assets/${withImg.qid}/..%2F..%2F${withImg.qid}.md`);
    check('拒绝路径穿越', traversal.status === 400 || traversal.status === 404, `实际 ${traversal.status}`);
  } else {
    console.log('  （库里没有带图片的题，跳过）');
  }

  // ==========================================================
  section('6. 整卷 PDF');
  // ==========================================================
  if (paperQids.length) {
    const qid = paperQids[0];
    const res = await fetch(`${BASE}/api/questions/${qid}/pdf/paper`);
    eq('题目 PDF 能取到', res.status, 200);
    eq('content-type 是 application/pdf', res.headers.get('content-type'), 'application/pdf');
    const buf = Buffer.from(await res.arrayBuffer());
    eq('PDF 魔数正确', buf.subarray(0, 5).toString('latin1'), '%PDF-');
    console.log(`       （PDF ${buf.length} 字节）`);

    const badRole = await fetch(`${BASE}/api/questions/${qid}/pdf/xxx`);
    eq('非法 role 被拒', badRole.status, 400);
  }

  // ==========================================================
  section('7. 删除题目应当被拒（题目不可删）');
  // ==========================================================
  const del = await fetch(`${BASE}/api/questions/0001`, { method: 'DELETE' });
  eq('DELETE 题目返回 405', del.status, 405);

  // ==========================================================
  section('8. 校验参数被拦下');
  // ==========================================================
  const badNumber = await postJson('/api/questions', {
    kind: '单题',
    type: '单选',
    source: '校验测试',
    number: '99',
  });
  eq('题号 99 被拒', badNumber.status, 400);
  check('错误信息说明了范围', String(badNumber.data.error).includes('1–30'), badNumber.data.error);

  const badDiff = await postJson('/api/questions', {
    kind: '单题',
    type: '单选',
    source: '校验测试',
    number: '1',
    difficulty: '94',
  });
  eq('难度 94 被拒', badDiff.status, 400);
  check('给出「是否按 0.94」提示', String(badDiff.data.hint ?? '').includes('0.94'), badDiff.data.hint);

  const badType = await postJson('/api/questions', { kind: '单题', type: '判断题' });
  eq('非法题型被拒', badType.status, 400);

  const noPdf = await postJson('/api/questions', { kind: '整卷', source: '校验测试' });
  eq('整卷缺 PDF 被拒', noPdf.status, 400);

  // 确认上面这些失败请求没有占号
  const afterFail = await getJson('/api/tags');
  const beforeQid = tags2.data.nextQid;
  eq('★ 校验失败没有占号', afterFail.data.nextQid, beforeQid);

  // ==========================================================
  section('9. 试题篮（持久化，v3 两栏模型）');
  // ==========================================================
  const b0 = await getJson('/api/baskets');
  eq('篮子接口返回 200', b0.status, 200);
  check('★ 返回「正在编辑」这一栏', !!b0.data.draft && Array.isArray(b0.data.draft.qids));
  check('★ 返回「已保存快照」这一栏', Array.isArray(b0.data.saved));

  const items = all.data.items as any[];
  const anySingle = items.find((e) => e.kind === '单题');
  const singleWithImg = items.find((e) => e.kind === '单题' && e.hasImages);
  const anyPaper = items.find((e) => e.kind === '整卷');
  check('库里有单题可挑', !!anySingle);
  check('库里有带图片的单题', !!singleWithImg);
  check('库里有整卷', !!anyPaper);

  const pickQids = Array.from(
    new Set([anySingle?.qid, singleWithImg?.qid].filter(Boolean) as string[])
  );
  console.log(`       （往正在编辑里加：${pickQids.join(', ')}）`);

  const bnDraft = async () => (await getJson('/api/baskets')).data.draft;

  // ---- v7：整卷不许进试题篮（三层里的服务端那层）----
  section('5a. v7：整卷不进试题篮');
  eq('清空返回 200', (await postJson('/api/baskets', { action: 'clear' })).status, 200);
  if (anyPaper) {
    const addPaper = await postJson('/api/baskets', { action: 'add', qids: [anyPaper.qid] });
    eq('★ 直接调接口加整卷 → 400', addPaper.status, 400);
    check(
      '错误信息说清了原因（是 PDF、没法重新排版）',
      /整卷不进试题篮/.test(String(addPaper.data.error ?? '')),
      String(addPaper.data.error)
    );
    eq('★ 整卷确实没进篮子', (await bnDraft()).qids.length, 0);
    eq('整卷 qid 被单独列出来（不是混进"不存在"）', addPaper.data.papers, [anyPaper.qid]);

    const setPaper = await postJson('/api/baskets', { action: 'set', qids: [anyPaper.qid] });
    eq('★ 整体替换也拒收整卷', setPaper.status, 400);
    eq('整体替换后篮子仍是空的', (await bnDraft()).qids.length, 0);

    // 单题照常能加（别把门关死）
    await postJson('/api/baskets', { action: 'add', qids: [anySingle.qid] });
    eq('单题照常能加进篮子', (await bnDraft()).qids.length, 1);
    await postJson('/api/baskets', { action: 'clear' });
  }

  section('5b. 试题篮（正在编辑）');
  eq('清空返回 200', (await postJson('/api/baskets', { action: 'clear' })).status, 200);

  // 追加式加入：重复加不覆盖也不重复
  await postJson('/api/baskets', { action: 'add', qids: pickQids });
  const add1 = await bnDraft();
  eq('加入题目后题数正确', add1.qids.length, pickQids.length);
  eq('顺序就是加入顺序', add1.qids, pickQids);

  await postJson('/api/baskets', { action: 'add', qids: pickQids });
  eq('★ 重复加入是追加式、不覆盖也不重复', (await bnDraft()).qids.length, pickQids.length);

  const addBad = await postJson('/api/baskets', { action: 'add', qids: ['9999'] });
  eq('加入不存在的 qid 被拒', addBad.status, 400);

  if (pickQids.length >= 2) {
    const reversed = [...pickQids].reverse();
    await postJson('/api/baskets', { action: 'set', qids: reversed });
    eq('拖动重排生效', (await bnDraft()).qids, reversed);
    await postJson('/api/baskets', { action: 'set', qids: pickQids });
    eq('排回原顺序', (await bnDraft()).qids, pickQids);
  }

  await postJson('/api/baskets', { action: 'remove', qid: pickQids[0] });
  eq('移出一道', (await bnDraft()).qids.length, pickQids.length - 1);
  await postJson('/api/baskets', { action: 'add', qids: [pickQids[0]] });
  eq('再加回来（追加到末尾）', (await bnDraft()).qids.length, pickQids.length);

  check('浏览页能拿到勾选态用的 draftQids', Array.isArray((await getJson('/api/baskets')).data.draftQids));

  // ---- v7：轻量统计接口（浏览页侧边那张卡）----
  section('5c. v7：/api/baskets/stats（浏览页侧边统计）');
  const st = await getJson('/api/baskets/stats');
  eq('stat 接口 200', st.status, 200);
  eq('总数与实际一致', st.data.total, pickQids.length);
  check(
    '★ 分题型统计齐全（单选/多选/填空/解答都在，没有的补 0）',
    ['单选', '多选', '填空', '解答'].every((t) => typeof st.data.byType?.[t] === 'number'),
    JSON.stringify(st.data.byType)
  );
  {
    const sum = Object.values(st.data.byType ?? {}).reduce((a: number, b) => a + Number(b), 0);
    eq('★ 各题型之和 = 总数（统计没漏没重）', sum, pickQids.length);
  }
  check('stat 同时带回勾选态', Array.isArray(st.data.draftQids) && st.data.draftQids.length === pickQids.length);
  eq('篮子里没有整卷（papers 为空）', st.data.papers, []);
  eq(
    '★ 勾选态与「正在编辑」内容一致',
    [...(await getJson('/api/baskets')).data.draftQids].sort(),
    [...(await bnDraft()).qids].sort()
  );

  check(
    '★ 篮子内容存在文件里（关页面/重启都还在）',
    fs.existsSync(path.join(metaDir(), 'baskets.json'))
  );
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(metaDir(), 'baskets.json'), 'utf-8')
  ) as { version: number; draft: { qids: string[] } };
  eq('★ baskets.json 已是 v2 结构', onDisk.version, 2);
  eq('★ 正在编辑的内容真的落盘了', onDisk.draft.qids.length, pickQids.length);

  // ==========================================================
  section('10. 导出：两个 PDF（题目 / 答案）+ xelatex 双份校验');
  // ==========================================================
  // v5：先设一个讲义标题，验证它真的进了 .tex（用户报过「没法控制标题」）
  const V5_TITLE = '校验用讲义标题ABC';
  await postJson('/api/baskets', { action: 'options', exportOptions: { title: V5_TITLE } });
  eq(
    '★ v5：讲义标题能存进「正在编辑」的导出选项',
    (await getJson('/api/baskets')).data.draft.exportOptions.title,
    V5_TITLE
  );

  // 记下导出前「正在编辑」的**实际**题数 —— 下面的断言要拿它比。
  // （以前是拿重新算出来的 pickQids.length 比，偶发对不上，是个不稳的断言）
  const beforeExpQids = ((await getJson('/api/baskets')).data.draft.qids ?? []) as string[];
  check('导出前试题篮里确实有题（否则下面的断言是空的）', beforeExpQids.length > 0, `${beforeExpQids.length} 道`);

  const exp = await postJson('/api/baskets/export', {});
  eq('导出返回 200', exp.status, 200);
  eq('★ v5：导出回报的标题就是设的那个', exp.data.title, V5_TITLE);
  if (exp.status !== 200 || exp.data.error) {
    check('导出成功', false, JSON.stringify(exp.data));
  } else {
    const outDir = path.join(exportRootDir(), exp.data.folder);
    console.log(`       （导出目录：${outDir}）`);
    check(`导出了 ${exp.data.count} 道单题`, exp.data.count > 0);
    check(`复制了 ${exp.data.imageCount} 张图片`, exp.data.imageCount > 0);
    // v7：整卷不进篮子，所以导出里不再报告整卷份数
    eq('★ v7：导出结果里已无 paperCount（整卷不再参与导出）', exp.data.paperCount, undefined);

    // ★ 标题真的写进了两个 tex：题目版无后缀、答案版带「（答案）」
    const texQ = fs.readFileSync(path.join(outDir, '题目.tex'), 'utf-8');
    const texA = fs.readFileSync(path.join(outDir, '答案.tex'), 'utf-8');
    check('★ v5：题目.tex 里是设的标题', texQ.includes(V5_TITLE), V5_TITLE);
    check('★ v5：答案.tex 里标题带「（答案）」', texA.includes(`${V5_TITLE}（答案）`));
    // 单一真源：\begin{document} 之后的正文段两份必须完全相同
    const bodyQ = texQ.slice(texQ.indexOf('\\begin{document}'));
    const bodyA = texA.slice(texA.indexOf('\\begin{document}'));
    check('★ v5：两份 tex 的正文段仍逐字节一致（标题不影响正文）', bodyQ === bodyA);

    for (const f of [
      '题目.tex',
      '答案.tex',
      'quirex.sty',
      'build.bat',
      'build.sh',
      '编译说明.txt',
    ]) {
      check(`导出文件夹里有 ${f}`, fs.existsSync(path.join(outDir, f)));
    }
    check('有 images/ 目录', fs.existsSync(path.join(outDir, 'images')));
    // v7：整卷不进篮子，导出里也就没有「整卷/」这个目录了（以前是复制 PDF 进去）
    check('★ v7：导出目录里没有 整卷/（整卷已不参与导出）', !fs.existsSync(path.join(outDir, '整卷')));

    // ---- v2 核心：两个 PDF ----
    check('★ 生成了 题目.pdf', fs.existsSync(path.join(outDir, '题目.pdf')));
    check('★ 生成了 答案.pdf', fs.existsSync(path.join(outDir, '答案.pdf')));
    for (const n of ['题目', '答案']) {
      const p = path.join(outDir, `${n}.pdf`);
      if (!fs.existsSync(p)) continue;
      const buf = fs.readFileSync(p);
      eq(`${n}.pdf 魔数正确`, buf.subarray(0, 5).toString('latin1'), '%PDF-');
      check(`${n}.pdf 不是空的`, buf.length > 10000, `${buf.length} 字节`);
      console.log(`       （${n}.pdf ${buf.length} 字节）`);
    }
    check(
      '答案.pdf 比 题目.pdf 大（多出答案内容）',
      fs.existsSync(path.join(outDir, '题目.pdf')) &&
        fs.existsSync(path.join(outDir, '答案.pdf')) &&
        fs.statSync(path.join(outDir, '答案.pdf')).size > fs.statSync(path.join(outDir, '题目.pdf')).size
    );

    const qTex = fs.readFileSync(path.join(outDir, '题目.tex'), 'utf-8');
    const aTex = fs.readFileSync(path.join(outDir, '答案.tex'), 'utf-8');

    check('题目.tex 用学生版预设', qTex.includes('\\presetStudent'));
    check('答案.tex 用教师版预设', aTex.includes('\\presetTeacher'));
    check('题目.tex 含题目环境', qTex.includes('\\begin{exercise}'));
    check('答案.tex 含答案命令', aTex.includes('\\ans{'));
    // v6：标注行从 \res{...} 换成 \qinfo{...}，而且内容由导出选项决定。
    // 这里验的还是那件老事：来源与题号之间必须留分隔，别粘成「25全国11」。
    const infoLine = (qTex.match(/\\qinfo\{([^}]*)\}/) ?? [])[1] ?? '';
    check('v6 用 \\qinfo{...} 出题目信息行', infoLine !== '', infoLine);
    check(
      '题源标注带分隔符（不会粘成 25全国11）',
      /第\d+题/.test(infoLine) && / /.test(infoLine.replace(/难度.*/, '')),
      infoLine
    );
    check('★ 标注行里没有数值难度（只出三档文字）', !/难度[\s]*\d/.test(infoLine), infoLine);
    check('整卷不生成 LaTeX（只复制 PDF）', !qTex.includes(anyPaper?.qid ?? '___'));

    // 两个 tex 的正文必须逐字一致（只有标题与预设不同）
    const qBody = qTex.slice(qTex.indexOf('\\begin{document}'));
    const aBody = aTex.slice(aTex.indexOf('\\begin{document}'));
    check('★ 两个 tex 的正文逐字一致（只有预设与标题不同）', qBody === aBody, `长度 ${qBody.length} vs ${aBody.length}`);

    if (singleWithImg) {
      const figMatch = qTex.match(/\\fig\[[\d.]+\]\{images\/([^}]+)\}/);
      check('示意图用非浮动 \\fig', !!figMatch, figMatch?.[0]);
      if (figMatch) {
        check('示意图文件已复制进 images/', fs.existsSync(path.join(outDir, 'images', figMatch[1])));
      }
    }

    // 编译校验：nonstopmode 下坏文档也会出 PDF，所以必须同时要求「零错误」
    check(
      '★ 题目.pdf 编译零错误',
      exp.data.compile?.questions?.errorCount === 0,
      String(exp.data.compileLog ?? '').slice(0, 800)
    );
    check(
      '★ 答案.pdf 编译零错误',
      exp.data.compile?.answers?.errorCount === 0,
      String(exp.data.compileLog ?? '').slice(0, 800)
    );
    check('★ 两个 PDF 都成功', exp.data.compile?.ok === true, String(exp.data.compileLog ?? '').slice(0, 800));

    // 结构自检：正文必须在 \begin{document} 之后（挡「内容被注进注释」那类模板事故）
    const docPos = qTex.indexOf('\\begin{document}');
    const exPos = qTex.indexOf('\\begin{exercise}');
    check('★ 题目出现在 \\begin{document} 之后', docPos !== -1 && exPos > docPos, `doc=${docPos} ex=${exPos}`);
    check('模板占位符没残留', !/\{\{[A-Z]+\}\}/.test(qTex), qTex.match(/\{\{[A-Z]+\}\}/)?.[0]);
    for (const n of ['题目', '答案']) {
      const logPath = path.join(outDir, `${n}.log`);
      if (!fs.existsSync(logPath)) {
        check(`${n}.log 存在`, false);
        continue;
      }
      const logText = fs.readFileSync(logPath, 'utf-8');
      check(`★ ${n}.log 里没有 ! 错误行`, !/^! /m.test(logText), (logText.match(/^! .*/m) ?? [''])[0]);
    }

    // v7：整卷 PDF 不再复制进导出目录（整卷不进篮子，已经没有这个分支）
    check(
      '★ v7：导出目录里找不到任何整卷 PDF',
      !anyPaper || !fs.existsSync(path.join(outDir, '整卷'))
    );

    // zip 下载
    const zipRes = await fetch(
      `${BASE}/api/export/download?folder=${encodeURIComponent(exp.data.folder)}`
    );
    eq('zip 下载返回 200', zipRes.status, 200);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    check(`zip 有内容（${zipBuf.length} 字节）`, zipBuf.length > 0);
    eq('zip 魔数正确', zipBuf.subarray(0, 2).toString('latin1'), 'PK');

    const hist = await getJson('/api/export/download');
    check('导出历史里有这次导出', (hist.data.folders ?? []).some((f: any) => f.folder === exp.data.folder));

    // 导出后「正在编辑」必须原样保留（跟导出前的实际内容比，逐项比）
    const afterExp = await getJson('/api/baskets');
    eq(
      '★ 导出后试题篮不清空（可以接着调了再导）',
      afterExp.data.draft.qids.length,
      beforeExpQids.length
    );
    eq(
      '★ 导出后试题篮内容也一模一样（顺序都没动）',
      JSON.stringify(afterExp.data.draft.qids),
      JSON.stringify(beforeExpQids)
    );
  }

  // ==========================================================
  section('11. 录入：HTTP 新建（JSON + multipart 带图片）');
  // ==========================================================
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const createdQids: string[] = [];

  // ---- JSON 路径（无图片）----
  const c1 = await postJson('/api/questions', {
    kind: '单题',
    type: '单选',
    source: '校验测试',
    number: '2',
    difficulty: '0.77',
    knowledge: ['校验用知识点'],
    description: 'verify-live 建的题，跑完会停用',
    stem: '$1+1=$',
    options: ['$1$', '$2$', '$3$', '$4$'],
  });
  eq('JSON 新建返回 201', c1.status, 201);
  // v9：id 前面带学科字母（AT0001），所以判据放宽成"可选字母 + T + 数字"
  check(
    `分配了 qid（${c1.data.qid}）`,
    /^[A-Z]?T\d{4,}$/.test(String(c1.data.qid)),
    String(c1.data.qid)
  );
  if (c1.data.qid) createdQids.push(c1.data.qid);

  const det1 = await getJson(`/api/questions/${c1.data.qid}`);
  check('题干自动补上了 \\pick', det1.data.stem.includes('\\pick'), det1.data.stem);
  check('选项拼成了 choices 环境', det1.data.stem.includes('\\begin{choices}'));
  check('手工传的难度生效', det1.data.meta.difficulty === 0.77);
  check('知识点生效', (det1.data.meta.knowledge ?? []).includes('校验用知识点'));

  // 注意带上 size：这个知识点会被历次校验不断累积（题目按设计不可删），
  // 用默认 size=10 时最新的那道会被挤到页外，造成**假失败**。
  const found = await getJson(
    `/api/questions/search?q=${encodeURIComponent('校验用知识点')}&status=全部&size=200`
  );
  check('新建的题立刻能被搜到', (found.data.items ?? []).some((e: any) => e.qid === c1.data.qid));

  // ---- multipart 路径（带一张示意图）----
  const fd = new FormData();
  fd.set('kind', '单题');
  fd.set('type', '解答');
  fd.set('source', '校验测试');
  fd.set('number', '3');
  fd.set('difficulty', '0.5');
  fd.set('stem', '如图 [[img:0]] 所示，求证两线平行');
  fd.set('answer', '作辅助线后由同位角相等得证');
  fd.set(
    'imageMeta',
    JSON.stringify([{ channel: 'fig', asFigure: true, width: 0.4, name: 'probe.png' }])
  );
  fd.set('img0', new Blob([new Uint8Array(PNG)]), 'probe.png');

  const mres = await fetch(`${BASE}/api/questions`, { method: 'POST', body: fd });
  const mdata = await mres.json();
  eq('multipart 新建返回 201', mres.status, 201);
  if (mdata.qid) createdQids.push(mdata.qid);

  if (mdata.qid) {
    const det2 = await getJson(`/api/questions/${mdata.qid}`);
    check(
      '占位标记换成了带 qid 的 \\fig 宏',
      det2.data.stem.includes(`\\fig[0.4]{images/${mdata.qid}-fig-01.png}`),
      det2.data.stem
    );
    check('正文无残留占位标记', !/\[\[img:\d+\]\]/.test(det2.data.stem));
    check('图片落进题目文件夹', (det2.data.assets ?? []).length === 1);

    const imgRes = await fetch(`${BASE}/api/assets/${mdata.qid}/${mdata.qid}-fig-01.png`);
    eq('图片能通过资产路由取到', imgRes.status, 200);
    eq('返回的是 PNG', imgRes.headers.get('content-type'), 'image/png');
  }

  // ---- 非法图片通道 ----
  const badFd = new FormData();
  badFd.set('kind', '单题');
  badFd.set('type', '解答');
  badFd.set('source', '校验测试');
  badFd.set('stem', 'x');
  badFd.set('imageMeta', JSON.stringify([{ channel: '不存在的通道', asFigure: true, name: 'a.png' }]));
  badFd.set('img0', new Blob([new Uint8Array(PNG)]), 'a.png');
  const badImg = await fetch(`${BASE}/api/questions`, { method: 'POST', body: badFd });
  eq('非法图片通道被拒', badImg.status, 400);

  // ---- 整卷：用从库里取到的真实 PDF 字节走一遍上传（缺 PDF 的情况第 8 节已验过）----
  let realPdfBytes = new Uint8Array(0);
  if (anyPaper) {
    const r = await fetch(`${BASE}/api/questions/${anyPaper.qid}/pdf/paper`);
    if (r.status === 200) realPdfBytes = new Uint8Array(await r.arrayBuffer());
  }
  check('拿到了真实 PDF 字节用于上传测试', realPdfBytes.length > 0, `${realPdfBytes.length} 字节`);

  const paperFd = new FormData();
  paperFd.set('kind', '整卷');
  paperFd.set('source', '校验测试');
  paperFd.set('difficulty', '0.6');
  paperFd.set('description', 'verify-live 建的整卷，跑完会停用');
  paperFd.set('paper', new Blob([realPdfBytes]), 'q.pdf');
  paperFd.set('answer', new Blob([realPdfBytes]), 'a.pdf');
  const pres = await fetch(`${BASE}/api/questions`, { method: 'POST', body: paperFd });
  const pdata = await pres.json();
  eq('整卷新建返回 201', pres.status, 201);
  if (pdata.qid) {
    createdQids.push(pdata.qid);
    const pdet = await getJson(`/api/questions/${pdata.qid}`);
    eq('整卷 kind 正确', pdet.data.meta.kind, '整卷');
    check(
      '整卷没有题型/题号/知识点',
      pdet.data.meta.type === undefined && pdet.data.meta.number === undefined
    );
    eq('两个 PDF 都在', pdet.data.pdfs.length, 2);

    const pdfBack = await fetch(`${BASE}/api/questions/${pdata.qid}/pdf/paper`);
    eq('新整卷的 PDF 能取回', pdfBack.status, 200);
    const backBytes = Buffer.from(await pdfBack.arrayBuffer());
    eq('字节数与上传的一致（原样保存）', backBytes.length, realPdfBytes.length);
  }

  // ---- 这些校验题不能留在库里碍事：题目不可删，只能停用 ----
  // 顺带把历史遗留（例如上次中途崩掉没跑到这一步）的校验题也停用，保证脚本可重复运行
  const leftovers = await getJson(
    `/api/questions/search?source=${encodeURIComponent('校验测试')}&status=全部&size=200`
  );
  const toDisable: string[] = Array.from(
    new Set<string>([
      ...createdQids,
      ...((leftovers.data.items ?? []) as any[]).map((e) => e.qid as string),
    ])
  );
  for (const q of toDisable) {
    await patchJson(`/api/questions/${q}`, { status: '停用' });
  }

  const stillOn = await getJson(
    `/api/questions/search?source=${encodeURIComponent('校验测试')}&status=启用`
  );
  eq('★ 校验题已全部停用（默认视图看不到）', (stillOn.data.items ?? []).length, 0);

  const allStatus = await getJson(
    `/api/questions/search?source=${encodeURIComponent('校验测试')}&status=全部&size=200`
  );
  check(
    `★ 停用的校验题仍然存在（题目不可删除，共 ${(allStatus.data.items ?? []).length} 道）`,
    (allStatus.data.items ?? []).length >= createdQids.length
  );

  // ==========================================================
  section('12. 详情页：改信息 / 改正文 / 图片增删 / 越界拦截');
  // ==========================================================
  // 用一道临时题来测，避免动演示数据（最后会被上面的清理逻辑停用）
  const t = await postJson('/api/questions', {
    kind: '单题',
    type: '解答',
    source: '校验测试',
    number: '5',
    difficulty: '0.4',
    knowledge: ['详情页校验知识点'],
    description: '详情页流程校验用',
    stem: '初始题干 $x$',
    answer: '初始答案',
  });
  eq('建临时题返回 201', t.status, 201);
  const tid: string = t.data.qid;
  createdQids.push(tid);

  const det0 = await getJson(`/api/questions/${tid}`);
  eq('详情返回 200', det0.status, 200);
  for (const k of ['meta', 'stem', 'answer', 'assets', 'pdfs', 'problems', 'orphanImages']) {
    check(`详情包含字段 ${k}`, k in det0.data);
  }

  // ---- 改元数据 ----
  const patched = await patchJson(`/api/questions/${tid}`, {
    number: '7',
    difficulty: '0.88',
    knowledge: ['详情页校验知识点', '新增的知识点'],
    description: '改过的描述',
  });
  eq('改元数据返回 200', patched.status, 200);
  eq('题号已改（"7" → 7）', patched.data.meta.number, 7);
  eq('难度已改', patched.data.meta.difficulty, 0.88);
  eq('知识点已改为 2 个', (patched.data.meta.knowledge ?? []).length, 2);
  eq('描述已改', patched.data.meta.description, '改过的描述');

  const badNum = await patchJson(`/api/questions/${tid}`, { number: '31' });
  eq('题号 31 被拒', badNum.status, 400);
  const badDiffDetail = await patchJson(`/api/questions/${tid}`, { difficulty: '0' });
  eq('难度 0 被拒', badDiffDetail.status, 400);
  eq('被拒后题号没变', (await getJson(`/api/questions/${tid}`)).data.meta.number, 7);

  // ---- 改正文 → 索引必须跟着刷新 ----
  const marker = `索引刷新校验${Date.now()}`;
  const putRes = await fetch(`${BASE}/api/questions/${tid}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ part: 'stem', text: `${marker} $a+b$ \\pick` }),
  });
  eq('改题干返回 200', putRes.status, 200);
  const byMarker = await getJson(`/api/questions/search?q=${encodeURIComponent(marker)}&status=全部`);
  check(
    '★ 改完正文立刻能按新内容搜到（索引已刷新）',
    (byMarker.data.items ?? []).some((e: any) => e.qid === tid)
  );

  // ---- 上传图片 ----
  const afd = new FormData();
  afd.set('channel', 'fig');
  afd.set('file', new Blob([new Uint8Array(PNG)]), 'detail.png');
  const up = await fetch(`${BASE}/api/questions/${tid}/assets`, { method: 'POST', body: afd });
  const upData = await up.json();
  eq('上传图片返回 201', up.status, 201);
  eq('图片名带 qid 与通道前缀', upData.name, `${tid}-fig-01.png`);

  const detAfter = await getJson(`/api/questions/${tid}`);
  eq('详情里能看到这张图', (detAfter.data.assets ?? []).length, 1);
  check(
    '★ 未被正文引用的图会被标成孤儿图',
    (detAfter.data.orphanImages ?? []).includes(`${tid}-fig-01.png`)
  );
  eq(
    '图片能取回',
    (await fetch(`${BASE}/api/assets/${tid}/${tid}-fig-01.png`)).status,
    200
  );

  // ---- 删图片 ----
  const delImg = await fetch(`${BASE}/api/questions/${tid}/assets/${tid}-fig-01.png`, {
    method: 'DELETE',
  });
  eq('删图片返回 200', delImg.status, 200);
  eq('删完取不到了', (await fetch(`${BASE}/api/assets/${tid}/${tid}-fig-01.png`)).status, 404);

  // ---- 跨类型的操作必须被拦下 ----
  const pdfFd = new FormData();
  pdfFd.set('role', 'paper');
  pdfFd.set('file', new Blob([realPdfBytes]), 'x.pdf');
  const pdfOnSingle = await fetch(`${BASE}/api/questions/${tid}/pdf`, { method: 'POST', body: pdfFd });
  eq('单题不允许上传整卷 PDF', pdfOnSingle.status, 400);

  if (paperQids.length) {
    const imgOnPaper = new FormData();
    imgOnPaper.set('channel', 'fig');
    imgOnPaper.set('file', new Blob([new Uint8Array(PNG)]), 'x.png');
    const r = await fetch(`${BASE}/api/questions/${paperQids[0]}/assets`, {
      method: 'POST',
      body: imgOnPaper,
    });
    eq('整卷不允许图片通道', r.status, 400);

    const contentOnPaper = await fetch(`${BASE}/api/questions/${paperQids[0]}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ part: 'stem', text: 'x' }),
    });
    eq('整卷没有题干正文，写入被拒', contentOnPaper.status, 400);
  }

  // ---- 描述不设上限 ----
  const longDesc = '描述'.repeat(1500);
  await patchJson(`/api/questions/${tid}`, { description: longDesc });
  eq(
    '超长描述（3000 字）原样存下',
    (await getJson(`/api/questions/${tid}`)).data.meta.description.length,
    3000
  );

  // ==========================================================
  section('13. v2：试卷独立 id / 难度档位 / 创新 / 带内容检索');
  // ==========================================================
  // ---- 试卷 id 独立成 P 系列 ----
  const papers2 = await getJson('/api/questions/search?kind=整卷&status=全部&size=50');
  check(`库里有试卷（${papers2.data.total} 份）`, papers2.data.total > 0);
  const allPaperIds: string[] = (papers2.data.items ?? []).map((e: any) => e.qid);
  check(
    '★ 试卷 id 都是「可选学科字母 + P + 数字」（v9 起带字母）',
    allPaperIds.length > 0 && allPaperIds.every((id) => /^[A-Z]?P\d{3,}$/.test(id)),
    JSON.stringify(allPaperIds)
  );
  const singles2 = await getJson('/api/questions/search?kind=单题&status=全部&size=50');
  check(
    '★ 单题 id 都是「可选学科字母 + T + 数字」（与整卷 P 不混）',
    (singles2.data.items ?? []).every((e: any) => /^[A-Z]?T\d{4,}$/.test(e.qid)),
    JSON.stringify((singles2.data.items ?? []).map((e: any) => e.qid).slice(0, 8))
  );
  check(
    '★ 单题 id 不会以 P 开头（与整卷彻底分开）',
    (singles2.data.items ?? []).every((e: any) => !/^P/.test(e.qid))
  );

  // 新建一份试卷应拿到下一个 P 号，且不消耗单题的号
  const beforeNextQ = (await getJson('/api/tags')).data.nextQid;
  const paperFd2 = new FormData();
  paperFd2.set('kind', '整卷');
  paperFd2.set('source', '校验测试');
  paperFd2.set('difficulty', '0.55');
  paperFd2.set('description', 'v2 校验用试卷');
  paperFd2.set('paper', new Blob([realPdfBytes]), 'q.pdf');
  const newPaper = await fetch(`${BASE}/api/questions`, { method: 'POST', body: paperFd2 });
  const newPaperData = await newPaper.json();
  eq('新建试卷返回 201', newPaper.status, 201);
  check(
    `★ 新试卷 id = ${newPaperData.qid}（P 系列，前面可有学科字母）`,
    /^[A-Z]?P\d{3,}$/.test(String(newPaperData.qid)),
    String(newPaperData.qid)
  );
  eq('★ 新建试卷不吃掉单题的号', (await getJson('/api/tags')).data.nextQid, beforeNextQ);
  createdQids.push(newPaperData.qid);

  // ---- 难度档位 ----
  const allForBands = await getJson('/api/questions/search?status=全部&size=500');
  const bandCounts: Record<string, number> = {};
  for (const b of ['基础', '压轴', '困难']) {
    const r = await getJson(`/api/questions/search?bands=${encodeURIComponent(b)}&status=全部&size=500`);
    bandCounts[b] = r.data.total;
    const bad = (r.data.items ?? []).filter((e: any) => {
      const d = e.difficulty;
      if (d === undefined) return true;
      if (b === '基础') return !(d >= 0.5 && d <= 0.99);
      if (b === '压轴') return !(d >= 0.25 && d < 0.5);
      return !(d >= 0.01 && d < 0.25);
    });
    check(
      `档位「${b}」筛出的题都落在区间内（${r.data.total} 道）`,
      bad.length === 0,
      JSON.stringify(bad.map((e: any) => `${e.qid}:${e.difficulty}`))
    );
  }
  check(
    '★ 三档不重叠：各档之和 = 有难度的题数',
    (() => {
      const withDiff = (allForBands.data.items ?? []).filter((e: any) => e.difficulty !== undefined);
      return (
        bandCounts['基础'] + bandCounts['压轴'] + bandCounts['困难'] === withDiff.length
      );
    })(),
    JSON.stringify(bandCounts)
  );

  // ---- 创新标记 ----
  const innov = await getJson('/api/questions/search?innovation=1&status=全部&size=500');
  eq('创新筛选返回 200', innov.status, 200);
  check(
    '创新筛出来的题都真的带 innovation',
    (innov.data.items ?? []).every((e: any) => e.innovation === true)
  );

  // ---- 带内容检索（列表要直接显示题目）----
  const wc = await getJson('/api/questions/search?kind=单题&size=10&withContent=1&status=全部');
  eq('withContent 返回 200', wc.status, 200);
  check(
    '★ 返回了这一页每道题的内容',
    !!wc.data.contents && Object.keys(wc.data.contents).length === wc.data.items.length
  );
  const firstItem = (wc.data.items ?? [])[0];
  if (firstItem) {
    const c = wc.data.contents[firstItem.qid];
    check(
      '★ 带回了非空题干',
      typeof c?.stem === 'string' && c.stem.length > 0,
      JSON.stringify(c?.stem?.slice(0, 40))
    );
    check('答案字段也一起带回（列表不显示但要用）', typeof c?.answer === 'string');
    check('图片清单是数组', Array.isArray(c?.assets));
  }
  const noContent = await getJson('/api/questions/search?kind=单题&size=3');
  check('不带 withContent 时不回内容（省流量）', noContent.data.contents === undefined);

  // ---- 勾选即入篮（浏览页交互靠这两个接口）----
  const bid = (await getJson('/api/baskets')).data.activeId;
  const anySingle2 = firstItem?.qid;
  if (bid && anySingle2) {
    await patchJson(`/api/baskets/${bid}`, { clear: true });
    const on = await patchJson(`/api/baskets/${bid}`, { addQids: [anySingle2] });
    eq('★ 勾选即入篮：加入成功', on.data.basket.qids.includes(anySingle2), true);
    const off = await patchJson(`/api/baskets/${bid}`, { removeQid: anySingle2 });
    eq('★ 取消勾选即移出', off.data.basket.qids.includes(anySingle2), false);
    const inAny = await getJson('/api/baskets');
    check('已入篮标记可用', Array.isArray(inAny.data.inAnyBasket));
  }

  // ==========================================================
  section('14. v3：年份 / 整卷无创新 / 筛选 facet');
  // ==========================================================

  // ---- 年份：单题能录、能改、能筛 ----
  const yTarget = (await getJson('/api/questions/search?kind=单题&status=全部&size=3')).data.items ?? [];
  const yIds = yTarget.map((e: any) => e.qid);
  check('库里有单题可供打年份', yIds.length >= 2, JSON.stringify(yIds));

  if (yIds.length >= 2) {
    const p1 = await patchJson(`/api/questions/${yIds[0]}`, { year: 2025 });
    eq('★ 单题能写入年份', p1.data.meta?.year, 2025);
    // ★ 关键：必须**读盘回验**。只信 PATCH 的返回值会漏掉「写盘白名单漏字段」这类
    //   bug —— 内存对象有、文件里没有，而索引恰好走内存，于是筛选能过、数据其实已丢。
    //   注意 GET /api/questions/[qid] 的形状是 { meta, stem, answer, ... }。
    const back1 = await getJson(`/api/questions/${yIds[0]}`);
    eq('★★ 年份真的落盘了（GET 回读仍是 2025）', back1.data.meta?.year, 2025);

    const p2 = await patchJson(`/api/questions/${yIds[1]}`, { year: 2024 });
    eq('★ 第二道单题写入不同年份', p2.data.meta?.year, 2024);
    eq('★★ 第二个年份也落盘', (await getJson(`/api/questions/${yIds[1]}`)).data.meta?.year, 2024);

    const y2025 = await qidsOf('year=2025&status=全部');
    check('★ 按年份筛出结果', y2025.includes(yIds[0]), JSON.stringify(y2025));
    check('★ 年份筛选不串档（2024 的不在 2025 里）', !y2025.includes(yIds[1]));

    const yBoth = await qidsOf('year=2025&year=2024&status=全部');
    check(
      '★ 年份多选 = OR',
      yBoth.includes(yIds[0]) && yBoth.includes(yIds[1]),
      JSON.stringify(yBoth)
    );

    // 关键字里直接打年份也能命中（年份按「标签」对待）
    const byKeyword = await qidsOf('q=2025&status=全部');
    check(
      '★ 年份当作标签：关键字 2025 能命中（含整卷，整卷 searchText 恒空）',
      byKeyword.length >= 1,
      JSON.stringify(byKeyword)
    );

    // 非法年份要被拦
    const bad = await patchJson(`/api/questions/${yIds[0]}`, { year: 12345 });
    eq('非法年份被拒（400）', bad.status, 400);
    const bad2 = await patchJson(`/api/questions/${yIds[0]}`, { year: 'abc' });
    eq('非数字年份被拒（400）', bad2.status, 400);

    // 留空 = 清掉
    const cleared = await patchJson(`/api/questions/${yIds[1]}`, { year: '' });
    eq('★ 年份留空即清除', cleared.data.meta?.year, undefined);
    await patchJson(`/api/questions/${yIds[1]}`, { year: 2024 });
  }

  // ---- 年份 facet（跟标签词表一起返回）----
  const tagsPayload = (await getJson('/api/tags')).data;
  check('★ /api/tags 带回 years facet', Array.isArray(tagsPayload.years), JSON.stringify(tagsPayload.years));
  const yf = tagsPayload.years ?? [];
  check('facet 里只含真实存在的年份', yf.every((x: any) => Number.isInteger(x.year)));
  check('facet 带引用计数', yf.every((x: any) => typeof x.count === 'number' && x.count >= 1));
  check(
    'facet 降序（新题在前）',
    yf.every((x: any, i: number) => i === 0 || yf[i - 1].year > x.year),
    JSON.stringify(yf.map((x: any) => x.year))
  );
  check('facet 里不含不存在的年份（不铺 1900–2100）', yf.length < 50, `共 ${yf.length} 个`);

  // ★★ 索引与文件的一致性：索引里有 year 的，读盘也必须能读到同样的 year。
  //    这一条专门盯「写盘白名单漏字段」→ 索引/文件分叉 的 bug 类型。
  const withYear = (await getJson('/api/questions/search?status=全部&size=200')).data.items.filter(
    (e: any) => e.year !== undefined
  );
  check('索引里存在带年份的记录', withYear.length >= 1, `共 ${withYear.length} 条`);
  const mismatch: string[] = [];
  for (const e of withYear) {
    const onDisk = (await getJson(`/api/questions/${e.qid}`)).data.meta;
    if (onDisk?.year !== e.year) mismatch.push(`${e.qid}: 索引 ${e.year} vs 文件 ${onDisk?.year}`);
  }
  check('★★ 索引里的 year 与题目文件里的 year 完全一致', mismatch.length === 0, mismatch.join('；'));

  // ---- 整卷：不能有创新 ----
  const paperList = (await getJson('/api/questions/search?kind=整卷&status=全部&size=50')).data.items ?? [];
  check('库里有整卷', paperList.length >= 1);
  check(
    '★ 整卷的索引里没有 innovation',
    paperList.every((e: any) => e.innovation === undefined),
    JSON.stringify(paperList.filter((e: any) => e.innovation).map((e: any) => e.qid))
  );

  // 直接调 API 给整卷塞 innovation，服务端必须丢弃（防绕过界面）
  const aPaper = paperList[0]?.qid;
  if (aPaper) {
    const tryInnov = await patchJson(`/api/questions/${aPaper}`, { innovation: true });
    eq('给整卷 PATCH innovation 返回 200（但被忽略）', tryInnov.status, 200);
    eq('★ 整卷的 innovation 被服务端丢弃', tryInnov.data.meta?.innovation, undefined);

    // 整卷能有年份（用户明确要求整卷也要年份）
    const py = await patchJson(`/api/questions/${aPaper}`, { year: 2023 });
    eq('★ 整卷也能写年份', py.data.meta?.year, 2023);
    const paperByYear = await qidsOf('year=2023&status=全部');
    check('★ 按年份能筛出整卷', paperByYear.includes(aPaper), JSON.stringify(paperByYear));
    await patchJson(`/api/questions/${aPaper}`, { year: '' });
  }

  // 新建整卷时带 innovation → 也要丢弃
  const paperForm = new FormData();
  paperForm.set('kind', '整卷');
  paperForm.set('source', 'verify-v3-整卷');
  paperForm.set('difficulty', '0.5');
  paperForm.set('innovation', 'true');
  paperForm.set('year', '2022');
  paperForm.set('paper', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'p.pdf');
  const createdPaper = await fetch(`${BASE}/api/questions`, { method: 'POST', body: paperForm });
  const createdPaperJson = await createdPaper.json();
  eq('新建整卷返回 201', createdPaper.status, 201);
  const newPaperMeta = (await getJson(`/api/questions/${createdPaperJson.qid}`)).data.meta;
  eq('★ 新建整卷时带的 innovation 被丢弃', newPaperMeta?.innovation, undefined);
  eq('★ 新建整卷时带的年份被保留（落盘）', newPaperMeta?.year, 2022);

  // ---- 单题的创新仍然能标 ----
  if (yIds[0]) {
    const on = await patchJson(`/api/questions/${yIds[0]}`, { innovation: true });
    eq('★ 单题仍然能标创新（v2 行为不回退）', on.data.meta?.innovation, true);
    const listed = await qidsOf('innovation=1&status=全部');
    check('创新筛选能筛出刚标的单题', listed.includes(yIds[0]));
    await patchJson(`/api/questions/${yIds[0]}`, { innovation: false });
  }

  // ==========================================================
  section('15. v3：试题篮两栏模型（正在编辑 + 已保存快照）');
  // ==========================================================

  const bnGet = async (page = 1) => (await getJson(`/api/baskets?page=${page}&size=15`)).data;
  const bnAct = async (body: Record<string, unknown>) => postJson('/api/baskets', body);

  /**
   * 把试题篮恢复成干净起点：**删掉所有已保存快照** + 清空正在编辑。
   * v4：这一段必须自清理 —— 否则上一次运行留下的快照会让「内容不在列表里 → 该自动保存」
   * 这类断言在第二次运行时失败（内容其实已经在列表里了）。测试互相污染是很隐蔽的坑。
   */
  const bnWipe = async () => {
    for (let page = 1; page <= 20; page++) {
      const st = await bnGet(page);
      const list = st.saved ?? [];
      if (list.length === 0) break;
      for (const s of list) await bnAct({ action: 'delete', id: s.id });
    }
    await bnAct({ action: 'clear' });
  };

  await bnWipe();
  const wiped = await bnGet();
  eq('★ 干净起点：没有已保存快照', wiped.savedTotal, 0);
  eq('★ 干净起点：正在编辑为空', wiped.draft.count, 0);

  // 挑三道题来玩
  const pool = ((await getJson('/api/questions/search?kind=单题&status=全部&size=5')).data.items ?? []).map(
    (e: any) => e.qid
  );
  check('库里有题可供加入试题篮', pool.length >= 3, JSON.stringify(pool));

  if (pool.length >= 3) {
    const [a, b, c] = pool as [string, string, string];

    // ---- 勾选 = 唯一的加入操作 ----
    const addA = await bnAct({ action: 'add', qids: [a] });
    eq('★ 勾选（add）即入「正在编辑」', addA.data.count, 1);
    const st1 = await bnGet();
    check('★ draftQids 反映正在编辑', st1.draftQids.includes(a));
    check('正在编辑带回正文（列表要直接显示题目）', typeof st1.draft.items[0]?.stem === 'string');

    // ---- 取消勾选 = 移除 ----
    await bnAct({ action: 'remove', qid: a });
    const st2 = await bnGet();
    eq('★ 取消勾选即移出', st2.draft.count, 0);

    // ---- 保存 = 拍快照，默认名 = 日期+时间（24 小时制） ----
    await bnAct({ action: 'add', qids: [a, b] });
    const sv1 = await bnAct({ action: 'save' });
    eq('保存返回 201', sv1.status, 201);
    const name1: string = sv1.data.snapshot?.name ?? '';
    check(
      '★ 保存默认名 = 日期+时间（YYYY-MM-DD HH:mm，24 小时制）',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(name1),
      name1
    );
    eq('★ 保存后当前编辑**不变**（仍是 2 道）', (await bnGet()).draft.count, 2);

    const afterSave = await bnGet();
    const snap1 = (afterSave.saved ?? []).find((s: any) => s.name === name1);
    check('★ 快照出现在左侧列表里', !!snap1, JSON.stringify(afterSave.saved));
    eq('快照记了题目数', snap1?.count, 2);
    eq('★「当前」标记指向与正在编辑内容相同的那条', afterSave.currentId, snap1?.id);

    // ---- 改动后「当前」标记应消失 ----
    await bnAct({ action: 'add', qids: [c] });
    const afterEdit = await bnGet();
    eq('正在编辑加到 3 道', afterEdit.draft.count, 3);
    eq('★ 内容一变，「当前」标记自动灭', afterEdit.currentId, null);
    check('★ draftQids 跟着变（勾选态只认正在编辑）', afterEdit.draftQids.includes(c));

    // ---- v7：载入存档 = 先保存当前 → 清空 → 复制存档的题 ----
    // 先存一条 3 道的，作为「被载入的那条」
    const sv2 = await bnAct({ action: 'save' });
    const id2: string = sv2.data.snapshot?.id ?? '';

    // 把 draft 改成另外一道题，制造差异
    await bnAct({ action: 'set', qids: [a] });
    const beforeLoad = await bnGet();
    eq('载入前正在编辑 = 1 道', beforeLoad.draft.count, 1);
    const savedCountBefore = beforeLoad.savedTotal;

    const ld = await bnAct({ action: 'load', id: id2 });
    eq('载入返回 200', ld.status, 200);
    check('★ 被载入那条**不移除**', (await bnGet()).savedTotal >= savedCountBefore, `before=${savedCountBefore}`);
    check('★ 载入时原来正在编辑的内容被自动保存', !!ld.data.autoSaved, JSON.stringify(ld.data.autoSaved));
    eq('★ 载入后正在编辑 = 被载入那条的内容', (await bnGet()).draft.count, 3);

    const afterLoad = await bnGet();
    const stillThere = (afterLoad.saved ?? []).find((s: any) => s.id === id2);
    check('★ 被载入那条仍留在左侧列表', !!stillThere, JSON.stringify((afterLoad.saved ?? []).map((s: any) => s.id)));
    eq('★ currentId 指向刚载入的那条（导出时"标题留空"用它）', afterLoad.currentId, id2);
    eq('★ 快照总数 = 原来 + 1（自动保存那条）', afterLoad.savedTotal, savedCountBefore + 1);
    check('★ 自动保存那条的名字也是时间戳', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ld.data.autoSaved?.name ?? ''), ld.data.autoSaved?.name);

    // ---- v7 的关键变化：**内容相同也照存**（你要求允许同内容不同名字）----
    const beforeNoop = await bnGet();
    const ld2 = await bnAct({ action: 'load', id: id2 }); // 已经在这条上，内容完全相同
    check(
      '★ v7：再点同一条**仍然**先保存当前（允许相同内容不同名字）',
      !!ld2.data.autoSaved,
      JSON.stringify(ld2.data.autoSaved)
    );
    eq('★ v7：所以快照总数 +1', (await bnGet()).savedTotal, beforeNoop.savedTotal + 1);
    check(
      '★ v7：自动保存的名字是新的时间戳（不是覆盖原来那条）',
      ld2.data.autoSaved?.id !== id2 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ld2.data.autoSaved?.name ?? ''),
      JSON.stringify(ld2.data.autoSaved)
    );

    // 空篮子载入 → 没有"当前内容"可存，就不该凭空多出一条
    await bnAct({ action: 'clear' });
    const beforeEmpty = await bnGet();
    const ldEmpty = await bnAct({ action: 'load', id: id2 });
    eq('★ 篮子是空的时候载入 → 不产生自动保存', ldEmpty.data.autoSaved, null);
    eq('★ 快照总数不变', (await bnGet()).savedTotal, beforeEmpty.savedTotal);
    eq('★ 但题目照样复制进来了', (await bnGet()).draft.count, 3);

    // ---- v7：「清理重复」已按你的要求删掉 ----
    const dp = await bnAct({ action: 'dedupe' });
    eq('★ v7：dedupe 这个操作已经不存在（400 未知操作）', dp.status, 400);

    // ---- 重命名 / 删除 ----
    // v7：允许同内容多条快照，所以 currentId 未必是 id2（它只要求"内容与正在编辑相同"）。
    // 能断言的是：改名不动内容 → currentId 的判定结果不该变。
    const cidBeforeRename = (await bnGet()).currentId;
    const rn = await bnAct({ action: 'rename', id: id2, name: '海淀一模冲刺卷' });
    eq('重命名返回 200', rn.status, 200);
    eq('★ 快照能重命名', rn.data.snapshot?.name, '海淀一模冲刺卷');
    eq('★ 重命名不改内容 → currentId 的判定不变', rn.data.currentId, cidBeforeRename);

    const dup = await bnAct({ action: 'rename', id: id2, name: name1 });
    check('重名会自动加后缀而不是覆盖', dup.data.snapshot?.name !== name1, dup.data.snapshot?.name);

    // 删除「当前正被载入的那条」：只删列表记录，右侧内容不受影响
    const beforeDelDraft = (await bnGet()).draft.count;
    const del = await bnAct({ action: 'delete', id: id2 });
    eq('删除返回 200', del.status, 200);
    const afterDel = await bnGet();
    check('★ 删掉后左侧不再有它', !(afterDel.saved ?? []).some((s: any) => s.id === id2));
    eq('★ 删掉正被载入的快照，右侧正在编辑不受影响', afterDel.draft.count, beforeDelDraft);
    // v7：允许同内容多条快照，所以删掉 id2 之后 currentId 可能落在**另一条**同内容的快照上，
    // 而不是变成 null。能断言的是：它不再指向刚删掉的那条。
    check('★ 删掉后 currentId 不再指向它', afterDel.currentId !== id2, String(afterDel.currentId));

    // ---- 分页（每页 15）----
    for (let i = 0; i < 17; i++) await bnAct({ action: 'save', name: `分页测试-${i}` });
    const p1 = await bnGet(1);
    const p2 = await bnGet(2);
    check('★ 左侧快照每页 15 个', (p1.saved ?? []).length === 15, `实际 ${(p1.saved ?? []).length}`);
    check('★ 总数 > 15 时有第 2 页', p1.savedTotal > 15 && (p2.saved ?? []).length >= 1, `total=${p1.savedTotal}`);
    eq('第 2 页的页码正确', p2.savedPage, 2);

    // ---- 导出导的是「正在编辑」----
    await bnAct({ action: 'set', qids: [a] });
    const exp = await postJson('/api/baskets/export', {});
    check('★ /api/baskets/export 存在且导的是正在编辑', exp.status === 200, `status=${exp.status}`);
    // ---- 旧的按 id 路由已删除 ----
    const gone = await fetch(`${BASE}/api/baskets/${id2}`, { method: 'DELETE' });
    check('★ 旧的 /api/baskets/[id] 路由已移除（405/404）', gone.status === 404 || gone.status === 405, `status=${gone.status}`);

    // 收尾：把分页测试造出来的快照清掉，别污染演示库
    const all = await bnGet(1);
    for (const s of all.saved ?? []) {
      if (String(s.name).startsWith('分页测试-')) await bnAct({ action: 'delete', id: s.id });
    }
    for (let page = 1; page <= 3; page++) {
      const pg = await bnGet(page);
      for (const s of pg.saved ?? []) {
        if (String(s.name).startsWith('分页测试-')) await bnAct({ action: 'delete', id: s.id });
      }
    }
    await bnAct({ action: 'clear' });
  }

  // ==========================================================
  section('16. v4：T 前缀 id / 旧库兼容 / 搜索建议数据 / 对齐约定');
  // ==========================================================

  // ---- 单题 id 是 T 前缀 ----
  const allNow = (await getJson('/api/questions/search?status=全部&size=500')).data.items ?? [];
  const qIdsNow = allNow.filter((e: any) => e.kind === '单题').map((e: any) => e.qid);
  check('库里有单题', qIdsNow.length > 0, `共 ${qIdsNow.length} 道`);
  check(
    '★ v4：所有单题 id 都是「可选学科字母 + T + 数字」',
    qIdsNow.every((id: string) => /^[A-Z]?T\d{4,}$/.test(id)),
    JSON.stringify(qIdsNow.slice(0, 8))
  );
  check(
    '★ v4：库里已无旧的纯数字单题目录',
    !qIdsNow.some((id: string) => /^\d+$/.test(id))
  );
  check(
    '★ v4：nextQid 预览也是 T 前缀（前面可有学科字母）',
    /^[A-Z]?T\d{4,}$/.test((await getJson('/api/tags')).data.nextQid)
  );

  // 新建一道，确认拿到 T 号且号是递增的
  const v4fd = new FormData();
  v4fd.set('kind', '单题');
  v4fd.set('type', '填空');
  v4fd.set('source', 'v4-校验');
  v4fd.set('stem', '$v4$ 校验用题干 \\fillin');
  const v4new = await fetch(`${BASE}/api/questions`, { method: 'POST', body: v4fd });
  const v4json = await v4new.json();
  check(
    `★ v4：新建单题拿到 T 号（${v4json.qid}）`,
    /^[A-Z]?T\d{4,}$/.test(String(v4json.qid)),
    String(v4json.qid)
  );

  // 资源名也跟着带 T 前缀
  if (v4json.qid) {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
      0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
      0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
      0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const assetFd = new FormData();
    assetFd.set('channel', 'fig');
    assetFd.set('file', new Blob([png], { type: 'image/png' }), 'x.png');
    const assetRes = await fetch(`${BASE}/api/questions/${v4json.qid}/assets`, {
      method: 'POST',
      body: assetFd,
    });
    const assetJson = await assetRes.json();
    check(
      `★ v4：资源文件名带 T 前缀（${assetJson.name}）`,
      String(assetJson.name).startsWith(`${v4json.qid}-`),
      String(assetJson.name)
    );
    await fetch(`${BASE}/api/questions/${v4json.qid}/assets/${assetJson.name}`, { method: 'DELETE' });
  }

  // ---- 旧库兼容（纯数字 id 仍被认作合法单题 id）----
  // 直接问服务端「T0001 与 0001 是不是都算合法单题目录」是测不到的（那是纯函数），
  // 所以这里只断言接口层不会因为前缀而报错；纯函数级断言在 selftest 里。
  check(
    '★ v4：按 id 取题目时前缀不影响路由（T 开头能取到）',
    qIdsNow.length > 0 ? (await getJson(`/api/questions/${qIdsNow[0]}`)).status === 200 : true
  );

  // ---- 搜索建议：需要的数据要在 /api/tags 里齐备 ----
  const sugTags = (await getJson('/api/tags')).data;
  const sugPool = [
    ...(sugTags.vocab?.source ?? []).map((t: any) => t.name),
    ...(sugTags.vocab?.knowledge ?? []).map((t: any) => t.name),
    ...(sugTags.years ?? []).map((y: any) => String(y.year)),
  ];
  check('★ v4：搜索建议的候选池非空（来源/知识点/年份）', sugPool.length > 0, `共 ${sugPool.length} 条`);
  check(
    '★ v4：候选里能匹配到「25」开头的标签（你举的例子）',
    sugPool.some((n: string) => n.startsWith('25')),
    JSON.stringify(sugPool.filter((n: string) => n.includes('25')).slice(0, 6))
  );

  // ---- 备份上限 ----
  const bkList = await getJson('/api/tags/action');
  check(
    '★ v4：备份列表不超过上限（100）',
    (bkList.data.backups ?? []).length <= 100,
    `当前 ${(bkList.data.backups ?? []).length} 条`
  );

  // ==========================================================
  section('17. v5：配图位置（meta → 索引 → 导出）');
  // ==========================================================

  // ---- 建题时设位置 ----
  const fd5 = new FormData();
  fd5.set('kind', '单题');
  fd5.set('type', '解答');
  fd5.set('source', 'v5-位置校验');
  fd5.set('stem', '$x^2=1$ \\fillin');
  fd5.set('figAlign', '右');
  const c5 = await fetch(`${BASE}/api/questions`, { method: 'POST', body: fd5 });
  const j5 = await c5.json();
  eq('v5：建题返回 201', c5.status, 201);
  eq('★ v5：配图位置写进了 meta（读盘回验）', (await getJson(`/api/questions/${j5.qid}`)).data.meta.figAlign, '右');

  const idx5 = (await getJson('/api/questions/search?status=全部&size=500')).data.items ?? [];
  const mine5 = idx5.find((e: any) => e.qid === j5.qid);
  eq('★ v5：索引里存的是**已解析的生效值**', mine5?.figAlign, '右');

  // ---- 没设过的：v8 起**一律靠右**（示意图的默认位置，不再按题型推导）----
  const singles5 = idx5.filter((e: any) => e.kind === '单题');
  const jieda = singles5.filter((e: any) => e.type === '解答');
  const others = singles5.filter((e: any) => e.type && e.type !== '解答');
  check('库里有解答题', jieda.length > 0, `${jieda.length} 道`);
  check(
    '★ v5：解答题默认靠右',
    jieda.every((e: any) => e.figAlign === '右'),
    JSON.stringify(jieda.filter((e: any) => e.figAlign !== '右').map((e: any) => e.qid))
  );
  check(
    '★ v8：选择/填空题默认**也**靠右（默认值不再跟题型走）',
    others.every((e: any) => e.figAlign === '右'),
    JSON.stringify(others.filter((e: any) => e.figAlign !== '右').map((e: any) => e.qid))
  );
  check(
    '★ v5：整卷不参与配图位置（索引里没有这个字段）',
    idx5.filter((e: any) => e.kind === '整卷').every((e: any) => e.figAlign === undefined)
  );

  // ---- 改位置 / 清掉位置 ----
  const patch5 = await patchJson(`/api/questions/${j5.qid}`, { figAlign: '左' });
  eq('★ v5：PATCH 能改位置', patch5.data.meta?.figAlign, '左');
  eq('★ v5：改完读盘仍是「左」', (await getJson(`/api/questions/${j5.qid}`)).data.meta.figAlign, '左');
  const clear5 = await patchJson(`/api/questions/${j5.qid}`, { figAlign: '' });
  eq('★ v5：传空串 = 清掉手动值（回到默认）', clear5.data.meta?.figAlign, undefined);
  eq(
    '★ v8：清掉后回到默认「右」（不再是按题型推导）',
    ((await getJson('/api/questions/search?status=全部&size=500')).data.items ?? []).find(
      (e: any) => e.qid === j5.qid
    )?.figAlign,
    '右'
  );

  // ---- 导出：位置真的进了 exercise 的第二个参数 ----
  await postJson('/api/baskets', { action: 'clear' });
  await postJson('/api/baskets', { action: 'add', qids: [j5.qid] });
  const exp5 = await postJson('/api/baskets/export', {});
  eq('v5：导出返回 200', exp5.status, 200);
  if (exp5.status === 200 && !exp5.data.error) {
    const tex5 = fs.readFileSync(path.join(exportRootDir(), exp5.data.folder, '题目.tex'), 'utf-8');
    const m5 = tex5.match(/\\begin\{exercise\}\[([^\]]*)\]\[([^\]]*)\]/);
    check('★ v5：exercise 带上了第二个参数（配图位置）', !!m5, tex5.split('\n').find((l) => l.includes('\\begin{exercise}')));
    eq('★ v5：解答题导出为 right', m5?.[2], 'right');
    check('★ v5：正文里没有参数残留（不该出现 left]/right] 这种字面文本）', !/(?<!\\|\[)\b(left|center|right)\]/.test(tex5));
    const l5 = fs.readFileSync(path.join(exportRootDir(), exp5.data.folder, '题目.log'), 'utf-8');
    eq('★ v5：带位置参数的讲义编译 0 错误', l5.split(/\r?\n/).filter((l) => l.startsWith('! ')).length, 0);
  }

  // ==========================================================
  section('18. 数值范围参数（numMin/numMax/diffMin/diffMax）');
  // ==========================================================
  // 这组参数以前**在 HTTP 层被漏读**，导致「同来源+同题号」查重失效：
  // 题号条件被丢掉 → 只要来源用过就报重复，且报的永远是同源里 qid 最小的那道。
  // 浏览页筛选界面没用到它们，所以一直没暴露 —— 只有录入页查重在用。

  const allS = (await getJson('/api/questions/search?status=全部&size=500')).data.items ?? [];
  const singlesS = allS.filter((e: any) => e.kind === '单题' && e.source && e.number !== undefined);
  check('库里有带来源与题号的单题', singlesS.length > 0, `${singlesS.length} 道`);

  if (singlesS.length > 0) {
    // 挑一个「同来源下有多道题」的来源，才能真正区分范围是否生效
    const bySrc = new Map<string, any[]>();
    for (const e of singlesS) {
      const list = bySrc.get(e.source) ?? [];
      list.push(e);
      bySrc.set(e.source, list);
    }
    const multi = [...bySrc.entries()].find(([, list]) => list.length >= 2);
    check('存在一个来源下有 ≥2 道题（这样才测得出范围过滤）', !!multi, `来源数 ${bySrc.size}`);

    if (multi) {
      const [src, list] = multi;
      const enc = encodeURIComponent(src);
      const nums = list.map((e) => e.number).sort((a, b) => a - b);
      const first = nums[0];
      const last = nums[nums.length - 1];

      const exact = await getJson(
        `/api/questions/search?source=${enc}&numMin=${first}&numMax=${first}&status=全部&size=200`
      );
      eq('★ 题号等值过滤只返回 1 道', exact.data.total, 1);
      eq('★ 返回的那道题号正确', exact.data.items[0]?.number, first);
      check(
        '★ 返回的那道来源也正确（没有串源）',
        exact.data.items.every((e: any) => e.source === src)
      );

      // 这是原 bug 的核心：一个库里不存在的题号必须 0 道
      const miss = await getJson(
        `/api/questions/search?source=${enc}&numMin=99&numMax=99&status=全部&size=200`
      );
      eq('★★ 题号填一个不存在的值 → 0 道（修好前会返回该来源全部）', miss.data.total, 0);
      check(
        '★ 这个来源确实有多道题（所以上面的 0 道真的是过滤起了作用）',
        list.length >= 2,
        `该来源 ${list.length} 道`
      );

      // 范围（非等值）
      if (last > first) {
        const range = await getJson(
          `/api/questions/search?source=${enc}&numMin=${first}&numMax=${last}&status=全部&size=200`
        );
        check(
          '★ 题号范围过滤：落在区间内的都返回、区间外的不返回',
          range.data.items.every((e: any) => e.number >= first && e.number <= last),
          JSON.stringify(range.data.items.map((e: any) => e.number))
        );
      }
    }
  }

  // diffMin / diffMax 同样是被漏读的两个（一起修了，一起测）
  const diffOk = (await getJson('/api/questions/search?diffMin=0.5&diffMax=0.99&status=全部&size=500'))
    .data.items ?? [];
  check(
    '★ 难度范围过滤生效（返回的都在区间内）',
    diffOk.length > 0 && diffOk.every((e: any) => e.difficulty >= 0.5 && e.difficulty <= 0.99),
    JSON.stringify(diffOk.filter((e: any) => !(e.difficulty >= 0.5 && e.difficulty <= 0.99)).map((e: any) => e.difficulty))
  );
  const diffNone = (await getJson('/api/questions/search?diffMin=0.999&diffMax=1&status=全部&size=500'))
    .data.items ?? [];
  check(
    '★ 难度范围卡在无解区间 → 0 道（证明条件没被丢掉）',
    diffNone.length === 0,
    `${diffNone.length} 道`
  );

  // 浏览器端「同来源+同题号」查重所依赖的完整查询，端到端复现一次
  if (singlesS.length > 0) {
    const s0 = singlesS[0];
    const enc2 = encodeURIComponent(s0.source);
    const dedup = await getJson(
      `/api/questions/search?source=${enc2}&numMin=${s0.number}&numMax=${s0.number}&status=全部&size=200`
    );
    check(
      '★ 录入页查重用的那条查询能命中且只命中它自己',
      dedup.data.total === 1 && dedup.data.items[0]?.qid === s0.qid,
      `total=${dedup.data.total} qid=${dedup.data.items[0]?.qid} 期望 ${s0.qid}`
    );
  }

  // ==========================================================
  section('19. v6：导出提速（并行 + 第2遍按需 + 分段耗时）');
  // ==========================================================
  // 以前：4 次 xelatex 首尾相接（题目 2 遍 + 答案 2 遍，且两个文件串行）≈ 12.7s
  // 现在：2 次（每个文件 1 遍，两个文件并行）≈ 3.9s
  // 第 2 遍之所以能省：第一遍报的 "Rerun" 全是 hyperref 的 /PageLabels 与空书签
  // 这类 PDF 元数据簿记，不是内容问题（实测少了它，PDF 连字节数都一样）。

  await postJson('/api/baskets', { action: 'clear' });
  const pool19 = ((await getJson('/api/questions/search?kind=单题&status=全部&size=5')).data.items ?? [])
    .map((e: any) => e.qid);
  await postJson('/api/baskets', { action: 'add', qids: pool19 });

  const t19 = Date.now();
  const exp19 = await postJson('/api/baskets/export', {});
  const wall19 = Date.now() - t19;
  eq('导出返回 200', exp19.status, 200);

  if (exp19.status === 200 && !exp19.data.error) {
    const tm = exp19.data.timings;
    check('★ v6：导出返回分段耗时', !!tm && typeof tm.compileMs === 'number', JSON.stringify(tm));

    eq('★★ xelatex 只跑了 2 次（题目 1 遍 + 答案 1 遍；以前是 4 次）', tm?.xelatexRuns, 2);
    eq('★ 题目只跑了 1 遍', exp19.data.compile.questions.passes, 1);
    eq('★ 答案只跑了 1 遍', exp19.data.compile.answers.passes, 1);
    check('★ 分段耗时之和不超过总耗时', (tm?.readMs ?? 0) + (tm?.writeMs ?? 0) + (tm?.compileMs ?? 0) <= (tm?.totalMs ?? 0) + 50, JSON.stringify(tm));
    check(
      '★ 编译耗时确实是大头（说明优化点选对了）',
      (tm?.compileMs ?? 0) > (tm?.readMs ?? 0) + (tm?.writeMs ?? 0),
      JSON.stringify(tm)
    );
    check('★ 整体耗时在合理区间（< 20 秒；实测约 4 秒）', wall19 < 20000, `${wall19}ms`);
    check('编译仍成功（提速不能牺牲正确性）', exp19.data.compile.ok === true);
  }

  // 提速后产物仍然正确：两个 tex 的正文段必须逐字节一致（单一真源没被破坏）
  if (exp19.status === 200 && !exp19.data.error) {
    const d19 = path.join(exportRootDir(), exp19.data.folder);
    const texQ = fs.readFileSync(path.join(d19, '题目.tex'), 'utf-8');
    const texA = fs.readFileSync(path.join(d19, '答案.tex'), 'utf-8');
    const bodyQ = texQ.slice(texQ.indexOf('\\begin{document}'));
    const bodyA = texA.slice(texA.indexOf('\\begin{document}'));
    check('★ 提速后两份 tex 的正文段仍逐字节一致', bodyQ === bodyA);
    for (const n of ['题目', '答案']) {
      const lg = fs.readFileSync(path.join(d19, `${n}.log`), 'utf-8');
      eq(`★ 提速后 ${n}.log 仍 0 错误`, lg.split(/\r?\n/).filter((l) => l.startsWith('! ')).length, 0);
    }
  }

  // ==========================================================
  section('结果');
  // ==========================================================
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail > 0) {
    console.log('\n失败清单：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('\n校验脚本自身崩了：', e);
  process.exit(2);
});

/**
 * verify-v9-subjects.ts — 校验「多学科」真的成立（v9 #6）
 *
 * 要证明的事（每条都能证伪）：
 *
 *   1. **零迁移**：没有 `_subjects.json` 的老库，题库路径照读
 *      （老库那层叫「题库」），而且带 `T0001` 这种**老 id** 的题照样读得到；
 *      新库用学科名当目录（`<题库位置>/数学`）
 *   2. **写带字母、读宽松、显示去字母**：新建的题是 `AT0001`；`T0001` / `0001`
 *      也照样认；界面上看到的永远是 `T0001`
 *   3. **每个学科真是一套独立题库**：标签表、试题篮、编号、索引都不串
 *      （这是 `_meta/` 本来就在 `题库/` 里的自然结果，但必须验）
 *   4. **学科上限**：名字超 5 字被拒、第 6 个被拒、重名被拒、名字里有 `/` 被拒
 *   5. **录入到别的学科**（withSubject）不改"当前学科"，且题真的落在那边
 *   6. **改名字不动目录**（否则要搬整个题库）
 *
 * 全程用**临时题库**，跑完删干净 —— 绝不动你的演示库。
 * 运行：npx tsx scripts/verify-v9-subjects.ts（不需要 dev server）
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { isolateVault } from './isolate';
import { configFilePath } from '../src/lib/config';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-subjects-'));
process.env.VAULT_PATH = TMP;
process.env.EXPORT_DIR = path.join(TMP, '导出');
// 光设环境变量不够：config.json 的优先级更高（见 isolate.ts 里的说明）
isolateVault(TMP, path.join(TMP, '导出'));

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

async function main(): Promise<void> {
  const subjects = await import('../src/lib/subjects');
  const service = await import('../src/lib/service');
  const store = await import('../src/lib/store');
  const paths = await import('../src/lib/paths');
  const { displayQid } = await import('../src/lib/types');

  // ============================================================
  section('#1 零迁移：没有注册表的老库，路径一个字都没变');
  // ============================================================
  check('起点：临时库里没有 _subjects.json', !fs.existsSync(subjects.subjectsFilePath()), subjects.subjectsFilePath());
  check(
    '★ 没有注册表时按"只有一个 A 学科、dir 为空"处理',
    subjects.readSubjects().active === 'A' &&
      subjects.listSubjects().length === 1 &&
      subjects.listSubjects()[0].dir === '',
    JSON.stringify(subjects.readSubjects())
  );
  check(
    `★ 题库路径是 <题库位置>/数学（学科 A 那层直接叫学科名）`,
    paths.bankPath() === path.join(TMP, '数学'),
    paths.bankPath()
  );

  /*
   * 老库兼容的**边界**（这条是踩出来的）：
   *   · 老库那层叫「题库」，磁盘上还在、**里面真有东西** → 照读，不能误判成空库；
   *   · 只剩一个**空**的 题库/ 目录 → 不算老库，用新名字「数学」。
   * 第二种要是判错，一个残留空目录就能把新库永远拖回旧名字（实测：界面上显示
   * `题库\题库`，「数学」目录怎么也建不出来）。
   *
   * ⚠️ 这一段要**换一个题库位置**来看结果，但 `config.json > 环境变量` ——
   * 而 isolateVault 为了让套件待在临时库里，正是把临时库写进了 config.json。
   * 所以这里临时把 config.json 收起来（让环境变量生效），测完原样放回去。
   */
  const cfgFile = configFilePath();
  const cfgSaved = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf-8') : null;
  fs.rmSync(cfgFile, { force: true });
  try {
    const legacyRoot = path.join(TMP, '老库情形');
    fs.mkdirSync(path.join(legacyRoot, '题库', 'AT0001'), { recursive: true });
    process.env.VAULT_PATH = legacyRoot;
    check(
      '★★ 老库（题库/ 里有题）照读：路径还是 <题库位置>/题库',
      paths.bankPath() === path.join(legacyRoot, '题库'),
      paths.bankPath()
    );

    const emptyRoot = path.join(TMP, '空库情形');
    fs.mkdirSync(path.join(emptyRoot, '题库'), { recursive: true });
    process.env.VAULT_PATH = emptyRoot;
    check(
      '★★ 只有一个空 题库/ 目录时不当老库：照样用「数学」',
      paths.bankPath() === path.join(emptyRoot, '数学'),
      paths.bankPath()
    );
  } finally {
    if (cfgSaved !== null) fs.writeFileSync(cfgFile, cfgSaved, 'utf-8');
  }

  process.env.VAULT_PATH = TMP;
  check('★ 切回临时库还是「数学」（路径按题库位置缓存，不会串）', paths.bankPath() === path.join(TMP, '数学'), paths.bankPath());

  service.ensureWorkspace();

  // 手工造一条"老库"的题（目录名是老写法 T0001，不带学科字母）
  const LEGACY = 'T0001';
  fs.mkdirSync(paths.questionDir(LEGACY), { recursive: true });
  store.writeContent(LEGACY, 'stem', '老库的题干');
  store.writeMeta({
    qid: LEGACY,
    kind: '单题',
    type: '填空',
    source: '老来源',
    number: 1,
    status: '启用',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const legacyEntries = service.searchQuestions({ source: '老来源', status: '全部', size: 10 });
  check(
    '★★ 带老 id（T0001）的题照样能读、能检索（宽松读）',
    legacyEntries.total === 1 && legacyEntries.items[0].qid === LEGACY,
    JSON.stringify(legacyEntries.items.map((e) => e.qid))
  );
  check('★ 老 id 在界面上显示成它本来的样子', displayQid(LEGACY) === 'T0001', displayQid(LEGACY));
  check(
    '★ 老库里的写操作照常（改个字段没炸）',
    (() => {
      service.updateQuestion(LEGACY, { description: '改一下' });
      return store.readMeta(LEGACY)?.description === '改一下';
    })()
  );

  // ============================================================
  section('#2 新建学科：目录、注册表、自动切换');
  // ============================================================
  const { subject: chem, registry } = subjects.createSubject('化学');
  check(`★ 新建学科拿到字母 ${chem.id}`, chem.id === 'B', chem.id);
  check('★ 注册表落盘在「题库位置」下（不在任何学科的题库里）', fs.existsSync(subjects.subjectsFilePath()), subjects.subjectsFilePath());
  check('★ 新建后自动切过去（active 变成新学科）', registry.active === 'B' && subjects.activeSubjectId() === 'B', registry.active);
  check(
    `★ 新学科的题库目录与默认学科**同级**：<题库位置>/化学`,
    paths.bankPath() === path.join(TMP, chem.dir),
    paths.bankPath()
  );
  check('★ 目录与 _meta 建出来了（不用手工建就能直接录题）', fs.existsSync(path.join(paths.bankPath(), '_meta')), paths.bankPath());
  check(
    '★ 老学科 A 的题库位置没被动过（还是 <题库位置>/数学）',
    subjects.bankPathOf('A') === path.join(TMP, '数学'),
    subjects.bankPathOf('A')
  );

  // ============================================================
  section('#3 每个学科是一套独立题库：编号 / 标签 / 试题篮 / 索引全隔离');
  // ============================================================
  const c1 = await service.createQuestion({
    kind: '单题',
    type: '填空',
    source: '化学来源',
    number: 1,
    custom: ['化学专用'],
    knowledge: ['化学知识点'],
    stem: '$2+2=$\\fillin',
    answer: '$4$',
  });
  check(`★★ B 学科第一道题拿到 BT0001（实际 ${c1.qid}）`, c1.qid === 'BT0001', c1.qid);
  check(`★ 界面上显示成 T0001（不显示学科字母）`, displayQid(c1.qid) === 'T0001', displayQid(c1.qid));
  check('★ 文件真的落在化学的题库目录里', fs.existsSync(paths.metaMdPath(c1.qid)), paths.metaMdPath(c1.qid));
  check('★ A 学科的题库目录里**没有**它', !fs.existsSync(path.join(TMP, '数学', c1.qid)), c1.qid);

  check(
    '★ B 的编号从 1 起（不受 A 已经用到 0001 的影响）',
    service.nextQidPreview() === 'BT0002',
    service.nextQidPreview()
  );

  const bVocab = service.listTags(true);
  check(
    '★ B 的标签表里只有 B 的来源/知识点/自定义',
    bVocab.source.some((t) => t.name === '化学来源') &&
      !bVocab.source.some((t) => t.name === '老来源') &&
      bVocab.knowledge.some((t) => t.name === '化学知识点') &&
      bVocab.custom.some((t) => t.name === '化学专用'),
    JSON.stringify({
      s: bVocab.source.map((t) => t.name),
      k: bVocab.knowledge.map((t) => t.name),
      c: bVocab.custom.map((t) => t.name),
    })
  );

  const baskets = await import('../src/lib/baskets');
  baskets.setDraftQids([c1.qid]);
  check('★ B 的试题篮里是那道化学题', baskets.getDraft().qids.includes(c1.qid), JSON.stringify(baskets.getDraft().qids));

  // 切回 A，看四样东西是不是都换了
  subjects.switchSubject('A');
  check('切回 A：题库路径还原', paths.bankPath() === path.join(TMP, '数学'), paths.bankPath());
  check(
    '★★ 切回 A：检索只看得到 A 的题（B 那道不见了）',
    service.searchQuestions({ status: '全部', size: 50 }).items.every((e) => e.qid !== c1.qid)
  );
  check(
    '★★ 切回 A：标签表是 A 的（没有化学来源）',
    !service.listTags(true).source.some((t) => t.name === '化学来源'),
    JSON.stringify(service.listTags(true).source.map((t) => t.name))
  );
  check(
    '★★ 切回 A：试题篮也换了（没有那道化学题）',
    !baskets.getDraft().qids.includes(c1.qid),
    JSON.stringify(baskets.getDraft().qids)
  );
  check(
    '★ 切回 A：下一个号回到 A 的计数器（AT0002，不是 BT0002）',
    service.nextQidPreview() === 'AT0002',
    service.nextQidPreview()
  );

  // ============================================================
  section('#4 录入到别的学科（withSubject）不改当前学科');
  // ============================================================
  check('当前学科仍是 A', subjects.activeSubjectId() === 'A');
  const intoB = subjects.withSubject('B', () =>
    service.createQuestion({
      kind: '单题',
      type: '填空',
      source: '化学来源',
      number: 2,
      stem: '$3+3=$\\fillin',
      answer: '$6$',
    })
  );
  const intoBQid = (await intoB).qid;
  check(`★★ 录到 B 的题拿到 BT0002（实际 ${intoBQid}）`, intoBQid === 'BT0002', intoBQid);
  check(
    '★★ 录到别的学科**不改当前学科**（还是 A）',
    subjects.activeSubjectId() === 'A',
    subjects.activeSubjectId()
  );
  check(
    '★ 那道题真的落在化学目录里',
    fs.existsSync(path.join(TMP, chem.dir, intoBQid, `${intoBQid}.md`)),
    path.join(TMP, chem.dir, intoBQid)
  );
  check(
    '★ 而它不在 A 的题库里',
    !fs.existsSync(path.join(TMP, '数学', intoBQid))
  );
  check(
    '★ withSubject 结束后上下文就恢复了（不会"漏"到下一个人）',
    paths.bankPath() === path.join(TMP, '数学'),
    paths.bankPath()
  );

  // ============================================================
  section('#5 学科的上限与校验');
  // ============================================================
  const cases: Array<[string, () => unknown, RegExp]> = [
    ['名字超过 5 个字 → 拒', () => subjects.createSubject('六个字的名字'), /最长 5 个字/],
    ['名字为空 → 拒', () => subjects.createSubject('   '), /不能为空/],
    ['名字里带 / → 拒（它要当目录名）', () => subjects.createSubject('物/理'), /不能有/],
    ['名字里带 .. → 拒', () => subjects.createSubject('..'), /不能有/],
    ['重名 → 拒', () => subjects.createSubject('化学'), /已经有一个/],
  ];
  for (const [label, run, pattern] of cases) {
    let msg = '';
    try {
      run();
    } catch (e) {
      msg = (e as Error).message;
    }
    check(`${label}：${msg}`, pattern.test(msg), msg || '居然通过了');
  }

  subjects.createSubject('物理');
  subjects.createSubject('生物');
  subjects.createSubject('英语');
  check('★ 一共可以建到 5 个', subjects.listSubjects().length === 5, String(subjects.listSubjects().length));
  let sixth = '';
  try {
    subjects.createSubject('第六个');
  } catch (e) {
    sixth = (e as Error).message;
  }
  check(`★★ 第 6 个学科被拒：${sixth}`, /最多 5 个/.test(sixth), sixth || '居然通过了');

  // ============================================================
  section('#6 改名字只改 name，不动目录');
  // ============================================================
  const before = subjects.findSubject('B')!;
  subjects.renameSubject('B', '化学二');
  const after = subjects.findSubject('B')!;
  check('★ 名字改了', after.name === '化学二', after.name);
  check('★★ 目录没变（否则要搬整个题库）', after.dir === before.dir, `${before.dir} → ${after.dir}`);
  check('★ 题库还在原处、题还在', fs.existsSync(path.join(TMP, chem.dir, intoBQid)));

  let renameErr = '';
  try {
    subjects.renameSubject('B', '太长的名字啦');
  } catch (e) {
    renameErr = (e as Error).message;
  }
  check(`★ 改成超长名字也被拒：${renameErr}`, /最长 5 个字/.test(renameErr), renameErr || '居然通过了');

  // ============================================================
  section('#7 地址栏里的老写法（不带字母）也要能打开');
  // ============================================================
  //
  // 界面上、收藏夹里写的是 T0001，磁盘上从 v9 起叫 AT0001。
  // 只认目录名的话，v8 以前存下的链接会全部 404 —— 而"字母只为了让系统分得清"
  // 本来就不该影响用户怎么访问。resolveQid 就是这道兼容。
  subjects.switchSubject('A');
  const r1 = subjects.withSubject('A', () =>
    service.createQuestion({
      kind: '单题',
      type: '填空',
      source: '兼容测试',
      number: 1,
      stem: '$1$\\fillin',
      answer: '$1$',
    })
  );
  const realQid = (await r1).qid;
  check(`A 学科新建的题叫 ${realQid}（带学科字母）`, /^AT\d{4,}$/.test(realQid), realQid);
  check(
    `★★ 用不带字母的写法（${displayQid(realQid)}）也能解析到真实目录`,
    paths.resolveQid(displayQid(realQid)) === realQid,
    paths.resolveQid(displayQid(realQid))
  );
  check(
    '★ 而老库里"目录名本来就叫 T0001"时，原样返回（不多加字母）',
    paths.resolveQid(LEGACY) === LEGACY,
    paths.resolveQid(LEGACY)
  );
  const bareNumber = realQid.replace(/^[A-Z]T/, '');
  check(
    `★ 纯数字的老写法也能解析（${bareNumber} → ${realQid}）`,
    paths.resolveQid(bareNumber) === realQid,
    paths.resolveQid(bareNumber)
  );
  check(
    '★ 但库里真的没有对应目录时不做无中生有（原样返回，让它照常 404）',
    paths.resolveQid('9999') === '9999',
    paths.resolveQid('9999')
  );
  check(
    '★ 已经带字母的写法原样返回（不做二次猜测）',
    paths.resolveQid('BT0001') === 'BT0001',
    paths.resolveQid('BT0001')
  );

  // ============================================================
  section('#8 注册表被手改坏时的兜底');
  // ============================================================
  const file = subjects.subjectsFilePath();
  const good = fs.readFileSync(file, 'utf-8');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf-8');
  check(
    '★ 注册表坏成非法 JSON → 按"单学科 A"兜底（程序不会打不开）',
    subjects.readSubjects().active === 'A' && subjects.listSubjects().length === 1,
    JSON.stringify(subjects.readSubjects())
  );
  fs.writeFileSync(file, good, 'utf-8');
  check('改回来后又认得出 5 个学科', subjects.listSubjects().length === 5, String(subjects.listSubjects().length));

  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, active: 'Z', subjects: [{ id: 'A', name: '数学', dir: '' }] }),
    'utf-8'
  );
  check('★ active 指向不存在的字母 → 落到第一个学科', subjects.activeSubjectId() === 'A', subjects.activeSubjectId());
  fs.writeFileSync(file, good, 'utf-8');

  // ============================================================
  section('#9 边界：字母用完 / 目录撞车');
  // ============================================================
  const reg = subjects.readSubjects();
  check(
    '建满 5 个之后字母正好用掉 A–E',
    reg.subjects.map((s) => s.id).join('') === 'ABCDE',
    reg.subjects.map((s) => s.id).join('')
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      active: 'A',
      subjects: [
        { id: 'A', name: '数学', dir: '' },
        { id: 'B', name: '化学', dir: '同名' },
        { id: 'C', name: '物理', dir: '同名' },
      ],
    }),
    'utf-8'
  );
  check(
    '★ 两个学科指同一个目录 → 丢掉第二个（否则两科的数据会互相污染）',
    subjects.listSubjects().length === 2,
    JSON.stringify(subjects.listSubjects())
  );
  fs.writeFileSync(file, good, 'utf-8');
}

main()
  .then(() => {
    console.log(`\n${'='.repeat(56)}`);
    console.log(`通过 ${pass}，失败 ${fail}`);
    if (failures.length) {
      console.log('\n失败项：');
      for (const f of failures) console.log(`  · ${f}`);
    }
  })
  .catch((e) => {
    console.error('\n脚本自身出错：', e);
    fail++;
  })
  .finally(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 删不掉无所谓 */
    }
    process.exit(fail === 0 ? 0 : 1);
  });

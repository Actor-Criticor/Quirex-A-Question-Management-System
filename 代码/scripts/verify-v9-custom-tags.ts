/**
 * verify-v9-custom-tags.ts — 校验「自定义标签」这条新维度真的成立（v9 #5）
 *
 * 要证明的六件事（每条都能证伪）：
 *   1. **两条上限真的拦得住**：第 6 个被拒、21 个字被拒；而且在 create 与 PATCH
 *      两个写入入口**都**拦（只在一边拦 = 另一边是后门）
 *   2. **整卷没有这一维**：传了也被丢弃（和知识点同一个口径）
 *   3. 落盘 / 读回一致；**没设过就不写这个字段**（"没有"和"空数组"要分清）
 *   4. 标签表、索引、关键字检索都认它
 *   5. 标签治理（登记 / 停用 / 恢复 / 改名 / 彻底清除）在第三维上同样работает，
 *      而且**不串到知识点那一维去**
 *   6. 浏览页的筛选面里**没有**它（你说过"别的地方不放"）——
 *      所以 `?custom=xxx` 这种参数必须是无效的
 *
 * 跑法：不需要浏览器，但要先 npm run dev（第 3、5、6 段打真接口）。
 * 自清理：建的题用「校验测试」这个来源，跑完停用；自建的标签全部彻底清除。
 */

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';

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

/** 前提：库里得先有种子数据（npx tsx scripts/seed-demo.ts --reset） */
const SRC = '校验测试';

/**
 * 一个**确定**超过 20 个字的名字。
 * 别手数汉字 —— 上一个版本里我写了一句"刚好二十一个字"的中文，
 * 实际只有 19 个，于是"21 字被拒"那条断言测的是个合法值，
 * 失败了还以为是校验没生效。用 repeat 生成，长度写死。
 */
const TOO_LONG = '超'.repeat(21);

async function main(): Promise<void> {
  const service = await import('../src/lib/service');
  const store = await import('../src/lib/store');
  const { TAG_KINDS, TAG_KIND_LABEL, CUSTOM_TAG_MAX, CUSTOM_TAG_LEN_MAX, truncateCustomTag } =
    await import('../src/lib/types');
  const { validateCustomTags } = await import('../src/lib/validate');
  const { entryTagNames } = await import('../src/lib/searchIndex');

  const created: string[] = [];
  /** 自建的标签，跑完全部彻底清除（绝不留在演示库里） */
  const MINE = ['v9自建甲', 'v9自建乙'];

  const mk = async (custom: unknown, extra: Record<string, unknown> = {}): Promise<{
    ok: boolean;
    qid?: string;
    error?: string;
  }> => {
    try {
      const r = await service.createQuestion({
        kind: '单题',
        type: '填空',
        source: SRC,
        number: 1,
        difficulty: 0.5,
        stem: '$1+1=$\\fillin',
        answer: '$2$',
        custom,
        ...extra,
      });
      created.push(r.qid);
      return { ok: true, qid: r.qid };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  try {
    // ============================================================
    section('#1 维度与常量');
    // ============================================================
    check(
      `★ 标签有三个维度：${TAG_KINDS.join(' / ')}`,
      TAG_KINDS.length === 3 && (TAG_KINDS as readonly string[]).includes('custom'),
      TAG_KINDS.join(',')
    );
    check('第三维在界面上的名字叫「自定义」', TAG_KIND_LABEL.custom === '自定义', TAG_KIND_LABEL.custom);
    check(`上限常量：每题 ${CUSTOM_TAG_MAX} 个、每个 ${CUSTOM_TAG_LEN_MAX} 字`, CUSTOM_TAG_MAX === 5 && CUSTOM_TAG_LEN_MAX === 20);
    check(
      '★ 列表行截断到 7 个字（8 个字 → 前 7 个 + …）',
      truncateCustomTag('期中复习重点加强') === '期中复习重点加…',
      `${truncateCustomTag('期中复习重点加强')}（原文 ${'期中复习重点加强'.length} 字）`
    );
    check('7 个字以内原样返回（不加省略号）', truncateCustomTag('送分题') === '送分题' && truncateCustomTag('七个字刚刚好').length === 6);
    check('正好 7 个字也不截', truncateCustomTag('一二三四五六七') === '一二三四五六七', truncateCustomTag('一二三四五六七'));

    // ============================================================
    section('#2 两条上限：第 6 个被拒、21 个字被拒');
    // ============================================================
    const five = ['一', '二', '三', '四', '五'];
    const six = [...five, '六'];

    const r5 = await mk(five);
    check(`★ 5 个自定义标签能存（${r5.qid}）`, r5.ok, r5.error);

    const r6 = await mk(six);
    check(
      `★ 第 6 个被拒：${r6.error ?? ''}`,
      !r6.ok && /最多 5 个/.test(r6.error ?? ''),
      r6.error
    );

    const r21 = await mk([TOO_LONG]);
    check(
      `★ 21 个字被拒：${r21.error ?? ''}`,
      !r21.ok && /最长 20 个字/.test(r21.error ?? ''),
      r21.error || `居然通过了（${TOO_LONG.length} 字）`
    );

    check(`测试用的这个名字确实是 21 个字（${TOO_LONG.length}）`, TOO_LONG.length === 21, String(TOO_LONG.length));

    const exactly20 = '长'.repeat(20);
    check('测试用的这个名字确实是 20 个字', exactly20.length === 20, String(exactly20.length));
    const r20 = await mk([exactly20]);
    check(`★ 正好 20 个字能存（边界不误伤）`, r20.ok, r20.error);

    const rDup = await mk(['同名', '同名', '同名', '同名', '同名', '同名']);
    check(
      '★ 重复的只算一个（去重之后再判上限）—— 6 个同名不等于 6 个',
      rDup.ok,
      rDup.error
    );
    if (rDup.ok) {
      const m = store.readMeta(rDup.qid!);
      check('去重后只留一个', JSON.stringify(m?.custom) === '["同名"]', JSON.stringify(m?.custom));
    }

    const rSpace = await mk([' '.repeat(30) + 'x'.repeat(21)]);
    check(
      '★ 靠首尾空格凑长度也拦得住（校验看的是规范化之后的值）',
      !rSpace.ok && /最长 20 个字/.test(rSpace.error ?? ''),
      rSpace.error
    );

    check('常量跟校验器同一份（不是两处各写一个数）', validateCustomTags(five) === null && !!validateCustomTags(six));

    // ============================================================
    section('#3 PATCH 也是写入入口，必须同样拦');
    // ============================================================
    const target = r5.qid!;
    const badPatch = await api('PATCH', `/api/questions/${target}`, { custom: six });
    check(
      `★ 走接口改题塞第 6 个 → 400：${String(badPatch.data.error ?? '')}`,
      badPatch.status === 400 && /最多 5 个/.test(String(badPatch.data.error ?? '')),
      JSON.stringify(badPatch.data)
    );
    const badPatch2 = await api('PATCH', `/api/questions/${target}`, { custom: [TOO_LONG] });
    check(
      `★ 走接口改题塞 21 个字 → 400：${String(badPatch2.data.error ?? '')}`,
      badPatch2.status === 400 && /最长 20 个字/.test(String(badPatch2.data.error ?? '')),
      JSON.stringify(badPatch2.data)
    );
    const goodPatch = await api('PATCH', `/api/questions/${target}`, { custom: ['改过之后'] });
    check('★ 合法值走 PATCH 能改（白名单没漏这个字段）', goodPatch.status === 200, JSON.stringify(goodPatch.data).slice(0, 200));
    check(
      '改完读回来就是新值',
      JSON.stringify(store.readMeta(target)?.custom) === '["改过之后"]',
      JSON.stringify(store.readMeta(target)?.custom)
    );
    const clearPatch = await api('PATCH', `/api/questions/${target}`, { custom: [] });
    check('★ 传空数组 = 清掉这一维', clearPatch.status === 200 && store.readMeta(target)?.custom === undefined, JSON.stringify(store.readMeta(target)?.custom));

    // ============================================================
    section('#4 整卷没有这一维（和知识点同一个口径）');
    // ============================================================
    const paper = await service.createQuestion({
      kind: '整卷',
      source: SRC,
      difficulty: 0.6,
      description: '校验用整卷',
      pdf: { paper: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40)]) },
      custom: ['整卷不该有'],
    } as never);
    created.push(paper.qid);
    check(
      '★ 给整卷传自定义标签 → 被丢弃（文件里没有这个字段）',
      store.readMeta(paper.qid)?.custom === undefined,
      JSON.stringify(store.readMeta(paper.qid)?.custom)
    );
    const paperPatch = await api('PATCH', `/api/questions/${paper.qid}`, { custom: ['也不该有'] });
    check('★ 整卷走 PATCH 传也无效', paperPatch.status === 200 && store.readMeta(paper.qid)?.custom === undefined);

    // ============================================================
    section('#5 落盘 / 读回 / 索引');
    // ============================================================
    const withTags = await mk(['落盘甲', '落盘乙']);
    const qid = withTags.qid!;
    const mdRaw = (await import('fs')).readFileSync(
      (await import('path')).join(
        (await import('../src/lib/paths')).questionDir(qid),
        `${qid}.md`
      ),
      'utf-8'
    );
    check('★ md 的 frontmatter 里有 custom: [...]', /^custom:\s*$/m.test(mdRaw) || /custom:/.test(mdRaw), mdRaw.slice(0, 300));
    check('两个值都在文件里', mdRaw.includes('落盘甲') && mdRaw.includes('落盘乙'), mdRaw.slice(0, 300));
    check(
      '读回来一模一样（读的一侧不查上限、不去重顺序打乱）',
      JSON.stringify(store.readMeta(qid)?.custom) === '["落盘甲","落盘乙"]',
      JSON.stringify(store.readMeta(qid)?.custom)
    );

    const noTags = await mk([]);
    const md2 = (await import('fs')).readFileSync(
      (await import('path')).join((await import('../src/lib/paths')).questionDir(noTags.qid!), `${noTags.qid}.md`),
      'utf-8'
    );
    check('★★ 没设过就**不写这个字段**（不是写一个空的 custom: []）', !/custom/.test(md2), md2.slice(0, 200));
    check('读回来是 undefined（不是空数组）', store.readMeta(noTags.qid!)?.custom === undefined);

    const entries = service.searchQuestions({ source: SRC, status: '全部', size: 50 }).items;
    const e1 = entries.find((e) => e.qid === qid);
    check('★ 索引里有 custom', JSON.stringify(e1?.custom) === '["落盘甲","落盘乙"]', JSON.stringify(e1?.custom));
    check(
      '★ 关键字路包含自定义标签名（打「落盘甲」能搜到）',
      !!e1 && entryTagNames(e1).includes('落盘甲'),
      JSON.stringify(e1 ? entryTagNames(e1) : null)
    );
    const byKeyword = service.searchQuestions({ q: '落盘甲', status: '全部', size: 50 });
    check(`★ 用标签名当关键字检索能命中（${byKeyword.total} 条）`, byKeyword.items.some((e) => e.qid === qid), `total=${byKeyword.total}`);
    const byKeyword2 = service.searchQuestions({ q: '落盘乙', status: '全部', size: 50 });
    check('第二个值也能命中', byKeyword2.items.some((e) => e.qid === qid));

    // ============================================================
    section('#6 标签表：第三维与另外两维并列');
    // ============================================================
    const vocab = service.listTags(true);
    check('★ listTags 返回三个维度', Object.keys(vocab).sort().join(',') === 'custom,knowledge,source', Object.keys(vocab).join(','));
    const mine = vocab.custom.find((t) => t.name === '落盘甲');
    check('★ 自建值出现在自定义标签表里，计数是 1', mine?.count === 1 && mine.kind === 'custom', JSON.stringify(mine));
    check(
      '它不在知识点表里（两维没串）',
      !vocab.knowledge.some((t) => t.name === '落盘甲'),
      JSON.stringify(vocab.knowledge.map((t) => t.name).slice(0, 5))
    );
    check(
      '★ 演示库种子数据里本来就有自定义标签（doc 里的例子）',
      vocab.custom.some((t) => t.name === '送分题') && vocab.custom.length >= 10,
      `${vocab.custom.length} 个`
    );
    check(
      '★ 种子里有超过 7 个字的标签（用来演示列表截断）',
      vocab.custom.some((t) => t.name.length > 7),
      vocab.custom.map((t) => t.name).join('、')
    );

    // 停用 / 恢复
    service.retireTag('custom', '落盘乙');
    check('★ 停用自定义标签：默认表里没有了', !service.listTags(false).custom.some((t) => t.name === '落盘乙'));
    check('「显示已停用」还能看到它', service.listTags(true).custom.some((t) => t.name === '落盘乙' && t.retired));
    check(
      '★ 停用**不动题目文件**（值还在，只是从表里消失）',
      JSON.stringify(store.readMeta(qid)?.custom) === '["落盘甲","落盘乙"]',
      JSON.stringify(store.readMeta(qid)?.custom)
    );
    service.restoreTag('custom', '落盘乙');
    check('恢复之后又回来了', service.listTags(false).custom.some((t) => t.name === '落盘乙'));

    // 手工登记
    service.addTag('custom', MINE[0]);
    check('★ 能手工登记一个自定义标签', service.listTags(true).custom.some((t) => t.name === MINE[0] && t.manual));
    let addTooLong = '';
    try {
      service.addTag('custom', TOO_LONG);
    } catch (e) {
      addTooLong = (e as Error).message;
    }
    check(`★ 手工登记超过 20 个字也被拒：${addTooLong}`, /最长 20 个字/.test(addTooLong), addTooLong || '居然通过了');

    // 改名（另一个写入入口）
    let renameTooLong = '';
    try {
      service.renameTag('custom', MINE[0], TOO_LONG);
    } catch (e) {
      renameTooLong = (e as Error).message;
    }
    check(`★ 改名改成超长也被拒（不能靠改名绕过长度上限）：${renameTooLong}`, /最长 20 个字/.test(renameTooLong), renameTooLong || '居然通过了');

    const before = JSON.stringify(store.readMeta(qid)?.knowledge);
    const rn = service.renameTag('custom', '落盘甲', '改名之后');
    check(`★ 改名影响到 1 道题（changed=${rn.changed}）`, rn.changed === 1, String(rn.changed));
    check('★ 题目上的值真的换了', JSON.stringify(store.readMeta(qid)?.custom) === '["改名之后","落盘乙"]', JSON.stringify(store.readMeta(qid)?.custom));
    check('★★ 知识点一个字节都没动（改名只作用于指定那一维）', JSON.stringify(store.readMeta(qid)?.knowledge) === before, `${before} → ${JSON.stringify(store.readMeta(qid)?.knowledge)}`);
    check('标签表里的名字也跟着走', service.listTags(true).custom.some((t) => t.name === '改名之后'));

    // 从备份还原 —— 这是第三个"会写 custom 字段"的地方，必须一起验
    // （v9 第一版就是这里漏了：备份里存错了值，还原时直接把整维删掉）
    const rb = service.restoreBackup(rn.backupId);
    check(`★ 从备份还原 1 道题（restored=${rb.restored}）`, rb.restored === 1, String(rb.restored));
    check(
      '★★ 还原后自定义标签回到原名（备份里存的就是这一维的原值）',
      JSON.stringify(store.readMeta(qid)?.custom) === '["落盘甲","落盘乙"]',
      JSON.stringify(store.readMeta(qid)?.custom)
    );
    // 再改一次，接着测彻底清除
    service.renameTag('custom', '落盘甲', '改名之后');

    // 彻底清除
    const pg = service.purgeTag('custom', '改名之后');
    check(`★ 彻底清除：从 1 道题上摘掉（changed=${pg.changed}）`, pg.changed === 1, String(pg.changed));
    check('题目上只剩另一个值', JSON.stringify(store.readMeta(qid)?.custom) === '["落盘乙"]', JSON.stringify(store.readMeta(qid)?.custom));
    check('标签表里也没了', !service.listTags(true).custom.some((t) => t.name === '改名之后'));

    // ============================================================
    section('#7 浏览页的筛选面里没有它（"别的地方不放"）');
    // ============================================================
    const viaApi = await api(
      'GET',
      `/api/questions/search?custom=${encodeURIComponent('落盘乙')}&status=全部&size=200`
    );
    // 基准必须是**同样不带其它过滤**的一次查询：拿"带 source 过滤"的结果比
    // 就只是证明了"两个不同查询结果不同"，什么也没证明（上一版就是这么错的）
    const noFilter = await api('GET', '/api/questions/search?status=全部&size=200');
    check(
      '★ 传 ?custom=… 不会过滤（这一维不是筛选条件，参数被忽略）',
      (viaApi.data.items as unknown[])?.length === (noFilter.data.items as unknown[])?.length,
      `带 custom 参数 ${(viaApi.data.items as unknown[])?.length} / 不带 ${(noFilter.data.items as unknown[])?.length}`
    );
    const tagsApi = await api('GET', '/api/tags?includeRetired=1');
    const tagsVocab = tagsApi.data.vocab as Record<string, unknown[]>;
    check(
      '★ /api/tags 三个维度都返回（标签管理页要能治理它）',
      !!tagsVocab.source && !!tagsVocab.knowledge && !!tagsVocab.custom,
      Object.keys(tagsVocab ?? {}).join(',')
    );
  } finally {
    // ---- 自清理：建的题停用、自建的标签彻底清除 ----
    for (const q of created) {
      try {
        service.updateQuestion(q, { status: '停用' });
      } catch {
        /* 已经没了就算了 */
      }
    }
    for (const name of [...MINE, '落盘乙', '同名', '改过之后']) {
      try {
        service.purgeTag('custom', name);
      } catch {
        /* 不存在就算了 */
      }
    }
    // 历史遗留的校验题也一并停用（上一次中途崩掉没跑到这一步）
    try {
      const leftovers = service.searchQuestions({ source: SRC, status: '启用', size: 200 }).items;
      for (const e of leftovers) service.updateQuestion(e.qid, { status: '停用' });
      console.log(`\n（已停用 ${created.length + leftovers.length} 道校验题；自建的标签已彻底清除）`);
    } catch (e) {
      console.log(`\n（清理时出错：${(e as Error).message}）`);
    }
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

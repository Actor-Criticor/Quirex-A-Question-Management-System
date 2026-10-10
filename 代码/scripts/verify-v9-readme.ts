/**
 * verify-v9-readme.ts — 校验《模板/自建模板规范.md》那节「从零做一套模板」说的是真的（v9 #4）
 *
 * 为什么值得单写一个脚本：**文档是最容易悄悄烂掉的东西**。
 * 你按文档一步步做，做不出来，最可能的错因却在文档自己身上。
 * 所以这里不是"读一遍文档看它写得对不对"，而是：
 *
 *   1. 把文档里那段 JSON 与那段 LaTeX **原文抠出来**（不复制一份到脚本里 ——
 *      复制一份就变成"校验脚本自己和自己对答案"了）；
 *   2. 照文档说的建成一套真的模板，**真导出、真跑 xelatex**；
 *   3. 文档里那张「常见错误对照表」引用的报错话术，逐条拿到校验器上复现一遍 ——
 *      话术对不上就说明文档在骗人（或者代码改了文档没跟）。
 *
 * 跑法：先 npm run dev（导出要走接口层读题库），再 npx tsx scripts/verify-v9-readme.ts
 * 导出到临时目录，不动你的 导出/；模板目录里临时套房建完就删。
 *
 * v11：这套模板说明从 README.md 搬到了「模板/自建模板规范.md」（README 精简了），
 * 脚本跟着改读新文件 —— 文档搬家不该让校验失效。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { isolateVault } from './isolate';

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000';
// 模板规范在「模板」文件夹里，也就是「代码」的上一层再进「模板」
const DOC = path.resolve(__dirname, '..', '..', '模板', '自建模板规范.md');

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

/** 取某个小节标题之后、下一个 `####` 之前的那一段 Markdown */
function sectionText(md: string, heading: string): string {
  const i = md.indexOf(heading);
  if (i < 0) return '';
  const rest = md.slice(i + heading.length);
  const next = rest.search(/\n#{2,4} /);
  return next < 0 ? rest : rest.slice(0, next);
}

/** 取一段文本里全部 ```lang 围栏代码块的内容 */
function fencedBlocks(text: string, lang?: string): string[] {
  const re = new RegExp('```' + (lang ?? '') + '\\r?\\n([\\s\\S]*?)```', 'g');
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[1].replace(/\r\n/g, '\n'));
  return out;
}

async function main(): Promise<void> {
  const {
    validateTemplate,
    KNOWN_TOKENS,
    TOKEN_DOC,
    TEMPLATE_SCHEMA,
    manifestSkeleton,
  } = await import('../src/lib/templates');
  const { templatesRootDir, exportHandout } = await import('../src/lib/latexExport');
  const { listQidFolders } = await import('../src/lib/paths');

  const md = fs.readFileSync(DOC, 'utf-8');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-v9-readme-'));
  const realRoot = templatesRootDir();
  const DEMO_ID = 'v9README示例';
  const demoDir = path.join(realRoot, DEMO_ID);
  process.env.EXPORT_DIR = path.join(TMP, '导出');
  process.env.VAULT_PATH = path.join(TMP, '题库');
  // 光设环境变量不够：config.json 的优先级更高（见 isolate.ts 里的说明）
  isolateVault(path.join(TMP, '题库'), path.join(TMP, '导出'));
  /*
   * 这一节要用「照抄来的模板」真导出一份，所以得有题可导。
   *
   * v10：改成**自己造题、写进临时题库** —— 以前是拿当前库里的演示题，于是
   * "题库为空"时它会红一片（真事：清空演示库之后就这样）。
   * 校验脚本不该指望用户库里恰好有数据，更不该为了自检往用户的库里写东西。
   */

  const { default: service } = { default: await import('../src/lib/service') };

  async function ensureQuestions(): Promise<string[]> {
    const existing = listQidFolders();
    if (existing.length > 0) return existing.slice(0, 3);
    const out: string[] = [];
    for (const n of [1, 2]) {
      const r = await service.createQuestion({
        kind: '单题',
        type: '填空',
        source: 'README示例',
        number: n,
        difficulty: 0.8,
        stem: `$1+${n}=$\\fillin`,
        answer: `$${1 + n}$`,
      });
      out.push(r.qid);
    }
    return out;
  }

  try {
    // ============================================================
    section('#1 规范里那张「六占位符」表与代码是一致的');
    // ============================================================
    const tokenSec = sectionText(md, '#### `main.tex` 里可以写什么');
    check('规范里有「main.tex 里可以写什么」这一节', tokenSec.length > 200, `${tokenSec.length} 字`);
    for (const t of KNOWN_TOKENS) {
      check(
        `六个占位符里的 ${t} 在文档里有说明（${TOKEN_DOC[t].slice(0, 12)}…）`,
        tokenSec.includes(`\`{{${t}}}\``),
        `规范里没写 {{${t}}}`
      );
    }
    check('文档说 PRESET 必须声明', /\|\s*\*\*必须\*\*\s*\|/.test(tokenSec) && /PRESET/.test(tokenSec));
    check(
      '★ 文档里列出的占位符数量 = 代码认识的占位符数量（多了少了都是文档漂了）',
      (tokenSec.match(/`\{\{[A-Z]+\}\}`/g) ?? []).length === KNOWN_TOKENS.length,
      `文档 ${(tokenSec.match(/`\{\{[A-Z]+\}\}`/g) ?? []).length} / 代码 ${KNOWN_TOKENS.length}`
    );

    // ============================================================
    section('#2 规范里那张 `meta.json` 字段表与代码是一致的');
    // ============================================================
    const fieldSec = sectionText(md, '#### `meta.json` 的字段');
    for (const k of ['schema', 'name', 'styleFiles', 'tokens', 'description', 'engine', 'defaults']) {
      check(`字段表里有 ${k}`, fieldSec.includes(`\`${k}\``), `规范里没写 ${k}`);
    }
    const skeleton = manifestSkeleton('我的模板') as string;
    const skeletonKeys = Object.keys(JSON.parse(skeleton) as Record<string, unknown>);
    check(
      `★ 文档列的字段 = 校验器给出的骨架里的字段（${skeletonKeys.join('、')}）`,
      skeletonKeys.every((k) => fieldSec.includes(`\`${k}\``)),
      JSON.stringify(skeletonKeys)
    );
    check(
      `骨架里的 schema 就是 ${TEMPLATE_SCHEMA}（文档说必须写 1）`,
      (JSON.parse(skeleton) as { schema: number }).schema === TEMPLATE_SCHEMA && fieldSec.includes('`1`'),
      skeleton
    );
    check('文档说 defaults 只有 group 一个键', /只有一个键 `group`/.test(fieldSec), fieldSec.slice(0, 200));
    check(
      '★ 文档不再提"不生效的" preset / layout（v9 收窄过，别又写回来）',
      !/`preset`|`layout`/.test(fieldSec.slice(0, fieldSec.indexOf('#### 最小可抄'))),
      '字段表里又出现了 preset / layout'
    );

    // ============================================================
    section('#3 ★ 规范里那份「可照抄的最小模板」真的能用');
    // ============================================================
    const miniSec = sectionText(md, '#### 最小可抄的一份模板');
    const jsonBlocks = fencedBlocks(miniSec, 'json');
    const texBlocks = fencedBlocks(miniSec, 'latex');
    check('规范里有可照抄的 meta.json（json 代码块）', jsonBlocks.length === 1, `${jsonBlocks.length} 块`);
    check('规范里有可照抄的 main.tex（latex 代码块）', texBlocks.length === 1, `${texBlocks.length} 块`);

    const miniMetaRaw = jsonBlocks[0] ?? '';
    const miniMain = texBlocks[0] ?? '';
    let miniMeta: Record<string, unknown> = {};
    try {
      miniMeta = JSON.parse(miniMetaRaw) as Record<string, unknown>;
    } catch (e) {
      check('规范里的 meta.json 是合法 JSON', false, (e as Error).message);
    }
    check('★ 规范里的 meta.json 是合法 JSON', Object.keys(miniMeta).length > 0, miniMetaRaw.slice(0, 120));
    console.log(`      照抄的 meta.json：${miniMetaRaw.trim().replace(/\s+/g, ' ')}`);
    console.log(`      照抄的 main.tex 行数：${miniMain.trim().split('\n').length}`);

    // 照 README 说的把它建成一套模板（quirex.sty 从现成模板复制一份）
    fs.mkdirSync(demoDir, { recursive: true });
    fs.writeFileSync(path.join(demoDir, 'main.tex'), miniMain, 'utf-8');
    fs.writeFileSync(path.join(demoDir, 'meta.json'), miniMetaRaw, 'utf-8');
    fs.copyFileSync(path.join(realRoot, '默认', 'quirex.sty'), path.join(demoDir, 'quirex.sty'));

    const info = validateTemplate(demoDir, DEMO_ID);
    check('★★ 照规范抄出来的模板**校验通过、可用**', info.usable, info.issues.join(' | '));
    check(
      `★ 显示名就是规范里写的那个（${String(miniMeta.name)}）`,
      info.manifest?.name === miniMeta.name,
      String(info.manifest?.name)
    );

    const apiRes = await fetch(`${BASE}/api/export/templates`, { cache: 'no-store' });
    const apiData = (await apiRes.json()) as {
      templates?: Array<{ id: string; name: string; usable: boolean }>;
    };
    const apiRow = (apiData.templates ?? []).find((t) => t.id === DEMO_ID);
    check('★★ 接口也认它、并标成可用（导出弹窗里选得到）', apiRow?.usable === true, JSON.stringify(apiRow));

    const qids = await ensureQuestions();
    check(`临时题库里有题可导（${qids.length} 道）`, qids.length >= 1, JSON.stringify(qids));
    const res = await exportHandout({
      title: 'v9README最小模板',
      qids,
      options: { template: DEMO_ID },
    });
    check('★★ 用照抄来的模板真导出了一份', res.count > 0, `count=${res.count}`);
    for (const role of ['题目', '答案'] as const) {
      const logPath = path.join(res.outDir, `${role}.log`);
      check(`${role}.log 存在（说明真跑了 xelatex）`, fs.existsSync(logPath), logPath);
      if (!fs.existsSync(logPath)) continue;
      const log = fs.readFileSync(logPath, 'utf-8');
      check(
        `★★ 照抄来的模板编译 ${role}.log 0 错误`,
        !/^! /m.test(log),
        (log.match(/^! .*/m) ?? [''])[0]
      );
      check(`★ ${role}.pdf 真的生成了`, fs.existsSync(path.join(res.outDir, `${role}.pdf`)));
    }
    const tex = fs.readFileSync(path.join(res.outDir, '题目.tex'), 'utf-8');
    check('★ 生成的 tex 里没有残留占位符', !/\{\{[A-Z]+\}\}/.test(tex), (tex.match(/\{\{[A-Z]+\}\}/) ?? [''])[0]);
    check('★ title 真的被替换进去了', tex.includes('v9README最小模板'));

    // ============================================================
    section('#4 ★ 那张「常见错误对照表」引用的报错话术，逐条复现');
    // ============================================================
    const errSec = sectionText(md, '#### 常见错误对照表');
    /** 对照表里带反引号包代码（比如 `{{TITLE}}`），比对时把反引号去掉 */
    const errPlain = errSec.replace(/`/g, '');
    check('规范里有「常见错误对照表」', errSec.length > 200, `${errSec.length} 字`);

    /** 造一个坏模板，返回校验器给出的问题全文 */
    const bad = (
      files: { main?: string | null; meta?: string | null; sty?: string | null }
    ): string => {
      const dir = fs.mkdtempSync(path.join(TMP, 'bad-'));
      if (files.main !== null && files.main !== undefined) {
        fs.writeFileSync(path.join(dir, 'main.tex'), files.main, 'utf-8');
      }
      if (files.meta !== null && files.meta !== undefined) {
        fs.writeFileSync(path.join(dir, 'meta.json'), files.meta, 'utf-8');
      }
      if (files.sty) fs.writeFileSync(path.join(dir, 'quirex.sty'), '%x\n', 'utf-8');
      return validateTemplate(dir, 'bad').issues.join('\n');
    };
    const OK_MAIN = '\\usepackage{quirex}\n{{PRESET}}\n{{BODY}}\n';
    const okMeta = (patch: Record<string, unknown> = {}): string =>
      JSON.stringify(
        {
          schema: 1,
          name: '坏模板',
          engine: 'xelatex',
          styleFiles: ['quirex.sty'],
          tokens: ['PRESET', 'BODY'],
          ...patch,
        },
        null,
        2
      );

    // README 表里"症状"那一列的原话 → 拿真校验器复现
    const cases: Array<[string, () => string, RegExp]> = [
      ['缺少 main.tex', () => bad({ main: null, meta: okMeta(), sty: 'quirex.sty' }), /缺少 main\.tex/],
      ['缺少 meta.json', () => bad({ main: OK_MAIN, meta: null, sty: 'quirex.sty' }), /缺少 meta\.json/],
      [
        'schema 是 (没写)',
        () => bad({ main: OK_MAIN, meta: okMeta({ schema: undefined }), sty: 'quirex.sty' }),
        /schema 是 \(没写\)/,
      ],
      [
        'styleFiles 里写的 quirex.sty 找不到',
        () =>
          bad({ main: OK_MAIN, meta: okMeta({ styleFiles: ['quirex.sty'] }), sty: null }),
        /styleFiles 里写的 quirex\.sty 在模板目录里找不到/,
      ],
      [
        'tokens 里缺少必须声明的 BODY',
        () =>
          bad({
            main: '\\usepackage{quirex}\n{{PRESET}}\n',
            meta: okMeta({ tokens: ['PRESET'] }),
            sty: 'quirex.sty',
          }),
        /tokens 里缺少必须声明的 BODY/,
      ],
      [
        'tokens 声明了 TITLE，但 main.tex 里没有 {{TITLE}}',
        () =>
          bad({
            main: '\\usepackage{quirex}\n{{PRESET}}\n{{BODY}}\n',
            meta: okMeta({ tokens: ['TITLE', 'PRESET', 'BODY'] }),
            sty: 'quirex.sty',
          }),
        /tokens 声明了 TITLE，但 main\.tex 里没有 \{\{TITLE\}\}/,
      ],
      [
        '{{BODY}} 出现了 2 次',
        () => bad({ main: '\\usepackage{quirex}\n{{PRESET}}\n{{BODY}}\n{{BODY}}\n', meta: okMeta(), sty: 'quirex.sty' }),
        /main\.tex 里 \{\{BODY\}\} 出现了 2 次，必须恰好 1 次/,
      ],
      [
        '用了没在 tokens 里声明的占位符：AUTHOR',
        () => bad({ main: '\\usepackage{quirex}\n{{PRESET}}\n{{BODY}}\n{{AUTHOR}}\n', meta: okMeta(), sty: 'quirex.sty' }),
        /用了没在 tokens 里声明的占位符：AUTHOR/,
      ],
      [
        'engine 是「pdflatex」，目前只支持 xelatex',
        () => bad({ main: OK_MAIN, meta: okMeta({ engine: 'pdflatex' }), sty: 'quirex.sty' }),
        /engine 是「pdflatex」，目前只支持 xelatex/,
      ],
    ];

    for (const [symptom, run, pattern] of cases) {
      const issues = run();
      check(
        `对照表里的「${symptom}」确实是程序真会说的话`,
        pattern.test(issues),
        issues.replace(/\n/g, ' | ').slice(0, 160)
      );
      check(`★ 而且这一条在规范的对照表里（没有"代码报了文档没写"的错）`, errPlain.includes(symptom), symptom);
    }

    // ============================================================
    section('#5 校验规则清单里的那 10 条，条条对得上代码');
    // ============================================================
    const ruleSec = sectionText(md, '#### 校验规则（也是报错的依据）');
    const ruleCount = (ruleSec.match(/^\d+\. /gm) ?? []).length;
    check(`规范里列了 10 条校验规则（实际 ${ruleCount} 条）`, ruleCount === 10, String(ruleCount));
    check('第 1 条讲 main.tex 存在性', /main\.tex/.test(ruleSec));
    check('第 8 条讲 PRESET/BODY 必填', /必须含 `PRESET` 与 `BODY`/.test(ruleSec));
    check('第 9 条讲"恰好一次"', /恰好出现一次/.test(ruleSec));
    check('第 10 条讲"用到的都要声明"', /都必须先在 `tokens` 里声明/.test(ruleSec));
    check('★ 文档提到校验看的是"去掉注释之后"的文本（这是踩过的坑）', /去掉注释之后/.test(ruleSec + sectionText(md, '#### `main.tex` 里可以写什么')));
    // 顺带：这三条真的成立
    check(
      '★ "注释里的占位符不算数"确实成立（拿上面那个 OK_MAIN 加一行注释试试）',
      (() => {
        const dir = fs.mkdtempSync(path.join(TMP, 'comment-'));
        fs.writeFileSync(path.join(dir, 'main.tex'), '%% 说明 {{AUTHOR}}\n' + OK_MAIN, 'utf-8');
        fs.writeFileSync(path.join(dir, 'meta.json'), okMeta(), 'utf-8');
        fs.writeFileSync(path.join(dir, 'quirex.sty'), '%x\n', 'utf-8');
        return validateTemplate(dir, 'comment').usable;
      })()
    );
  } finally {
    for (const d of [demoDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* 删不掉算了 */
      }
    }
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 删不掉算了 */
    }
    console.log(`\n（临时模板 ${DEMO_ID} 已删除：${!fs.existsSync(demoDir)}）`);
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

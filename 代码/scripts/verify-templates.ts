/**
 * verify-templates.ts — 校验「模板契约」真的成立（v6 #4）
 *
 * 分四层，一层比一层硬：
 *   1. 注释剥离      —— 模板注释里写字面占位符不再有害（这是踩过的坑）
 *   2. 校验器        —— 每一种坏模板都必须被指出、并说清哪里坏
 *   3. 多模板        —— 换一个模板目录、换一个样式文件名，导出就跟着变
 *   4. 真导出 + 真编译 —— 用一个"只声明 BODY/PRESET/TITLE"的自制模板跑完整导出，
 *                        断言导出目录里出现的是**它的**样式文件名，且 xelatex 0 错误
 *
 * 不碰真题库、不碰真配置：题库仍读 ../题库，模板目录与导出目录用环境变量
 * 指到临时目录（进程内设置，跑完即失效）。
 * 运行：先 npm run dev（第 3、4 层要打接口），再 npx tsx scripts/verify-templates.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quirex-tpl-'));

/** 造一个模板目录。传 null 表示"这个文件不要写" */
function makeTemplate(
  root: string,
  id: string,
  files: { main?: string | null; meta?: string | null; sty?: string; styName?: string }
): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  if (files.main !== null && files.main !== undefined) {
    fs.writeFileSync(path.join(dir, 'main.tex'), files.main, 'utf-8');
  }
  if (files.meta !== null && files.meta !== undefined) {
    fs.writeFileSync(path.join(dir, 'meta.json'), files.meta, 'utf-8');
  }
  if (files.sty) {
    fs.writeFileSync(path.join(dir, files.styName ?? 'quirex.sty'), files.sty, 'utf-8');
  }
  return dir;
}

const MINI_MAIN = `\\documentclass[11pt,a4paper]{book}
\\usepackage{quirex}
\\newcommand{\\handoutHeader}{\\begin{center}{\\Large {{TITLE}}}\\end{center}}
{{PRESET}}
\\normalLayout
\\raggedbottom
\\begin{document}
\\handoutHeader
{{BODY}}
\\end{document}
`;

/** 造 meta.json。**不要用字符串替换去改** —— JSON.stringify 会换行，替换会静默失配 */
function miniMeta(patch: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      schema: 1,
      name: '迷你模板',
      description: '测试用',
      engine: 'xelatex',
      styleFiles: ['quirex.sty'],
      tokens: ['TITLE', 'PRESET', 'BODY'],
      ...patch,
    },
    null,
    2
  );
}

const MINI_META = miniMeta();

async function main(): Promise<void> {
  const {
    stripTexComments,
    applyTemplate,
    validateTemplate,
    listTemplateInfos,
    countToken,
    manifestSkeleton,
    KNOWN_TOKENS,
  } = await import('../src/lib/templates');
  const { templatesRootDir, resolveTemplate, listTemplates, exportHandout } = await import(
    '../src/lib/latexExport'
  );
  const { listQidFolders } = await import('../src/lib/paths');

  // ============================================================
  section('#1 注释剥离');
  // ============================================================
  check('去掉行尾注释', stripTexComments('a % 注释') === 'a ', JSON.stringify(stripTexComments('a % 注释')));
  check(
    '注释里的 {{BODY}} 一起被剥掉',
    !stripTexComments('%% 说明 {{BODY}} 写这里\\ncode').includes('{{BODY}}')
  );
  check(
    '\\% 不是注释（后面内容保留）',
    stripTexComments('50\\% 的学生 % 真注释').includes('50\\% 的学生'),
    JSON.stringify(stripTexComments('50\\% 的学生 % 真注释'))
  );
  check('\\\\（换行）后面的 % 仍是注释', stripTexComments('a\\\\ % x\\nb').includes('a\\\\'),
    JSON.stringify(stripTexComments('a\\\\ % x\\nb')));
  const verb = '\\begin{verbatim}\n100% 原文\n\\end{verbatim}';
  check('verbatim 里的 % 不是注释', stripTexComments(verb).includes('100% 原文'));

  // ============================================================
  section('#2 套用模板');
  // ============================================================
  // ★ 这是老 bug 的回归测试：注释里写占位符，正文里也写 → 以前计数为 2 直接报错，
  //   只写在注释里 → 静默把内容注进注释。现在两种都应该正常工作。
  const tplBoth = '%% 文档说明 {{BODY}} {{TITLE}}\n\\begin{document}\n{{BODY}}\n{{TITLE}}';
  const out1 = applyTemplate(tplBoth, { BODY: '\\begin{exercise}X\\end{exercise}', TITLE: '标题' });
  check('注释里的占位符不再导致"出现 2 次"报错', !out1.includes('{{'));
  check('正文被正确注入到 {{BODY}} 的位置', out1.includes('\\begin{exercise}'));
  check('注入内容在注释之外（前面没有 %）', !/%.*\\begin\{exercise\}/.test(out1));
  check('正文出现在 \\begin{document} 之后', out1.indexOf('\\begin{exercise}') > out1.indexOf('\\begin{document}'));

  const tplCommentOnly = '%% 说明 {{TITLE}}\n\\begin{document}\n{{BODY}}';
  const out2 = applyTemplate(tplCommentOnly, { TITLE: '不该出现', BODY: 'B' });
  check('只写在注释里的占位符不会被替换进注释', !out2.includes('不该出现'));
  check('没声明/没提供的占位符替换成空串', applyTemplate('a{{LAYOUT}}b', {}).length === 2);

  const tplTwice = '{{BODY}}\n{{BODY}}';
  let threw = '';
  try {
    applyTemplate(tplTwice, { BODY: 'x' });
  } catch (e) {
    threw = (e as Error).message;
  }
  check('真出现两次 → 报错', /2 次/.test(threw), threw);

  // ★ BODY 最后替换：正文里若含字面 {{TITLE}}，不能被二次替换
  const out3 = applyTemplate('{{TITLE}}\n{{BODY}}', { TITLE: '真标题', BODY: '正文里的 {{TITLE}}' });
  check('★ BODY 最后替换（正文里的字面 {{TITLE}} 原样保留）', out3.includes('正文里的 {{TITLE}}'), out3);

  check('countToken 计数正确', countToken('{{A}}x{{A}}', 'A') === 2);
  check('没写的 token 计数为 0', countToken('abc', 'A') === 0);

  // ============================================================
  section('#3 校验器：每种坏模板都要被指出来');
  // ============================================================
  const R = path.join(TMP, 'root1');
  fs.mkdirSync(R, { recursive: true });

  /** 每个用例：造模板 → 校验 → 断言"不可用且原因里提到了关键词" */
  const caseOf = (
    id: string,
    files: { main?: string | null; meta?: string | null; sty?: string; styName?: string },
    pattern: RegExp,
    label: string
  ) => {
    makeTemplate(R, id, { sty: '% 占位样式文件\n', ...files });
    const info = validateTemplate(path.join(R, id), id);
    const all = info.issues.join(' | ');
    check(label, !info.usable && pattern.test(all), info.usable ? '竟然通过了' : all.slice(0, 200));
  };

  caseOf('t-no-main', { main: null, meta: MINI_META }, /main\.tex/, '缺 main.tex → 报出来');
  caseOf('t-no-meta', { main: MINI_MAIN, meta: null }, /meta\.json/, '缺 meta.json → 报出来');
  caseOf('t-bad-json', { main: MINI_MAIN, meta: '{ 不是 JSON' }, /JSON/, 'meta.json 坏 JSON → 报出来');
  caseOf(
    't-bad-schema',
    { main: MINI_MAIN, meta: miniMeta({ schema: 2 }) },
    /schema/,
    'schema 版本不对 → 报出来'
  );
  caseOf('t-no-name', { main: MINI_MAIN, meta: miniMeta({ name: '' }) }, /name/, '缺 name → 报出来');
  caseOf(
    't-bad-engine',
    { main: MINI_MAIN, meta: miniMeta({ engine: 'pdflatex' }) },
    /xelatex/,
    'engine 不支持 → 报出来'
  );
  caseOf(
    't-no-sty',
    { main: MINI_MAIN, meta: miniMeta({ styleFiles: ['不存在.sty'] }) },
    /找不到/,
    'styleFiles 里的文件不存在 → 报出来'
  );
  caseOf(
    't-empty-sty',
    { main: MINI_MAIN, meta: miniMeta({ styleFiles: [] }) },
    /styleFiles/,
    'styleFiles 为空 → 报出来'
  );
  caseOf(
    't-empty-tokens',
    { main: MINI_MAIN, meta: miniMeta({ tokens: [] }) },
    /tokens/,
    'tokens 为空 → 报出来'
  );
  caseOf(
    't-unknown-token',
    { main: MINI_MAIN, meta: miniMeta({ tokens: ['TITLE', 'PRESET', 'BODY', 'FOO'] }) },
    /不认识的占位符/,
    '声明了不认识的占位符 → 报出来'
  );
  caseOf(
    't-no-preset',
    { main: MINI_MAIN, meta: miniMeta({ tokens: ['TITLE', 'BODY'] }) },
    /PRESET/,
    '★ 缺少 PRESET（题目/答案会一模一样）→ 报出来'
  );
  caseOf(
    't-no-body',
    { main: MINI_MAIN, meta: miniMeta({ tokens: ['TITLE', 'PRESET'] }) },
    /BODY/,
    '缺少 BODY（没有正文）→ 报出来'
  );
  caseOf(
    't-missing-in-tex',
    { main: '\\begin{document}\n{{BODY}}\n{{PRESET}}\n\\end{document}', meta: MINI_META },
    /没有 \{\{TITLE\}\}/,
    '声明了但 main.tex 里没有 → 报出来'
  );
  caseOf(
    't-twice-in-tex',
    { main: '{{TITLE}}{{TITLE}}\n{{PRESET}}\n{{BODY}}', meta: MINI_META },
    /恰好 1 次/,
    'main.tex 里出现两次 → 报出来'
  );
  caseOf(
    't-undeclared',
    { main: '{{TITLE}}\n{{PRESET}}\n{{BODY}}\n{{AUTHOR}}', meta: MINI_META },
    /没在 tokens 里声明/,
    'main.tex 用了没声明的占位符 → 报出来'
  );

  // 注释里的占位符不算数（这是刻意的宽松之处）
  const okComment = makeTemplate(R, 't-comment-ok', {
    main: '%% 说明：{{AUTHOR}} 在这里只是文档\n' + MINI_MAIN,
    meta: MINI_META,
    sty: '%x',
  });
  const okInfo = validateTemplate(okComment, 't-comment-ok');
  check(
    '★ 只在注释里出现的占位符，不算"用到了"（不再强迫模板作者回避）',
    okInfo.usable,
    okInfo.issues.join(' | ')
  );

  const good = makeTemplate(R, 't-good', { main: MINI_MAIN, meta: MINI_META, sty: '%x' });
  const goodInfo = validateTemplate(good, 't-good');
  check('一个合法模板通过校验', goodInfo.usable, goodInfo.issues.join(' | '));
  check('能读出显示名', goodInfo.manifest?.name === '迷你模板');
  check('能读出 styleFiles', JSON.stringify(goodInfo.manifest?.styleFiles) === '["quirex.sty"]');
  check(
    '不可用模板会给一份可照抄的 meta.json 骨架',
    manifestSkeleton('x').includes('"schema": 1') && manifestSkeleton('x').includes('"tokens"')
  );
  check('KNOWN_TOKENS 是六个占位符', KNOWN_TOKENS.length === 6);

  // ============================================================
  section('#4 仓库里真实的模板');
  // ============================================================
  const realRoot = templatesRootDir();
  check('模板根目录存在', fs.existsSync(realRoot), realRoot);
  const real = listTemplateInfos(realRoot);
  check('至少有一个模板', real.length >= 1, JSON.stringify(real.map((t) => t.id)));
  const def = real.find((t) => t.id === '默认');
  check('「默认」模板可用', !!def?.usable, def?.issues.join(' | '));
  check('「默认」的显示名是「默认讲义」', def?.manifest?.name === '默认讲义', String(def?.manifest?.name));
  check(
    '「默认」声明的样式文件是 quirex.sty（改名由 meta.json 驱动，不再写死在代码里）',
    JSON.stringify(def?.manifest?.styleFiles) === '["quirex.sty"]',
    JSON.stringify(def?.manifest?.styleFiles)
  );
  check('模板目录里确实有 quirex.sty', fs.existsSync(path.join(realRoot, '默认', 'quirex.sty')));
  check('模板目录里已经没有 mathatlas.sty', !fs.existsSync(path.join(realRoot, '默认', 'mathatlas.sty')));
  check('listTemplates() 只列可用的', JSON.stringify(listTemplates()) === JSON.stringify(real.filter((t) => t.usable).map((t) => t.id)));

  let errMsg = '';
  try {
    resolveTemplate('不存在模板');
  } catch (e) {
    errMsg = (e as Error).message;
  }
  check('取不存在的模板 → 报错并列出可用模板', /不存在[^]*默认/.test(errMsg), errMsg);

  errMsg = '';
  try {
    resolveTemplate('../../etc');
  } catch (e) {
    errMsg = (e as Error).message;
  }
  check('模板名带路径跳转 → 被挡住', /不合法/.test(errMsg), errMsg);

  // ============================================================
  section('#5 换模板目录 → 导出就跟着换（环境变量层）');
  // ============================================================
  const R2 = path.join(TMP, 'root2');
  fs.mkdirSync(R2, { recursive: true });
  // 一个"只有 BODY/PRESET/TITLE、样式文件叫 my-style.sty"的自制模板
  const customMain = `\\documentclass[11pt,a4paper]{book}
\\usepackage{my-style}
\\newcommand{\\handoutHeader}{\\begin{center}{\\Large {{TITLE}}}\\end{center}}
{{PRESET}}
\\normalLayout
\\raggedbottom
\\begin{document}
\\handoutHeader
{{BODY}}
\\end{document}
`;
  const customMeta = JSON.stringify(
    {
      schema: 1,
      name: '我的极简模板',
      description: '只有标题和正文，样式文件换了名字',
      engine: 'xelatex',
      styleFiles: ['my-style.sty'],
      tokens: ['TITLE', 'PRESET', 'BODY'],
    },
    null,
    2
  );
  const realSty = fs.readFileSync(path.join(realRoot, '默认', 'quirex.sty'), 'utf-8');
  makeTemplate(R2, '极简', { main: customMain, meta: customMeta, sty: realSty, styName: 'my-style.sty' });
  // 再加一个坏模板，确认它只是被标成不可用、不影响别的模板
  makeTemplate(R2, '坏的', { main: MINI_MAIN, meta: '{oops' });

  process.env.TEMPLATES_DIR = R2;
  const exportDir = path.join(TMP, '导出');
  process.env.EXPORT_DIR = exportDir;

  check('换了模板目录后 templatesRootDir() 跟着变', templatesRootDir() === R2, templatesRootDir());
  const infos2 = listTemplateInfos(R2);
  check('能列出 2 个模板（含不可用的）', infos2.length === 2, JSON.stringify(infos2.map((t) => t.id)));
  check('可用的只有自制模板', JSON.stringify(listTemplates()) === '["极简"]', JSON.stringify(listTemplates()));
  const bad = infos2.find((t) => t.id === '坏的');
  check('坏模板被标成不可用且带原因', !!bad && !bad.usable && bad.issues.length > 0, JSON.stringify(bad?.issues));

  // ============================================================
  section('#6 ★ 真导出 + 真编译：导出目录里应该出现 my-style.sty');
  // ============================================================
  const qids = listQidFolders().slice(0, 2);
  check('题库里有题可导', qids.length > 0, JSON.stringify(qids));

  const res = await exportHandout({ title: '模板契约验证', qids, options: { template: '极简' } });
  const files = fs.readdirSync(res.outDir);
  check('导出的模板 id 就是「极简」', res.template === '极简', res.template);
  check('导出的模板显示名是「我的极简模板」', res.templateName === '我的极简模板', res.templateName);
  check('★ 导出目录里有 my-style.sty', files.includes('my-style.sty'), files.join(', '));
  check('★ 导出目录里没有 quirex.sty（样式文件名完全由 meta.json 决定）', !files.includes('quirex.sty'), files.join(', '));

  const texQ = fs.readFileSync(path.join(res.outDir, '题目.tex'), 'utf-8');
  const texA = fs.readFileSync(path.join(res.outDir, '答案.tex'), 'utf-8');
  check('生成的 tex 里没有残留占位符', !/\{\{[A-Z]+\}\}/.test(texQ), (texQ.match(/\{\{[A-Z]+\}\}/g) ?? []).join(','));
  check('\\usepackage{my-style}', texQ.includes('\\usepackage{my-style}'));
  check('★ 生成的 tex 里没有残留注释行（注释在替换前已剥离）', !/^\s*%.*说明：/m.test(texQ));
  check('标题被替换进去了', texQ.includes('模板契约验证'), texQ.slice(0, 200));
  check('题目版是 presetStudent', texQ.includes('\\presetStudent'));
  check('答案版是 presetTeacher 且标题带（答案）', texA.includes('\\presetTeacher') && texA.includes('（答案）'));
  check('没用到的 AUTHOR/LAYOUT/DATE 不会报错（只替换声明的）', !texQ.includes('AUTHOR'));

  const readme = fs.readFileSync(path.join(res.outDir, '编译说明.txt'), 'utf-8');
  check('★ 编译说明里写的是 my-style.sty（不再写死名字）', readme.includes('my-style.sty'), readme.slice(0, 400));
  check('编译说明里写明了本次用的模板', readme.includes('我的极简模板'));

  check('★ 题目.pdf 编译成功', res.compile.questions.ok && res.compile.questions.pdfExists, JSON.stringify(res.compile.questions).slice(0, 300));
  check('★ 题目.log 0 错误', res.compile.questions.errorCount === 0, JSON.stringify(res.compile.questions));
  check('★ 答案.pdf 编译成功', res.compile.answers.ok && res.compile.answers.pdfExists, JSON.stringify(res.compile.answers));
  check('★ 答案.log 0 错误', res.compile.answers.errorCount === 0, JSON.stringify(res.compile.answers));

  // 坏模板必须被挡住，而且要说清原因
  let badExport = '';
  try {
    await exportHandout({ title: 'x', qids: [qids[0]], options: { template: '坏的' } });
  } catch (e) {
    badExport = (e as Error).message;
  }
  check('★ 用坏模板导出 → 直接报错，不产出半个文件夹', /不可用/.test(badExport), badExport.slice(0, 200));
  check('报错里带上了具体原因', /JSON/.test(badExport), badExport.slice(0, 200));

  // ============================================================
  section('#7 服务端也认这个契约（打真实接口）');
  // ============================================================
  const api = async (method: string, body?: unknown) => {
    const r = await fetch(`${BASE}/api/export/templates`, {
      method,
      cache: 'no-store',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };

  const g = await api('GET');
  check(
    '★ /api/export/templates 存在并返回模板列表',
    g.status === 200 && Array.isArray(g.data.templates) && g.data.templates.length >= 1,
    `status=${g.status} body=${JSON.stringify(g.data).slice(0, 200)}`
  );
  check(
    '接口返回模板目录与可用 id 列表',
    typeof g.data.root === 'string' && Array.isArray(g.data.usableIds),
    JSON.stringify(g.data).slice(0, 200)
  );
  check(
    '接口返回占位符字典（界面说明与后端话术同源）',
    typeof g.data.tokenDoc?.BODY === 'string' && g.data.knownTokens.length === 6
  );
  const row = (g.data.templates as Array<Record<string, unknown>>).find((t) => t.id === '默认');
  check('列表里能看到「默认」模板的显示名', row?.name === '默认讲义', JSON.stringify(row)?.slice(0, 200));
  check('列表里能看到它的样式文件', JSON.stringify(row?.styleFiles) === '["quirex.sty"]', JSON.stringify(row?.styleFiles));

  // ============================================================
  section('#8 ★ 改名：只动 meta.json 的 name，文件夹名不动，其它字段一字不改');
  // ============================================================
  const metaPath = path.join(realRoot, '默认', 'meta.json');
  const before = fs.readFileSync(metaPath); // 字节留底，最后要原样还回去
  const originalName = JSON.parse(before.toString('utf-8')).name as string;

  try {
    const r1 = await api('POST', { action: 'rename', id: '默认', name: '临时改的名' });
    check('改名接口 200', r1.status === 200 && r1.data.name === '临时改的名', JSON.stringify(r1.data));

    const after = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    check('meta.json 里的 name 变了', after.name === '临时改的名', String(after.name));
    check('文件夹名没变（还是「默认」）', fs.existsSync(path.join(realRoot, '默认', 'main.tex')));
    check('schema 没被动过', after.schema === 1, JSON.stringify(after.schema));
    check(
      'styleFiles / tokens / defaults 都原样保留',
      JSON.stringify(after.styleFiles) === '["quirex.sty"]' &&
        Array.isArray(after.tokens) &&
        (after.tokens as unknown[]).length === 6 &&
        typeof after.defaults === 'object',
      JSON.stringify(after)
    );

    const g2 = await api('GET');
    const row2 = (g2.data.templates as Array<Record<string, unknown>>).find((t) => t.id === '默认');
    check('重新列出来时显示名已经变了（界面会自动刷新）', row2?.name === '临时改的名', String(row2?.name));
    check('改名后模板仍然可用', row2?.usable === true, JSON.stringify(row2?.issues));
  } finally {
    const r2 = await api('POST', { action: 'rename', id: '默认', name: originalName });
    check('改回原名，接口 200', r2.status === 200, JSON.stringify(r2.data));
    check(
      '★ meta.json 逐字节还原（测试没有留下任何改动）',
      fs.readFileSync(metaPath).equals(before),
      '字节不一致'
    );
  }

  // ============================================================
  section('#9 改名的边界与防跳转');
  // ============================================================
  check('空名字 → 400', (await api('POST', { action: 'rename', id: '默认', name: '  ' })).status === 400);
  check(
    '超长名字 → 400',
    (await api('POST', { action: 'rename', id: '默认', name: 'x'.repeat(60) })).status === 400
  );
  check('不存在的模板 → 404', (await api('POST', { action: 'rename', id: '没有这个', name: 'x' })).status === 404);
  check(
    '★ id 带路径跳转 → 404（不能借改名写到模板目录之外）',
    (await api('POST', { action: 'rename', id: '../src', name: 'x' })).status === 404
  );
  check('reveal 不存在的模板 → 404', (await api('POST', { action: 'reveal', id: '没有这个' })).status === 404);
  check('未知 action → 400', (await api('POST', { action: '乱写', id: '默认' })).status === 400);
  check('缺 id → 400', (await api('POST', { action: 'rename', name: 'x' })).status === 400);

  // ============================================================
  section('#10 ★ v9 update：显示名 + 描述都能改，其它字段一字不动（含排版）');
  // ============================================================
  //
  // 为什么单列一节：v9 之前 description 只让看不让改，等于摆设。
  // 现在它走 update 一起写回 meta.json —— 而 meta.json 是你会亲手打开改的文件，
  // 所以「只改这两个字段、原文件排版不动」是这条改动的核心承诺，必须逐字节验证。
  {
    const tplDir = path.join(realRoot, '紧凑题单');
    const metaPath2 = path.join(tplDir, 'meta.json');
    const beforeBytes = fs.readFileSync(metaPath2);
    const beforeObj = JSON.parse(beforeBytes.toString('utf-8')) as Record<string, unknown>;
    // 原文里 "name" 与 "description" 各在一行、styleFiles 是单行数组 —— 排版特征留底
    const beforeRaw = beforeBytes.toString('utf-8');
    const hadSameLineArray = /"styleFiles":\s*\[[^\]]*\]/.test(beforeRaw);

    try {
      const NEW_NAME = '紧凑题单';
      const NEW_DESC = '这是校验脚本临时写的描述，稍后会逐字节还原。';
      const r = await api('POST', {
        action: 'update',
        id: '紧凑题单',
        name: NEW_NAME,
        description: NEW_DESC,
      });
      check('update 接口 200', r.status === 200, JSON.stringify(r.data).slice(0, 200));
      check('返回里带回新描述', r.data.description === NEW_DESC, String(r.data.description));

      const afterRaw = fs.readFileSync(metaPath2, 'utf-8');
      const after = JSON.parse(afterRaw) as Record<string, unknown>;
      check('meta.json 里的 description 变了', after.description === NEW_DESC, String(after.description));
      check(
        '★ schema / styleFiles / tokens / defaults / engine 全部原样保留',
        after.schema === beforeObj.schema &&
          JSON.stringify(after.styleFiles) === JSON.stringify(beforeObj.styleFiles) &&
          JSON.stringify(after.tokens) === JSON.stringify(beforeObj.tokens) &&
          JSON.stringify(after.defaults) === JSON.stringify(beforeObj.defaults) &&
          after.engine === beforeObj.engine,
        JSON.stringify(after)
      );
      check(
        '★ 原文件排版没被规范化（单行数组还是单行）',
        !hadSameLineArray || /"styleFiles":\s*\[[^\]]*\]/.test(afterRaw),
        afterRaw
      );
      check(
        '★ 除 name / description 外逐字符相同',
        (() => {
          const strip = (s: string) =>
            s
              .replace(/"name"\s*:\s*"(?:[^"\\]|\\.)*"/, '')
              .replace(/"description"\s*:\s*"(?:[^"\\]|\\.)*"/, '');
          return strip(beforeRaw) === strip(afterRaw);
        })(),
        '就地替换动到了别的字符'
      );

      const g3 = await api('GET');
      const row3 = (g3.data.templates as Array<Record<string, unknown>>).find((t) => t.id === '紧凑题单');
      check('重新列出来时描述已经变了（导出弹窗跟着变）', row3?.description === NEW_DESC, String(row3?.description));
      check('改了描述后模板仍然可用', row3?.usable === true, JSON.stringify(row3?.issues));
    } finally {
      const back = await api('POST', {
        action: 'update',
        id: '紧凑题单',
        name: String(beforeObj.name ?? ''),
        description: String(beforeObj.description ?? ''),
      });
      check('还原接口 200', back.status === 200, JSON.stringify(back.data).slice(0, 200));
      check(
        '★ meta.json 逐字节还原（测试没有留下任何改动）',
        fs.readFileSync(metaPath2).equals(beforeBytes),
        '字节不一致'
      );
    }

    check(
      '超长描述 → 400（最多 200 字）',
      (await api('POST', { action: 'update', id: '紧凑题单', name: '紧凑题单', description: 'x'.repeat(201) }))
        .status === 400
    );
    check(
      '描述可以为空（清空描述是合法操作）',
      (await api('POST', { action: 'update', id: '紧凑题单', name: '紧凑题单', description: '' })).status === 200
    );
    const cleared = JSON.parse(fs.readFileSync(metaPath2, 'utf-8')) as Record<string, unknown>;
    check('清空后 description 是空串而不是被删掉', cleared.description === '', JSON.stringify(cleared.description));
    // 还原
    await api('POST', {
      action: 'update',
      id: '紧凑题单',
      name: String(beforeObj.name ?? ''),
      description: String(beforeObj.description ?? ''),
    });
    check(
      '★ 清空测试后再次逐字节还原',
      fs.readFileSync(metaPath2).equals(beforeBytes),
      '字节不一致'
    );
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
  })
  .catch((e) => {
    console.error('\n脚本自身出错：', e);
    fail++;
  })
  .finally(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉无所谓 */
    }
    process.exit(fail === 0 ? 0 : 1);
  });

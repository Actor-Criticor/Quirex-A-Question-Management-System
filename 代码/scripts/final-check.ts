/**
 * final-check.ts — 收尾验收：把方案 §14.3 的检查项一次跑完
 *
 * 运行：npx tsx scripts/final-check.ts
 * （其中「实况 HTTP 校验」需要开发服务器在跑）
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

interface Item {
  name: string;
  ok: boolean;
  detail?: string;
}

const items: Item[] = [];
const add = (name: string, ok: boolean, detail?: string) => items.push({ name, ok, detail });

function readAll(dir: string, exts: string[]): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (['node_modules', '.next', '.git'].includes(e.name)) continue;
        walk(full);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        out.push({ file: full, text: fs.readFileSync(full, 'utf-8') });
      }
    }
  };
  walk(dir);
  return out;
}

// ============================================================
// 1. v0 导出/转换残留（应为 0 命中）
// ============================================================
// 注意排除本文件自身 —— 它必然包含下面这些关键词作为字面量。
const srcFiles = [
  ...readAll('src', ['.ts', '.tsx']),
  ...readAll('scripts', ['.ts']),
].filter((f) => !f.file.includes('final-check'));

const banned = [
  'docx',
  'mammoth',
  'pandoc',
  'buildLatexHandout',
  'markdownToLatex',
  'questionBarData',
  'copyAsMarkdown',
  'MathText',
  'convertHtmlTables',
  'optionsToChoices',
  // v0 特有的导出产物名（v1 已经不再生成这些）
  '讲义_LaTeX_',
  '讲义_Markdown_',
  '试题栏讲义',
  '试题栏_Markdown_',
];
const hits: string[] = [];
for (const f of srcFiles) {
  // 迁移工具需要读 v0 的语法，因此允许它出现 convertHtmlTables 这类词
  const isMigrator = f.file.includes('migrate-v0');
  for (const b of banned) {
    if (isMigrator && ['convertHtmlTables'].includes(b)) continue;
    if (f.text.includes(b)) hits.push(`${path.basename(f.file)}: ${b}`);
  }
}
add('v0 的导出/转换残留为 0 命中', hits.length === 0, hits.slice(0, 6).join('; '));

// ============================================================
// 2. 已删字段残留（只应出现在迁移工具里）
// ============================================================
const removedFields = ['ai_tags', 'exam_type', 'semester', 'NEXT_PUBLIC_DEFAULT_GRADE', 'serverEnv'];
const fieldHits: string[] = [];
for (const f of srcFiles) {
  // 迁移工具要读 v0 的旧字段，允许它出现
  if (f.file.includes('migrate-v0')) continue;
  for (const field of removedFields) {
    if (f.text.includes(field)) fieldHits.push(`${path.basename(f.file)}: ${field}`);
  }
}
add('已删字段残留为 0', fieldHits.length === 0, fieldHits.slice(0, 6).join('; '));

// ============================================================
// 3. 依赖
// ============================================================
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const deps = Object.keys(pkg.dependencies ?? {});
for (const bad of ['docx', 'mammoth', 'marked']) {
  add(`依赖里没有 ${bad}`, !deps.includes(bad));
}
add('依赖里有 sharp（图片转 PNG 需要）', deps.includes('sharp'));

// ============================================================
// 4. 环境变量示例文件
// ============================================================
const envExample = fs.readFileSync('.env.local.example', 'utf-8');
add('.env.local.example 已经不含 PANDOC_PATH', !envExample.includes('PANDOC'));
add('.env.local.example 已经不含年级变量', !envExample.includes('GRADE'));
add('.env.local.example 含 VAULT_PATH', envExample.includes('VAULT_PATH'));

// ============================================================
// 5. v0 旧文件是否真的清掉了
// ============================================================
const shouldBeGone = [
  'src/components/MathText.tsx',
  'src/components/FilterableTable.tsx',
  'src/components/BrowseView.tsx',
  'src/lib/latex.ts',
  'src/lib/questions.ts',
  'public/mathatlas.sty',
  'src/app/add/page copy.tsx',
  'src/app/examBasket',
  'LATEX',
];
const stillHere = shouldBeGone.filter((p) => fs.existsSync(p));
add('v0 旧文件与陈旧副本已清除', stillHere.length === 0, stillHere.join(', '));

// ============================================================
// 6. v1 该有的文件都在
// ============================================================
// 路径都相对「代码」解析；`../` 那几个是仓库根下的数据/说明文件夹
//（v10 整理目录：代码、模板、题库、导出 四个并列放在根上）。
const shouldExist = [
  'src/lib/types.ts',
  'src/lib/paths.ts',
  'src/lib/validate.ts',
  'src/lib/qid.ts',
  'src/lib/store.ts',
  'src/lib/searchIndex.ts',
  'src/lib/tags.ts',
  'src/lib/baskets.ts',
  'src/lib/service.ts',
  'src/lib/latexSubset.ts',
  'src/lib/latexRender.ts',
  'src/lib/latexCompose.ts',
  'src/lib/latexExport.ts',
  'src/app/page.tsx',
  'src/app/add/page.tsx',
  'src/app/tags/page.tsx',
  'src/app/baskets/page.tsx',
  'src/app/settings/page.tsx',
  'src/app/question/[qid]/page.tsx',
  '../模板/默认/main.tex',
  '../模板/默认/quirex.sty',
  '../模板/默认/meta.json',
  'scripts/selftest.ts',
  'scripts/verify-live.ts',
  'scripts/migrate-v0.ts',
  'scripts/verify-migrated.ts',
  '../README.md',
];
const missing = shouldExist.filter((p) => !fs.existsSync(p));
add('v1 该有的文件都在', missing.length === 0, missing.join(', '));

// ============================================================
// 7. README 已更新到 v1
// ============================================================
const readme = fs.readFileSync('../README.md', 'utf-8');
add('README 提到整卷', readme.includes('整卷'));
add('README 提到试题篮', readme.includes('试题篮'));
add('README 不再把 Word 导出当功能', !/导出\s*Word|Word 导出/.test(readme));
add('README 说明了迁移', readme.includes('migrate-v0'));

// ============================================================
// 8. v2 应有的东西
// ============================================================
const srcAll = readAll('src', ['.ts', '.tsx']);
const hasInSrc = (needle: string) => srcAll.some((f) => f.text.includes(needle));
/** 路径在 Windows 上是反斜杠，统一成正斜杠再匹配 */
const findSrc = (fragment: string) =>
  srcAll.find((f) => f.file.replace(/\\/g, '/').includes(fragment));

add('v2：难度档位（DIFFICULTY_BANDS）已定义', hasInSrc('DIFFICULTY_BANDS'));
add('v2：档位换算函数已实现', hasInSrc('difficultyToBand'));
add('v2：创新标记字段已支持', hasInSrc('innovation'));
add('v2：试卷有独立 id 前缀（PAPER_PAD / paperNumberToId）', hasInSrc('paperNumberToId'));
add('v2：检索支持按档位筛选', hasInSrc('params.bands'));
add('v2：检索支持返回正文（列表直接显示题目）', hasInSrc('withContent'));

// 辣椒与 📄 必须彻底消失
for (const bad of ['🌶', '📄', 'PEPPER_BANDS', 'difficultyToPeppers']) {
  add(`v2：源码里已无「${bad}」`, !hasInSrc(bad));
}

// 导出必须是两个 PDF
const exportSrc = findSrc('lib/latexExport');
add(
  'v2：导出生成 题目.tex / 答案.tex 两个源文件',
  !!exportSrc && exportSrc.text.includes("'题目.tex'") && exportSrc.text.includes("'答案.tex'")
);
add(
  'v2：导出选项只剩分组（无 preset/layout/order）',
  (() => {
    const b = findSrc('lib/baskets');
    if (!b) return false;
    return !/preset\?:|layout\?:|order\?:/.test(b.text);
  })()
);

// 录入页两个 bug 的回归：datalist 必须在页面根级（单题也能用）
const addSrc = findSrc('app/add/page');
add(
  'v2：来源联想 datalist 已在页面根级（修掉只在整卷分支的 bug）',
  !!addSrc && addSrc.text.includes('id="source-list"')
);
add(
  'v2：答案框有宽度类（修掉与其它框不等宽的 bug）',
  !!addSrc && /ref=\{answerRef\}\s*\n\s*className=\{styles\./.test(addSrc.text)
);

// 开发指示器关掉
add('v2：next.config 已关闭开发指示器', fs.readFileSync('next.config.ts', 'utf-8').includes('devIndicators: false'));

// ============================================================
// 8b. v3 源码级验收
// ============================================================

const globalsCss = fs.readFileSync('src/app/globals.css', 'utf-8');
const navCss = fs.readFileSync('src/app/nav.css', 'utf-8');

// #1 版面：宽度只有一个来源，页面不许再写私有 max-width
add('v3#1：定义了唯一的页面宽度变量 --ma-page-w', /--ma-page-w:\s*1500px/.test(globalsCss));
add('v3#1：.ma-main 用该变量而非硬编码', /max-width:\s*var\(--ma-page-w\)/.test(navCss));
add(
  'v3#1：各页面不再有私有 max-width（1000/1080/1100px 全清）',
  !/max-width:\s*(1000|1080|1100)px/.test(
    ['page', 'add/page', 'tags/page', 'settings/page', 'question/[qid]/page']
      .map((p) => {
        const f = findSrc(p);
        return f ? f.text : '';
      })
      .join('\n')
  )
);

// #2 整卷没有创新：四处口径一致
const storeSrc = fs.readFileSync('src/lib/store.ts', 'utf-8');
const svcSrc = fs.readFileSync('src/lib/service.ts', 'utf-8');
const idxSrc = fs.readFileSync('src/lib/searchIndex.ts', 'utf-8');
add('v3#2：store 写盘时只有单题写 innovation', /kind === '单题'[^\n]*innovation/.test(storeSrc));
add('v3#2：store 读盘时整卷忽略 innovation', /kind === '单题'[^\n]*normalizeInnovation/.test(storeSrc));
add('v3#2：service 建题时整卷丢弃 innovation', /kind === '单题' && normalizeInnovation/.test(svcSrc));
add('v3#2：索引里整卷不写 innovation', /kind === '单题' && meta\.innovation/.test(idxSrc));

// #3 年份
const typesSrc = fs.readFileSync('src/lib/types.ts', 'utf-8');
const valSrc = fs.readFileSync('src/lib/validate.ts', 'utf-8');
add(
  'v8#10：年份区间改成 1900–**今年**（不再写死 2100）',
  /YEAR_MIN\s*=\s*1900/.test(typesSrc) &&
    !/YEAR_MAX\s*=\s*2100/.test(typesSrc) &&
    /export function currentYear/.test(typesSrc)
);
add('v3#3：QuestionMeta 有 year 字段', /interface QuestionMeta[\s\S]*?\byear\?: number/.test(typesSrc));
add('v3#3：IndexEntry 有 year 字段', /interface IndexEntry[\s\S]*?\byear\?: number/.test(typesSrc));
add('v3#3：SearchParams 支持 years 多选', /years\?:\s*number\[\]/.test(typesSrc));
add('v3#3：实现了 parseYearField / validateYear', /export function parseYearField/.test(valSrc) && /export function validateYear/.test(valSrc));
add('v3#3：年份算进「标签路」，关键字能命中（整卷也有效）', /entry\.year !== undefined\) names\.push/.test(idxSrc));
add('v3#3：有年份 facet 聚合 listYears', /export function listYears/.test(idxSrc));
add('v3#3：/api/tags 带回 years facet', /years:\s*listYears\(\)/.test(fs.readFileSync('src/app/api/tags/route.ts', 'utf-8')));
// 关键回归：写盘 / 读盘两边都要搬 year，否则索引与文件会分叉
add('v3#3：★ writeMeta 会写 year（漏了就会写盘即丢）', /if \(meta\.year !== undefined\) data\.year/.test(storeSrc));
add('v3#3：★ coerceMeta 会读 year（漏了就会读不到）', /meta\.year = year/.test(storeSrc));

// #4 创新开关：不再是裸 checkbox
add(
  'v3#4：录入页创新改成胶囊开关（裸 checkbox 已消失）',
  !!addSrc && /togglePill/.test(addSrc.text) && /aria-pressed=\{innovation\}/.test(addSrc.text)
);
add('v3#4：创新开关有对应样式', /\.togglePill\[aria-pressed='true'\]/.test(fs.readFileSync('src/app/add/page.module.css', 'utf-8')));

// #5 / #7 分页
const pagerSrc = fs.readFileSync('src/components/Pager.tsx', 'utf-8');
const usePagerSrc = fs.readFileSync('src/components/usePager.ts', 'utf-8');
add('v3#7：抽出了共用分页组件 Pager', pagerSrc.includes('export function Pager'));
add('v3#7：抽出了共用分页 hook usePager', usePagerSrc.includes('export function usePager'));
add('v3#7：只有一页时不渲染分页条', /pageCount <= 1\) return null/.test(pagerSrc));
const tagsSrc = findSrc('app/tags/page');
add('v3#5：标签列表分页每页 20', !!tagsSrc && /TAG_PAGE_SIZE = 20/.test(tagsSrc.text));
add(
  'v3#5：标签页的 note（「单题与整卷都有」等）已删除',
  !!tagsSrc && !tagsSrc.text.includes('单题与整卷都有') && !tagsSrc.text.includes('只有单题有')
);
add('v3#5：标签页不再有「备份与还原」区块', !!tagsSrc && !tagsSrc.text.includes('备份与还原'));
const setSrc = findSrc('app/settings/page');
add('v3#5：备份与还原搬到了设置页', !!setSrc && setSrc.text.includes('备份与还原'));
add('v3#7：设置页导出历史分页每页 15', !!setSrc && /HISTORY_PAGE_SIZE = 15/.test(setSrc.text));

// #6 试题篮两栏模型
const bkLib = fs.readFileSync('src/lib/baskets.ts', 'utf-8');
add('v3#6：baskets 模型改成 draft + saved', /draft:\s*BasketDraft/.test(bkLib) && /saved:\s*Basket\[\]/.test(bkLib));
add('v3#6：STORE_VERSION 升到 2', /STORE_VERSION = 2/.test(bkLib));
add('v3#6：有 v1→v2 迁移函数', /function migrateFromV1/.test(bkLib));
// v8：实现搬到了 types.ts（纯函数、客户端能引），baskets.ts 只做转出 ——
// 原因见 types.ts 里那段注释（客户端引 baskets.ts 会把 fs 拖进浏览器包）
add(
  'v3#6 / v8：默认快照名 = 日期+时间（24 小时制），实现在纯模块里',
  /export function defaultSnapshotName/.test(typesSrc) &&
    /\$\{p\(at\.getHours\(\)\)\}/.test(typesSrc) &&
    /export \{ defaultSnapshotName \} from '\.\/types'/.test(bkLib)
);
add('v3#6：载入副本（loadSnapshot 未删除被点的那条）', /export function loadSnapshot/.test(bkLib) && /被点的那条存档\*\*不动\*\*/.test(bkLib));
// v7：把 v4 的「已在列表里就不自动保存」改掉了 —— 你现在允许相同内容配两个名字，
// 载入时**总是**先保存当前那篮。这两条断言跟着反过来。
add('v7：载入时不再判断「已在列表里」（总是先保存当前）', !/alreadyInList/.test(bkLib));
add(
  'v7：载入 = 先保存当前 → 清空 → 复制存档的题',
  /if \(store\.draft\.qids\.length > 0\)/.test(bkLib) &&
    /store\.draft = \{[\s\S]{0,120}qids: targetQids/.test(bkLib)
);
add(
  'v7：已按你的要求删掉「清理重复」',
  !/export function dedupeSnapshots/.test(bkLib) &&
    !/case 'dedupe'/.test(fs.readFileSync('src/app/api/baskets/route.ts', 'utf-8')) &&
    !/dedupeSnapshots/.test(fs.readFileSync('src/app/api/baskets/route.ts', 'utf-8'))
);
add('v3#6：有 currentSnapshotId（导出标题回退还在用它）', /export function currentSnapshotId/.test(bkLib));
add('v3#6：draftQids 取代 qidsInAnyBasket', /export function draftQids/.test(bkLib) && !/qidsInAnyBasket/.test(bkLib));
add(
  'v7：整卷不进试题篮（addToDraft / setDraftQids 都会拒收）',
  /export function pickPapers/.test(bkLib) &&
    /papersRejectedMessage/.test(bkLib) &&
    /const papers = pickPapers\(valid\)/.test(bkLib) &&
    /const papers = pickPapers\(clean\)/.test(bkLib)
);
add(
  'v7：浏览页用轻量统计接口（不再拉整篮正文）',
  /app\/api\/baskets\/stats\/route\.ts/.test('src/app/api/baskets/stats/route.ts') &&
    fs.existsSync(path.join('src/app/api/baskets/stats/route.ts'))
);
add(
  'v3#6：旧的按 id 篮子路由已删除',
  !fs.existsSync(path.join('src/app/api/baskets/[id]')) &&
    fs.existsSync(path.join('src/app/api/baskets/export/route.ts'))
);
const bkPage = findSrc('app/baskets/page');
add('v3#6：试题篮页有「正在编辑」栏', !!bkPage && bkPage.text.includes('正在编辑'));
add('v3#6：试题篮页左侧每页 15', !!bkPage && /SAVED_PAGE_SIZE = 15/.test(bkPage.text));
// v7：你反馈「当前」标签被挡住，而高亮已经说明了问题 —— 标签删掉，高亮保留
add('v7：去掉了「当前」小标签（保留高亮 basketActive）', !!bkPage && !bkPage.text.includes('currentTag'));
add(
  'v7：与「正在编辑」相同的那条仍然高亮',
  fs.readFileSync('src/app/baskets/page.module.css', 'utf-8').includes('.basketActive') &&
    !!bkPage &&
    bkPage.text.includes('basketActive')
);
add('v3#6：去掉了「＋新建 / 复制」', !!bkPage && !bkPage.text.includes('＋新建') && !bkPage.text.includes('已复制一份'));

// #8 文案
for (const p of ['app/page', 'app/add/page', 'app/settings/page', 'question/[qid]/page']) {
  const f = findSrc(p);
  add(
    `v3#8：${p} 已无解释性文案（可留空/只读数字/不进搜索索引/顺序永不断裂）`,
    !!f &&
      !/可留空|只读数字|不进搜索索引|不进讲义|顺序永不断裂|零风险|一道都不会少/.test(f.text)
  );
}

// #9 筛选面板
const browseSrc = findSrc('app/page');
add('v3#9：浏览页有筛选面板（facetPanel）', !!browseSrc && browseSrc.text.includes('facetPanel'));
add('v3#9：知识点/年份分页每页 20', !!browseSrc && /FACET_PAGE_SIZE = 20/.test(browseSrc.text));
add('v3#9：已无「还有 N 个…」的旧写法', !!browseSrc && !browseSrc.text.includes('KNOWLEDGE_CHIP_LIMIT'));

// #10 图片尺寸
add('v3#10：figure 宽度输出成 CSS 变量而非 width', /--ma-fig-w:/.test(fs.readFileSync('src/lib/latexRender.ts', 'utf-8')));
add('v3#10：示意图有高度上限', /\.ma-fig img[\s\S]*?max-height:\s*var\(--ma-fig-h\)/.test(globalsCss));
add('v3#10：行内图有高度上限', /\.ma-img img[\s\S]*?max-height:\s*var\(--ma-img-h\)/.test(globalsCss));
add('v3#10：纯图题有专用类 ma-image-only', globalsCss.includes('.ma-image-only'));
add(
  'v3#10/v5：卡片与详情页的图高各一档（v5 已改成 em）',
  /--ma-fig-h:\s*\d+em/.test(fs.readFileSync('src/app/page.module.css', 'utf-8')) &&
    /--ma-fig-h:\s*\d+em/.test(fs.readFileSync('src/app/question/[qid]/page.module.css', 'utf-8'))
);
add(
  'v3#10：★ 导出链路仍只从 .tex 真源取内容（不经过网页渲染器）',
  /readContent\(meta\.qid, 'stem'\)/.test(idxSrc) &&
    !/latexRender|LatexContent/.test(fs.readFileSync('src/lib/latexExport.ts', 'utf-8'))
);

// ============================================================
// 8c. v4 源码级验收
// ============================================================
const pathsSrc4 = fs.readFileSync('src/lib/paths.ts', 'utf-8');
const globalsCss4 = fs.readFileSync('src/app/globals.css', 'utf-8');

// #1 搜索建议
add('v4#1：抽出了带建议的搜索框组件', fs.existsSync('src/components/SearchSuggest.tsx'));
add(
  'v4#1：浏览页换用了 SearchSuggest（裸 input 已消失）',
  !!browseSrc && browseSrc.text.includes('SearchSuggest') && !/className=\{styles\.search\}/.test(browseSrc.text)
);
add(
  'v4#1：建议候选池含来源/知识点/年份三类',
  !!browseSrc &&
    browseSrc.text.includes("kind: '来源'") &&
    browseSrc.text.includes("kind: '知识点'") &&
    browseSrc.text.includes("kind: '年份'")
);
add('v4#1：无匹配时不显示浮层', fs.readFileSync('src/components/SearchSuggest.tsx', 'utf-8').includes('open && matches.length > 0'));

// #2 T 前缀 id
add('v4#2：定义了 QUESTION_PREFIX = T', /QUESTION_PREFIX = 'T'/.test(typesSrc));
// v9：numberToQid 前面还要拼学科字母（AT0001），所以断言改成"含 QUESTION_PREFIX 与补零"
add(
  'v4#2：numberToQid 写出 T 前缀（v9 起前面还有学科字母）',
  /return `\$\{letter\}\$\{QUESTION_PREFIX\}\$\{String\(n\)\.padStart/.test(pathsSrc4) ||
    /return `\$\{QUESTION_PREFIX\}\$\{String\(n\)\.padStart/.test(pathsSrc4)
);
/** 剥掉 CSS 注释再判断，免得断言命中注释里的字样 */
function stripCssComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}
const tagsCss4 = stripCssComments(fs.readFileSync('src/app/tags/page.module.css', 'utf-8'));
const settingsCss4 = stripCssComments(fs.readFileSync('src/app/settings/page.module.css', 'utf-8'));

add('v4#2：isQuestionId 用 QUESTION_PREFIX 拼新格式', pathsSrc4.includes('${QUESTION_PREFIX}'));
add('v4#2：★ isQuestionId 也认旧的纯数字（宽松读）', /isLegacyQuestionId/.test(pathsSrc4) && /export function isLegacyQuestionId/.test(pathsSrc4));
add(
  'v4#2：qidToNumber 能吃掉 T 前缀（v9 起前面还可能带学科字母）',
  /qid\.replace\(\/\^\[A-Z\]\?T\/i, ''\)/.test(pathsSrc4) || /qid\.replace\(\/\^T\/i, ''\)/.test(pathsSrc4)
);
add(
  'v4#2：★ 资源名正则三种前缀都认（不会静默丢图）',
  /\^\(\[A-Za-z\]\{0,2\}\\d\{3,\}\)-\(stem\|fig\|ans\|ansfig\)/.test(fs.readFileSync('src/lib/store.ts', 'utf-8'))
);
add(
  'v4#2：latexSubset 的图片名检查也放宽了',
  /\[A-Za-z\]\{0,2\}\\d\{3,\}-\(stem\|fig\|ans\|ansfig\)/.test(fs.readFileSync('src/lib/latexSubset.ts', 'utf-8'))
);
// v9：reset 不再自己写一套正则，改成用 isQidName（加了学科字母后，
//     手写正则漏掉了 AT0001/AP001，导致 --reset "成功"却没清干净）
add(
  'v4#2：seed-demo --reset 用 isQidName 认题目目录（v9 起不再手写正则）',
  /isQidName/.test(fs.readFileSync('scripts/seed-demo.ts', 'utf-8'))
);

// #5 备份上限
add('v4#5：定义了 BACKUP_LIMIT = 100', /BACKUP_LIMIT = 100/.test(typesSrc));
add('v4#5：有裁剪函数 pruneBackups', /export function pruneBackups/.test(svcSrc));
add('v4#5：写备份后立刻裁剪', /pruneBackups\(\);\s*\n\s*return record/.test(svcSrc));
add('v4#5：同一秒不覆盖（重名往后加序号）', /fs\.existsSync\(file\) && i < 1000/.test(svcSrc));
add('v4#5：备份与还原每页 10 条', !!setSrc && /FIELD_BACKUP_PAGE_SIZE = 10/.test(setSrc.text));

// #3 #6 操作列对齐
add('v4#6：定义了操作列的共用约定', /\.ma-ops-cell/.test(globalsCss4) && /--ma-ops-w/.test(globalsCss4));
add('v4#6：按钮给了固定宽度（第 1/2/3 个各自成列）', /min-width:\s*var\(--ma-ops-btn-w\)/.test(globalsCss4));
add('v4#6：标签页操作列不再 text-align: right（注释也算）', !/text-align:\s*right/.test(tagsCss4));
add('v4#6：设置页操作列不再 text-align: right（注释也算）', !/text-align:\s*right/.test(settingsCss4));
add('v4#6：标签页表头与单元格都套了 ma-ops', !!tagsSrc && (tagsSrc.text.match(/ma-ops/g) ?? []).length >= 3);
add('v4#6：设置页表头与单元格都套了 ma-ops', !!setSrc && (setSrc.text.match(/ma-ops/g) ?? []).length >= 4);

// #7 题库单栏
// v4 当时用的 --ma-list-w，v5 已并入 --ma-col-w（全站只留一把尺子）
add('v4#7：题库是单栏（flex-direction: column）', /\.cards\s*\{[\s\S]*?flex-direction:\s*column/.test(fs.readFileSync('src/app/page.module.css', 'utf-8')));
add('v5：v4 的 --ma-list-w 已并入 --ma-col-w', !/^\s*--ma-list-w:/m.test(fs.readFileSync('src/app/globals.css', 'utf-8')));

// ============================================================
// 8d. v5 源码级验收
// ============================================================
const globalsCss5 = fs.readFileSync('src/app/globals.css', 'utf-8');
const browseCss5 = fs.readFileSync('src/app/page.module.css', 'utf-8');
const sty5 = fs.readFileSync('../模板/默认/quirex.sty', 'utf-8');
const storeSrc5 = fs.readFileSync('src/lib/store.ts', 'utf-8');
const patchRoute5 = fs.readFileSync('src/app/api/questions/[qid]/route.ts', 'utf-8');
const latexContent5 = fs.readFileSync('src/components/LatexContent.tsx', 'utf-8');
const addPage5 = fs.readFileSync('src/app/add/page.tsx', 'utf-8');
const detailPage5 = fs.readFileSync('src/app/question/[qid]/page.tsx', 'utf-8');

// #1 宽度统一（含用户补提的「搜索区跟列表同宽」）
add('v5#1：定义了全站唯一的正文栏宽度 --ma-col-w', /--ma-col-w:\s*1000px/.test(globalsCss5));
add('v5#1：v3 的 --ma-read-w 已删除（不留第二把尺子）', !/^\s*--ma-read-w:/m.test(globalsCss5));
add(
  'v5#1：★ 题库页整页收敛到它 → 搜索/筛选区与题目列表自动同宽同左边界',
  /\.page\s*\{[^}]*max-width:\s*var\(--ma-col-w\)/.test(browseCss5)
);
add('v5#1：浏览页不再有双栏网格', !/grid-template-columns/.test(browseCss5));

// #2 图片大小：导入时滑块 + 分类默认值
add('v5#2：抽出了大小/位置两个共用控件', fs.existsSync('src/components/FigureControls.tsx'));
add(
  'v5#2：★ 录入页大小改成滑块（不再是裸数字框）',
  addPage5.includes('FigSizeSlider') && !/type="number"[\s\S]{0,80}im\.width/.test(addPage5)
);
add(
  'v5#2：★ 选项图单独处理（一个滑块管整题）',
  addPage5.includes('optionImgWidth') &&
    addPage5.includes('setAllOptionImageWidth') &&
    addPage5.includes('optionImgCount')
);
// 加图按钮要跟着「你在写的地方」走，而不是堆在页面底部的图片区
add(
  'v5b：★ 题干工具条里有「题干图 / 示意图」两个加图按钮',
  /CHANNEL_BUTTONS\.filter\(\(c\) => c\.channel === 'stem' \|\| c\.channel === 'fig'\)/.test(addPage5)
);
add(
  'v5b：★ 答案工具条里有「答案图 / 答案示意图」两个加图按钮',
  /CHANNEL_BUTTONS\.filter\(\(c\) => c\.channel === 'ans' \|\| c\.channel === 'ansfig'\)/.test(addPage5)
);
add(
  'v5b：★ 「图片」区不再重复放加图按钮（只列已加入的图）',
  !/步骤[\s\S]{0,40}\n[\s\S]{0,200}CHANNEL_BUTTONS\.map/.test(addPage5) &&
    addPage5.includes('已加入的图片')
);
add(
  'v5b：★ 四个通道仍都有入口（题干 2 + 答案 2，选项图另有 🖼）',
  ['\'stem\'', '\'fig\'', '\'ans\'', '\'ansfig\''].every((c) => addPage5.includes(`c.channel === ${c}`))
);
add(
  'v5#2：★ 图片按「插在哪儿」分类（选项图 vs 整题图 vs 行内图）',
  /typeof pendingChannel\.target === 'number'/.test(addPage5) &&
    addPage5.includes("target: 'stem' | 'answer' | number")
);
add(
  'v5#2：大小滑块显示纸面厘米数',
  fs.readFileSync('src/components/FigureControls.tsx', 'utf-8').includes('ratioToCm')
);

// #3 配图位置：数据层（读写两侧都要改 —— 这个坑踩过两次）
add(
  'v5#3：定义了 FIG_ALIGNS / FigAlign / resolveFigAlign',
  /export const FIG_ALIGNS/.test(typesSrc) && /export function resolveFigAlign/.test(typesSrc)
);
add('v5#3：QuestionMeta 有 figAlign', /interface QuestionMeta[\s\S]*?\bfigAlign\?: FigAlign/.test(typesSrc));
add('v5#3：IndexEntry 有 figAlign（存解析后的生效值）', /interface IndexEntry[\s\S]*?\bfigAlign\?: FigAlign/.test(typesSrc));
add('v5#3：★ writeMeta 会写 figAlign（漏了就写盘即丢）', /meta\.kind === '单题' && meta\.figAlign\) data\.figAlign/.test(storeSrc5));
add('v5#3：★ coerceMeta 会读 figAlign（漏了就读不到）', /isFigAlign\(data\.figAlign\)\) meta\.figAlign/.test(storeSrc5));
add('v5#3：★ PATCH 路由白名单里有 figAlign（这个白名单漏过两次）', /figAlign: body\.figAlign/.test(patchRoute5));
add(
  'v5#3：索引里存的是解析后的生效值（网页不必自己再推）',
  /entry\.figAlign = resolveFigAlign\(meta\.type, meta\.figAlign\)/.test(idxSrc)
);
add('v5#3：latexRender 支持 figAlign', /figAlign\?: FigAlign/.test(fs.readFileSync('src/lib/latexRender.ts', 'utf-8')));
add(
  'v5#3：★ buildExercise 把位置注入 exercise 的第二个参数',
  /blankLevel\(meta\)\}\]\[\$\{align\}\]/.test(fs.readFileSync('src/lib/latexExport.ts', 'utf-8'))
);
add(
  'v5#3：★ 网页四处调用都传了 figAlign（否则网页与 PDF 不一致）',
  ['src/app/page.tsx', 'src/app/baskets/page.tsx', 'src/app/question/[qid]/page.tsx', 'src/app/add/page.tsx'].every(
    (p) => fs.readFileSync(p, 'utf-8').includes('figAlign=')
  )
);
add(
  'v5#3：★ 配图位置是三档**分段按钮**（不是滑块 —— 只有三个合法取值，滑块是假象）',
  /export function FigAlignPicker/.test(fs.readFileSync('src/components/FigureControls.tsx', 'utf-8')) &&
    /aria-pressed=\{a === value\}/.test(fs.readFileSync('src/components/FigureControls.tsx', 'utf-8'))
);
add(
  'v5#3：★ 位置控件里已无 type="range"（全仓只剩大小滑块那一处）',
  (() => {
    const fc = fs.readFileSync('src/components/FigureControls.tsx', 'utf-8');
    const alignPart = fc.slice(fc.indexOf('export function FigAlignPicker'));
    return !alignPart.includes('type="range"');
  })()
);
add('v5#3：详情页能改位置并落盘', detailPage5.includes('saveFigAlign'));

// #4 模板：两个可选参数 + makebox 摆放 + 兜底 0.3
add(
  'v5#4：★ exercise 用 \\NewDocumentEnvironment 的 O{M} O{center}',
  /\\NewDocumentEnvironment\{exercise\}\{\s*O\{M\}\s*O\{center\}\s*\}/.test(sty5)
);
add('v5#4：★ 没有用有坑的 \\newenvironment{exercise}[2][]', !/\\newenvironment\{exercise\}\[2\]/.test(sty5));
add(
  'v5#4：★ \\fig 用 \\makebox 摆放（\\hfill 会被 parfillskip 顶偏）',
  /\\makebox\[\\linewidth\]\[r\]/.test(sty5) &&
    /\\makebox\[\\linewidth\]\[c\]/.test(sty5) &&
    /\\makebox\[\\linewidth\]\[l\]/.test(sty5)
);
add('v5#4：\\fig 兜底宽度 0.45 → 0.3', /\\newcommand\{\\fig\}\[2\]\[0\.3\]/.test(sty5));

// #5 视觉修复
add(
  'v5#5：★ 图片兜底上限 px → em',
  /--ma-fig-h:\s*\d+em/.test(globalsCss5) && !/--ma-fig-h:\s*\d+px/.test(globalsCss5)
);
add('v5#5：★ 去掉图外面的边框与圆角', !/\.ma-fig img\s*\{[^}]*border/.test(globalsCss5));
add(
  'v5#5：★ 三个位置类齐全',
  ['.ma-fig-left', '.ma-fig-center', '.ma-fig-right'].every((c) => globalsCss5.includes(c))
);
add('v5#5：.ma-fig 用 flex 稳定居中/靠边', /\.ma-fig\s*\{[^}]*display:\s*flex/.test(globalsCss5));
add(
  'v5#5：★ 点图全屏放大（渲染层做，全站都有）',
  globalsCss5.includes('.ma-lightbox') && latexContent5.includes('ma-lightbox')
);
add('v5#5：放大能用 Esc 关闭', /e\.key === 'Escape'/.test(latexContent5));
add('v5：有配图位置的真实版面验证脚本', fs.existsSync('scripts/verify-fig-align.ts'));

// ---- 深色模式的 hydration 警告（用户报过 Console Error）----
// 主题内联脚本会在 hydrate 之前给 <html> 加 data-theme，
// 服务端 HTML 里没有这个属性 → React 报 attributes didn't match。
// 官方解法就是给 <html> 加 suppressHydrationWarning（只影响该元素自身属性）。
const layoutSrc = fs.readFileSync('src/app/layout.tsx', 'utf-8');
add(
  '★ 修掉深色模式的 hydration 属性不匹配（<html> 有 suppressHydrationWarning）',
  /<html[^>]*suppressHydrationWarning/.test(layoutSrc)
);
add('主题内联脚本仍在（保留"首屏不闪白"）', /THEME_BOOTSTRAP/.test(layoutSrc));
add(
  '★ 主题开关服务端一律渲染浅色（useSyncExternalStore 的 server snapshot）',
  /function getServerSnapshot\(\): boolean \{\s*return false;/.test(
    fs.readFileSync('src/components/ThemeToggle.tsx', 'utf-8')
  )
);

// ============================================================
// 9. 口令检查（跑外部命令）
// ============================================================
function run(name: string, cmd: string, expectEmpty = true) {
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    add(name, expectEmpty ? out.trim() === '' : true, out.trim().slice(0, 400));
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    add(name, false, text.slice(0, 400) || err.message);
  }
}

run('npx tsc --noEmit 零错误', 'npx tsc --noEmit');

// ============================================================
// 输出
// ============================================================
console.log('Quirex 收尾验收');
console.log('='.repeat(60));
let pass = 0;
let fail = 0;
for (const it of items) {
  if (it.ok) {
    pass++;
    console.log(`  ✓ ${it.name}`);
  } else {
    fail++;
    console.log(`  ✗ ${it.name}${it.detail ? `\n      ${it.detail}` : ''}`);
  }
}
console.log('');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);

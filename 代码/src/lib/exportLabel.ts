/**
 * exportLabel.ts — 题目信息行的拼装（v6 #6）
 *
 * 单独放一个**不碰 fs** 的纯模块，是因为它有两个消费者：
 *   · 服务端导出（latexExport）—— 生成 `\qinfo{...}` 那一行
 *   · 客户端导出弹窗       —— 实时预览"勾了这几项，出来长什么样"
 *
 * 预览必须是**同一份逻辑**算出来的。各写一遍的话，总有一天两边会不一致，
 * 而这种不一致最难发现：预览好看，导出的 PDF 却是另一个样子。
 */

import { difficultyToBand } from './validate';
import { type ExportInfoOptions, type QuestionMeta } from './types';

/** 只处理最有破坏力的 `%`（会把后面整行注掉）；其余靠 xelatex 校验兜底 */
export function escapeTexPercent(text: string): string {
  return (text ?? '').replace(/(^|[^\\])%/g, '$1\\%').trim();
}

/**
 * 拼题目信息行，如 `25全国1 第1题 · 基础 · 年份 2024 · 知识点 函数与导数`。
 *
 * 有几个刻意的选择：
 *   1) **来源与题号合成第一段**。分开用分隔符的话，「25全国1」+「1」会粘成
 *      歧义的「25全国11」—— 所以它们之间是一个空格，整体再和别的段用 · 隔开。
 *   2) **难度只出三档文字**（基础 / 压轴 / 困难），不带 0.62 那种数字，
 *      也**不带「难度」两个字**（v10 按你的要求去掉）—— 老师要的是"这题什么档次"，
 *      三个词摆在那儿一眼就认得出，前面再加个标签反而是噪音。
 *   3) 每一段单独转义。来源与知识点是用户自己起的名字，里面若有一个 `%`
 *      就会把整行注掉。
 *   4) 一项都没勾（或题目没录入任何信息）→ 返回 null，调用方就不输出这一行，
 *      而不是留一对空括号。
 *
 * @param escape 生成 LaTeX 时传 true；界面预览传 false（预览要显示 `%` 本身）
 */
export function buildInfoLabel(
  meta: QuestionMeta,
  info: ExportInfoOptions,
  escape = true
): string | null {
  const clean = (t: string) => (escape ? escapeTexPercent(t) : (t ?? '').trim());
  const parts: string[] = [];

  const src: string[] = [];
  if (info.source && meta.source) src.push(clean(meta.source));
  if (info.number && meta.number !== undefined) src.push(`第${meta.number}题`);
  if (src.length) parts.push(src.join(' '));

  if (info.difficulty) {
    const band = difficultyToBand(meta.difficulty);
    if (band) parts.push(band);
  }
  if (info.year && meta.year) parts.push(`年份 ${meta.year}`);
  if (info.knowledge && meta.knowledge?.length) {
    parts.push(`知识点 ${meta.knowledge.map(clean).join('、')}`);
  }

  const text = parts.filter(Boolean).join(' · ');
  return text || null;
}

/**
 * 题目信息行的**完整预览**（含两个标记），与导出时写进 .tex 的内容一致。
 * 界面拿它渲染一行示例，省得"勾了半天不知道出来什么样"。
 *
 * v10：创新改成**一颗五角星**（不要「创新」两个字）；
 *      题型标记不再是可选项 —— 多选题**永远**带一个「（多选）」。
 */
export function previewInfoLine(
  meta: QuestionMeta | null | undefined,
  info: ExportInfoOptions
): { label: string | null; innovation: boolean; typeMark: boolean } {
  if (!meta) return { label: null, innovation: false, typeMark: false };
  return {
    label: buildInfoLabel(meta, info, false),
    innovation: info.innovation && !!meta.innovation,
    typeMark: meta.type === '多选',
  };
}

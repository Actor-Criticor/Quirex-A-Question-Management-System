/**
 * LatexContent.tsx — 网页显示端（把 .tex 真源渲染出来）
 *
 * 与导出端共用同一份 .tex：导出是原样嵌入模板，这里是渲染。
 * 中间不做任何格式转换，所以两边不可能不一致。
 */

import { useEffect, useState } from 'react';
import { renderLatex, isImageOnly, type RenderOptions } from '@/lib/latexRender';
import type { FigAlign } from '@/lib/types';

export interface QuestionBodyProps {
  qid: string;
  stem: string;
  answer?: string;
  showAnswer?: boolean;
  captions?: Record<string, string>;
  existingFiles?: string[];
  /** 自定义图片地址解析（录入页预览时指向浏览器的 object URL） */
  assetUrl?: (fileName: string) => string;
  /**
   * v5：示意图位置。要和 PDF 一致 —— 那边由 `\begin{exercise}[..][right]` 控制，
   * 这边由同一个值（meta.figAlign 或按题型推导）控制。
   */
  figAlign?: FigAlign;
}

export function LatexBlock({ tex, options }: { tex: string; options: RenderOptions }) {
  const { html, problems } = renderLatex(tex ?? '', options);
  return (
    <>
      <div className="ma-body" dangerouslySetInnerHTML={{ __html: html }} />
      {problems.length > 0 && (
        <div className="ma-problems">
          {problems.map((p, i) => (
            <div key={i}>⚠ {p}</div>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * 题干 + 答案一起渲染。
 * 图号在同一道题内连续：题干先数，答案接着往下编 —— 这样无论题目在讲义里
 * 怎么排序，网页和 PDF 的「图N」都对得上。
 */
export function QuestionBody({
  qid,
  stem,
  answer,
  showAnswer = false,
  captions,
  existingFiles,
  assetUrl,
  figAlign,
}: QuestionBodyProps) {
  const base: RenderOptions = {
    qid,
    captions,
    existingFiles: existingFiles ? new Set(existingFiles) : undefined,
    assetUrl,
    figAlign,
  };

  // v5：点图放大用的状态。Esc 关闭。
  const [zoom, setZoom] = useState<string | null>(null);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoom(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);

  const stemRes = renderLatex(stem ?? '', { ...base, figureStart: 1 });
  const answerRes = renderLatex(answer ?? '', {
    ...base,
    figureStart: stemRes.nextFigure,
  });

  const problems = [...stemRes.problems, ...answerRes.problems];

  // v3：纯图题（题干除图片外没有文字）加一个类，让图片居中且卡片高度稳定 ——
  // 否则一张满宽示意图会把卡片撑得比周围高一大截。
  const stemClass = isImageOnly(stem ?? '') ? 'ma-body ma-image-only' : 'ma-body';

  /**
   * v5：点图放大。
   * 放在渲染层而不是各个页面 —— 这样题库列表、试题篮、详情页、录入预览全都有了。
   * 列表里受限于版面看不清的图，点一下就能看原尺寸。
   */
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.tagName !== 'IMG') return;
    const src = (el as HTMLImageElement).src;
    if (src) setZoom(src);
  };

  return (
    <>
      <div className={stemClass} onClick={onClick} dangerouslySetInnerHTML={{ __html: stemRes.html }} />

      {showAnswer && (answer ?? '').trim().length > 0 && (
        <div className="ma-answer">
          <span className="ma-answer-tag">答案</span>
          <div className="ma-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: answerRes.html }} />
        </div>
      )}

      {zoom && (
        <div
          className="ma-lightbox"
          onClick={() => setZoom(null)}
          role="presentation"
          title="点任意处关闭（Esc 也可以）"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt="放大查看" />
        </div>
      )}

      {problems.length > 0 && (
        <div className="ma-problems">
          {problems.map((p, i) => (
            <div key={i}>⚠ {p}</div>
          ))}
        </div>
      )}
    </>
  );
}

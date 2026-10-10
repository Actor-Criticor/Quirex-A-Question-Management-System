'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { QuestionBody } from '@/components/LatexContent';
import { BackLink } from '@/components/BackLink';
import { SourceQuestions } from '@/components/SourceQuestions';
import { buildImageMacro } from '@/lib/latexCompose';
import { FigAlignPicker } from '@/components/FigureControls';
import { difficultyText } from '@/lib/validate';
import type { FigAlign, ImageChannel, QuestionType, TagItem } from '@/lib/types';
import { resolveFigAlign, CUSTOM_TAG_LEN_MAX, CUSTOM_TAG_MAX, displayQid } from '@/lib/types';
import styles from './page.module.css';

// 服务端 /api/questions/[qid] 的返回形状
interface DetailMeta {
  qid: string;
  kind: string;
  type?: string;
  source?: string;
  number?: number;
  difficulty?: number;
  /** v2：创新（仅单题） */
  innovation?: boolean;
  /** v3：年份 */
  year?: number;
  /** v5：配图位置（仅单题；未设 = 按题型推导） */
  figAlign?: FigAlign;
  knowledge?: string[];
  /** v9：自定义标签（仅单题） */
  custom?: string[];
  description?: string;
  status: string;
  figures?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface AssetInfo {
  name: string;
  channel: string;
  index: number;
  ext: string;
}

interface LintProblem {
  level: string;
  message: string;
  snippet?: string;
}

interface QuestionDetail {
  meta: DetailMeta;
  stem: string;
  answer: string;
  assets: AssetInfo[];
  pdfs: Array<{ role: 'paper' | 'answer'; bytes: number }>;
  problems: LintProblem[];
  orphanImages: string[];
  error?: string;
}

const CHANNELS: Array<{ channel: ImageChannel; asFigure: boolean; label: string; width: number }> = [
  { channel: 'stem', asFigure: false, label: '题干图', width: 0.3 },
  { channel: 'fig', asFigure: true, label: '示意图', width: 0.4 },
  { channel: 'ans', asFigure: false, label: '答案图', width: 0.3 },
  { channel: 'ansfig', asFigure: true, label: '答案示意图', width: 0.4 },
];

export default function QuestionDetailPage() {
  const params = useParams<{ qid: string }>();
  const qid = String(params?.qid ?? '');

  const [data, setData] = useState<QuestionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [tab, setTab] = useState<'preview' | 'edit'>('preview');
  const [showAnswer, setShowAnswer] = useState(false);

  // 正文草稿
  const [stemDraft, setStemDraft] = useState('');
  const [answerDraft, setAnswerDraft] = useState('');

  // 元数据草稿
  const [sourceDraft, setSourceDraft] = useState('');
  const [numberDraft, setNumberDraft] = useState('');
  const [difficultyDraft, setDifficultyDraft] = useState('');
  /** v3：年份 */
  const [yearDraft, setYearDraft] = useState('');
  /** v2 的缺口：创新以前改不了，v3 补上 */
  const [innovationDraft, setInnovationDraft] = useState(false);
  const [knowledgeDraft, setKnowledgeDraft] = useState<string[]>([]);
  const [knowledgeInput, setKnowledgeInput] = useState('');
  /** v9：自定义标签（详情页是**唯一**能看全它们的地方：列表行里只显示 7 个字） */
  const [customDraft, setCustomDraft] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');

  const [figWidth, setFigWidth] = useState(0.4);
  // v8：整卷的 PDF 阅读器已从详情页移除，pdfRole 这个 state 也就没用了（PDF 用「替换」按钮管）
  const [vocab, setVocab] = useState<{
    source: TagItem[];
    knowledge: TagItem[];
    custom: TagItem[];
  } | null>(null);

  const stemRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const pendingUpload = useRef<{ channel: ImageChannel; asFigure: boolean; into: 'stem' | 'answer' } | null>(null);
  const pendingPdfRole = useRef<'paper' | 'answer'>('paper');

  const isPaper = data?.meta.kind === '整卷';
  const files = useMemo(() => (data?.assets ?? []).map((a) => a.name), [data]);

  /** v5：改配图位置（空串 = 清掉，回到按题型推导）。改完重新拉一次，界面与实际一致。 */
  const saveFigAlign = async (v: FigAlign | '') => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/questions/${qid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figAlign: v }),
      });
      const d = await res.json();
      if (!res.ok || d.error) setError(d.error || `保存失败（HTTP ${res.status}）`);
      else {
        setMessage('已保存配图位置');
        setTimeout(() => setMessage(''), 2500);
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // v5：配图位置 —— 手动设过用设的，否则按题型推导（解答题靠右）。
  // 和 PDF 那边 buildExercise 用的是同一个函数，保证两边一致。
  const figAlign = resolveFigAlign(
    data?.meta.type as QuestionType | undefined,
    data?.meta.figAlign
  );

  const applyData = useCallback((d: QuestionDetail) => {
    if (d.error) {
      setError(d.error);
      setData(null);
      return;
    }
    setData(d);
    setStemDraft(d.stem);
    setAnswerDraft(d.answer);
    setSourceDraft(d.meta.source ?? '');
    setNumberDraft(d.meta.number !== undefined ? String(d.meta.number) : '');
    setDifficultyDraft(d.meta.difficulty !== undefined ? String(d.meta.difficulty) : '');
    setYearDraft(d.meta.year !== undefined ? String(d.meta.year) : '');
    setInnovationDraft(d.meta.innovation === true);
    setKnowledgeDraft(d.meta.knowledge ?? []);
    setCustomDraft(d.meta.custom ?? []);
    setDescriptionDraft(d.meta.description ?? '');
    setError('');
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/questions/${qid}`, { cache: 'no-store' });
      applyData((await res.json()) as QuestionDetail);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [qid, applyData]);

  // 挂载 / qid 变化时加载：setState 全在 .then 回调里，避免 effect 体内同步 setState
  useEffect(() => {
    fetch(`/api/questions/${qid}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => applyData(d as QuestionDetail))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));

    fetch('/api/tags', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setVocab(d.vocab))
      .catch(() => setVocab(null));
  }, [qid, applyData]);

  const flash = (t: string) => {
    setMessage(t);
    setTimeout(() => setMessage(''), 4000);
  };

  // ============================================================
  // 保存
  // ============================================================

  const saveMeta = async () => {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      const patch: Record<string, unknown> = {
        source: sourceDraft,
        difficulty: difficultyDraft,
        description: descriptionDraft,
        // v3：年份（空串 = 清掉）
        year: yearDraft,
      };
      // 整卷没有题号、知识点、创新、自定义标签，就不发这几个字段
      if (!isPaper) {
        patch.number = numberDraft;
        patch.knowledge = knowledgeDraft;
        patch.innovation = innovationDraft;
        // v9：自定义标签（服务端会再拦一次 5 个 / 20 字）
        patch.custom = customDraft;
      }

      const res = await fetch(`/api/questions/${qid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.hint ? `${d.error}\n${d.hint}` : d.error || '保存失败');
        return;
      }
      if (d.warnings?.length) flash(`已保存（${d.warnings.join('；')}）`);
      else flash('已保存题目信息');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveContent = async (part: 'stem' | 'answer') => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/questions/${qid}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ part, text: part === 'stem' ? stemDraft : answerDraft }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error || '保存失败');
        return;
      }
      flash(part === 'stem' ? '题干已保存' : '答案已保存');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async () => {
    if (!data) return;
    const next = data.meta.status === '启用' ? '停用' : '启用';
    if (next === '停用') {
      const ok = confirm(
        '停用这道题？（可随时恢复）'
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/questions/${qid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error || '操作失败');
        return;
      }
      flash(next === '停用' ? '已停用' : '已恢复启用');
      await load();
    } finally {
      setBusy(false);
    }
  };

  // ============================================================
  // 图片
  // ============================================================

  const openImagePicker = (channel: ImageChannel, asFigure: boolean, into: 'stem' | 'answer') => {
    pendingUpload.current = { channel, asFigure, into };
    imageInputRef.current?.click();
  };

  /** 把宏插入到指定正文的光标处（没聚焦就追加到末尾） */
  const insertMacro = (into: 'stem' | 'answer', macro: string) => {
    const ref = into === 'stem' ? stemRef : answerRef;
    const el = ref.current;
    const current = into === 'stem' ? stemDraft : answerDraft;
    let next: string;

    if (el && el.selectionStart !== null && document.activeElement === el) {
      const start = el.selectionStart;
      const end = el.selectionEnd ?? start;
      next = current.slice(0, start) + macro + current.slice(end);
    } else {
      next = current ? `${current}\n\n${macro}` : macro;
    }

    if (into === 'stem') setStemDraft(next);
    else setAnswerDraft(next);
    flash('图片已上传并插入正文，记得点「保存题干/答案」');
  };

  const handleImagePicked = async (file: File) => {
    const pending = pendingUpload.current;
    pendingUpload.current = null;
    if (!pending) return;

    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.set('channel', pending.channel);
      fd.set('file', file);
      const res = await fetch(`/api/questions/${qid}/assets`, { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error || '图片上传失败');
        return;
      }
      insertMacro(pending.into, buildImageMacro(d.name as string, pending.asFigure, figWidth));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteImage = async (name: string) => {
    if (!confirm(`删除图片 ${name}？\n\n（正文里引用它的位置会显示缺图提示。）`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/questions/${qid}/assets/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error || '删除失败');
        return;
      }
      flash('图片已删除');
      await load();
    } finally {
      setBusy(false);
    }
  };

  // ============================================================
  // 整卷 PDF
  // ============================================================

  const handlePdfPicked = async (file: File) => {
    const role = pendingPdfRole.current;
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.set('role', role);
      fd.set('file', file);
      const res = await fetch(`/api/questions/${qid}/pdf`, { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok || d.error) {
        setError(d.error || 'PDF 上传失败（必须是真正的 PDF 文件）');
        return;
      }
      flash(role === 'paper' ? '题目 PDF 已上传' : '答案 PDF 已上传');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ============================================================
  // 渲染
  // ============================================================

  if (loading) return <div className="ma-muted">载入中…</div>;

  if (!data) {
    return (
      <div className={styles.page}>
        <div className={styles.err}>{error || '题目不存在'}</div>
        <BackLink className={styles.back} label="← 返回上一页" />
      </div>
    );
  }

  const { meta } = data;
  const lintErrors = data.problems.filter((p) => p.level === 'error');

  return (
    <div className={styles.page}>
      {/* ---------- 头部 ---------- */}
      <div className={styles.head}>
        <div className={styles.headLeft}>
          {/* v7：回**上一页**而不是永远回首页 —— 从题库第 3 页点进来的就回第 3 页 */}
          <BackLink className={styles.back} label="← 返回上一页" />
          <h1 className={styles.title}>
            {/* v9：显示时去掉学科字母（AT0001 → T0001） */}
            <span className="ma-mono">{displayQid(meta.qid)}</span>
          </h1>
          {isPaper ? (
            <span className="ma-badge paper">整卷</span>
          ) : (
            <span className="ma-badge accent">{meta.type}</span>
          )}
          {meta.status === '停用' && <span className="ma-badge warn">已停用</span>}
        </div>
        <div className={styles.headOps}>
          <Link href="/baskets">
            <button>去试题篮</button>
          </Link>
          <button onClick={toggleStatus} disabled={busy}>
            {meta.status === '启用' ? '停用' : '恢复启用'}
          </button>
        </div>
      </div>

      {message && <div className={styles.ok}>{message}</div>}
      {error && <div className={styles.err}>{error}</div>}

      {/* ---------- 元数据摘要（单题） ---------- */}
      {!isPaper && (
        <div className={styles.metaBar}>
          <span>
            来源 <b>{meta.source ?? '未指定'}</b>
          </span>
          <span>
            题号 <b>{meta.number ?? '—'}</b>
          </span>
          <span>
            难度 <b className="ma-mono">{difficultyText(meta.difficulty)}</b>
          </span>
          <span>
            知识点{' '}
            {(meta.knowledge ?? []).length > 0
              ? (meta.knowledge ?? []).map((k) => (
                  <span key={k} className="ma-badge">
                    {k}
                  </span>
                ))
              : '—'}
          </span>
          <span className="ma-muted">更新于 {meta.updatedAt.slice(0, 19).replace('T', ' ')}</span>
        </div>
      )}

      {/* ---------- v7：整卷的「基本信息」（含完整描述，列表里是截断的，这里不截断） ---------- */}
      {isPaper && (
        <section className="ma-card">
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>基本信息</h2>
          </div>

          <div className={styles.infoList}>
            <div className={styles.infoRow}>
              <span className={styles.infoKey}>来源</span>
              <span>{meta.source ?? '未指定'}</span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoKey}>难度</span>
              <span className="ma-mono">{difficultyText(meta.difficulty)}</span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoKey}>年份</span>
              <span className="ma-mono">{meta.year ?? '未录入'}</span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoKey}>PDF</span>
              <span>
                {data.pdfs.length === 0
                  ? '还没有上传'
                  : (['paper', 'answer'] as const)
                      .map((r) => {
                        const p = data.pdfs.find((x) => x.role === r);
                        const label = r === 'paper' ? '题目' : '答案';
                        return p ? `${label} ${(p.bytes / 1024 / 1024).toFixed(1)} MB` : `${label} 缺`;
                      })
                      .join(' · ')}
              </span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoKey}>时间</span>
              <span className="ma-muted">
                录入 {meta.createdAt.slice(0, 19).replace('T', ' ')} · 更新{' '}
                {meta.updatedAt.slice(0, 19).replace('T', ' ')}
              </span>
            </div>
            <div className={styles.infoRow}>
              <span className={styles.infoKey}>描述</span>
              <div className={styles.descFull}>
                {descriptionDraft.trim() ? (
                  descriptionDraft
                ) : (
                  <span className="ma-muted">（还没有描述）</span>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ---------- 单题：预览 / 编辑 ---------- */}
      {!isPaper && (
        <>
          <div className={styles.tabs}>
            <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
              预览
            </button>
            <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>
              编辑
            </button>
          </div>

          {tab === 'preview' && (
            <section className="ma-card">
              <div className={styles.sectionHead}>
                <h2 className={styles.h2}>显示效果</h2>
                <button onClick={() => setShowAnswer((v) => !v)}>
                  {showAnswer ? '隐藏答案' : '显示答案'}
                </button>
              </div>

              {data.stem.trim() === '' ? (
                <div className="ma-muted">还没有题干内容。</div>
              ) : (
                <div className={styles.previewBox}>
                  <QuestionBody
                    qid={meta.qid}
                    stem={data.stem}
                    answer={data.answer}
                    showAnswer={showAnswer}
                    captions={meta.figures}
                    existingFiles={files}
                    figAlign={figAlign}
                  />
                </div>
              )}

              {lintErrors.length > 0 && (
                <div className={styles.lintErr}>
                  {lintErrors.map((p, i) => (
                    <div key={i}>✗ {p.message}</div>
                  ))}
                </div>
              )}
              {data.problems.length > 0 && lintErrors.length === 0 && (
                <div className={styles.lintWarn}>
                  {data.problems.map((p, i) => (
                    <div key={i}>⚠ {p.message}</div>
                  ))}
                </div>
              )}
              {data.problems.length === 0 && (
                <div className={styles.lintOk}>✓ 通过可移植子集检查</div>
              )}

              {data.orphanImages.length > 0 && (
                <div className={styles.lintWarn}>
                  未被正文引用的图片：{data.orphanImages.join('、')}
                </div>
              )}
            </section>
          )}

          {tab === 'edit' && (
            <>
              <section className="ma-card">
                <div className={styles.sectionHead}>
                  <h2 className={styles.h2}>题干</h2>
                  <button
                    className="primary"
                    onClick={() => saveContent('stem')}
                    disabled={busy || stemDraft === data.stem}
                  >
                    {stemDraft === data.stem ? '无改动' : '保存题干'}
                  </button>
                </div>
                <textarea
                  ref={stemRef}
                  className={styles.texArea}
                  rows={10}
                  value={stemDraft}
                  onChange={(e) => setStemDraft(e.target.value)}
                />
              </section>

              <section className="ma-card">
                <div className={styles.sectionHead}>
                  <h2 className={styles.h2}>答案</h2>
                  <button
                    className="primary"
                    onClick={() => saveContent('answer')}
                    disabled={busy || answerDraft === data.answer}
                  >
                    {answerDraft === data.answer ? '无改动' : '保存答案'}
                  </button>
                </div>
                <textarea
                  ref={answerRef}
                  className={styles.texArea}
                  rows={6}
                  value={answerDraft}
                  onChange={(e) => setAnswerDraft(e.target.value)}
                />
              </section>
            </>
          )}
        </>
      )}

      {/* ---------- 整卷：不再内嵌 PDF 阅读器（v8）----------
          你要的是"详情页只显示该标签下的题目"：原卷 PDF 在**浏览列表**上点一下就能开
          （那两个「题目 PDF / 答案 PDF」直链保留），详情页再塞一个阅读器只是占地方。
          想换 PDF 的话，下面的「题目信息」里那两个「替换」按钮还在。 */}

      {/* ---------- v7：整卷 = 来源。列它名下的单题，就地勾进试题篮 ----------
          v8：没有题目时**不再整块隐藏** —— 留一块空白区，让人看得出"这里本来是题目"，
          而不是以为页面没加载完。 */}
      {isPaper && meta.source && (
        <SourceQuestions source={meta.source} currentQid={meta.qid} />
      )}

      {/* ---------- 图片（仅单题） ---------- */}
      {!isPaper && (
        <section className="ma-card">
          <div className={styles.sectionHead}>
            <h2 className={styles.h2}>图片</h2>
            <label className={styles.widthLabel}>
              插入宽度
              <input
                type="number"
                step={0.05}
                min={0.1}
                max={1}
                value={figWidth}
                onChange={(e) => setFigWidth(Number(e.target.value))}
                className={styles.widthInput}
              />
              × 行宽
            </label>
          </div>

          <div className={styles.rowOps}>
            {CHANNELS.map((c) => (
              <button
                key={c.channel}
                onClick={() =>
                  openImagePicker(c.channel, c.asFigure, c.channel === 'stem' || c.channel === 'fig' ? 'stem' : 'answer')
                }
                disabled={busy}
                title={`上传到「${c.label}」通道，并把宏插到${c.channel === 'stem' || c.channel === 'fig' ? '题干' : '答案'}的光标处`}
              >
                ＋ {c.label}
              </button>
            ))}
          </div>

          {/* v5：配图位置 —— 与 PDF 里 \fig 的对齐同一个来源。
              导入时选错了在这里改；「恢复默认」= 回到按题型推导（解答题靠右）。 */}
          <div className={styles.posRow}>
            <FigAlignPicker
              value={figAlign}
              auto={!meta.figAlign}
              onChange={(v) => saveFigAlign(v)}
              onReset={() => saveFigAlign('')}
              disabled={busy}
            />
          </div>

          {data.assets.length === 0 ? (
            <div className="ma-muted" style={{ marginTop: '.6rem' }}>
              还没有图片。
            </div>
          ) : (
            <ul className={styles.imageGrid}>
              {data.assets.map((a) => {
                const label = CHANNELS.find((c) => c.channel === a.channel)?.label ?? a.channel;
                const referenced = data.stem.includes(a.name) || data.answer.includes(a.name);
                return (
                  <li key={a.name} className={styles.imageCard}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/assets/${meta.qid}/${encodeURIComponent(a.name)}`} alt={a.name} />
                    <div className={styles.imageMeta}>
                      <div>
                        <span className="ma-badge">{label}</span>{' '}
                        {referenced ? (
                          <span className="ma-badge accent">已引用</span>
                        ) : (
                          <span className="ma-badge warn">未引用</span>
                        )}
                      </div>
                      <div className="ma-mono" style={{ fontSize: '.72rem', wordBreak: 'break-all' }}>
                        {a.name}
                      </div>
                      <div className={styles.imageOps}>
                        {!referenced && (
                          <button
                            onClick={() =>
                              insertMacro(
                                a.channel === 'stem' || a.channel === 'fig' ? 'stem' : 'answer',
                                buildImageMacro(
                                  a.name,
                                  a.channel === 'fig' || a.channel === 'ansfig',
                                  figWidth
                                )
                              )
                            }
                            disabled={busy}
                          >
                            插入引用
                          </button>
                        )}
                        <button onClick={() => handleDeleteImage(a.name)} disabled={busy}>
                          删除
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* ---------- 元数据编辑 ---------- */}
      <section className="ma-card">
        <div className={styles.sectionHead}>
          <h2 className={styles.h2}>题目信息</h2>
          <button className="primary" onClick={saveMeta} disabled={busy}>
            保存信息
          </button>
        </div>

        <div className={styles.metaGrid}>
          <label className={styles.metaField}>
            <span className={styles.metaLabel}>来源（标签，输入为主）</span>
            <input
              type="text"
              list="src-list"
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
            />
            <datalist id="src-list">
              {(vocab?.source ?? []).map((s) => (
                <option key={s.name} value={s.name} />
              ))}
            </datalist>
          </label>

          {!isPaper && (
            <label className={styles.metaField}>
              <span className={styles.metaLabel}>题号（1–30）</span>
              <input
                type="text"
                value={numberDraft}
                onChange={(e) => setNumberDraft(e.target.value)}
                placeholder="留空表示不标题号"
              />
            </label>
          )}

          <label className={styles.metaField}>
            <span className={styles.metaLabel}>难度（0.01–0.99）</span>
            <input
              type="text"
              value={difficultyDraft}
              onChange={(e) => setDifficultyDraft(e.target.value)}
              placeholder="留空 = 未录入"
            />
          </label>

          {/* v3：年份（两种 kind 都有）。录入时打错了能在这里改。 */}
          <label className={styles.metaField}>
            <span className={styles.metaLabel}>年份</span>
            <input
              type="text"
              inputMode="numeric"
              value={yearDraft}
              onChange={(e) => setYearDraft(e.target.value)}
              placeholder="留空 = 未录入"
            />
          </label>

          {/* v2 的缺口：创新以前只在录入时能标，录完再也改不了
              （PATCH 的白名单里漏了这个字段）。v3 补上，仅单题。 */}
          {!isPaper && (
            <div className={styles.metaField}>
              <span className={styles.metaLabel}>创新</span>
              <button
                type="button"
                className={styles.togglePill}
                aria-pressed={innovationDraft}
                onClick={() => setInnovationDraft((v) => !v)}
              >
                {innovationDraft ? '★ 创新' : '☆ 创新'}
              </button>
            </div>
          )}

          {!isPaper && (
            <div className={styles.metaFieldWide}>
              <span className={styles.metaLabel}>知识点</span>
              <div className={styles.chips}>
                {knowledgeDraft.map((k) => (
                  <span key={k} className={styles.kChip}>
                    {k}
                    <button
                      className={styles.chipX}
                      onClick={() => setKnowledgeDraft((p) => p.filter((x) => x !== k))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                list="kp-list"
                value={knowledgeInput}
                onChange={(e) => setKnowledgeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const clean = knowledgeInput.trim().replace(/\s+/g, ' ');
                  if (clean) setKnowledgeDraft((p) => (p.includes(clean) ? p : [...p, clean]));
                  setKnowledgeInput('');
                }}
                placeholder="输入后回车添加"
              />
              <datalist id="kp-list">
                {(vocab?.knowledge ?? []).map((k) => (
                  <option key={k.name} value={k.name} />
                ))}
              </datalist>
            </div>
          )}

          {!isPaper && (
            <div className={styles.metaFieldWide}>
              <span className={styles.metaLabel}>
                自定义（最多 {CUSTOM_TAG_MAX} 个，每个最长 {CUSTOM_TAG_LEN_MAX} 字）
              </span>
              <div className={styles.chips}>
                {customDraft.map((k) => (
                  <span key={k} className={`${styles.kChip} ${styles.cChip}`}>
                    {k}
                    <button
                      className={styles.chipX}
                      onClick={() => setCustomDraft((p) => p.filter((x) => x !== k))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                type="text"
                list="ct-list"
                value={customInput}
                maxLength={CUSTOM_TAG_LEN_MAX}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const clean = customInput.trim().replace(/\s+/g, ' ');
                  if (clean.length > CUSTOM_TAG_LEN_MAX) {
                    setError(`自定义标签最长 ${CUSTOM_TAG_LEN_MAX} 个字`);
                    return;
                  }
                  if (clean && !customDraft.includes(clean) && customDraft.length >= CUSTOM_TAG_MAX) {
                    setError(`自定义标签最多 ${CUSTOM_TAG_MAX} 个`);
                    return;
                  }
                  if (clean) setCustomDraft((p) => (p.includes(clean) ? p : [...p, clean]));
                  setCustomInput('');
                  setError('');
                }}
                placeholder="输入后回车添加"
              />
              <datalist id="ct-list">
                {(vocab?.custom ?? []).map((k) => (
                  <option key={k.name} value={k.name} />
                ))}
              </datalist>
            </div>
          )}

          <label className={styles.metaFieldWide}>
            <span className={styles.metaLabel}>描述</span>
            <textarea
              rows={isPaper ? 5 : 3}
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
            />
          </label>
        </div>

        {isPaper && (
          <div className={styles.pdfUpload}>
            {(['paper', 'answer'] as const).map((r) => (
              <button
                key={r}
                onClick={() => {
                  pendingPdfRole.current = r;
                  pdfInputRef.current?.click();
                }}
                disabled={busy}
              >
                {data.pdfs.some((p) => p.role === r) ? '替换' : '上传'}
                {r === 'paper' ? '题目 PDF' : '答案 PDF'}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 隐藏的文件选择器 */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImagePicked(f);
          e.target.value = '';
        }}
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handlePdfPicked(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

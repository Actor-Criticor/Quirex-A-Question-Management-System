'use client';

/**
 * baskets/page.tsx — 试题篮（v3 两栏模型）
 *
 * 左：已保存的快照（每页 15 个，点一下 = 载入副本）
 * 右：正在编辑（唯一；勾选进的就是它；[保存] 拍快照；[导出] 导它）
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QuestionBody } from '@/components/LatexContent';
import { Pager } from '@/components/Pager';
import { usePager } from '@/components/usePager';
import { useScrollRestore } from '@/components/useScrollRestore';
import { ExportDialog, type ExportDialogOptions } from '@/components/ExportDialog';
import { difficultyText } from '@/lib/validate';
import {
  coerceExportInfo,
  defaultSnapshotName,
  displayQid,
  type ExportInfoOptions,
  type FigAlign,
  type QuestionMeta,
} from '@/lib/types';
import styles from './page.module.css';

interface ExportOptions {
  template?: string;
  group?: string;
  /** v5：讲义标题（v8 起默认预填时间戳，见 dialogOptions） */
  title?: string;
  /** v6：题目信息要装哪些 */
  info?: ExportInfoOptions;
}

/** 已保存的快照（左侧列表项） */
interface SnapshotSummary {
  id: string;
  name: string;
  count: number;
  createdAt: string;
  updatedAt: string;
}

interface ItemInfo {
  qid: string;
  missing: boolean;
  kind?: string;
  type?: string;
  source?: string;
  number?: number;
  difficulty?: number;
  year?: number;
  /** v5：已解析的配图位置 */
  figAlign?: FigAlign;
  knowledge?: string[];
  innovation?: boolean;
  descPreview?: string;
  status?: string;
  hasPdf?: boolean;
  /** 正文（试题篮要直接显示题目） */
  stem?: string;
  answer?: string;
  assets?: string[];
}

interface BasketsData {
  draft: {
    qids: string[];
    exportOptions: ExportOptions;
    count: number;
    items: ItemInfo[];
  };
  saved: SnapshotSummary[];
  savedTotal: number;
  savedPage: number;
  savedSize: number;
  currentId: string | null;
}

/** v3：左侧快照每页 15 个 */
const SAVED_PAGE_SIZE = 15;
/** v3：右侧正在编辑每页 15 个 */
const DRAFT_PAGE_SIZE = 15;

export default function BasketsPage() {
  const [data, setData] = useState<BasketsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [savedPage, setSavedPage] = useState(1);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  /** 每条题的答案是否展开（答案按需展开） */
  const [showAnswer, setShowAnswer] = useState<Record<string, boolean>>({});
  /** v6：导出弹窗开着没 */
  const [exportOpen, setExportOpen] = useState(false);

  const draft = data?.draft;
  const options: ExportOptions = draft?.exportOptions ?? {};
  const currentId = data?.currentId ?? null;
  /** v7：篮子里残留的整卷（老数据）—— 只用来提示，不自动删 */
  const paperQids = (draft?.items ?? []).filter((i) => i.kind === '整卷').map((i) => i.qid);
  /**
   * v6：把选项收敛成弹窗需要的形状（老数据没有 info，这里会补默认值）。
   * v8：标题**默认预填时间戳** —— 以前是空框 + 一句"留空则用时间戳"的占位提示，
   * 你要的是"直接给个时间戳，想改再改"。所以这里就把默认值填进去，
   * 弹窗一打开就看得见、点一下就能改。
   */
  const dialogOptions: ExportDialogOptions = {
    template: options.template ?? '默认',
    group: options.group ?? 'flat',
    title: options.title?.trim() || defaultSnapshotName(),
    info: coerceExportInfo(options.info),
  };
  /** 预览用：试题篮里第一道题的元信息（够了 —— 预览只是给人一个样子看） */
  const previewMeta: QuestionMeta | null = draft?.items?.[0]
    ? ({
        qid: draft.items[0].qid,
        kind: draft.items[0].kind,
        type: draft.items[0].type,
        source: draft.items[0].source,
        number: draft.items[0].number,
        difficulty: draft.items[0].difficulty,
        year: draft.items[0].year,
        knowledge: draft.items[0].knowledge,
        innovation: draft.items[0].innovation,
      } as unknown as QuestionMeta)
    : null;

  /** v7：右侧「正在编辑」翻页后滚到这一区的标题（同浏览页的做法） */
  const mainTopRef = useRef<HTMLHeadingElement>(null);

  // v3：右侧列表分页（15/页）。左侧是服务端分页（savedPage）。
  const draftPager = usePager(draft?.items ?? [], DRAFT_PAGE_SIZE, 'draft');
  const draftOffset = (draftPager.page - 1) * DRAFT_PAGE_SIZE;

  const applyData = (d: BasketsData & { error?: string }) => {
    if (!d || d.error) {
      if (d?.error) setError(d.error);
      return;
    }
    setData(d);
    setError('');
  };

  /** 取某一页（左侧快照是服务端分页） */
  const fetchPage = async (page: number): Promise<BasketsData & { error?: string }> => {
    const res = await fetch(`/api/baskets?page=${page}&size=${SAVED_PAGE_SIZE}`, {
      cache: 'no-store',
    });
    return (await res.json()) as BasketsData & { error?: string };
  };

  /**
   * 重新载入。显式传页，避免自引用递归。
   * 边界保护：删掉最后一页仅有的一条之后别再停在空页上。
   */
  const load = async (page: number) => {
    try {
      let d = await fetchPage(page);
      if (!d.error && (d.saved ?? []).length === 0 && (d.savedTotal ?? 0) > 0 && page > 1) {
        const last = Math.max(1, Math.ceil((d.savedTotal ?? 0) / SAVED_PAGE_SIZE));
        d = await fetchPage(last);
        setSavedPage(last);
      } else if (page !== savedPage) {
        setSavedPage(page);
      }
      applyData(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // 挂载时加载：setState 放在 .then 回调里（effect 体内同步 setState 会触发级联渲染）
  useEffect(() => {
    fetch(`/api/baskets?page=1&size=${SAVED_PAGE_SIZE}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        const payload = d as BasketsData & { error?: string };
        if (!payload.error) {
          setData(payload);
          setError('');
        } else setError(payload.error);
      })
      .catch(() => {
        /* 忽略 */
      })
      .finally(() => setLoading(false));
  }, []);

  const flash = (t: string) => {
    setMessage(t);
    setTimeout(() => setMessage(''), 4500);
  };

  /** 统一走 POST /api/baskets 的 action 端点 */
  const act = async (payload: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/baskets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = (await res.json()) as Record<string, unknown> & { error?: string };
      if (d.error) {
        setError(d.error);
        return null;
      }
      await load(savedPage);
      return d;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  // v10：从详情页返回时也要回到原来的滚动位置（与题库页同一套 hook）
  useScrollRestore('/baskets', !loading && !!data);

  // ---- 左侧：快照操作 ----

  const handleSave = async () => {
    const d = await act({ action: 'save' });
    if (d) {
      const name = (d.snapshot as { name?: string } | undefined)?.name ?? '';
      flash(`已保存「${name}」`);
      await load(1);
    }
  };

  const handleLoad = async (s: SnapshotSummary) => {
    // v7：不是"直接改之前那条"，而是三步 ——
    //   ① 当前有正在编辑的题目 → 先自动保存成一条新快照
    //   ② 清空当前试题篮
    //   ③ 把这条存档的全部题目复制进来（原存档不动，可反复载入）
    const hint = draft?.count
      ? `\n\n当前正在编辑的 ${draft.count} 道会**先自动保存成一条新快照**，然后本篮清空、换成这条的 ${s.count} 道。\n原存档「${s.name}」不受影响。`
      : `\n\n本篮现在是空的，直接换成这条的 ${s.count} 道。原存档不受影响。`;
    if (!confirm(`把「${s.name}」载入为当前编辑？${hint}`)) return;
    const d = await act({ action: 'load', id: s.id });
    if (d) {
      const auto = d.autoSaved as { name?: string } | null;
      const skipped = (d.skippedPapers as string[] | undefined) ?? [];
      const extra = skipped.length ? `（已跳过其中的整卷 ${skipped.join('、')}）` : '';
      flash(
        auto?.name
          ? `已载入；原来正在编辑的内容已保存为「${auto.name}」${extra}`
          : `已载入${extra}`
      );
    }
  };

  const handleRename = async (s: SnapshotSummary) => {
    const name = prompt('改名为', s.name);
    if (name === null || !name.trim()) return;
    const d = await act({ action: 'rename', id: s.id, name });
    if (d) flash('已改名');
  };

  const handleDelete = async (s: SnapshotSummary) => {
    if (!confirm(`删除快照「${s.name}」？\n\n（只删这条记录，正在编辑的内容不受影响。）`)) return;
    const d = await act({ action: 'delete', id: s.id });
    if (d) flash('已删除该快照');
  };

  // ---- 右侧：正在编辑 ----

  const move = async (from: number, to: number) => {
    if (!draft) return;
    const qids = [...draft.qids];
    if (to < 0 || to >= qids.length) return;
    const [item] = qids.splice(from, 1);
    qids.splice(to, 0, item);
    await act({ action: 'set', qids });
  };

  const handleClear = async () => {
    if (!confirm('清空当前编辑？')) return;
    const d = await act({ action: 'clear' });
    if (d) flash('已清空');
  };

  /**
   * v7：把「正在编辑」里残留的整卷移出。
   *
   * 整卷不允许进试题篮（它是 PDF，没有可重新排版的内容），但老数据里可能存过。
   * 这里**不自动删** —— 那是你的数据，得你点一下；界面只负责告诉你它在。
   */
  const handleDropPapers = async () => {
    const keep = (draft?.qids ?? []).filter((q) => !paperQids.includes(q));
    const d = await act({ action: 'set', qids: keep });
    if (d) flash(`已移出 ${paperQids.length} 份整卷`);
  };

  /**
   * v6：真正的导出。options 由弹窗一次给全 —— 先落盘（这样「保存快照」会
   * 把这次的选择一起记住），再打导出接口。
   * 以前是"请求不带参数、导出选项散在界面上各处即时保存"，标题/模板/题目信息
   * 三样东西没法在一个地方一次定完。
   */
  const handleExport = async (next: ExportDialogOptions) => {
    if (!draft?.count) {
      setError('试题篮是空的');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // 1) 把选择存进「正在编辑」的导出选项。
      //    v8：标题兜一道 —— 万一在弹窗里被清空，也用时间戳，不让讲义变成无名的。
      const title = next.title.trim() || defaultSnapshotName();
      const saved = await act({
        action: 'options',
        exportOptions: {
          title,
          template: next.template,
          group: next.group,
          info: next.info,
        },
      });
      if (!saved) return;

      // 2) 导出（导的永远是「正在编辑」，所以这里不带任何参数）
      const res = await fetch('/api/baskets/export', { method: 'POST' });
      const d = await res.json();
      if (d.error) setError(d.error);
      else {
        setExportOpen(false);
        const imgs = d.imageCount ? `，${d.imageCount} 张图片` : '';
        const pdfs: string[] = d.compile?.pdfs ?? [];
        const t = d.timings;
        const cost = t ? `，用时 ${(t.totalMs / 1000).toFixed(1)}s` : '';
        const compileInfo = d.compile
          ? d.compile.ok
            ? `（已生成 ${pdfs.join(' 与 ')}）`
            : '（⚠ 编译失败，见下方日志）'
          : '';
        flash(`已导出 ${d.count} 道题${imgs} → ${d.folder} ${compileInfo}${cost}`);
        if (d.warnings?.length)
          setError(`导出提示：\n${d.warnings.map((w: string) => `· ${w}`).join('\n')}`);
        if (d.compileLog) setError(`xelatex 错误：\n${d.compileLog}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="ma-muted">载入中…</div>;

  const savedTotal = data?.savedTotal ?? 0;
  const savedPageCount = Math.max(1, Math.ceil(savedTotal / SAVED_PAGE_SIZE));

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <h1 className={styles.title}>试题篮</h1>
      </div>

      {message && <div className={styles.ok}>{message}</div>}
      {error && <div className={styles.err}>{error}</div>}

      <div className={styles.columns}>
        {/* ---------- 左：已保存的快照 ---------- */}
        <aside className={styles.sidebar}>
          <div className={styles.sideHead}>
            <span>已保存（{savedTotal}）</span>
          </div>

          {savedTotal === 0 && (
            <div className={styles.emptyBasket}>还没有保存过。编辑好后点右边「保存」。</div>
          )}

          <ul className={styles.basketList}>
            {(data?.saved ?? []).map((s) => (
              <li key={s.id} className={s.id === currentId ? styles.basketActive : styles.basketItem}>
                <button
                  type="button"
                  className={styles.basketPick}
                  onClick={() => handleLoad(s)}
                  disabled={busy}
                  title="载入为当前编辑"
                >
                  <span className={styles.basketName}>{s.name}</span>
                  <span className={styles.basketMeta}>
                    {s.count} 道 · {s.createdAt.slice(0, 16).replace('T', ' ')}
                  </span>
                </button>
                <span className={styles.basketOps}>
                  <button onClick={() => handleRename(s)} disabled={busy} title="重命名">
                    ✎
                  </button>
                  <button onClick={() => handleDelete(s)} disabled={busy} title="删除这条快照">
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <Pager
            page={savedPage}
            pageCount={savedPageCount}
            total={savedTotal}
            unit="条"
            noJump
            onChange={(p) => {
              setSavedPage(p);
              void load(p);
            }}
          />
        </aside>

        {/* ---------- 右：正在编辑 ---------- */}
        <section className={styles.main}>
          <div className={styles.mainHead}>
            <h2 className={styles.h2} ref={mainTopRef}>
              正在编辑
              <span className="ma-badge" style={{ marginLeft: '.5em' }}>
                {draft?.count ?? 0} 道
              </span>
            </h2>
            <div className={styles.mainOps}>
              <button onClick={handleSave} disabled={busy || !draft?.count}>
                保存
              </button>
              <button onClick={handleClear} disabled={busy || !draft?.count}>
                清空
              </button>
              <Link href="/">
                <button>＋ 去题库挑题</button>
              </Link>
            </div>
          </div>

          {/* v7：整卷不允许进试题篮，但老数据里可能存过 —— 明说 + 一键移出 */}
          {paperQids.length > 0 && (
            <div className={styles.paperWarn}>
              试题篮里还有 {paperQids.length} 份整卷（{paperQids.join('、')}）。
              整卷是 PDF，没有可重新排版的内容，导出时会被跳过 —— 建议移出。
              <button onClick={handleDropPapers} disabled={busy}>
                移出整卷
              </button>
            </div>
          )}

          {!draft?.count ? (
            <div className={styles.emptyBasket}>
              还没有题目。去 <Link href="/">题库</Link> 勾选即可加入。
            </div>
          ) : (
            <>
              <ol className={styles.itemList}>
                {draftPager.pageItems.map((it, i) => {
                  const gi = draftOffset + i; // 全局序号（跨页上移/下移用）
                  return (
                    <li
                      key={it.qid}
                      className={`${styles.item} ${overIndex === gi ? styles.itemOver : ''} ${
                        it.status === '停用' ? styles.itemRetired : ''
                      }`}
                    >
                      <div className={styles.itemHead}>
                        <span
                          className={styles.grip}
                          title="拖动排序"
                          draggable
                          onDragStart={() => setDragIndex(gi)}
                          onDragEnd={() => {
                            setDragIndex(null);
                            setOverIndex(null);
                          }}
                        >
                          ⠿
                        </span>
                        <span className={styles.order}>{gi + 1}</span>
                        <span className="ma-mono">{displayQid(it.qid)}</span>
                        {it.missing ? (
                          <span className="ma-badge warn">题目不存在</span>
                        ) : it.kind === '整卷' ? (
                          <span className="ma-badge paper">整卷</span>
                        ) : (
                          <span className="ma-badge accent">{it.type}</span>
                        )}
                        {it.status === '停用' && <span className="ma-badge warn">已停用</span>}
                        {/* v2/v3：创新只属于单题 */}
                        {it.kind !== '整卷' && it.innovation && (
                          <span className="ma-badge accent">创新</span>
                        )}
                        {it.year !== undefined && <span className="ma-badge">{it.year}</span>}
                        <span className="ma-muted">
                          {it.source ?? '未指定'}
                          {it.number !== undefined ? ` 第${it.number}题` : ''}
                        </span>
                        <span className="ma-mono">{difficultyText(it.difficulty)}</span>

                        <span className={styles.itemOps}>
                          <button
                            onClick={() => move(gi, gi - 1)}
                            disabled={busy || gi === 0}
                            title="上移"
                          >
                            ↑
                          </button>
                          <button
                            onClick={() => move(gi, gi + 1)}
                            disabled={busy || gi === (draft?.count ?? 1) - 1}
                            title="下移"
                          >
                            ↓
                          </button>
                          <Link href={`/question/${it.qid}`}>详情</Link>
                          <button
                            onClick={async () => {
                              const d = await act({ action: 'remove', qid: it.qid });
                              if (d) flash(`已移出 ${displayQid(it.qid)}`);
                            }}
                            disabled={busy}
                            title="移出试题篮"
                          >
                            ✕
                          </button>
                        </span>
                      </div>

                      {/* 直接显示题目 */}
                      <div
                        className={styles.itemBody}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setOverIndex(gi);
                        }}
                        onDragLeave={() => setOverIndex((v) => (v === gi ? null : v))}
                        onDrop={async (e) => {
                          e.preventDefault();
                          setOverIndex(null);
                          if (dragIndex === null || dragIndex === gi) return;
                          await move(dragIndex, gi);
                          setDragIndex(null);
                        }}
                      >
                        {it.kind === '整卷' ? (
                          <>
                            <p className={styles.descClamp}>{it.descPreview ?? '（无描述）'}</p>
                            <div className={styles.paperLinks}>
                              {it.hasPdf && (
                                <>
                                  <a
                                    href={`/api/questions/${it.qid}/pdf/paper`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    题目 PDF
                                  </a>
                                  <a
                                    href={`/api/questions/${it.qid}/pdf/answer`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    答案 PDF
                                  </a>
                                </>
                              )}
                            </div>
                          </>
                        ) : (
                          <QuestionBody
                            qid={it.qid}
                            stem={it.stem ?? ''}
                            answer={it.answer ?? ''}
                            showAnswer={!!showAnswer[it.qid]}
                            existingFiles={it.assets}
                            figAlign={it.figAlign}
                          />
                        )}

                        {it.kind !== '整卷' && (
                          <div className={styles.itemFoot}>
                            <button
                              onClick={() =>
                                setShowAnswer((prev) => ({ ...prev, [it.qid]: !prev[it.qid] }))
                              }
                            >
                              {showAnswer[it.qid] ? '隐藏答案' : '显示答案'}
                            </button>
                            {(it.knowledge ?? []).map((k) => (
                              <span key={k} className="ma-badge">
                                {k}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>

              {/* v7：翻页后滚到「正在编辑」标题，而不是停在分页按钮上 */}
              <Pager
                page={draftPager.page}
                pageCount={draftPager.pageCount}
                total={draftPager.total}
                unit="道"
                scrollTo={mainTopRef}
                onChange={draftPager.setPage}
              />
            </>
          )}

          {/* ---------- 导出：导出的永远是「正在编辑」 ----------
              v6：选项收进弹窗里一次定完（标题 / 模板 / 分组 / 题目信息）。
              v8：这块**只留一个按钮** —— 那三行摘要与说明文字你说没用、白占地方
              （同一个信息在弹窗里都能看到，而且那里还能改）。 */}
          <div className={styles.exportBox}>
            <button
              className="primary"
              onClick={() => setExportOpen(true)}
              disabled={busy || !draft?.count}
            >
              导出讲义
            </button>
          </div>
        </section>
      </div>

      <ExportDialog
        open={exportOpen}
        options={dialogOptions}
        count={draft?.count ?? 0}
        previewMeta={previewMeta}
        fallbackTitle={defaultSnapshotName()}
        busy={busy}
        onClose={() => setExportOpen(false)}
        onConfirm={handleExport}
      />
    </div>
  );
}

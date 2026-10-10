'use client';

/**
 * ExportDialog.tsx — 导出讲义弹窗（v6 #6）
 *
 * 点「导出讲义」弹出这个窗，在这里一次定完：
 *   标题 / 模板 / 分组 / **题目信息要装哪些**（来源、题号、难度、知识点、年份…）
 * 然后按「导出讲义」才开始导。
 *
 * 三个设计决定：
 *
 * 1) **只在"确认导出"时落盘**。打开弹窗随便勾一勾然后取消，不会改到你已保存的
 *    设置 —— 弹窗里的状态是本地的。确认时把所有选项一次写进 draft.exportOptions，
 *    于是「保存快照」会把它们一起记住。
 *
 * 2) **实时预览**。勾选项下面直接显示"第一道题会是什么样"。预览用的是
 *    lib/exportLabel.ts 里那个函数 —— 和真正生成 .tex 的是同一个，
 *    不是照着抄一份近似实现。
 *
 * 3) **导出的永远是「正在编辑」**（v3 的主线）。这里不提供"导出某个历史快照"。
 */

import { useEffect, useState } from 'react';
import { EXPORT_INFO_KEYS, EXPORT_INFO_LABEL, type ExportInfoOptions } from '@/lib/types';
import { previewInfoLine } from '@/lib/exportLabel';
import type { QuestionMeta } from '@/lib/types';
import styles from './ExportDialog.module.css';

export interface ExportDialogOptions {
  template: string;
  group: string;
  title: string;
  info: ExportInfoOptions;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  usable: boolean;
  issues: string[];
  styleFiles: string[];
  /** v9：模板自己声明的默认分组（选中它就跟着切，用户仍可随手改） */
  defaults?: { group?: string };
}

/**
 * 分组方式（v10：加了「按题型」）。
 * 前三项的顺序就是界面上从左到右的顺序；`title` 是鼠标停上去的解释 ——
 * 界面上不再写整句说明（你说过多余）。
 */
const GROUPS: Array<[string, string, string]> = [
  ['flat', '平铺', '按试题篮里的顺序一路排下去'],
  ['type', '按题型', '单选 → 多选 → 填空 → 解答，各成一节'],
  ['knowledge', '按知识点', '同一知识点的题放在一起（多知识点的题只归入第一个）'],
  ['source', '按来源', '按来源分章（每份来源一章）'],
];

/**
 * 外层只做一件事：关着的时候不渲染。
 *
 * 这样内层每次打开都是**全新挂载**，本地草稿用 `useState(options)` 初始化就够了 ——
 * 不需要"打开时把 props 同步进 state"的 effect。那种写法会引起级联渲染，
 * 而且 props 一变就会把用户正在输入的内容冲掉。
 */
export function ExportDialog(props: ExportDialogProps) {
  if (!props.open) return null;
  return <DialogBody {...props} />;
}

interface ExportDialogProps {
  open: boolean;
  options: ExportDialogOptions;
  count: number;
  /** 试题篮里第一道题的元信息 —— 只为预览那一行 */
  previewMeta: QuestionMeta | null;
  /** 标题留空时会用什么（快照名 / 时间戳） */
  fallbackTitle: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (next: ExportDialogOptions) => void;
}

function DialogBody({
  options,
  count,
  previewMeta,
  fallbackTitle,
  busy,
  onClose,
  onConfirm,
}: Omit<ExportDialogProps, 'open'>) {
  // 本地草稿：取消就丢弃，不碰已保存的设置
  const [draft, setDraft] = useState<ExportDialogOptions>(options);
  const [templates, setTemplates] = useState<TemplateRow[] | null>(null);
  const [tplError, setTplError] = useState('');

  useEffect(() => {
    fetch('/api/export/templates', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setTplError(d.error);
        else setTemplates(d.templates ?? []);
      })
      .catch((e) => setTplError((e as Error).message));
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const usable = (templates ?? []).filter((t) => t.usable);
  const broken = (templates ?? []).filter((t) => !t.usable);
  const current = usable.find((t) => t.id === draft.template);
  const preview = previewInfoLine(previewMeta, draft.info);
  const checkedCount = EXPORT_INFO_KEYS.filter((k) => draft.info[k]).length;

  const toggle = (k: (typeof EXPORT_INFO_KEYS)[number]) =>
    setDraft((p) => ({ ...p, info: { ...p.info, [k]: !p.info[k] } }));

  return (
    <div className={styles.mask} onClick={onClose}>
      <div
        className={styles.dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="导出讲义"
      >
        <div className={styles.head}>
          <h2 className={styles.title}>导出讲义</h2>
          <span className={styles.sub}>
            共 {count} 道题 · 导出的是「正在编辑」这一份
          </span>
          <button className={styles.close} onClick={onClose} title="关闭（Esc）">
            ×
          </button>
        </div>

        <div className={styles.body}>
          {/* ---------- 标题 ---------- */}
          <div className={styles.field}>
            <span className={styles.label}>标题</span>
            <input
              type="text"
              value={draft.title}
              spellCheck={false}
              placeholder={`（清空则用「${fallbackTitle}」）`}
              onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
            />
          </div>

          {/* ---------- 模板 ---------- */}
          <div className={styles.field}>
            <span className={styles.label}>模板</span>
            <select
              value={draft.template}
              onChange={(e) => {
                // v9：模板可以声明"我适合怎么分组"（紧凑题单→按知识点、双栏试卷→按来源）。
                // 选中它就跟着切一次 —— 不声明就保持用户当前的选择不变。
                const id = e.target.value;
                const g = usable.find((t) => t.id === id)?.defaults?.group;
                const valid = g && GROUPS.some(([v]) => v === g);
                setDraft((p) => ({ ...p, template: id, group: valid ? g : p.group }));
              }}
              disabled={usable.length === 0}
            >
              {usable.length === 0 && <option value={draft.template}>（没有可用模板）</option>}
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {/* 只显示显示名。以前名字与文件夹名不同时会补一个「（默认）」，
                      三套模板并列时那截括号就显得一多一少、很不齐 ——
                      要确认文件夹名去「设置 → 讲义模板」看。 */}
                  {t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setTemplates(null);
                setTplError('');
                fetch('/api/export/templates', { cache: 'no-store' })
                  .then((r) => r.json())
                  .then((d) => {
                    if (d.error) setTplError(d.error);
                    else setTemplates(d.templates ?? []);
                  })
                  .catch((e) => setTplError((e as Error).message));
              }}
              disabled={busy}
              title="重新读取模板目录（刚放进去的模板不用重启）"
            >
              刷新
            </button>
          </div>
          {current?.description && <div className={styles.hint}>{current.description}</div>}
          {tplError && <div className={styles.warn}>读模板失败：{tplError}</div>}
          {usable.length === 0 && !tplError && (
            <div className={styles.warn}>
              模板目录里没有可用模板 —— 去「设置 → 讲义模板」看看哪里不合规。
            </div>
          )}
          {broken.length > 0 && (
            <div className={styles.warn}>
              另有 {broken.length} 个模板有问题、不能选：
              {broken.map((b) => `「${b.id}」（${b.issues.length} 个问题）`).join('，')}
              <br />
              详情在「设置 → 讲义模板」。
            </div>
          )}

          {/* ---------- 分组 ---------- */}
          <div className={styles.field}>
            <span className={styles.label}>分组</span>
            <div className={styles.segmented}>
              {GROUPS.map(([v, label, hint]) => (
                <button
                  type="button"
                  key={v}
                  className={draft.group === v ? 'active' : ''}
                  title={hint}
                  onClick={() => setDraft((p) => ({ ...p, group: v }))}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* ---------- 题目信息（v10：6 项排一行，不写解释） ---------- */}
          <div className={styles.sectionHead}>
            <span className={styles.label}>题目信息</span>
          </div>

          <div className={styles.checks}>
            {EXPORT_INFO_KEYS.map((k) => (
              <label className={styles.check} key={k}>
                <input type="checkbox" checked={draft.info[k]} onChange={() => toggle(k)} />
                <span className={styles.checkLabel}>{EXPORT_INFO_LABEL[k].label}</span>
              </label>
            ))}
          </div>

          {/* ---------- 预览 ---------- */}
          <div className={styles.previewBox}>
            <div className={styles.previewHead}>预览（按第一道题）</div>
            {!previewMeta ? (
              <div className={styles.hint}>试题篮里第一道题的详情还没载入，先看个大概。</div>
            ) : checkedCount === 0 && !preview.typeMark ? (
              <div className={styles.hint}>一项都没勾 —— 题目上方不会有多余的标注行。</div>
            ) : (
              <div className={styles.previewLine}>
                <span className={styles.previewNo}>1.</span>
                {preview.label && <span className={styles.previewInfo}>（{preview.label}）</span>}
                {preview.innovation && <span className={styles.previewTag}>★</span>}
                {preview.typeMark && <span className={styles.previewTag}>（多选）</span>}
                <span className={styles.previewStem}>……题干……</span>
              </div>
            )}
          </div>

          <div className={styles.note}>
            导出位置在「设置 → 路径」里改。
          </div>
        </div>

        <div className={styles.foot}>
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="primary"
            onClick={() => onConfirm({ ...draft, title: draft.title.trim() })}
            disabled={busy || usable.length === 0}
          >
            {busy ? '导出中…' : '导出讲义'}
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

/**
 * TemplateSettings.tsx — 设置页的「讲义模板」区（v6 建，v8b 重排）
 *
 * 这里是模板的**唯一管理入口**：列出模板目录下的每一个模板、校验结果、
 * 显示名（可改，只改 meta.json 的 name，文件夹名不动）、以及打开文件夹。
 *
 * 为什么把不可用的模板也列出来：模板写错了如果被藏起来，你只会看到
 * "模板不见了"，却不知道该改哪个文件。列出来 + 说清哪里错，才是能自己修的。
 *
 * v8b 重排（你说"这里还不太好，再规整一下"）：原来是"一行标题 + 折叠展开"，
 * 折叠着看不全、展开后又是一大堆横七竖八的键值行。现在改成：
 *   · **不折叠** —— 一个模板一张卡，所有信息一次看全（模板本来就该只有几个）
 *   · 卡内是**固定的三段**：谁（显示名 + 状态）→ 是什么（目录/样式文件/占位符/引擎）
 *     → 怎么调（改名、打开文件夹）
 *   · 元信息用**等宽的键值两列**，不再是散落的行
 *   · 「模板目录」提到最上面并配「打开模板目录」按钮，不用滚到底才看得见
 *   · 占位符含义收进一个可展开的说明里（需要时再看，不占地方）
 */

import { useCallback, useEffect, useState } from 'react';
import { Pager } from '@/components/Pager';
import { usePager } from '@/components/usePager';
import styles from './PathSettings.module.css';
import own from './TemplateSettings.module.css';

/**
 * v9：每页 3 个模板。
 * 模板卡信息量比列表行大得多（名字/状态/描述/四项元信息/一行操作），
 * 一屏 3 张正好；再多就得滚，反而不好找。
 */
const TEMPLATE_PAGE_SIZE = 3;

interface TemplateRow {
  id: string;
  dir: string;
  usable: boolean;
  issues: string[];
  name: string;
  description: string;
  engine: string;
  styleFiles: string[];
  tokens: string[];
}

interface TemplatesView {
  root: string;
  templates: TemplateRow[];
  usableIds: string[];
  tokenDoc: Record<string, string>;
  knownTokens: string[];
}

export function TemplateSettings() {
  const [view, setView] = useState<TemplatesView | null>(null);
  /** 每个模板的显示名草稿（key = 模板 id） */
  const [draft, setDraft] = useState<Record<string, string>>({});
  /** 每个模板的描述草稿（v9：描述也能改了 —— 它本来就写在 meta.json 里） */
  const [descs, setDescs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  /** v10：正在改哪个模板的名字（点铅笔进入，Esc/取消退出） */
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/export/templates', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: TemplatesView) => {
        setView(d);
        setDraft(Object.fromEntries((d.templates ?? []).map((t) => [t.id, t.name])));
        setDescs(Object.fromEntries((d.templates ?? []).map((t) => [t.id, t.description])));
      })
      .catch(() => setView(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // v9：模板列表分页，每页 3 个（用项目里统一的 Pager）
  const allTemplates = view?.templates ?? [];
  const pager = usePager(allTemplates, TEMPLATE_PAGE_SIZE, 'templates');

  const flash = (t: string) => {
    setMsg(t);
    setTimeout(() => setMsg(''), 5000);
  };

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/export/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown> & { error?: string };
  };

  /**
   * v9：保存显示名**与描述**（走同一个 update 动作）。
   * 这两个字段都写在模板自己的 meta.json 里 —— 所以"改了就生效"，
   * 不需要碰任何代码，导出弹窗里显示的也是它。
   */
  const saveMeta = async (id: string) => {
    setBusy(`save:${id}`);
    setErr('');
    try {
      const d = await post({
        action: 'update',
        id,
        name: (draft[id] ?? '').trim(),
        description: (descs[id] ?? '').trim(),
      });
      if (d.error) setErr(d.error);
      else {
        flash(`「${id}」的模板信息已保存（已写进它的 meta.json）`);
        load();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const reveal = async (id: string) => {
    setErr('');
    const d = await post({ action: 'reveal', id });
    if (d.error) setErr(d.error);
  };

  const revealRoot = async () => {
    setErr('');
    const d = await post({ action: 'revealRoot' });
    if (d.error) setErr(d.error);
  };

  const usableCount = view?.usableIds.length ?? 0;

  return (
    <section className="ma-card">
      <div className={styles.head}>
        <h2 className={styles.h2}>讲义模板</h2>
        {view && (
          <span className={styles.hint}>
            共 {view.templates.length} 个{usableCount < view.templates.length ? ` · ${usableCount} 个可用` : ''}
          </span>
        )}
      </div>

      {msg && <div className={styles.ok}>{msg}</div>}
      {err && <div className={styles.err}>{err}</div>}

      {!view && <div className={styles.hint}>读取中…</div>}

      {/* ---------- 模板目录（提到最上面） ---------- */}
      {view && (
        <div className={own.rootBar}>
          <span className={own.rootLabel}>模板目录</span>
          <span className={`ma-mono ${own.rootPath}`}>{view.root}</span>
          <button onClick={() => revealRoot()} disabled={!!busy} className={own.rootBtn}>
            打开
          </button>
        </div>
      )}

      {view && view.templates.length === 0 && (
        <div className={styles.note}>
          这个目录里还没有模板。加模板 = 放一个文件夹进来，里面要有{' '}
          <span className="ma-mono">main.tex</span> 与 <span className="ma-mono">meta.json</span>。
          （模板目录可以在上面的「路径」里改。）
        </div>
      )}

      {/* ---------- 每个模板一张卡，不折叠（v9：每页 3 张） ---------- */}
      {pager.pageItems.map((t) => {
        const changed =
          (draft[t.id] ?? '') !== t.name || (descs[t.id] ?? '') !== t.description;
        return (
          // data-template 是给校验脚本用的稳定钩子：显示名可以被改、改成输入框之后
          // innerText 里就没有它了，按名字找卡片会时灵时不灵
          <article className={own.card} key={t.id} data-template={t.id}>
            {/*
              第一段：谁。
              v10：**只显示一个名字**（用 meta.json 的 name），文件夹名不再在旁边重复一遍
              —— 之前是「默认讲义  默认」，看着像两个名字。改名也不再单列一行，
              而是在名字旁边给一支铅笔，点它名字就地变成输入框。
            */}
            <header className={own.cardHead}>
              {editing === t.id ? (
                <>
                  <input
                    type="text"
                    autoFocus
                    className={own.nameInput}
                    value={draft[t.id] ?? ''}
                    spellCheck={false}
                    placeholder="导出弹窗里显示的名字"
                    onChange={(e) => setDraft((p) => ({ ...p, [t.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveMeta(t.id);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  <button
                    className="primary"
                    onClick={() => saveMeta(t.id)}
                    disabled={!!busy || !changed}
                  >
                    {busy === `save:${t.id}` ? '保存中…' : '保存'}
                  </button>
                  <button onClick={() => setEditing(null)} disabled={!!busy}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <span className={own.name}>{t.name || '（未命名）'}</span>
                  <button
                    className={own.editBtn}
                    onClick={() => setEditing(t.id)}
                    disabled={!!busy}
                    title="改这个名字（写进模板自己的 meta.json）"
                    aria-label={`改「${t.name || t.id}」的名字`}
                  >
                    ✎
                  </button>
                </>
              )}
              <span className={t.usable ? own.okBadge : own.badBadge}>
                {t.usable ? '可用' : `不可用 · ${t.issues.length} 个问题`}
              </span>
            </header>

            {t.issues.length > 0 && (
              <div className={styles.err}>
                这个模板现在<b>不能用于导出</b>：
                {'\n'}
                {t.issues.map((i) => `· ${i}`).join('\n')}
              </div>
            )}

            {/* 第二段：怎么调（v10：元信息键值表与占位符说明整块去掉了） */}
            <footer className={own.foot}>
              <div className={own.descRow}>
                <span className={own.opLabel}>描述</span>
                <textarea
                  className={own.descBox}
                  value={descs[t.id] ?? ''}
                  spellCheck={false}
                  rows={2}
                  placeholder="一句话说明这个模板长什么样、适合什么场景（导出弹窗里会显示）"
                  onChange={(e) => setDescs((p) => ({ ...p, [t.id]: e.target.value }))}
                />
              </div>
              <div className={own.ops}>
                <button onClick={() => saveMeta(t.id)} disabled={!!busy || !changed}>
                  {busy === `save:${t.id}` ? '保存中…' : changed ? '保存' : '未改动'}
                </button>
                <button
                  onClick={() => reveal(t.id)}
                  disabled={!!busy}
                  title="在文件管理器里打开这个模板目录"
                >
                  打开文件夹
                </button>
              </div>
            </footer>
          </article>
        );
      })}

      {/* ---------- 翻页（每页 3 个） ---------- */}
      {view && view.templates.length > 0 && (
        <Pager
          page={pager.page}
          pageCount={pager.pageCount}
          total={pager.total}
          unit="套"
          onChange={pager.setPage}
        />
      )}
    </section>
  );
}

'use client';

/**
 * SourceQuestions.tsx — 「此来源下的题目」（v7）
 *
 * 这是"**整卷也是来源**"那半套逻辑的落点：
 * 一份卷子的详情页上，直接列出它名下有哪些单题，并且**就地勾选就能进试题篮**。
 *
 * 三个刻意的行为：
 *   1. **一道都没有 → 显示一块空白区**（v8 改的）。上一版是整块隐藏，但那样
 *      "这份卷子还没有录题"和"页面根本没这块"看起来一样，容易以为没加载完。
 *   2. **只列单题**。同一来源下可能还有别的整卷，但卷子列卷子没有意义，
 *      而且整卷本来就进不了试题篮（v7）。
 *   3. 勾选/取消与浏览页共用同一个接口与同一套乐观更新，行为一致。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { QuestionBody } from '@/components/LatexContent';
import { difficultyText } from '@/lib/validate';
import { displayQid, type IndexEntry } from '@/lib/types';
import styles from './SourceQuestions.module.css';

interface Content {
  stem: string;
  answer: string;
  assets: string[];
}

export function SourceQuestions({ source, currentQid }: { source: string; currentQid: string }) {
  const [entries, setEntries] = useState<IndexEntry[] | null>(null);
  const [contents, setContents] = useState<Record<string, Content>>({});
  const [inBasket, setInBasket] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // 没有来源就什么都不查（entries 保持 null → 组件渲染 null）。
    // 这里**不能**写成 setEntries([])：在 effect 体内同步 setState 会触发级联渲染。
    if (!source) return;
    const sp = new URLSearchParams();
    sp.set('source', source);
    sp.set('kind', '单题');
    sp.set('status', '全部');
    sp.set('size', '200');
    sp.set('withContent', '1');

    fetch(`/api/questions/search?${sp.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { items?: IndexEntry[]; contents?: Record<string, Content>; error?: string }) => {
        if (d.error) {
          setError(d.error);
          setEntries([]);
          return;
        }
        // 自己（万一这份"整卷"其实是单题）不列出来
        setEntries((d.items ?? []).filter((e) => e.qid !== currentQid));
        setContents(d.contents ?? {});
      })
      .catch((e: Error) => {
        setError(e.message);
        setEntries([]);
      });

    fetch('/api/baskets/stats', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { draftQids?: string[] }) => setInBasket(new Set(d.draftQids ?? [])))
      .catch(() => {
        /* 篮子不可用不影响查看 */
      });
  }, [source, currentQid]);

  const toggle = async (qid: string) => {
    const was = inBasket.has(qid);
    setError('');
    setBusy(qid);
    // 先乐观更新（点下去就有反应），失败再回滚
    setInBasket((prev) => {
      const next = new Set(prev);
      if (was) next.delete(qid);
      else next.add(qid);
      return next;
    });
    try {
      const res = await fetch('/api/baskets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(was ? { action: 'remove', qid } : { action: 'add', qids: [qid] }),
      });
      const d = await res.json();
      if (d.error) throw new Error(d.error);
    } catch (e) {
      setInBasket((prev) => {
        const next = new Set(prev);
        if (was) next.add(qid);
        else next.delete(qid);
        return next;
      });
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  // 还没查完 → 不渲染（避免闪一块"暂无"再变成列表）
  if (!entries) return null;

  const picked = entries.filter((e) => inBasket.has(e.qid)).length;

  return (
    <section className="ma-card">
      <div className={styles.head}>
        <h2 className={styles.h2}>
          「{source}」名下的题目
          <span className="ma-badge" style={{ marginLeft: '.5em' }}>
            {entries.length} 道
          </span>
        </h2>
        {entries.length > 0 && (
          <span className={styles.hint}>
            勾选即加入试题篮{picked > 0 ? `（已选 ${picked}）` : ''}
          </span>
        )}
      </div>

      {error && <div className={styles.err}>{error}</div>}

      {/* v8：一道都没有时留白，不隐藏整块 —— 让人看得出"这里本来是题目" */}
      {entries.length === 0 && (
        <div className={styles.blank}>这个来源下还没有录入单题。</div>
      )}

      <ul className={styles.list}>
        {entries.map((e) => {
          const c = contents[e.qid];
          const checked = inBasket.has(e.qid);
          return (
            <li key={e.qid} className={`${styles.item} ${checked ? styles.checked : ''}`}>
              <div className={styles.itemHead}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy === e.qid}
                  onChange={() => toggle(e.qid)}
                  title={checked ? '取消勾选即移出试题篮' : '勾选即加入试题篮'}
                />
                <span className="ma-mono">{displayQid(e.qid)}</span>
                {e.number !== undefined && <span>第{e.number}题</span>}
                {e.type && <span className="ma-badge accent">{e.type}</span>}
                <span className={styles.diff}>{difficultyText(e.difficulty)}</span>
                {e.innovation && <span className="ma-badge">创新</span>}
                {e.status === '停用' && <span className="ma-badge warn">停用</span>}
                {(e.knowledge ?? []).map((k) => (
                  <span key={k} className="ma-badge">
                    {k}
                  </span>
                ))}
                <Link href={`/question/${e.qid}`} className={styles.link}>
                  详情
                </Link>
              </div>

              <div className={styles.body}>
                {c ? (
                  <QuestionBody
                    qid={e.qid}
                    stem={c.stem}
                    showAnswer={false}
                    existingFiles={c.assets}
                    figAlign={e.figAlign}
                  />
                ) : (
                  <span className="ma-muted">载入中…</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default SourceQuestions;

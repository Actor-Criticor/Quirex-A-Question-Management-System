'use client';

/**
 * Pager.tsx — 全站统一的分页条（v3）
 *
 *   ‹ 上一页    第 3 / 12 页（共 118 条）    下一页 ›    跳到 [__] 页
 *
 * 约定：
 *   - 只有一页时**不渲染**（不出现「第 1 / 1 页」这种废话条）
 *   - 需要强制显示时传 always
 *   - v7：传了 `scrollTo` 就在翻页后滚到那个元素 —— 不传就不滚。
 *     为什么是"传才滚"而不是"一律滚到页面顶部"：这个组件也用在**筛选面板内部**
 *     （知识点分页），在那里把整页滚回顶部反而把面板滚出视野，更糟。
 */

import { useState, type RefObject } from 'react';
import styles from './Pager.module.css';

export interface PagerProps {
  page: number;
  pageCount: number;
  total: number;
  unit?: string;
  onChange: (page: number) => void;
  /** 只有一页时也显示（默认隐藏） */
  always?: boolean;
  /** 不显示「跳到第 N 页」输入框 */
  noJump?: boolean;
  /**
   * v7：翻页后把哪个元素滚到视口顶部（通常是列表上方的标题/结果条）。
   * 不传 = 不滚动，保持浏览器默认行为。
   */
  scrollTo?: RefObject<HTMLElement | null>;
}

export function Pager({
  page,
  pageCount,
  total,
  unit = '条',
  onChange,
  always = false,
  noJump = false,
  scrollTo,
}: PagerProps) {
  const [jump, setJump] = useState('');

  if (!always && pageCount <= 1) return null;

  /**
   * 翻页 + 滚到列表顶部。
   *
   * 用 `requestAnimationFrame` 等一帧：新一页的内容要先渲染出来，
   * 否则滚动位置的基准还是旧列表的高度，会滚到一个莫名其妙的地方。
   */
  const go = (next: number) => {
    onChange(next);
    const el = scrollTo?.current;
    if (!el) return;
    requestAnimationFrame(() => {
      // block:'start' 会让元素贴着视口最上沿，下面那条固定导航正好压住它 —— 所以稍微退一点
      const top = el.getBoundingClientRect().top + window.scrollY - 72;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    });
  };

  const doJump = () => {
    const n = Number(jump);
    if (Number.isFinite(n) && n >= 1) go(Math.min(Math.floor(n), pageCount));
    setJump('');
  };

  return (
    <div className={styles.pager}>
      <button onClick={() => go(page - 1)} disabled={page <= 1}>
        ‹ 上一页
      </button>
      <span className={styles.info}>
        第 <b>{page}</b> / {pageCount} 页
        <span className={styles.dim}>（共 {total} {unit}）</span>
      </span>
      <button onClick={() => go(page + 1)} disabled={page >= pageCount}>
        下一页 ›
      </button>

      {!noJump && pageCount > 1 && (
        <span className={styles.jump}>
          跳到
          <input
            type="text"
            inputMode="numeric"
            value={jump}
            onChange={(e) => setJump(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                doJump();
              }
            }}
            aria-label="跳到第几页"
          />
          页
        </span>
      )}
    </div>
  );
}

export default Pager;

'use client';

/**
 * usePager.ts — 全站统一的分页 hook（v3）
 *
 * 为什么要有它：v2 只有浏览页手写了一处分页，其它 7 处长列表全是 .map 全铺。
 * v3 把所有「多项列表」统一到这一套，页大小不同但行为完全一致：
 *   - 过滤条件一变 → 自动回到第 1 页
 *   - 总数不足一页 → pageCount = 1，Pager 自己会隐藏
 *   - 越界保护：删掉最后一页的唯一一条后不会停在空页
 *
 * 「过滤条件变了就回第 1 页」是**渲染期派生**出来的，不用 useEffect ——
 * 这样既不会多渲染一帧，也不会触发 react-hooks/set-state-in-effect。
 */

import { useCallback, useMemo, useState } from 'react';

interface PagerState {
  /** 记住当前页所属的过滤条件 */
  key: string;
  page: number;
}

export interface Pager<T> {
  page: number;
  setPage: (p: number) => void;
  goPrev: () => void;
  goNext: () => void;
  pageCount: number;
  /** 当前页的条目 */
  pageItems: T[];
  /** 总条数 */
  total: number;
  /** 每页条数（回显用） */
  pageSize: number;
}

export function usePager<T>(items: T[], pageSize: number, resetKey = ''): Pager<T> {
  const [state, setState] = useState<PagerState>({ key: resetKey, page: 1 });

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // 渲染期派生：resetKey 变了就当第 1 页，不需要额外 effect
  const raw = state.key === resetKey ? state.page : 1;
  const page = Math.min(Math.max(1, raw), pageCount);

  const setPage = useCallback(
    (p: number) => {
      const next = Math.min(Math.max(1, Math.floor(p) || 1), pageCount);
      setState({ key: resetKey, page: next });
    },
    [resetKey, pageCount]
  );

  const goPrev = useCallback(() => setPage(page - 1), [setPage, page]);
  const goNext = useCallback(() => setPage(page + 1), [setPage, page]);

  const pageItems = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize]
  );

  return { page, setPage, goPrev, goNext, pageCount, pageItems, total, pageSize };
}

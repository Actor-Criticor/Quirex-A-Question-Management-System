'use client';

/**
 * BackLink.tsx — 「返回上一页」（v7）
 *
 * 以前详情页左上角是 `<Link href="/">← 题库</Link>`：不管你从哪一页点进来，
 * 返回都回**首页**。你是从题库第 3 页点进来的，回去却掉到第 1 页 —— 这是被报的毛病。
 *
 * 现在用 `router.back()` 回上一页。只有一个例外：
 * **没有上一页**（新标签页直接粘 URL 打开、或书签进来）时，`back()` 会把人送出本站，
 * 那就退回首页 —— 那才是"上一页"在这个场景下该有的意思。
 *
 * 判据是 `window.history.length <= 1`。它不完美（同标签页里连续跳几个站也会 > 1），
 * 但对本工具足够：Quirex 是本地单页应用，历史上没有"跳出去再回来"的路径。
 */

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

export function BackLink({
  fallback = '/',
  label = '← 返回',
  className,
  children,
}: {
  /** 没有上一页时去哪 */
  fallback?: string;
  label?: string;
  className?: string;
  children?: ReactNode;
}) {
  const router = useRouter();

  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (typeof window !== 'undefined' && window.history.length > 1) router.back();
        else router.push(fallback);
      }}
    >
      {children ?? label}
    </button>
  );
}

export default BackLink;

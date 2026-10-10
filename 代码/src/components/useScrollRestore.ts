'use client';

/**
 * useScrollRestore.ts — 「回到这个视图时回到原来的滚动位置」（v8b 建，v10 抽成公共 hook）
 *
 * ## 解决的问题
 *
 * 长列表里翻到下面、点进详情、再点返回 —— 浏览器默认把你放在**页面顶部**，
 * 等于又丢了一次位置（明明 URL 里的筛选条件和页码都还在）。
 * 所以另存一份 `URL → 滚动距离`，回同一个视图时滚回去。
 * 用 sessionStorage（关掉标签页就清）而不是 localStorage：滚动位置属于"这次浏览"，
 * 隔三天再打开同一页，你多半想从顶上开始看。
 *
 * ## 三个坑（都是实测踩出来的，所以每一条都有注释守着）
 *
 * 1. **退出时不能现读 `window.scrollY`**：点详情那一刻 next 已经换了 URL、
 *    浏览器也把滚动夹回 0，现读会把我刚滑到的 2042 写成 0。
 *    → 每次滚动都同步记下"当时的 URL + 当时的位置"，退出时写这份记录。
 * 2. **只在"本页还在前台"时记录**：进详情时会有一条 scroll 事件（夹回 0 引起的），
 *    记下来就是把 2042 冲掉。→ 用 `pathname` 判断。
 * 3. **开发模式 StrictMode 会挂载→cleanup→再挂载**，那次 cleanup 时 memo 还是
 *    挂载瞬间的 `y = 0`，照写就把上次的位置覆盖掉。
 *    → `hasScrolled` 为 true 才落盘。
 *
 * 恢复那一步要跟 Next **抢**几次：Next 在每次导航（含后退）后都会把页面滚到顶部，
 * 滚一次很容易被它覆盖。所以落到位就停、否则每 120ms 再试，最多约 1 秒；
 * 用户一旦自己动了（滚轮 / 触摸 / 按键）就立刻收手，不跟人抢。
 *
 * v10：题库页与试题篮页共用它 —— 原来只有题库页有，试题篮页从详情返回时还是回到顶上。
 */

import { useEffect, useRef } from 'react';

const SCROLL_STORE = 'quirex:scroll';

function readScrollOffset(url: string): number {
  try {
    const all = JSON.parse(sessionStorage.getItem(SCROLL_STORE) ?? '{}') as Record<string, number>;
    const y = all[url];
    return typeof y === 'number' && y > 0 ? y : 0;
  } catch {
    return 0;
  }
}

function writeScrollOffset(url: string, y: number): void {
  try {
    const all = JSON.parse(sessionStorage.getItem(SCROLL_STORE) ?? '{}') as Record<string, number>;
    all[url] = Math.round(y);
    sessionStorage.setItem(SCROLL_STORE, JSON.stringify(all));
  } catch {
    /* 隐私模式之类写不了就算了，大不了回到顶上 */
  }
}

/**
 * @param pathname 这个页面自己的路由（`'/'` 或 `'/baskets'`）—— 用来判断"还在不在本页"
 * @param ready    数据到位了没。列表没渲染出来时页面不够高，滚不到那个位置，所以要等它
 */
export function useScrollRestore(pathname: string, ready: boolean): void {
  /** 最近一次"这个视图滚到哪了"（见文件头坑 1） */
  const memo = useRef<{ url: string; y: number }>({ url: '', y: 0 });
  /** 有没有真的滚动过（见文件头坑 3） */
  const scrolled = useRef(false);

  useEffect(() => {
    const prevMode = window.history.scrollRestoration;
    // 交给我们自己管：不然浏览器可能也恢复一次，两边打架
    window.history.scrollRestoration = 'manual';

    let timer: number | undefined;
    const remember = (persist: boolean) => {
      if (window.location.pathname !== pathname) return;
      memo.current = { url: window.location.pathname + window.location.search, y: window.scrollY };
      if (!persist || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        writeScrollOffset(memo.current.url, memo.current.y);
      }, 250);
    };

    const onScroll = () => {
      scrolled.current = true;
      remember(true);
    };
    remember(false); // 初始只记不落盘
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onScroll);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onScroll);
      if (scrolled.current) writeScrollOffset(memo.current.url, memo.current.y);
      window.history.scrollRestoration = prevMode;
    };
  }, [pathname]);

  /** 恢复一次（每次挂载只恢复一次） */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    if (!ready) return;
    restored.current = true;

    const y = readScrollOffset(window.location.pathname + window.location.search);
    if (y <= 0) return;

    let stopped = false;
    const takeOver = () => {
      stopped = true;
    };
    window.addEventListener('wheel', takeOver, { passive: true, once: true });
    window.addEventListener('touchstart', takeOver, { passive: true, once: true });
    window.addEventListener('keydown', takeOver, { once: true });

    const timers: number[] = [];
    let tries = 0;
    const attempt = () => {
      if (stopped) return;
      if (Math.abs(window.scrollY - y) <= 4) return; // 已经到位
      window.scrollTo({ top: y, behavior: 'auto' });
      if (++tries < 6) timers.push(window.setTimeout(attempt, 120));
    };
    timers.push(window.setTimeout(attempt, 0));

    return () => {
      timers.forEach((t) => clearTimeout(t));
      window.removeEventListener('wheel', takeOver);
      window.removeEventListener('touchstart', takeOver);
      window.removeEventListener('keydown', takeOver);
    };
  }, [ready]);
}

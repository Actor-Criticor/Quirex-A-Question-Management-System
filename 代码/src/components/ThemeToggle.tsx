'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * 主题切换。
 *
 * 用 useSyncExternalStore 而不是「useEffect 里读 localStorage + setState」：
 *   · 后者会在挂载时产生一次级联渲染（React 明确不建议）
 *   · localStorage 本来就是一个外部数据源，用它才符合语义
 * 无闪白：由 layout 里的一段内联脚本在首屏绘制前就把 data-theme 写到 <html> 上。
 *
 * 位置由导航栏决定（本组件不再 fixed，避免和导航重叠）。
 */

const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(): void {
  for (const l of listeners) l();
}

/** 当前是否为深色（快照必须同步且幂等） */
function getSnapshot(): boolean {
  try {
    return localStorage.getItem('theme') === 'dark';
  } catch {
    return false;
  }
}

/** 服务端渲染时一律按浅色，避免 hydration 不一致 */
function getServerSnapshot(): boolean {
  return false;
}

export function setTheme(dark: boolean): void {
  try {
    localStorage.setItem('theme', dark ? 'dark' : '');
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略即可 */
  }
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  emit();
}

export default function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const toggle = useCallback(() => setTheme(!getSnapshot()), []);

  return (
    <button
      onClick={toggle}
      className="ma-theme-toggle"
      title={dark ? '切换到浅色模式' : '切换到深色模式'}
      aria-label="切换主题"
    >
      {dark ? '☀️' : '🌙'}
    </button>
  );
}

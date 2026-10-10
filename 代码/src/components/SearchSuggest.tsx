'use client';

/**
 * SearchSuggest.tsx — 带建议的搜索框（v4）
 *
 * 起因：浏览页的搜索框原来是个光秃秃的 <input>，全站没有任何建议机制。
 * 检索逻辑本来就认标签名（entryTagNames），**打全了能搜到**，
 * 只是没人告诉你有哪些标签可选 —— 打个「25」根本不知道库里有个「25海淀一模」。
 *
 * 这里给搜索框挂一个建议浮层：
 *   - 候选 = 来源 + 知识点 + 年份（都由父组件从已有的 /api/tags 传进来，组件自己不请求）
 *   - 子串匹配、大小写不敏感；**前缀命中的排前面**，再按引用数降序
 *   - ↑ ↓ 选择、Enter 采用、Esc 关闭、鼠标点击采用
 *   - 无匹配就不显示浮层（不占位、不啰嗦）
 */

import { useMemo, useState } from 'react';
import styles from './SearchSuggest.module.css';

export interface SuggestItem {
  /** 唯一键（来源/知识点用名字，年份用 y:2025） */
  key: string;
  /** 显示文本，也是采用后填进搜索框的内容 */
  label: string;
  /** 维度徽标 */
  kind: '来源' | '知识点' | '自定义' | '年份';
  /** 引用数 */
  count: number;
}

export interface SearchSuggestProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 候选池（不匹配自己过滤） */
  items: SuggestItem[];
  /** 最多显示几条 */
  limit?: number;
  className?: string;
}

const MAX_DEFAULT = 8;

/** 排序：前缀命中 > 引用数多 > 名字短 > 名字字典序 */
function rank(a: SuggestItem, b: SuggestItem, needle: string): number {
  const pa = a.label.toLowerCase().startsWith(needle) ? 0 : 1;
  const pb = b.label.toLowerCase().startsWith(needle) ? 0 : 1;
  if (pa !== pb) return pa - pb;
  if (a.count !== b.count) return b.count - a.count;
  if (a.label.length !== b.label.length) return a.label.length - b.label.length;
  return a.label.localeCompare(b.label);
}

export function SearchSuggest({
  value,
  onChange,
  placeholder,
  items,
  limit = MAX_DEFAULT,
  className,
}: SearchSuggestProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const matches = useMemo(() => {
    const needle = value.trim().toLowerCase();
    if (!needle) return [];
    return items
      .filter((it) => it.label.toLowerCase().includes(needle))
      // 完全等于当前输入时没必要再提示它自己
      .filter((it) => it.label.toLowerCase() !== needle)
      .sort((a, b) => rank(a, b, needle))
      .slice(0, limit);
  }, [items, value, limit]);

  const show = open && matches.length > 0;
  const activeIdx = Math.min(Math.max(-1, active), matches.length - 1);

  const pick = (it: SuggestItem) => {
    onChange(it.label);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      <input
        type="search"
        className={styles.input}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, -1));
          } else if (e.key === 'Enter') {
            if (show && activeIdx >= 0) {
              e.preventDefault();
              pick(matches[activeIdx]);
            } else {
              setOpen(false);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
            setActive(-1);
          }
        }}
      />

      {show && (
        <ul className={styles.list} role="listbox">
          {matches.map((it, i) => (
            <li key={it.key}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIdx}
                className={`${styles.item} ${i === activeIdx ? styles.itemActive : ''}`}
                // 用 mousedown 阻止默认，否则 input 先失焦、浮层在 click 之前就关了
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(it)}
                onMouseEnter={() => setActive(i)}
              >
                <span className={styles.label}>{it.label}</span>
                <span className={styles.meta}>
                  <span className={styles.kind}>{it.kind}</span>
                  <span className={styles.count}>{it.count}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default SearchSuggest;

'use client';

/**
 * FigureControls.tsx — 配图的「大小」与「位置」两个滑块（v5）
 *
 * 设计来自用户的原话：
 *   · 大小：「导入时用一个 0~1 的滑块，是相对题干宽度的比值」
 *   · 位置：「让我可以选择配图的位置，靠右或者居中，或者做一个滑块直接控制」
 *
 * 两个都做成滑块（交互一致），但位置**吸附到左/中/右三档** ——
 * 打印出来的讲义里"半靠右"这种位置会显得没对齐，LaTeX 原生的三种对齐才干净。
 */

import { FIG_ALIGNS, type FigAlign } from '@/lib/types';
import styles from './FigureControls.module.css';

/** 讲义正文栏宽（A4）约 15cm —— 用来把比值换算成"纸上多宽"，老师对这个有概念 */
const LINE_WIDTH_CM = 15;

export function ratioToCm(ratio: number): string {
  return `${(ratio * LINE_WIDTH_CM).toFixed(1)}cm`;
}

export interface FigSizeSliderProps {
  /** 0~1，图片宽度占正文栏的比例 */
  value: number;
  onChange: (v: number) => void;
  /** 左侧小标题 */
  label?: string;
  disabled?: boolean;
}

/**
 * 图片大小滑块。拖动时显示「占正文栏 40% ≈ 6.0cm 宽」。
 * 宽度最终写进 `.tex` 的 `width=`，所以 PDF 和网页一起变。
 */
export function FigSizeSlider({ value, onChange, label = '大小', disabled }: FigSizeSliderProps) {
  const pct = Math.round(value * 100);
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <input
        type="range"
        min={0.05}
        max={1}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={styles.range}
        aria-label={label}
      />
      <span className={styles.value}>
        {pct}% <span className={styles.dim}>≈ {ratioToCm(value)} 宽</span>
      </span>
    </div>
  );
}

export interface FigAlignPickerProps {
  /** 当前**生效**的位置 */
  value: FigAlign;
  onChange: (v: FigAlign) => void;
  /** 点「恢复默认」时调用（清掉手动设置） */
  onReset?: () => void;
  /** 当前是不是"默认值"（而不是手动设的）—— 是的话就不显示「恢复默认」 */
  auto?: boolean;
  disabled?: boolean;
}

/**
 * 配图位置：左 / 中 / 右 三档**分段按钮**。
 *
 * 这里刻意**不用滑块**：滑块的交互含义是「连续可调」，
 * 但这个位置只有三个合法取值（对应 LaTeX 的 flushleft / center / flushright），
 * 拖到中间没有任何意义、也排不出"半靠右"。
 * 三选一就该用三个按钮 —— 一眼看清有几个选项、当前选的是哪个。
 *
 * v8：去掉了「按题型默认」那几个字（你说的）。默认值是"示意图靠右"，
 * 这件事在按钮选中态上已经看出来了，不需要再多一行字解释；
 * 只有当你手动设过、想撤回默认时才会出现「恢复默认」。
 */
export function FigAlignPicker({ value, onChange, onReset, auto, disabled }: FigAlignPickerProps) {
  const hint = (a: FigAlign) => `示意图放${a === '左' ? '左' : a === '中' ? '中' : '右'}边`;
  return (
    <div className={styles.row}>
      <span className={styles.label}>位置</span>
      <div className={styles.segmented} role="group" aria-label="配图位置">
        {FIG_ALIGNS.map((a) => (
          <button
            key={a}
            type="button"
            className={a === value ? styles.segOn : styles.segOff}
            aria-pressed={a === value}
            onClick={() => onChange(a)}
            disabled={disabled}
            title={hint(a)}
          >
            {a}
          </button>
        ))}
      </div>
      {!auto && onReset && (
        <button type="button" className={styles.linkBtn} onClick={onReset} disabled={disabled}>
          恢复默认
        </button>
      )}
    </div>
  );
}

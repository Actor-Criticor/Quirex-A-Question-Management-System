/**
 * imageConvert.ts — 图片格式统一
 *
 * xelatex 只可靠支持 png / jpg / pdf。webp、svg、bmp、gif 上传后一律转成 PNG，
 * 否则导出的讲义编译不过 —— 而"导出即可编译"是这个工具的核心承诺。
 */

import sharp from 'sharp';

export interface ConvertResult {
  buf: Buffer;
  ext: string;
  /** 是否发生了转换 */
  converted: boolean;
  note?: string;
}

/** xelatex 能直接用的格式 */
const NATIVE = new Set(['png', 'jpg', 'jpeg']);

export async function toPortableImage(
  buf: Buffer,
  originalName: string
): Promise<ConvertResult> {
  const ext = (originalName.split('.').pop() ?? '').toLowerCase();

  if (NATIVE.has(ext)) {
    return { buf, ext: ext === 'jpeg' ? 'jpg' : ext, converted: false };
  }

  const out = await sharp(buf, { density: 300 }).png().toBuffer();
  return {
    buf: out,
    ext: 'png',
    converted: true,
    note: `${ext || '未知格式'} 已转成 PNG（xelatex 不支持该格式）`,
  };
}

/**
 * seed-demo.ts — 往「题库」里灌一批 v1 格式的演示题
 *
 * 用途：给界面一个可看的数据集（题库浏览 / 预览 / 整卷 PDF / 示意图渲染）。
 * 这不是迁移工具 —— 把你自己的 v0 老库转成 v1 的是 scripts/migrate-v0.ts（第 9 步）。
 *
 * 运行：npx tsx scripts/seed-demo.ts
 * 注意：会在**当前题库**里写题，别对着你正在用的真题库跑。
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import * as service from '../src/lib/service';
import { isQidName, listQidFolders, questionDir, bankPath } from '../src/lib/paths';
import { buildAssetName, writeAsset } from '../src/lib/store';
import { composeStemTex } from '../src/lib/latexCompose';
import { resolvePathValue } from '../src/lib/config';

// 题库位置**跟应用同一套解析**（config.json > 环境变量 > 默认），别再自己拼一个路径 ——
// 否则"界面里指到 A 库、脚本却往 B 库灌"，是最难查的那种不一致。
process.env.VAULT_PATH = resolvePathValue('vaultPath');

// ============================================================
// 生成一个结构合法的最小 PDF（用于整卷演示）
// ============================================================

function buildDemoPdf(title: string): Buffer {
  const ascii = title.replace(/[^\x20-\x7E]/g, '?');
  const content =
    `BT /F1 20 Tf 56 780 Td (${ascii}) Tj ET\n` +
    `BT /F1 11 Tf 56 750 Td (Quirex demo paper, generated for UI testing.) Tj ET\n` +
    `BT /F1 11 Tf 56 730 Td (Not a real exam paper.) Tj ET`;

  const objs: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    4: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  };

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ============================================================
// 现画一张示意图 PNG（不依赖仓库里有没有现成图）
//
// 为什么需要：示意图原来是"从 <题库>/images/ 里拷一张现成的"，而那个目录在清库时
// 被删掉了 —— 于是灌出来的演示数据里**一张图都没有**：界面上看不到示意图渲染，
// 连"库里有带图题"这种断言（verify-live）都会红两条。演示数据应当自给自足，
// 所以这里手写一张 PNG（不塞 base64 —— 手写 base64 很容易弄出坏文件，libpng 直接报 IDAT 错）。
// ============================================================

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

type Rgb = [number, number, number];

/** 一张 480×320 的「坐标系 + 抛物线」示意图。 */
function makeFigurePng(w = 480, h = 320): Buffer {
  const px = Buffer.alloc(w * h * 3, 255); // 白底
  const set = (x: number, y: number, c: Rgb): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 3;
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
  };
  const line = (x0: number, y0: number, x1: number, y1: number, c: Rgb): void => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
    for (let i = 0; i <= n; i++) {
      set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
    }
  };

  const AXIS: Rgb = [90, 90, 90];
  const TICK: Rgb = [165, 165, 165];
  const CURVE: Rgb = [40, 90, 200];
  const GUIDE: Rgb = [200, 60, 60];

  const ox = 60;
  const oy = h - 50; // 原点
  line(ox, oy, w - 20, oy, AXIS); // x 轴
  line(ox, oy, ox, 20, AXIS); // y 轴
  for (const x of [140, 220, 300, 380, 440]) line(x, oy - 5, x, oy + 5, TICK);
  for (const y of [60, 120, 180, 240]) line(ox - 5, y, ox + 5, y, TICK);

  // 一条从原点附近扬起的曲线（示意图而已，不追求画得多准）
  for (let x = ox; x < w - 30; x++) {
    const t = (x - ox) / (w - 30 - ox);
    const y = Math.round(30 + (h - 100) * (1 - t) * (1 - t));
    set(x, y, CURVE);
    set(x, y + 1, CURVE);
  }
  line(400, oy, 400, 96, GUIDE); // 一条竖直辅助线

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const stride = w * 3 + 1; // 每行最前面一个 filter 字节
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    px.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ============================================================
// 演示题数据
// ============================================================
interface DemoQuestion {
  type: '单选' | '多选' | '填空' | '解答';
  source: string;
  number: number;
  /** v8：年份（演示库给个值，年份筛选才有数据可看） */
  year?: number;
  difficulty: number | '';
  knowledge: string[];
  description?: string;
  stem: string;
  options?: string[];
  answer: string;
  /** 拷一张 demo 图片当示意图 */
  figure?: { width: number; caption: string };
}

/** 整卷的演示规格 */
interface DemoPaper {
  source: string;
  difficulty: number;
  year?: number;
  description: string;
}

const DEMO: DemoQuestion[] = [
  {
    type: '单选',
    source: '25全国1',
    number: 1,
    difficulty: 0.94,
    knowledge: ['复数的实部与虚部', '复数代数形式的乘法运算'],
    description: '复数为背景的送分题，用来巩固虚部定义。',
    stem: '$(1+5\\mathrm{i})\\mathrm{i}$ 的虚部为',
    options: ['$-1$', '$0$', '$1$', '$6$'],
    answer: '因为 $(1+5i)i=i+5i^{2}=-5+i$，所以其虚部为 $1$，故选 C。',
  },
  {
    type: '单选',
    source: '25全国1',
    number: 2,
    difficulty: 0.82,
    knowledge: ['集合的交集运算', '一元二次不等式的解法'],
    description: '集合运算基础题，注意先把不等式解出来再取交集。',
    stem: '已知集合 $A=\\{x \\mid x^{2}-3x-4<0\\}$，$B=\\{x \\mid x>0\\}$，则 $A\\cap B=$',
    options: ['$(0,4)$', '$(0,1)$', '$(-1,4)$', '$(-1,0)$'],
    answer: '$x^{2}-3x-4<0 \\iff (x-4)(x+1)<0 \\iff -1<x<4$，与 $x>0$ 取交集得 $(0,4)$，故选 A。',
  },
  {
    type: '多选',
    source: '25全国1',
    number: 9,
    difficulty: 0.55,
    knowledge: ['三角函数的图象与性质', '正弦函数的单调性'],
    description: '多选题，四个选项要逐个验证，容易漏选。',
    stem: '关于函数 $f(x)=2\\sin(2x+\\dfrac{\\pi}{3})$，下列说法正确的是',
    options: [
      '最小正周期为 $\\pi$',
      '图象关于直线 $x=\\dfrac{\\pi}{12}$ 对称',
      '在 $\\left[0,\\dfrac{\\pi}{6}\\right]$ 上单调递增',
      '最大值为 $2$',
    ],
    answer: 'A 对：$T=\\dfrac{2\\pi}{2}=\\pi$。D 对：振幅为 $2$。B、C 需代入验证不成立。故选 AD。',
  },
  {
    type: '填空',
    source: '25全国1',
    number: 13,
    difficulty: 0.68,
    knowledge: ['等差数列的前n项和', '等差数列的通项公式'],
    description: '等差数列基本量运算，用通项公式列方程即可。',
    stem: '已知等差数列 $\\{a_n\\}$ 中 $a_1=1$，$a_3=5$，则 $S_{10}=$',
    answer: '公差 $d=\\dfrac{a_3-a_1}{2}=2$，故 $S_{10}=10\\times 1+\\dfrac{10\\times 9}{2}\\times 2=100$。',
  },
  {
    type: '解答',
    source: '25全国1',
    number: 16,
    difficulty: 0.48,
    knowledge: ['利用导数研究函数的单调性', '利用导数求函数的最值'],
    description: '导数常规题，第一问讨论单调性，第二问求最值。',
    stem:
      '已知函数 $f(x)=x^{3}-3x^{2}+2$。\n\n(1) 求 $f(x)$ 的单调区间；\n\n(2) 求 $f(x)$ 在区间 $[-1,3]$ 上的最大值与最小值。',
    answer:
      '$f\'(x)=3x^{2}-6x=3x(x-2)$，令 $f\'(x)=0$ 得 $x=0$ 或 $x=2$。\n\n(1) 单调递增区间为 $(-\\infty,0)$ 与 $(2,+\\infty)$，单调递减区间为 $(0,2)$。\n\n(2) 比较 $f(-1)=-2$，$f(0)=2$，$f(2)=-2$，$f(3)=2$，得最大值 $2$，最小值 $-2$。',
  },
  {
    type: '单选',
    source: '25全国2',
    number: 3,
    difficulty: 0.86,
    knowledge: ['平面向量的数量积', '向量的模'],
    description: '带示意图的向量题，注意先由垂直关系求出夹角余弦。',
    stem: '已知向量 $\\vec{a},\\vec{b}$ 满足 $|\\vec{a}|=1$，$|\\vec{b}|=2$，$\\vec{a}\\perp(\\vec{a}-\\vec{b})$，则 $|\\vec{b}|$ 与 $\\vec{a}$ 的夹角余弦值为（如图）',
    options: ['$\\dfrac{1}{2}$', '$\\dfrac{\\sqrt{3}}{2}$', '$\\dfrac{\\sqrt{2}}{2}$', '$\\dfrac{1}{3}$'],
    answer: '由 $\\vec{a}\\perp(\\vec{a}-\\vec{b})$ 得 $\\vec{a}\\cdot(\\vec{a}-\\vec{b})=0$，即 $1-1\\cdot2\\cos\\theta=0$，故 $\\cos\\theta=\\dfrac{1}{2}$，选 A。',
    figure: { width: 0.36, caption: '向量 $\\vec{a}$ 与 $\\vec{b}$ 的位置关系' },
  },
  {
    type: '填空',
    source: '25全国2',
    number: 14,
    difficulty: 0.6,
    knowledge: ['双曲线的离心率', '双曲线的简单几何性质'],
    description: '离心率题，把已知条件转化为 $a,b,c$ 的关系。',
    stem: '已知双曲线 $\\dfrac{x^{2}}{a^{2}}-\\dfrac{y^{2}}{b^{2}}=1\\ (a>0,b>0)$ 的一条渐近线斜率为 $2$，则其离心率为',
    answer: '渐近线斜率 $\\dfrac{b}{a}=2$，故 $e=\\sqrt{1+\\dfrac{b^{2}}{a^{2}}}=\\sqrt{1+4}=\\sqrt{5}$。',
  },
  {
    type: '解答',
    source: '25全国2',
    number: 17,
    difficulty: 0.42,
    knowledge: ['解三角形', '正弦定理', '余弦定理'],
    description: '解三角形综合题，两问分别用正弦定理与余弦定理。',
    stem:
      '在 $\\triangle ABC$ 中，角 $A,B,C$ 的对边分别为 $a,b,c$，且 $2a\\cos B=2c-b$。\n\n(1) 求角 $A$ 的大小；\n\n(2) 若 $a=\\sqrt{7}$，$b+c=5$，求 $\\triangle ABC$ 的面积。',
    answer:
      '(1) 由正弦定理得 $2\\sin A\\cos B=2\\sin C-\\sin B$，又 $\\sin C=\\sin(A+B)$，化简得 $\\cos A=\\dfrac{1}{2}$，故 $A=\\dfrac{\\pi}{3}$。\n\n(2) 由余弦定理 $a^{2}=b^{2}+c^{2}-bc=(b+c)^{2}-3bc=25-3bc=7$，得 $bc=6$，故 $S=\\dfrac{1}{2}bc\\sin A=\\dfrac{3\\sqrt{3}}{2}$。',
  },
  {
    type: '单选',
    source: '25海淀一模',
    number: 5,
    difficulty: 0.75,
    knowledge: ['椭圆的标准方程', '椭圆的定义'],
    description: '椭圆定义题，注意 $2a$ 与焦距的关系。',
    stem: '已知椭圆 $\\dfrac{x^{2}}{25}+\\dfrac{y^{2}}{9}=1$ 上一点 $P$ 到左焦点的距离为 $3$，则 $P$ 到右焦点的距离为',
    options: ['$3$', '$5$', '$7$', '$10$'],
    answer: '$a=5$，由椭圆定义 $|PF_1|+|PF_2|=2a=10$，故 $|PF_2|=10-3=7$，选 C。',
  },
  {
    type: '解答',
    source: '25海淀一模',
    number: 19,
    difficulty: 0.35,
    knowledge: ['直线与圆锥曲线的位置关系', '弦长问题'],
    description: '解析几何压轴，联立后注意判别式与韦达定理的使用。',
    stem:
      '已知椭圆 $C:\\dfrac{x^{2}}{4}+y^{2}=1$，直线 $l:y=kx+1$ 与 $C$ 交于 $A,B$ 两点。\n\n(1) 求 $k$ 的取值范围；\n\n(2) 若 $|AB|=\\dfrac{4\\sqrt{2}}{3}$，求 $k$ 的值。',
    answer:
      '联立得 $(1+4k^{2})x^{2}+8kx=0$。\n\n(1) 需有两个不同交点，得 $k\\neq 0$。\n\n(2) 由弦长公式 $|AB|=\\sqrt{1+k^{2}}\\cdot\\dfrac{8|k|}{1+4k^{2}}=\\dfrac{4\\sqrt{2}}{3}$，解得 $k=\\pm\\dfrac{1}{2}$。',
  },
];

/**
 * v8：补充题 —— 演示库原来只有 10 道，翻页只有一页，**看不出分页正不正常**。
 * 补到 30 道（每页 10 → 3~4 页），每道都是真算得对的常规题，不是复制改数字。
 */
const DEMO_MORE: DemoQuestion[] = [
  {
    type: '单选',
    source: '25全国1',
    number: 3,
    year: 2025,
    difficulty: 0.92,
    knowledge: ['集合的交集运算', '补集及其运算'],
    description: '集合的并集与补集，先求补集再取并。',
    stem: '已知全集 $U=\\{1,2,3,4,5\\}$，$A=\\{1,3\\}$，$B=\\{3,4,5\\}$，则 $A\\cup(\\complement_U B)=$',
    options: ['$\\{1,2,3\\}$', '$\\{1,3\\}$', '$\\{2,3\\}$', '$\\{1,2,3,4,5\\}$'],
    answer: '$\\complement_U B=\\{1,2\\}$，故 $A\\cup(\\complement_U B)=\\{1,2,3\\}$，选 A。',
  },
  {
    type: '单选',
    source: '25全国1',
    number: 4,
    year: 2025,
    difficulty: 0.88,
    knowledge: ['复数代数形式的乘法运算', '共轭复数'],
    description: '先算出 $i(1+i)$，再取共轭。注意 $i^{2}=-1$。',
    stem: '复数 $i(1+i)$ 的共轭复数为',
    options: ['$-1-i$', '$-1+i$', '$1-i$', '$1+i$'],
    answer: '$i(1+i)=i+i^{2}=-1+i$，其共轭复数为 $-1-i$，选 A。',
  },
  {
    type: '单选',
    source: '25全国2',
    number: 5,
    year: 2025,
    difficulty: 0.8,
    knowledge: ['等比数列的通项公式'],
    description: '等比数列隔项成等比，$a_5=a_3q^{2}$。',
    stem: '已知等比数列 $\\{a_n\\}$ 中 $a_1=2$，$a_3=8$，则 $a_5=$',
    options: ['$32$', '$64$', '$-32$', '$\\pm 32$'],
    answer: '由 $a_5=a_1q^{4}$，而 $q^{2}=\\dfrac{a_3}{a_1}=4$，故 $a_5=2\\times 16=32$。（$q$ 的符号不影响 $q^{4}$。）选 A。',
  },
  {
    type: '单选',
    source: '25全国2',
    number: 7,
    year: 2025,
    difficulty: 0.72,
    knowledge: ['两角和与差的正弦公式', '辅助角公式'],
    description: '凑成 $\\sqrt{2}\\sin(\\theta+45^\\circ)$ 再算。',
    stem: '$\\sin 15^\\circ+\\cos 15^\\circ=$',
    options: ['$\\dfrac{\\sqrt{6}}{2}$', '$\\dfrac{\\sqrt{3}}{2}$', '$\\dfrac{\\sqrt{2}}{2}$', '$\\dfrac{\\sqrt{6}}{4}$'],
    answer: '$\\sin 15^\\circ+\\cos 15^\\circ=\\sqrt{2}\\sin(15^\\circ+45^\\circ)=\\sqrt{2}\\sin 60^\\circ=\\dfrac{\\sqrt{6}}{2}$，选 A。',
  },
  {
    type: '单选',
    source: '25海淀一模',
    number: 6,
    year: 2025,
    difficulty: 0.7,
    knowledge: ['球的表面积', '正方体的外接球'],
    description: '正方体外接球直径 = 体对角线。',
    stem: '棱长为 $1$ 的正方体的外接球的表面积为',
    options: ['$3\\pi$', '$4\\pi$', '$6\\pi$', '$12\\pi$'],
    answer: '体对角线 $=\\sqrt{3}$，即 $2R=\\sqrt{3}$，$R=\\dfrac{\\sqrt{3}}{2}$，故 $S=4\\pi R^{2}=3\\pi$，选 A。',
  },
  {
    type: '单选',
    source: '25海淀一模',
    number: 8,
    year: 2025,
    difficulty: 0.78,
    knowledge: ['古典概型', '排列组合'],
    description: '和为奇数 = 一奇一偶，数是有限的，直接数。',
    stem: '从 $1,2,3,4$ 中任取两个不同的数，其和为奇数的概率为',
    options: ['$\\dfrac{2}{3}$', '$\\dfrac{1}{2}$', '$\\dfrac{1}{3}$', '$\\dfrac{3}{4}$'],
    answer: '两数之和为奇数需一奇一偶：$C_2^1\\times C_2^1=4$ 种，总数 $C_4^2=6$，故 $P=\\dfrac{4}{6}=\\dfrac{2}{3}$，选 A。',
  },
  {
    type: '单选',
    source: '24全国1',
    number: 4,
    year: 2024,
    difficulty: 0.66,
    knowledge: ['点到直线的距离公式', '直线与圆的位置关系'],
    description: '圆上的点到直线的最近距离 = 圆心到直线距离 − 半径。',
    stem: '圆 $x^{2}+y^{2}=4$ 上的点到直线 $3x+4y-15=0$ 的距离的最小值为',
    options: ['$1$', '$2$', '$3$', '$5$'],
    answer: '圆心 $(0,0)$ 到直线的距离 $d=\\dfrac{15}{5}=3$，半径 $r=2$，故最小距离 $=3-2=1$，选 A。',
  },
  {
    type: '单选',
    source: '24全国1',
    number: 6,
    year: 2024,
    difficulty: 0.75,
    knowledge: ['对数的运算性质'],
    description: '$\\log_3\\dfrac{1}{9}=-2$，别写成 $2$。',
    stem: '$\\log_2 8+\\log_3\\dfrac{1}{9}=$',
    options: ['$1$', '$-1$', '$5$', '$\\dfrac{1}{3}$'],
    answer: '$\\log_2 8=3$，$\\log_3\\dfrac{1}{9}=-2$，故原式 $=3-2=1$，选 A。',
  },
  {
    type: '填空',
    source: '24全国1',
    number: 13,
    year: 2024,
    difficulty: 0.62,
    knowledge: ['二项式定理', '二项展开式的通项公式'],
    description: '求常数项就是让通项里 $x$ 的指数为 $0$。',
    stem: '$\\left(x+\\dfrac{1}{x}\\right)^{6}$ 的展开式中的常数项为',
    answer: '通项 $T_{k+1}=C_6^k x^{6-k}x^{-k}=C_6^k x^{6-2k}$，令 $6-2k=0$ 得 $k=3$，故常数项为 $C_6^3=20$。',
  },
  {
    type: '填空',
    source: '24全国2',
    number: 14,
    year: 2024,
    difficulty: 0.64,
    knowledge: ['平面向量的数量积', '向量的模'],
    description: '$|a+b|^{2}=|a|^{2}+2a\\cdot b+|b|^{2}$。',
    stem: '已知 $|\\vec{a}|=3$，$|\\vec{b}|=4$，$\\vec{a}\\cdot\\vec{b}=-6$，则 $|\\vec{a}+\\vec{b}|=$',
    answer: '$|\\vec{a}+\\vec{b}|^{2}=9+2\\times(-6)+16=13$，故 $|\\vec{a}+\\vec{b}|=\\sqrt{13}$。',
  },
  {
    type: '填空',
    source: '24全国2',
    number: 15,
    year: 2024,
    difficulty: 0.7,
    knowledge: ['导数的几何意义', '导数的运算法则'],
    description: '切线斜率就是该点处的导数值。',
    stem: '曲线 $y=x^{3}$ 在点 $(1,1)$ 处的切线斜率为',
    answer: "$y'=3x^{2}$，在 $x=1$ 处 $y'=3$，故切线斜率为 $3$。",
  },
  {
    type: '填空',
    source: '25西城一模',
    number: 12,
    year: 2025,
    difficulty: 0.6,
    knowledge: ['圆的一般方程', '圆的标准方程'],
    description: '把一般方程配方成标准方程再读半径。',
    stem: '圆 $x^{2}+y^{2}-4x+2y=0$ 的半径为',
    answer: '配方得 $(x-2)^{2}+(y+1)^{2}=5$，故半径为 $\\sqrt{5}$。',
  },
  {
    type: '填空',
    source: '25西城一模',
    number: 13,
    year: 2025,
    difficulty: 0.55,
    knowledge: ['双曲线的简单几何性质'],
    description: '渐近线 $y=\\pm\\dfrac{b}{a}x$，注意是 $b$ 比 $a$。',
    stem: '双曲线 $\\dfrac{x^{2}}{9}-\\dfrac{y^{2}}{16}=1$ 的渐近线方程为',
    answer: '$a=3$，$b=4$，渐近线为 $y=\\pm\\dfrac{b}{a}x=\\pm\\dfrac{4}{3}x$。',
  },
  {
    type: '填空',
    source: '24海淀二模',
    number: 11,
    year: 2024,
    difficulty: 0.82,
    knowledge: ['等差数列的前n项和', '等差数列的通项公式'],
    description: '由 $S_n$ 求 $a_1$ 只需取 $n=1$。',
    stem: '已知等差数列 $\\{a_n\\}$ 的前 $n$ 项和 $S_n=n^{2}+n$，则 $a_1=$',
    answer: '$a_1=S_1=1+1=2$。',
  },
  {
    type: '填空',
    source: '24海淀二模',
    number: 12,
    year: 2024,
    difficulty: 0.68,
    knowledge: ['三角函数的图象与性质', '三角函数的周期性'],
    description: '$T=\\dfrac{2\\pi}{\\omega}$，与相位无关。',
    stem: '函数 $y=2\\sin\\left(2x+\\dfrac{\\pi}{6}\\right)$ 的最小正周期为',
    answer: '$\\omega=2$，故 $T=\\dfrac{2\\pi}{2}=\\pi$。',
  },
  {
    type: '填空',
    source: '25西城一模',
    number: 14,
    year: 2025,
    difficulty: 0.5,
    knowledge: ['圆锥的体积', '旋转体'],
    description: '先由母线与半径求高，再代体积公式。',
    stem: '圆锥的底面半径为 $3$，母线长为 $5$，则该圆锥的体积为',
    answer: '高 $h=\\sqrt{5^{2}-3^{2}}=4$，故 $V=\\dfrac{1}{3}\\pi r^{2}h=\\dfrac{1}{3}\\pi\\times 9\\times 4=12\\pi$。',
  },
  {
    type: '解答',
    source: '24全国1',
    number: 17,
    year: 2024,
    difficulty: 0.45,
    knowledge: ['等差数列的通项公式', '等差数列的前n项和', '含绝对值的数列求和'],
    description: '第二问要注意前 5 项为负，去绝对值要分段。',
    stem:
      '已知等差数列 $\\{a_n\\}$ 的通项公式为 $a_n=2n-11$。\n\n(1) 求 $S_n$ 的最小值及此时 $n$ 的值；\n\n(2) 求 $|a_1|+|a_2|+\\cdots+|a_{10}|$。',
    answer:
      '$a_1=-9$，$S_n=\\dfrac{n(-9+2n-11)}{2}=n^{2}-10n=(n-5)^{2}-25$。\n\n(1) 当 $n=5$ 时 $S_n$ 取最小值 $-25$。\n\n(2) $a_1,\\dots,a_5<0$，$a_6,\\dots,a_{10}>0$，故原式 $=(9+7+5+3+1)+(1+3+5+7+9)=25+25=50$。',
  },
  {
    type: '解答',
    source: '24全国2',
    number: 18,
    year: 2024,
    difficulty: 0.44,
    knowledge: ['利用导数研究函数的单调性', '利用导数求函数的最值'],
    description: '导数是 $\\ln x$，零点在 $x=1$ —— 这题的关键是别把 $f\'(x)$ 算错。',
    stem:
      '已知函数 $f(x)=x\\ln x-x$。\n\n(1) 求 $f(x)$ 的单调区间；\n\n(2) 求 $f(x)$ 在区间 $\\left[\\dfrac{1}{e},e\\right]$ 上的最小值。',
    answer:
      "$f'(x)=\\ln x+1-1=\\ln x$。\n\n(1) 当 $0<x<1$ 时 $f'(x)<0$，$f(x)$ 单调递减；当 $x>1$ 时 $f'(x)>0$，$f(x)$ 单调递增。\n\n(2) $\\left[\\dfrac{1}{e},e\\right]$ 上最小值在 $x=1$ 处取得，$f(1)=0-1=-1$。",
  },
  {
    type: '解答',
    source: '25海淀一模',
    number: 16,
    year: 2025,
    difficulty: 0.52,
    knowledge: ['余弦定理', '正弦定理'],
    description: '两问分别用余弦定理与正弦定理。',
    stem:
      '在 $\\triangle ABC$ 中，角 $A,B,C$ 的对边分别为 $a,b,c$，且 $a=3$，$b=4$，$C=\\dfrac{\\pi}{3}$。\n\n(1) 求 $c$；\n\n(2) 求 $\\sin A$。',
    answer:
      '(1) $c^{2}=a^{2}+b^{2}-2ab\\cos C=9+16-2\\times 3\\times 4\\times\\dfrac{1}{2}=13$，故 $c=\\sqrt{13}$。\n\n(2) 由 $\\dfrac{a}{\\sin A}=\\dfrac{c}{\\sin C}$ 得 $\\sin A=\\dfrac{a\\sin C}{c}=\\dfrac{3\\times\\frac{\\sqrt{3}}{2}}{\\sqrt{13}}=\\dfrac{3\\sqrt{39}}{26}$。',
  },
  {
    type: '解答',
    source: '25西城一模',
    number: 19,
    year: 2025,
    difficulty: 0.36,
    knowledge: ['抛物线的简单几何性质', '直线与抛物线的位置关系', '焦点弦'],
    description: '焦点弦长公式 $|AB|=\\dfrac{2p}{\\sin^{2}\\theta}$ 一步到位。',
    stem:
      '已知抛物线 $y^{2}=4x$ 的焦点为 $F$，过 $F$ 的直线 $l$ 与抛物线交于 $A,B$ 两点，且 $|AB|=8$。\n\n(1) 求抛物线的焦点坐标；\n\n(2) 求直线 $l$ 的方程。',
    answer:
      '(1) $2p=4$，$p=2$，焦点 $F(1,0)$。\n\n(2) 设 $l$ 的倾斜角为 $\\theta$，则 $|AB|=\\dfrac{2p}{\\sin^{2}\\theta}=\\dfrac{4}{\\sin^{2}\\theta}=8$，得 $\\sin^{2}\\theta=\\dfrac{1}{2}$，$\\tan\\theta=\\pm 1$，故 $l:y=\\pm(x-1)$。',
  },
];

// ============================================================
// v9：演示用的自定义标签
// ============================================================

/**
 * 键是「来源 第N题」，值就是挂在那道题上的自定义标签。
 *
 * 为什么不写在上面每条 DEMO 里：**绝大多数题故意不挂** ——
 * 「没设自定义标签就什么都不显示」本身就是要能一眼看出来的行为，
 * 所以只在下面这几道上挂，其余留空当对照组。
 *
 * 这里特意覆盖了四种情况：
 *   · 1 个（看列表行里的胶囊长什么样）
 *   · 5 个（上限那一档）
 *   · 超过 7 个字（看题库列表行里怎么截成 `…`：详情页显示全名）
 *   · 不挂（空）
 */
const DEMO_CUSTOM: Record<string, string[]> = {
  '25全国1 第1题': ['送分题'],
  '25全国1 第2题': ['易错'],
  '25全国1 第9题': ['多选题常错', '课堂速练'],
  // 「期中复习重点加强」8 个字 > 列表行的 7 字上限 → 列表显示「期中复习重点…」
  '25全国1 第16题': ['压轴必讲', '期中复习重点加强'],
  // 5 个 = 上限那一档
  '25全国2 第17题': ['讲过的', '待重做', '限时训练', '一题多解', '创新改编'],
  '25海淀一模 第19题': ['一模压轴', '必须掌握的七种方法'],
  '24全国2 第18题': ['导数专题'],
};

const DEMO_PAPERS: DemoPaper[] = [
  {
    source: '25全国1',
    difficulty: 0.62,
    description:
      '2025 年全国一卷完整卷。压轴题是解析几何与导数双压轴，适合高三一轮复习结束后做限时训练。整体难度中等偏上，选填偏基础、解答题梯度明显。\n\n（这份描述不设长度上限，也不会进搜索索引 —— 要找它直接按来源筛选或搜「25全国1」即可。）',
  },
  {
    source: '25全国2',
    difficulty: 0.58,
    description:
      '2025 年全国二卷完整卷。相比一卷更注重基础与计算，解三角形与立体几何位置靠前，适合用来稳固基本题型。',
  },
  // v8：补到 12 份 —— 原来只有 2 份，整卷页签根本翻不了页，
  // "分页正不正常"也就无从验证。顺便留几份**名下还没有单题**的卷子，
  // 用来演示"整卷详情里那块留白的题目区"。
  { source: '25海淀一模', difficulty: 0.6, year: 2025, description: '海淀一模完整卷，中档题占比高，适合二轮专题前的诊断。' },
  { source: '25西城一模', difficulty: 0.63, year: 2025, description: '西城一模完整卷，解析几何与导数都是常规套路，计算量偏大。' },
  { source: '24全国1', difficulty: 0.66, year: 2024, description: '2024 年全国一卷，概率统计放在解答题前列，最后一题仍是导数。' },
  { source: '24全国2', difficulty: 0.6, year: 2024, description: '2024 年全国二卷，立体几何与数列都不难，适合限时训练找手感。' },
  { source: '24海淀二模', difficulty: 0.55, year: 2024, description: '海淀二模完整卷，选填偏基础，解答题第二问开始上强度。' },
  { source: '25东城二模', difficulty: 0.52, year: 2025, description: '东城二模完整卷。（这份来源下还没有录入单题 —— 详情页会显示一块留白的题目区。）' },
  { source: '24朝阳一模', difficulty: 0.57, year: 2024, description: '朝阳一模完整卷。（这份来源下还没有录入单题。）' },
  { source: '23全国甲卷', difficulty: 0.68, year: 2023, description: '2023 年全国甲卷，难度略高，圆锥曲线那题要有耐心。' },
  { source: '23全国乙卷', difficulty: 0.64, year: 2023, description: '2023 年全国乙卷，函数与导数压轴考的是含参讨论。' },
  { source: '25浙江', difficulty: 0.61, year: 2025, description: '浙江卷完整卷，题型顺序与其他省不同，适合做适应性训练。' },
];

// ============================================================
// 主流程
// ============================================================

async function main(): Promise<void> {
  service.ensureWorkspace();

  const vault = String(process.env.VAULT_PATH || resolvePathValue('vaultPath'));
  // 题库目录问应用自己要（学科 A 那层叫「数学」）—— 不再手写 path.join(vault, '题库')
  const bank = bankPath();
  const reset = process.argv.includes('--reset');

  if (reset) {
    // 题目按设计不可删，所以"重置"只能整个目录来：删掉 _meta 与所有题目目录。
    //
    // ★ 这里**必须用 isQidName**，别再自己写一套正则 ——
    //   v9 加学科字母（AT0001 / AP001）时就是这么踩的：脚本里那两条手写正则
    //   只认 `T0001` 与 `P001`，于是 `--reset` "跑成功了"却把 24 个新目录
    //   原封不动留在库里，接着报"题库里已经有 24 道题，本脚本只在空库上运行"。
    //   id 的规则只有一处（paths.ts），这里跟着走就不会再漂。
    if (fs.existsSync(bank)) {
      for (const entry of fs.readdirSync(bank, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === '_meta' || isQidName(entry.name)) {
          fs.rmSync(path.join(bank, entry.name), { recursive: true, force: true });
        }
      }
    }
    console.log('已重置题库（删掉 _meta 与所有题目目录，含试卷）\n');
    service.ensureWorkspace();
  }

  const existing = listQidFolders();
  if (existing.length > 0) {
    console.log(`题库里已经有 ${existing.length} 道题（${existing.slice(0, 5).join(', ')}…）。`);
    console.log('为避免重复灌数据，本脚本只在空库上运行。');
    console.log('想重置成干净的演示数据：npx tsx scripts/seed-demo.ts --reset');
    process.exit(0);
  }

  const imagesDir = path.join(vault, 'images');
  const demoImages = fs.existsSync(imagesDir)
    ? fs.readdirSync(imagesDir).filter((f) => /\.(jpe?g|png)$/i.test(f))
    : [];
  let imageCursor = 0;

  console.log(`开始灌入 ${DEMO.length + DEMO_MORE.length} 道单题 + ${DEMO_PAPERS.length} 份整卷…\n`);

  // v9：自定义标签按「来源 第N题」查表；表里有但没匹配上的键要报出来
  //（写错一个字就会静默少灌一批标签，这种事必须当场发现）
  const customUsed = new Set<string>();

  for (const d of [...DEMO, ...DEMO_MORE]) {
    // 和录入页一样：结构化输入先规范化成唯一的 LaTeX 真源
    const composed = composeStemTex({ type: d.type, stem: d.stem, options: d.options });

    // v9：自定义标签（查表；没配就是空 —— 空数组会被服务端忽略，不会写进文件）
    const customKey = `${d.source} 第${d.number}题`;
    const custom = DEMO_CUSTOM[customKey] ?? [];
    if (custom.length) customUsed.add(customKey);

    const { qid, warnings } = await service.createQuestion({
      kind: '单题',
      type: d.type,
      source: d.source,
      number: d.number,
      difficulty: d.difficulty,
      knowledge: d.knowledge,
      custom,
      description: d.description,
      // v8：年份也灌上 —— 浏览页的年份 facet 得有数据才看得出筛选效果
      year: (d as { year?: number }).year ?? 2025,
      stem: composed.tex,
      answer: d.answer,
    });
    warnings.push(...composed.notes);

    // 带示意图的题：有现成的演示图就用现成的（<题库>/images/），
    // 没有就自己画一张（见上面 makeFigurePng 的说明）——
    // 两种情况都按 {qid}-fig-01 命名，正文里写 \fig 宏。
    if (d.figure) {
      const src = demoImages.length
        ? path.join(imagesDir, demoImages[imageCursor++ % demoImages.length])
        : null;
      const name = buildAssetName(qid, 'fig', 1, src ? path.extname(src).slice(1).toLowerCase() : 'png');
      writeAsset(qid, name, src ? fs.readFileSync(src) : makeFigurePng());

      const full = service.getQuestion(qid);
      const macro = `\n\n\\fig[${d.figure.width}]{images/${name}}`;
      service.writeContent(qid, 'stem', full.stem + macro);
      service.updateQuestion(qid, { figures: { [name]: d.figure.caption } });
    }

    const files = fs.readdirSync(questionDir(qid));
    console.log(
      `  ${qid}  ${d.type}  ${d.source} 第${d.number}题  难度${d.difficulty || '—'}  [${files.join(', ')}]`
    );
    if (warnings.length) console.log(`         提示：${warnings.join('；')}`);
  }

  for (const p of DEMO_PAPERS) {
    const { qid } = await service.createQuestion({
      kind: '整卷',
      source: p.source,
      difficulty: p.difficulty,
      description: p.description,
      year: (p as { year?: number }).year ?? 2025,
      pdf: {
        paper: buildDemoPdf(`${p.source} - QUESTIONS`),
        answer: buildDemoPdf(`${p.source} - ANSWERS`),
      },
    });
    console.log(`  ${qid}  整卷  ${p.source}  难度${p.difficulty}  [题目.pdf, 答案.pdf]`);
  }

  const missed = Object.keys(DEMO_CUSTOM).filter((k) => !customUsed.has(k));
  if (missed.length) {
    throw new Error(
      `DEMO_CUSTOM 里这些键没有匹配到任何题目（来源或题号写错了？）：${missed.join('、')}`
    );
  }

  const vocab = service.listTags(true);
  console.log('\n标签表：');
  console.log(`  来源 ${vocab.source.length} 个：${vocab.source.map((t) => `${t.name}(${t.count})`).join('  ')}`);
  console.log(`  知识点 ${vocab.knowledge.length} 个：${vocab.knowledge.map((t) => `${t.name}(${t.count})`).join('  ')}`);
  console.log(`  自定义 ${vocab.custom.length} 个：${vocab.custom.map((t) => `${t.name}(${t.count})`).join('  ')}`);
  const withoutCustom = service
    .searchQuestions({ kind: '单题', status: '全部', size: 500 })
    .items.filter((e) => !(e.custom ?? []).length).length;
  console.log(`  （其中 ${withoutCustom} 道题没有自定义标签 —— 那些题的列表行里不该出现任何痕迹）`);

  const idx = service.searchQuestions({ status: '全部', size: 500 });
  console.log(`\n索引共 ${idx.total} 条。完成。`);
}

main().catch((e) => {
  console.error('灌数据失败：', e);
  process.exit(1);
});

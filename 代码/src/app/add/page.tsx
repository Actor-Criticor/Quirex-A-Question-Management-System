'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { QuestionBody } from '@/components/LatexContent';
import { FigAlignPicker, FigSizeSlider } from '@/components/FigureControls';
import {
  buildImageMacro,
  composeAnswer,
  composeStemTex,
  imageMarker,
  replaceImageMarkers,
  splitOptionsFromStem,
} from '@/lib/latexCompose';
import { checkImageRefs, lintLatex, type LintWarning } from '@/lib/latexSubset';
import { renderLatex } from '@/lib/latexRender';
import {
  difficultyToBand,
  validateChoiceOptions,
  validateCustomTags,
  validateKnowledgeCount,
} from '@/lib/validate';
import type { FigAlign, ImageChannel, QuestionType, TagItem } from '@/lib/types';
import {
  CUSTOM_TAG_LEN_MAX,
  CUSTOM_TAG_MAX,
  KNOWLEDGE_MAX,
  currentYear,
  displayQid,
  resolveFigAlign,
} from '@/lib/types';
import styles from './page.module.css';

const TYPES = ['单选', '多选', '填空', '解答'] as const;
type TypeChoice = (typeof TYPES)[number];
type KindChoice = TypeChoice | '整卷';

interface Pending {
  id: number;
  file: File;
  url: string;
  channel: ImageChannel;
  asFigure: boolean;
  width: number;
  /**
   * v5：这张图被插在**第几个选项**里（数字），或插在题干/答案正文里（'stem'/'answer'）。
   * 用它区分「选项图」和「整题图 / 行内图」—— 两类排版需求完全相反，
   * 但走的是同一个通道、同一个宏，只能靠**插在哪儿**来判断。
   */
  target: 'stem' | 'answer' | number;
  /** 预览时用的假文件名（真实文件名要等入库拿到 qid 才知道） */
  label: string;
}

const CHANNEL_BUTTONS: Array<{ channel: ImageChannel; asFigure: boolean; label: string; title: string }> = [
  { channel: 'stem', asFigure: false, label: '题干图', title: '题干本身就是一张图（整题截图 / 图形选项）——行内插入' },
  { channel: 'fig', asFigure: true, label: '示意图', title: '题干的配图（立体几何图形等）——居中、带「图N」编号' },
  { channel: 'ans', asFigure: false, label: '答案图', title: '答案本身就是一张图——行内插入' },
  { channel: 'ansfig', asFigure: true, label: '答案示意图', title: '答案的配图（辅助线图等）——居中、带「图N」编号' },
];

export default function AddPage() {
  const [choice, setChoice] = useState<KindChoice | null>(null);

  // ---- 单题内容 ----
  const [stem, setStem] = useState('');
  const [options, setOptions] = useState(['', '', '', '']);
  const [letters, setLetters] = useState<string[]>([]);
  const [detail, setDetail] = useState('');

  // ---- 元数据 ----
  const [source, setSource] = useState('');
  const [number, setNumber] = useState('');
  const [difficulty, setDifficulty] = useState('');
  /** v2：创新标记（可选）。**只有单题能标**，整卷分支不渲染这个控件 */
  const [innovation, setInnovation] = useState(false);
  /** v3：年份（单题与整卷都有，可选） */
  const [year, setYear] = useState('');
  /**
   * v5：配图位置。null = 没手动设过（按题型推导），设过就是左/中/右。
   * 存在 meta.figAlign，不写进 .tex —— 改位置不用重写内容。
   */
  const [figAlign, setFigAlign] = useState<FigAlign | null>(null);
  const [knowledge, setKnowledge] = useState<string[]>([]);
  /** v9：自定义标签（与知识点同构，上限 5 个、每个最长 20 字） */
  const [custom, setCustom] = useState<string[]>([]);
  const [description, setDescription] = useState('');

  // ---- 图片 ----
  const [images, setImages] = useState<Pending[]>([]);
  /** v5：选项图默认大小（四张一行大致是 0.2）；改它会一起改掉已有的选项图 */
  const [optionImgWidth, setOptionImgWidth] = useState(0.2);
  const [pendingChannel, setPendingChannel] = useState<{
    channel: ImageChannel;
    asFigure: boolean;
    target: 'stem' | 'answer' | number;
  } | null>(null);

  // ---- 整卷 ----
  const [paper, setPaper] = useState<File | null>(null);
  const [answerPdf, setAnswerPdf] = useState<File | null>(null);

  // ---- 其它 ----
  const [continuous, setContinuous] = useState(false);
  const [vocab, setVocab] = useState<{
    source: TagItem[];
    knowledge: TagItem[];
    custom: TagItem[];
  } | null>(null);
  const [knowledgeInput, setKnowledgeInput] = useState('');
  /** v9：自定义标签的输入框（与知识点各一份，互不干扰） */
  const [customInput, setCustomInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dup, setDup] = useState<string | null>(null);
  const [preview, setPreview] = useState(true);

  const stemRef = useRef<HTMLTextAreaElement>(null);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  const isChoiceType = choice === '单选' || choice === '多选';
  const isSingle = choice !== null && choice !== '整卷';

  /**
   * v9：学科。
   *   subjects    —— 全部学科（顶栏那个注册表）
   *   targetSubject —— **这一次录到哪个**（默认当前学科）
   * 切它只影响"录到哪儿"和标签联想，不改当前学科。
   */
  const [subjects, setSubjects] = useState<
    Array<{ id: string; name: string; count: number; active: boolean }>
  >([]);
  const [activeSubject, setActiveSubject] = useState('');
  const [targetSubject, setTargetSubject] = useState('');

  /** 难度输入实时算出的档位（基础 / 压轴 / 困难），用来给录入者即时反馈 */
  const bandPreview = useMemo(() => {
    const n = parseFloat(difficulty);
    return Number.isFinite(n) ? difficultyToBand(n) : null;
  }, [difficulty]);

  /**
   * v7：整卷录入时填的来源名是否已经存在。
   * 只做**提示**、不阻止 —— 一份来源下有多份卷子是正常的（比如"25全国1"的甲卷乙卷）。
   * 但"同名"也常常是手滑（想打 25全国2 结果打成已有的），所以要让人看见。
   */
  const sourceExists = useMemo(() => {
    const s = source.trim();
    if (choice !== '整卷' || !s) return false;
    return (vocab?.source ?? []).some((t) => t.name === s);
  }, [choice, source, vocab]);

  // 学科列表（读一次；录入页只是"选一个目标"，不在这里建/切学科）
  useEffect(() => {
    fetch('/api/subjects', { cache: 'no-store' })
      .then((r) => r.json())
      .then(
        (d: {
          active?: string;
          subjects?: Array<{ id: string; name: string; count: number; active: boolean }>;
        }) => {
          if (!Array.isArray(d.subjects) || d.subjects.length === 0) return;
          setSubjects(d.subjects);
          setActiveSubject(d.active ?? d.subjects[0].id);
          setTargetSubject((prev) => prev || d.active || d.subjects![0].id);
        }
      )
      .catch(() => {
        /* 读不到就当单学科（输入仍然能用） */
      });
  }, []);

  // 标签表（联想用）—— v9：**跟着目标学科走**（切学科就重取那一科的词表）
  useEffect(() => {
    const url = targetSubject ? `/api/tags?subject=${encodeURIComponent(targetSubject)}` : '/api/tags';
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setVocab(d.vocab))
      .catch(() => setVocab(null));
  }, [targetSubject]);

  // 查重：同「来源 + 题号」是否已存在
  // 注意：setState 只在定时器回调里调用（在 effect 体里同步 setState 会触发级联渲染）
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      if (!isSingle || !source.trim() || !number.trim()) {
        if (alive) setDup(null);
        return;
      }
      const want = parseInt(number.replace(/\D/g, ''), 10);
      if (!Number.isInteger(want)) {
        if (alive) setDup(null);
        return;
      }
      try {
        const sp = new URLSearchParams();
        sp.set('source', source.trim());
        sp.set('numMin', String(want));
        sp.set('numMax', String(want));
        sp.set('status', '全部');
        // v9：查重也要查**目标学科** —— 录到化学却拿数学的库查重，
        // 既会漏报（化学里已有第 1 题）又会误报（数学里那道）
        if (targetSubject) sp.set('subject', targetSubject);
        const res = await fetch(`/api/questions/search?${sp.toString()}`, { cache: 'no-store' });
        const d = await res.json();
        if (!alive) return;
        /*
         * 这里**自己在客户端再核一遍题号**，不只信接口。
         * 原因：接口层曾经漏读 numMin/numMax（真事，已修），
         * 于是条件被静默丢弃 → 只要来源用过就报重复、且报的永远是同一道题。
         * 查重是个"提示"，宁可它少报一次，也不能乱报 —— 所以加这道本地校验兜底。
         */
        const hit = (d.items ?? []).find(
          (e: { number?: number; source?: string }) =>
            e.number === want && e.source === source.trim()
        );
        setDup(hit ? `${displayQid(hit.qid)}（${(hit as { type?: string }).type ?? ''}）` : null);
      } catch {
        if (alive) setDup(null);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [source, number, isSingle, targetSubject]);

  // ============================================================
  // 图片
  // ============================================================

  const insertAtCursor = useCallback(
    (target: 'stem' | 'answer' | number, text: string) => {
      if (typeof target === 'number') {
        setOptions((prev) => prev.map((o, i) => (i === target ? o + text : o)));
        return;
      }
      const ref = target === 'stem' ? stemRef : answerRef;
      const el = ref.current;
      if (!el) {
        if (target === 'stem') setStem((s) => s + text);
        else setDetail((s) => s + text);
        return;
      }
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const next = el.value.slice(0, start) + text + el.value.slice(end);

      if (target === 'stem') setStem(next);
      else setDetail(next);

      requestAnimationFrame(() => {
        el.focus();
        const pos = start + text.length;
        el.setSelectionRange(pos, pos);
      });
    },
    []
  );

  /**
   * 点通道按钮 → 记下"这张图属于哪个通道、插到哪"，然后打开文件选择器。
   * 不用 useEffect 触发（那样会因为回调身份变化而反复弹窗）；直接同步调用，
   * pendingChannel 会在用户选完文件之前落到 state 上。
   */
  const pickImage = useCallback(
    (channel: ImageChannel, asFigure: boolean, target: 'stem' | 'answer' | number) => {
      setPendingChannel({ channel, asFigure, target });
      fileRef.current?.click();
    },
    []
  );

  /** 选图 → 加进待入库列表 → 在光标处插入 [[img:N]] */
  const handleFilePicked = useCallback(
    (file: File) => {
      if (!pendingChannel) return;
      const id = nextId.current++;
      const index = images.length;
      const url = URL.createObjectURL(file);

      // v5：默认大小按「这张图在排版里扮演什么角色」定，而不是一刀切：
      //   · 选项图（插到某个选项里）→ 小，四张才排得下一行
      //   · 示意图（\fig）→ 0.4
      //   · 整题图（题干/答案本身就是一张图）→ 满栏，因为它就是题面
      //   其余（正文里跟文字混排的行内图）→ 小
      const isOptionImg = typeof pendingChannel.target === 'number';
      const defaultWidth = isOptionImg
        ? optionImgWidth
        : pendingChannel.asFigure
          ? 0.4
          : 1;

      setImages((prev) => [
        ...prev,
        {
          id,
          file,
          url,
          channel: pendingChannel.channel,
          asFigure: pendingChannel.asFigure,
          width: defaultWidth,
          target: pendingChannel.target,
          label: `pending-${index}.png`,
        },
      ]);
      insertAtCursor(pendingChannel.target, imageMarker(index));
      setPendingChannel(null);
    },
    [images.length, insertAtCursor, pendingChannel, optionImgWidth]
  );

  /**
   * v5：选项图大小 —— 整题一个滑块（不给 4 个选项各一个，太碎）。
   * 改的时候把已有的选项图**一起**改掉，这样几张必然等大。
   */
  const setAllOptionImageWidth = (w: number) => {
    setOptionImgWidth(w);
    setImages((prev) => prev.map((im) => (typeof im.target === 'number' ? { ...im, width: w } : im)));
  };

  /** 当前题里有没有选项图（有才显示那个滑块） */
  const optionImgCount = images.filter((im) => typeof im.target === 'number').length;

  /** 删图：同时把正文里的标记删掉，并把后面的标记整体重编号 */
  const removeImage = useCallback((id: number) => {
    setImages((prev) => {
      const i = prev.findIndex((im) => im.id === id);
      if (i < 0) return prev;

      const remap = (text: string) =>
        text.replace(/\[\[img:(\d+)\]\]/g, (_, n: string) => {
          const old = parseInt(n, 10);
          if (old === i) return '';
          return imageMarker(old > i ? old - 1 : old);
        });

      setStem(remap);
      setDetail(remap);
      setOptions((opts) => opts.map(remap));

      const rest = prev.filter((im) => im.id !== id);
      // 重新生成预览用的假文件名，保证与新的下标一一对应
      return rest.map((im, idx) => ({ ...im, label: `pending-${idx}.png` }));
    });
  }, []);

  const setImageWidth = (id: number, width: number) =>
    setImages((prev) => prev.map((im) => (im.id === id ? { ...im, width } : im)));

  // ============================================================
  // 预览 / lint
  // ============================================================

  const previewModel = useMemo(() => {
    if (!isSingle || !choice) return null;
    const composed = composeStemTex({ type: choice as TypeChoice, stem, options });
    const macros = images.map((im) => buildImageMacro(im.label, im.asFigure, im.width));
    return {
      stemTex: replaceImageMarkers(composed.tex, macros),
      answerTex: replaceImageMarkers(composeAnswer(letters, detail), macros),
      notes: composed.notes,
    };
  }, [choice, stem, options, letters, detail, images, isSingle]);

  const urlByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const im of images) m.set(im.label, im.url);
    return m;
  }, [images]);

  const lint = useMemo(() => {
    if (!previewModel) return [];
    const files = new Set(images.map((im) => im.label));
    /*
     * v10：**把渲染期的问题也算进拦截条件**。
     *
     * 原来这里只跑 lintLatex（白名单检查）+ 图片存在性 —— 而公式里的宏是
     * 交给 KaTeX 的、不查。于是 `\begin{case}`（少个 s）、`\foo{x}` 这类
     * 拼错的公式能一路存进库，直到详情页才发现"渲染不出来"。
     * 现在把 KaTeX 真正渲染一遍，它报的问题按**错误**计，直接不许入库 ——
     * 你说的"录入时如果出现问题不允许录入"就落到这里。
     */
    const opts = { qid: 'preview', existingFiles: files };
    const renderProblems = [
      ...renderLatex(previewModel.stemTex, opts).problems.map((m) => `题干：${m}`),
      ...renderLatex(previewModel.answerTex, opts).problems.map((m) => `答案：${m}`),
    ].map((message): LintWarning => ({ level: 'error', message }));

    return [
      ...lintLatex(previewModel.stemTex, '题干'),
      ...lintLatex(previewModel.answerTex, '答案'),
      ...checkImageRefs(previewModel.stemTex, files),
      ...checkImageRefs(previewModel.answerTex, files),
      ...renderProblems,
    ];
  }, [previewModel, images]);

  const lintErrors = lint.filter((w) => w.level === 'error');

  // v5：配图位置 —— 手动设过就用设的，否则按题型推导（解答题靠右）
  const autoAlign = resolveFigAlign(choice && choice !== '整卷' ? (choice as QuestionType) : undefined);
  const resolvedAlign: FigAlign = figAlign ?? autoAlign;

  // ============================================================
  // 入库
  // ============================================================

  const resetForNext = () => {
    setStem('');
    setOptions(['', '', '', '']);
    setLetters([]);
    setDetail('');
    setDescription('');
    setImages([]);
    // 创新是「每一道题各自的属性」，不能带给下一题。
    // （来源/难度/知识点/年份是一套卷子共有的，所以保留。）
    setInnovation(false);
    if (number.trim()) {
      const n = parseInt(number.replace(/\D/g, ''), 10);
      if (Number.isInteger(n) && n < 30) setNumber(String(n + 1));
      else setNumber(number);
    }
  };

  /**
   * 报错时**把视图拉回最上面**（v10）。
   *
   * 报警横幅挂在页面顶部，而录入页很长：站在最下面的「描述/自定义标签」那儿点入库，
   * 报错出现在顶上你看不见 —— 表现就是"点了没反应"。
   * 所以凡是"要拦下这次录入"的报错，都走这个函数：先报错，再把视角带上去。
   *
   * ⚠️ 这里必须调 `setError`。当初批量把校验里的 `setError(` 换成 `fail(` 时，
   * 这一行也被顺手换掉了 —— 于是 fail 调 fail，一点入库就
   * `RangeError: Maximum call stack size exceeded`，报错横幅反而**永远不出现**
   * （浏览器套件当场抓到）。改这类批量替换时，替换函数自己的实现要排除在外。
   */
  const fail = (msg: string) => {
    setError(msg);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleSave = async () => {
    if (!choice) return;
    setBusy(true);
    setError('');
    setMessage('');
    setWarnings([]);

    try {
      const fd = new FormData();
      fd.set('kind', choice === '整卷' ? '整卷' : '单题');
      if (choice !== '整卷') fd.set('type', choice);
      if (source.trim()) fd.set('source', source.trim());
      if (difficulty.trim()) fd.set('difficulty', difficulty.trim());
      if (description.trim()) fd.set('description', description.trim());
      // v3：年份（单题与整卷都发；留空就不发，服务端按未录入处理）
      if (year.trim()) fd.set('year', year.trim());
      // v2/v3：创新标记 —— **只有单题**。整卷分支根本不渲染这个控件，
      // 这里再挡一道，服务端还有第三道兜底。
      if (innovation && choice !== '整卷') fd.set('innovation', 'true');
      // v5：配图位置（只发手动设过的；没设就让服务端按题型推导）
      if (figAlign && choice !== '整卷') fd.set('figAlign', figAlign);
      // v9：录到哪个学科（不传 = 当前学科；服务端会用它包住"占号 + 写文件"整段）
      if (targetSubject) fd.set('subject', targetSubject);

      if (choice === '整卷') {
        if (!paper) {
          fail('整卷必须上传题目 PDF');
          setBusy(false);
          return;
        }
        // v7：整卷本身就是一份来源，没有来源的卷子没法"按来源看它名下的题"，
        // 所以这里必填（服务端仍然容错 —— 库里已有的老卷子可能没有来源）
        if (!source.trim()) {
          fail('整卷必须填「来源名称」—— 整卷本身就是一份来源，它名下的题目靠它串起来。');
          setBusy(false);
          return;
        }
        fd.set('paper', paper);
        if (answerPdf) fd.set('answer', answerPdf);
      } else {
        if (!stem.trim()) {
          fail('题干不能为空');
          setBusy(false);
          return;
        }
        // v8：选择题至少 3 个选项。以前四个全空也能存 ——
        // 出来的是一道"没有选项的单选题"，事后很难看出是漏填还是故意。
        if (choice === '单选' || choice === '多选') {
          const optErr = validateChoiceOptions(options);
          if (optErr) {
            fail(optErr);
            setBusy(false);
            return;
          }
        }
        // v8：知识点上限
        const kErr = validateKnowledgeCount(knowledge);
        if (kErr) {
          fail(kErr);
          setBusy(false);
          return;
        }
        // v9：自定义标签的两条上限（数量 + 单个长度）
        const cErr = validateCustomTags(custom);
        if (cErr) {
          fail(cErr);
          setBusy(false);
          return;
        }
        if (number.trim()) fd.set('number', number.trim());
        // 题干与选项都发原始文本，由服务端统一规范化（避免二次组合）
        fd.set('stem', stem);
        ['A', 'B', 'C', 'D'].forEach((L, i) => {
          if (options[i].trim()) fd.set(`option${L}`, options[i]);
        });
        const ans = composeAnswer(letters, detail);
        if (ans) fd.set('answer', ans);
        knowledge.forEach((k) => fd.append('knowledge', k));
        // v9：自定义标签也按多值发（服务端 fd.getAll('custom')）
        custom.forEach((k) => fd.append('custom', k));

        // 待入库图片：顺序必须与正文里的 [[img:N]] 一致
        if (images.length) {
          fd.set(
            'imageMeta',
            JSON.stringify(
              images.map((im) => ({
                channel: im.channel,
                asFigure: im.asFigure,
                width: im.width,
                name: im.file.name,
              }))
            )
          );
          images.forEach((im, i) => fd.set(`img${i}`, im.file, im.file.name));
        }
      }

      const res = await fetch('/api/questions', { method: 'POST', body: fd });
      const d = await res.json();
      if (!res.ok || d.error) {
        fail(d.hint ? `${d.error}\n\n${d.hint}` : d.error || `入库失败（HTTP ${res.status}）`);
        return;
      }

      setWarnings(d.warnings ?? []);
      setMessage(
        // v9：录到别的学科时说清"录到哪儿"了 —— 否则在化学里录完，
        // 回当前学科（数学）怎么也找不到这道题
        targetSubject && targetSubject !== activeSubject
          ? `✅ 已入库到「${subjects.find((s) => s.id === targetSubject)?.name}」，qid = ${displayQid(d.qid)}`
          : `✅ 已入库，qid = ${displayQid(d.qid)}`
      );
      if (previewModel?.notes.length) setWarnings((w) => [...w, ...previewModel.notes]);
      images.forEach((im) => URL.revokeObjectURL(im.url));

      if (continuous && choice !== '整卷') {
        resetForNext();
      } else {
        setChoice(null);
        setStem('');
        setOptions(['', '', '', '']);
        setLetters([]);
        setDetail('');
        setDescription('');
        setImages([]);
        setPaper(null);
        setAnswerPdf(null);
        // v3：整轮录入结束，元数据也一起清干净
        setInnovation(false);
        setYear('');
        setFigAlign(null);
        // v9：自定义标签也要清 —— 不清的话下一道题会莫名其妙带着上一道的标签
        setCustom([]);
        setCustomInput('');
      }
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addKnowledge = (name: string) => {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    // v8：上限 8 个。在这里就拦住并说明，比等到点入库才报错好 ——
    // 打第 9 个的时候人就该知道，而不是录完一整道题才发现。
    if (!knowledge.includes(clean) && knowledge.length >= KNOWLEDGE_MAX) {
      fail(`知识点最多 ${KNOWLEDGE_MAX} 个 —— 挂太多就分不出层次了。先删掉一个再加。`);
      return;
    }
    setKnowledge((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
    setKnowledgeInput('');
    // 加成功了就把上一条报错收掉 —— 否则"撞过上限→删掉一个→加成功"之后，
    // 那条红字还挂在那儿，看起来像是这次也失败了（v9 实测发现的）
    setError('');
  };

  /**
   * v9：加一个自定义标签。
   * 上限与长度**当场拦**（和"知识点最多 8 个"同一个理由：打的时候就说，
   * 别等录完一整道题点入库才报错）。服务端还有一道，两边同一个判据。
   */
  const addCustom = (name: string) => {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    if (clean.length > CUSTOM_TAG_LEN_MAX) {
      fail(`自定义标签最长 ${CUSTOM_TAG_LEN_MAX} 个字（「${clean}」有 ${clean.length} 个字）`);
      return;
    }
    if (!custom.includes(clean) && custom.length >= CUSTOM_TAG_MAX) {
      fail(`自定义标签最多 ${CUSTOM_TAG_MAX} 个。先删掉一个再加。`);
      return;
    }
    setCustom((prev) => (prev.includes(clean) ? prev : [...prev, clean]));
    setCustomInput('');
    setError('');
  };

  // ============================================================
  // 渲染
  // ============================================================

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>录入题目</h1>

      {/*
        v9：先选学科、再选类型（你说的「录入时先选择录入到哪个学科，
        再选择对应学科里有的标签」）。
        默认就是当前学科 —— 不切学科的时候这一栏等于一个说明。
        选了别的学科**不会改当前学科**，只是这一次录到那边去
        （否则录完还得切回来，白跑一趟）。
      */}
      {subjects.length > 0 && (
        <section className="ma-card">
          <div className={styles.stepTitle}>
            <span className={styles.stepNo}>1</span> 录入到哪个学科
          </div>
          <div className={styles.subjectRow}>
            {subjects.map((s) => (
              <button
                key={s.id}
                className={targetSubject === s.id ? 'active' : ''}
                onClick={() => setTargetSubject(s.id)}
                disabled={busy}
                title={`${s.name}（${s.count} 条记录）`}
              >
                {s.name}
                {s.active && <span className={styles.currentMark}>当前</span>}
              </button>
            ))}
            {targetSubject !== activeSubject && (
              <span className={styles.subjectHint}>
                这次录进「{subjects.find((s) => s.id === targetSubject)?.name}」，
                当前学科仍是「{subjects.find((s) => s.id === activeSubject)?.name}」。
                下面的标签联想来自目标学科。
              </span>
            )}
          </div>
        </section>
      )}

      {/* ---------- 第二步：选类型 ---------- */}
      <section className="ma-card">
        <div className={styles.stepTitle}>
          <span className={styles.stepNo}>{subjects.length > 0 ? 2 : 1}</span> 选择录入类型
        </div>
        <div className={styles.typeRow}>
          {TYPES.map((t) => (
            <button
              key={t}
              className={choice === t ? 'active' : ''}
              onClick={() => setChoice(t)}
              disabled={busy}
            >
              {t}
            </button>
          ))}
          <span className={styles.divider} />
          <button
            className={choice === '整卷' ? 'active' : ''}
            onClick={() => setChoice('整卷')}
            disabled={busy}
          >
            整卷
          </button>
        </div>
      </section>

      {message && <div className={styles.ok}>{message}</div>}
      {error && <div className={styles.err}>{error}</div>}
      {warnings.length > 0 && (
        <div className={styles.warn}>
          {warnings.map((w, i) => (
            <div key={i}>· {w}</div>
          ))}
        </div>
      )}

      {choice === null && <div className={`ma-card ${styles.pickFirst}`}>先选一个录入类型。</div>}

      {/* ---------- 整卷表单 ---------- */}
      {choice === '整卷' && (
        <section className="ma-card">
          <div className={styles.stepTitle}>
            <span className={styles.stepNo}>2</span> 上传 PDF
          </div>
          <div className={styles.pdfRow}>
            <label className={styles.pdfPick}>
              <span>题目 PDF（必填）</span>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setPaper(e.target.files?.[0] ?? null)}
              />
              {paper && <span className={styles.fileName}>{paper.name}</span>}
            </label>
            <label className={styles.pdfPick}>
              <span>答案 PDF（可选）</span>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setAnswerPdf(e.target.files?.[0] ?? null)}
              />
              {answerPdf && <span className={styles.fileName}>{answerPdf.name}</span>}
            </label>
          </div>

          <div className={styles.stepTitle} style={{ marginTop: '1rem' }}>
            <span className={styles.stepNo}>3</span> 元数据
          </div>
          <div className={styles.metaGrid}>
            {/* v7：整卷**本身就是一份来源**，所以这里不是"从已有来源里挑一个"，
                而是"给它起一个来源名"。故意**不给联想下拉** —— 联想会让人下意识
                从旧名单里选，而这一步的语义是新建。同名的来源会被复用（提示在下面）。 */}
            <MetaField label="来源名称（新建）">
              <input
                type="text"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="25全国1"
              />
            </MetaField>
            <MetaField label="难度（0.01–0.99）">
              <input
                type="text"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value)}
                placeholder="0.62"
              />
            </MetaField>
            {/* v3：年份（整卷也录）。v8：上限是**今年** —— 标签里直接写出来，
                免得录完才发现被拦。 */}
            <MetaField label={`年份（1900–${currentYear()}）`}>
              <input
                type="text"
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder={String(currentYear())}
              />
            </MetaField>
            <MetaField label="描述" wide>
              <textarea
                rows={5}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="输入描述"
              />
            </MetaField>
          </div>

          {/* v10：整卷=来源 的那句说明去掉了（你说多余）。
              保留"重名"那条提示 —— 那是**当场反馈**，不是说明书。 */}
          {sourceExists && (
            <div className={styles.sourceDup}>
              「{source.trim()}」这个来源已经存在 —— 这份卷子会归到它名下（一份来源有多份卷子是正常的）。
            </div>
          )}
        </section>
      )}

      {/* ---------- 单题表单 ---------- */}
      {isSingle && (
        <>
          <section className="ma-card">
            <div className={styles.stepTitle}>
              <span className={styles.stepNo}>2</span> 题干
            </div>
            <textarea
              ref={stemRef}
              className={styles.stemInput}
              rows={6}
              value={stem}
              onChange={(e) => setStem(e.target.value)}
              placeholder="粘贴题干"
            />
            <div className={styles.rowOps}>
              <button
                onClick={() => {
                  const split = splitOptionsFromStem(stem);
                  if (!split) {
                    fail('题干里没找到 A．B．C．D． 这样的选项行');
                    return;
                  }
                  setError('');
                  setStem(split.stem);
                  const next = ['', '', '', ''];
                  split.options.forEach((o, i) => {
                    if (i < 4) next[i] = o;
                  });
                  setOptions(next);
                }}
                disabled={!isChoiceType || busy}
              >
                从题干里自动拆出选项
              </button>
              {choice === '填空' && (
                <button onClick={() => insertAtCursor('stem', ' \\fillin ')} disabled={busy}>
                  插入填空横线
                </button>
              )}
              {isChoiceType && (
                <button onClick={() => insertAtCursor('stem', ' \\pick ')} disabled={busy}>
                  插入空括号
                </button>
              )}
              {/* v5b：图片按钮跟着「你在写的地方」走 ——
                  题干这边就放题干要用的两种图，不用再滚到页面底部的图片区去找。 */}
              {CHANNEL_BUTTONS.filter((c) => c.channel === 'stem' || c.channel === 'fig').map((c) => (
                <button
                  key={c.channel}
                  title={c.title}
                  onClick={() => pickImage(c.channel, c.asFigure, 'stem')}
                  disabled={busy}
                >
                  ＋ {c.label}
                </button>
              ))}
            </div>
          </section>

          {isChoiceType && (
            <section className="ma-card">
              <div className={styles.stepTitle}>
                <span className={styles.stepNo}>3</span> 选项
              </div>
              {['A', 'B', 'C', 'D'].map((L, i) => (
                <div key={L} className={styles.optionRow}>
                  <span className={styles.optionLabel}>{L}</span>
                  <input
                    type="text"
                    value={options[i]}
                    onChange={(e) => setOptions((p) => p.map((o, j) => (j === i ? e.target.value : o)))}
                    placeholder={`选项 ${L}`}
                  />
                  <button
                    className={styles.miniBtn}
                    title="给这个选项插一张图（图形选项）"
                    onClick={() => pickImage('stem', false, i)}
                    disabled={busy}
                  >
                    ＋
                  </button>
                </div>
              ))}

              {/* v5：选项图大小 —— 图形选项（A/B/C/D 各一张小图）单独处理：
                  一个滑块管整题，改一下几张一起变，必然是等大的。
                  它不是「配图」而是选项本身的内容，所以尺寸规则跟示意图分开。 */}
              {optionImgCount > 0 && (
                <div className={styles.posRow}>
                  <FigSizeSlider
                    label={`选项图（${optionImgCount} 张）`}
                    value={optionImgWidth}
                    onChange={setAllOptionImageWidth}
                    disabled={busy}
                  />
                </div>
              )}
            </section>
          )}

          <section className="ma-card">
            <div className={styles.stepTitle}>
              <span className={styles.stepNo}>{isChoiceType ? 4 : 3}</span> 答案
            </div>
            {isChoiceType && (
              <div className={styles.rowOps}>
                <span className={styles.hint}>{choice === '多选' ? '可多选' : ''}</span>
                {['A', 'B', 'C', 'D'].map((L) => (
                  <button
                    key={L}
                    className={letters.includes(L) ? 'active' : ''}
                    onClick={() =>
                      setLetters((prev) =>
                        choice === '单选'
                          ? [L]
                          : prev.includes(L)
                            ? prev.filter((x) => x !== L)
                            : [...prev, L]
                      )
                    }
                    disabled={busy}
                  >
                    {L}
                  </button>
                ))}
                {letters.length > 0 && (
                  <button onClick={() => setLetters([])} disabled={busy}>
                    清除
                  </button>
                )}
              </div>
            )}
            <textarea
              ref={answerRef}
              className={styles.stemInput}
              rows={isChoiceType ? 3 : 5}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder={isChoiceType ? '详解' : '答案'}
            />
            {/* v5b：答案这边放答案要用的两种图（同样不用滚下去找） */}
            <div className={styles.rowOps}>
              {CHANNEL_BUTTONS.filter((c) => c.channel === 'ans' || c.channel === 'ansfig').map((c) => (
                <button
                  key={c.channel}
                  title={c.title}
                  onClick={() => pickImage(c.channel, c.asFigure, 'answer')}
                  disabled={busy}
                >
                  ＋ {c.label}
                </button>
              ))}
            </div>
          </section>

          <section className="ma-card">
            <div className={styles.stepTitle}>
              <span className={styles.stepNo}>{isChoiceType ? 5 : 4}</span> 已加入的图片
            </div>
            {/* v5b：加图的按钮已经挪到「题干」和「答案」各自的工具条里了
                （在那儿点更方便，不用回头找）。这里只负责已加入的图片：
                调大小、删除、以及整道题的配图位置。 */}
            {images.length === 0 && <div className="ma-muted">还没有图片。</div>}

            {images.length > 0 && (
              <ul className={styles.imageList}>
                {images.map((im, i) => (
                  <li key={im.id} className={styles.imageItem}>
                    {/* blob: 临时地址（用户刚选的文件），next/image 无法优化，这里用原生 img 是对的 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={im.url} alt={im.label} />
                    <div className={styles.imageInfo}>
                      <div>
                        <span className="ma-mono">{imageMarker(i)}</span>{' '}
                        <span className="ma-badge">{CHANNEL_BUTTONS.find((c) => c.channel === im.channel)?.label}</span>
                        {im.asFigure && <span className="ma-badge accent">带图号</span>}
                      </div>
                      <div className={styles.imageMeta}>
                        {/* v5：大小改成滑块。左边小、右边满栏，拖动时显示
                            「占正文栏 40% ≈ 6.0cm 宽」—— 老师对厘米有概念，「0.4」没有。
                            这个值最终写进 .tex 的 width=，所以 PDF 和网页一起变。 */}
                        <FigSizeSlider
                          value={im.width}
                          onChange={(v) => setImageWidth(im.id, v)}
                          disabled={busy}
                        />
                        <button className={styles.miniBtn} onClick={() => removeImage(im.id)}>
                          删除
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* v5：配图位置 —— 每题一个，左/中/右三个按钮。
                只有三个合法取值，所以是分段按钮而不是滑块。
                v8：默认**靠右**（示意图的默认位置），你动过就用手动值。 */}
            <div className={styles.posRow}>
              <FigAlignPicker
                value={resolvedAlign}
                auto={!figAlign}
                onChange={(v) => setFigAlign(v)}
                onReset={() => setFigAlign(null)}
                disabled={busy}
              />
            </div>
          </section>

          <section className="ma-card">
            <div className={styles.stepTitle}>
              <span className={styles.stepNo}>{isChoiceType ? 6 : 5}</span> 元数据
            </div>
            <div className={styles.metaGrid}>
              <MetaField label="来源（标签，输入为主）">
                <input
                  type="text"
                  list="source-list"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="25全国1"
                />
              </MetaField>
              <MetaField label="题号（1–30）">
                <input
                  type="text"
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  placeholder="1"
                />
              </MetaField>
              <MetaField label="难度（0.01–0.99）">
                <div className={styles.diffRow}>
                  <input
                    type="text"
                    value={difficulty}
                    onChange={(e) => setDifficulty(e.target.value)}
                    placeholder="0.94"
                  />
                  {bandPreview && <span className={styles.bandTag}>{bandPreview}</span>}
                </div>
              </MetaField>
              {/* v3：年份。v8：上限改成今年（写进标签里） */}
              <MetaField label={`年份（1900–${currentYear()}）`}>
                <input
                  type="text"
                  inputMode="numeric"
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  placeholder={String(currentYear())}
                />
              </MetaField>
              {/* v3：创新从裸 checkbox 改成和题型/难度同族的胶囊开关。
                  这样全站控件风格统一，也不再出现「一个孤零零的方框」。 */}
              <MetaField label="创新">
                <button
                  type="button"
                  className={styles.togglePill}
                  aria-pressed={innovation}
                  onClick={() => setInnovation((v) => !v)}
                >
                  {innovation ? '★ 创新' : '☆ 创新'}
                </button>
              </MetaField>
              <MetaField label="知识点" wide>
                <div className={styles.chips}>
                  {knowledge.map((k) => (
                    <span key={k} className={styles.kChip}>
                      {k}
                      <button
                        className={styles.chipX}
                        onClick={() => setKnowledge((p) => p.filter((x) => x !== k))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {/* v8：把上限写出来，免得打到第 9 个才知道有上限 */}
                  <span className={styles.kCount}>
                    {knowledge.length} / {KNOWLEDGE_MAX}
                  </span>
                </div>
                <input
                  type="text"
                  list="knowledge-list"
                  value={knowledgeInput}
                  onChange={(e) => setKnowledgeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addKnowledge(knowledgeInput);
                    }
                  }}
                  placeholder="输入后回车添加"
                />
              </MetaField>
              <MetaField label="描述" wide>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="输入描述"
                />
              </MetaField>
              {/*
                v9：自定义标签 —— 你说"逻辑要类似于知识点"，所以这里就是照知识点那一套做的：
                手打、回车添加、从已有里联想（同一个 datalist 机制）、点×删掉、显示已用/上限。
                两处不同：上限 5 个（不是 8），单个最长 20 字（因为它要跟
                「25全国1 第1题 0.94 基础」挤在题库列表的同一行）。
              */}
              <MetaField label="自定义" wide>
                <div className={styles.chips}>
                  {custom.map((k) => (
                    <span key={k} className={`${styles.kChip} ${styles.cChip}`}>
                      {k}
                      <button
                        className={styles.chipX}
                        onClick={() => setCustom((p) => p.filter((x) => x !== k))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <span className={styles.kCount}>
                    {custom.length} / {CUSTOM_TAG_MAX}
                  </span>
                </div>
                <input
                  type="text"
                  list="custom-list"
                  value={customInput}
                  maxLength={CUSTOM_TAG_LEN_MAX}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addCustom(customInput);
                    }
                  }}
                  placeholder={`输入后回车添加（最长 ${CUSTOM_TAG_LEN_MAX} 个字）`}
                />
              </MetaField>
            </div>

            {dup && (
              <div className={styles.dupWarn}>
                ⚠ 「{source} 第{number}题」已存在（qid {dup}）—— 可能重复录入。
              </div>
            )}
          </section>

          {/* ---------- 预览 ---------- */}
          <section className="ma-card">
            <div className={styles.stepTitle}>
              <span className={styles.stepNo}>{isChoiceType ? 7 : 6}</span> 预览与检查
              <button className={styles.toggleBtn} onClick={() => setPreview((v) => !v)}>
                {preview ? '收起预览' : '展开预览'}
              </button>
            </div>

            {lintErrors.length > 0 && (
              <div className={styles.lintErr}>
                {lintErrors.map((w, i) => (
                  <div key={i}>
                    ✗ {w.message}
                    {w.snippet ? `（${w.snippet}）` : ''}
                  </div>
                ))}
              </div>
            )}
            {lint.length === 0 && <div className={styles.lintOk}>✓ 通过可移植子集检查</div>}

            {preview && previewModel && (
              <div className={styles.previewBox}>
                <QuestionBody
                  qid="preview"
                  stem={previewModel.stemTex}
                  answer={previewModel.answerTex}
                  showAnswer
                  figAlign={resolvedAlign}
                  existingFiles={images.map((im) => im.label)}
                  assetUrl={(name) => urlByName.get(name) ?? ''}
                />
              </div>
            )}
            {previewModel?.notes.length ? (
              <div className={styles.hint}>{previewModel.notes.join('；')}</div>
            ) : null}
          </section>
        </>
      )}

      {/* ---------- 入库 ---------- */}
      {choice !== null && (
        <section className={`ma-card ${styles.submitBar}`}>
          {/* v7：整卷不显示「连续录入」—— 录入一份卷子就是上传一次 PDF，
              没有"下一题"这回事。以前是 disabled（看起来像"以后能用"），现在直接不渲染。 */}
          {isSingle && (
            <label className={styles.contLabel}>
              <input
                type="checkbox"
                checked={continuous}
                onChange={(e) => setContinuous(e.target.checked)}
              />
              连续录入（保留来源/难度/知识点，题号 +1）
            </label>
          )}
          <div className={styles.submitOps}>
            <Link href="/">
              <button>取消</button>
            </Link>
            <button
              className="primary"
              onClick={handleSave}
              disabled={busy || lintErrors.length > 0}
            >
              {busy ? '入库中…' : '确认入库'}
            </button>
          </div>
        </section>
      )}

      {/* ---------- 联想用的 datalist（放在页面根级，单题/整卷两个分支都能用） ---------- */}
      {/* 之前只写在整卷分支里，导致单题录入时来源没有联想 —— 这是修掉的 bug */}
      <datalist id="source-list">
        {(vocab?.source ?? []).map((s) => (
          <option key={s.name} value={s.name} />
        ))}
      </datalist>
      <datalist id="knowledge-list">
        {(vocab?.knowledge ?? []).map((k) => (
          <option key={k.name} value={k.name} />
        ))}
      </datalist>
      {/* v9：自定义标签的联想（与知识点同一个机制，词表来自 /api/tags 的 custom 维） */}
      <datalist id="custom-list">
        {(vocab?.custom ?? []).map((k) => (
          <option key={k.name} value={k.name} />
        ))}
      </datalist>

      {/* 隐藏的文件选择器 */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFilePicked(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function MetaField({
  label,
  children,
  wide,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? styles.metaFieldWide : styles.metaField}>
      <span className={styles.metaLabel}>{label}</span>
      {children}
    </div>
  );
}

import type { NextRequest } from 'next/server';
import { createQuestion, type CreateQuestionInput, type PendingImage } from '@/lib/service';
import { fail, ok } from '@/lib/api';
import { composeStemTex } from '@/lib/latexCompose';
import { toPortableImage } from '@/lib/imageConvert';
import { isImageChannel, type ImageChannel, type PdfRole, type QuestionType } from '@/lib/types';
import { validateChoiceOptions, validateCustomTags, validateKnowledgeCount } from '@/lib/validate';
import { findSubject, withSubject } from '@/lib/subjects';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

async function fileToBuffer(v: FormDataEntryValue | null): Promise<Buffer | undefined> {
  if (!v || typeof v === 'string') return undefined;
  return Buffer.from(await v.arrayBuffer());
}

function str(v: FormDataEntryValue | null): string | undefined {
  if (v === null || typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

interface ImageMetaItem {
  channel: string;
  asFigure?: boolean;
  width?: number;
  name?: string;
}

/**
 * POST /api/questions — 新建题目（单题 / 整卷 同一入口）
 *
 * 1) JSON（单题，无图片）：
 *    { kind, type, source, number, difficulty, knowledge[], description, stem, answer, options? }
 *
 * 2) multipart/form-data（要带图片或整卷 PDF 时）：
 *    字段同上；另外
 *      imageMeta = JSON 数组，每项 { channel, asFigure, width, name }
 *      img0, img1, …  = 对应的图片文件（顺序必须与 imageMeta 一致）
 *      paper / answer  = 整卷 PDF
 *
 * 单题正文先经 composeStemTex 规范化（自动补 \pick / \fillin、拼 choices 环境），
 * 图片则先按 {qid}-{通道}-NN 落盘，再把正文里的 [[img:N]] 占位标记换成真正的宏。
 * —— 全过程只做这一遍，落盘的就是唯一真源。
 */
export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get('content-type') ?? '';
    const warnings: string[] = [];
    let input: CreateQuestionInput;
    /**
     * v9：这次录到哪个学科。不传 = 当前学科。
     * 用 withSubject 包住 createQuestion —— 占号、建目录、写文件全都跟着它走。
     */
    let subject: string | null = null;

    if (contentType.includes('multipart/form-data')) {
      const fd = await req.formData();
      const kind = (str(fd.get('kind')) ?? '单题') as CreateQuestionInput['kind'];
      const rawType = str(fd.get('type'));
      const stemRaw = str(fd.get('stem')) ?? '';
      const answerRaw = str(fd.get('answer')) ?? '';
      subject = str(fd.get('subject')) ?? null;

      const options = ['A', 'B', 'C', 'D']
        .map((L) => str(fd.get(`option${L}`)))
        .filter((v): v is string => !!v);

      // v8：选择题选项数下限。界面也拦，这里是**第二道**（防绕过界面直接调接口）
      if (kind === '单题' && (rawType === '单选' || rawType === '多选')) {
        const bad = validateChoiceOptions(options);
        if (bad) return ok({ error: bad, field: 'options' }, 400);
      }

      // v8：知识点数量上限
      const kErr = validateKnowledgeCount(fd.getAll('knowledge'));
      if (kErr) return ok({ error: kErr, field: 'knowledge' }, 400);

      // v9：自定义标签的上限（数量 + 单个长度）。界面也拦，这里是第二道。
      const cErr = validateCustomTags(fd.getAll('custom'));
      if (cErr) return ok({ error: cErr, field: 'custom' }, 400);

      let stem = stemRaw;
      if (kind === '单题' && rawType) {
        const composed = composeStemTex({
          type: rawType as QuestionType,
          stem: stemRaw,
          options,
        });
        stem = composed.tex;
        warnings.push(...composed.notes);
      }

      // ---- 待入库图片 ----
      const pendingImages: PendingImage[] = [];
      const imageMetaRaw = str(fd.get('imageMeta'));
      if (imageMetaRaw) {
        let metaList: ImageMetaItem[] = [];
        try {
          const parsed = JSON.parse(imageMetaRaw);
          if (Array.isArray(parsed)) metaList = parsed as ImageMetaItem[];
        } catch {
          return ok({ error: 'imageMeta 不是合法 JSON' }, 400);
        }

        for (let i = 0; i < metaList.length; i++) {
          const entry = fd.get(`img${i}`);
          if (!entry || typeof entry === 'string') continue;

          const meta = metaList[i];
          if (!isImageChannel(meta.channel)) {
            return ok({ error: `第 ${i + 1} 张图片的通道无效：${meta.channel}` }, 400);
          }

          const raw = Buffer.from(await entry.arrayBuffer());
          const originalName = meta.name || (entry as File).name || `upload-${i}.png`;
          const conv = await toPortableImage(raw, originalName);
          if (conv.note) warnings.push(conv.note);

          pendingImages.push({
            channel: meta.channel as ImageChannel,
            buf: conv.buf,
            ext: conv.ext,
            asFigure: meta.asFigure !== false,
            width: typeof meta.width === 'number' ? meta.width : 0.4,
          });
        }
      }

      // ---- 整卷 PDF ----
      const pdf: Partial<Record<PdfRole, Buffer>> = {};
      const paper = await fileToBuffer(fd.get('paper'));
      const answerPdf = await fileToBuffer(fd.get('answer'));
      if (paper) pdf.paper = paper;
      if (answerPdf) pdf.answer = answerPdf;

      input = {
        kind,
        type: rawType,
        source: str(fd.get('source')),
        number: str(fd.get('number')),
        difficulty: str(fd.get('difficulty')),
        knowledge: fd.getAll('knowledge').filter((v): v is string => typeof v === 'string'),
        // v9：自定义标签（同样是多值，界面用同一个输入控件）
        custom: fd.getAll('custom').filter((v): v is string => typeof v === 'string'),
        description: str(fd.get('description')),
        // v2：创新标记（仅单题，服务端会再兜底）
        innovation: str(fd.get('innovation')),
        // v3：年份
        year: str(fd.get('year')),
        // v5：配图位置（仅单题）
        figAlign: str(fd.get('figAlign')),
        stem,
        answer: answerRaw,
        pendingImages: pendingImages.length ? pendingImages : undefined,
        pdf: Object.keys(pdf).length ? pdf : undefined,
      };
    } else {
      const body = (await req.json()) as Record<string, unknown>;
      subject = typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim() : null;
      input = {
        kind: (body.kind as CreateQuestionInput['kind']) ?? '单题',
        type: body.type,
        source: body.source,
        number: body.number,
        difficulty: body.difficulty,
        knowledge: body.knowledge,
        // v9：自定义标签
        custom: body.custom,
        description: body.description,
        // v2：创新标记（仅单题，服务端会再兜底）
        innovation: body.innovation,
        // v3：年份
        year: body.year,
        // v5：配图位置（仅单题）
        figAlign: body.figAlign,
        stem: typeof body.stem === 'string' ? body.stem : undefined,
        answer: typeof body.answer === 'string' ? body.answer : undefined,
      };

      if (input.kind === '单题' && typeof input.type === 'string') {
        const composed = composeStemTex({
          type: input.type as QuestionType,
          stem: input.stem ?? '',
          options: Array.isArray(body.options)
            ? (body.options as unknown[]).map((o) => String(o))
            : undefined,
        });
        input.stem = composed.tex;
        warnings.push(...composed.notes);
      }
    }

    // v9：指名的学科不存在时**当场报错**，不要悄悄录到当前学科 ——
    // 那是最难发现的一类错（以为录进了化学，其实进了数学）。
    if (subject && !findSubject(subject)) {
      return ok({ error: `没有这个学科：${subject}`, field: 'subject' }, 400);
    }

    const run = () => createQuestion(input);
    const result = await (subject ? withSubject(subject, run) : run());
    return ok(
      { qid: result.qid, subject: subject ?? '', warnings: [...warnings, ...result.warnings] },
      201
    );
  } catch (e) {
    return fail(e);
  }
}

'use strict';
// 纯文本/版本核心逻辑：解析、范围校验、合并、异议锚点迁移

function cpArray(s) {
  return Array.from(String(s));
}
function cpLen(s) {
  return cpArray(s).length;
}
function cpSlice(s, start, end) {
  return cpArray(s).slice(start, end).join('');
}

class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * 解析 UTF-8 逐字稿。每行一段，形如 “12 段内容”，分隔符支持
 * 制表符/半角逗号/中文逗号/顿号/句点/冒号。空行跳过。
 * 返回 [{seg_no, text}]
 */
function parseTranscript(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DomainError(400, 'EMPTY_TRANSCRIPT', '逐字稿为空');
  }
  const text = raw.replace(/^\uFEFF/, ''); // 去掉 UTF-8 BOM
  const lines = text.split(/\r\n|\n|\r/);
  const segments = [];
  const seen = new Set();
  lines.forEach((rawLine, idx) => {
    const line = rawLine.replace(/^[ \t]+/, '');
    if (line.trim() === '') return;
    const m = /^(\d+)([，,、．.：:\t])(.*)$/.exec(line);
    if (!m) {
      throw new DomainError(
        400, 'BAD_LINE',
        `第 ${idx + 1} 行无法识别：应以“段号+分隔符”开头（如 “1	… / 1, … / 1：…”）`
      );
    }
    const segNo = m[1];
    if (seen.has(segNo)) {
      throw new DomainError(400, 'DUP_SEG', `段号 ${segNo} 重复出现`);
    }
    seen.add(segNo);
    let content = m[3];
    // 分隔符后最多吞掉一个空白，其余视为正文
    if (content.length && (content[0] === ' ' || content[0] === '\t')) {
      content = content.slice(1);
    }
    segments.push({ seg_no: segNo, text: content });
  });
  if (segments.length === 0) {
    throw new DomainError(400, 'EMPTY_TRANSCRIPT', '逐字稿中没有任何段落');
  }
  return segments;
}

function findSeg(segments, segNo) {
  return segments.find((s) => s.seg_no === String(segNo));
}

/** 校验范围并返回 {seg, oldText}；码点偏移，[start,end) */
function validateRange(segments, segNo, start, end) {
  const seg = findSeg(segments, segNo);
  if (!seg) {
    throw new DomainError(400, 'NO_SEG', `段号 ${segNo} 不存在`);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new DomainError(400, 'BAD_RANGE', '范围必须是整数码点偏移');
  }
  const len = cpLen(seg.text);
  if (start < 0 || end < start || end > len) {
    throw new DomainError(
      400, 'BAD_RANGE',
      `非法范围：段 ${segNo} 长度 ${len}，给定 [${start},${end})`
    );
  }
  return { seg, oldText: cpSlice(seg.text, start, end) };
}

function overlaps(a, b) {
  return a.seg_no === b.seg_no && a.start < b.end && b.start < a.end;
}

/**
 * 将同一基版上互不重叠的已采纳修订合并为新正文。
 * edits: [{proposal_id, seg_no, start, end, new_text, old_text}]
 * 返回 {segments, changes}，changes: seg_no -> [{start,end,newLen,proposal_id}]
 */
function mergeEdits(baseSegments, edits) {
  const bySeg = new Map();
  for (const e of edits) {
    if (!bySeg.has(e.seg_no)) bySeg.set(e.seg_no, []);
    bySeg.get(e.seg_no).push(e);
  }
  const changes = new Map();
  const segments = baseSegments.map((seg) => {
    const list = bySeg.get(seg.seg_no);
    if (!list || list.length === 0) return seg;
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (overlaps(sorted[i - 1], sorted[i])) {
        throw new DomainError(
          409, 'OVERLAP',
          `采纳结果在段 ${seg.seg_no} 交叠：提案 #${sorted[i - 1].proposal_id} 与 #${sorted[i].proposal_id}`
        );
      }
    }
    // 重新校验原文片段仍匹配（防止基版被意外改动，正常流程不会触发）
    let arr = cpArray(seg.text);
    for (const e of sorted) {
      const actual = arr.slice(e.start, e.end).join('');
      if (actual !== e.old_text) {
        throw new DomainError(
          409, 'STALE_TEXT',
          `提案 #${e.proposal_id} 的原文与基版不一致，无法合并（基版可能已过期）`
        );
      }
    }
    // 从后向前替换
    for (let i = sorted.length - 1; i >= 0; i--) {
      const e = sorted[i];
      arr = [
        ...arr.slice(0, e.start),
        ...cpArray(e.new_text),
        ...arr.slice(e.end),
      ];
    }
    changes.set(seg.seg_no, sorted.map((e) => ({
      start: e.start,
      end: e.end,
      newLen: cpLen(e.new_text),
      proposal_id: e.proposal_id,
    })));
    return { seg_no: seg.seg_no, text: arr.join('') };
  });
  return { segments, changes };
}

/**
 * 把旧版本上的有效异议锚点迁移到新版本。
 * anchors: [{objection_id, seg_no, start, end, quote}]
 * 返回新锚点列表，字段含 state/note/start/end/quote。
 * 绝不自动指向新文字：与任一修订交叠即 broken，保留旧快照。
 */
function transformAnchors(newSegments, changesBySeg, anchors) {
  const newSegMap = new Map(newSegments.map((s) => [s.seg_no, s]));
  return anchors.map((a) => {
    const changes = (changesBySeg.get(a.seg_no) || []).slice().sort((x, y) => x.start - y.start);
    const hit = changes.find((c) => a.start < c.end && c.start < a.end);
    if (hit) {
      return {
        ...a,
        start: null,
        end: null,
        quote: a.quote, // 保留被引原文快照
        state: 'broken',
        note: `修订（提案 #${hit.proposal_id}）覆盖了该引用范围，原文快照已保留，需重新定位，系统不会自动指向新文字`,
      };
    }
    let delta = 0;
    for (const c of changes) {
      if (c.end <= a.start) delta += c.newLen - (c.end - c.start);
    }
    const ns = a.start + delta;
    const ne = a.end + delta;
    const seg = newSegMap.get(a.seg_no);
    const moved = seg ? cpSlice(seg.text, ns, ne) : null;
    if (!seg || moved !== a.quote) {
      return {
        ...a,
        start: null,
        end: null,
        quote: a.quote,
        state: 'broken',
        note: '修订后该位置的文字与引用快照不一致，需重新定位',
      };
    }
    return { ...a, start: ns, end: ne, state: 'anchored', note: '' };
  });
}

module.exports = {
  cpLen,
  cpSlice,
  DomainError,
  parseTranscript,
  validateRange,
  overlaps,
  mergeEdits,
  transformAnchors,
};

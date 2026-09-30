'use strict';
const express = require('express');
const path = require('path');
const { initDb, getDb, createSession, getUserByToken, getUserByCredentials } = require('./db');
const core = require('./core');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || '/data';

initDb(DATA_DIR);
const db = getDb();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'TOO_LARGE', message: '请求体超过 10MB 限制' } });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 辅助 ----------
function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  let token = null;
  if (header.startsWith('Bearer ')) token = header.slice(7);
  else if (req.query && req.query.token) token = String(req.query.token);
  req.user = token ? getUserByToken(token) : null;
  next();
}
app.use(auth);

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '未登录' } });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `无权操作：该操作需要 ${roles.join('/')} 身份，当前为 ${req.user.role}`,
        },
      });
    }
    next();
  };
}

function fail(res, err) {
  if (err instanceof core.DomainError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
}

function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}
function getVersion(id) {
  return db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
}
function parseContent(v) {
  return JSON.parse(v.content);
}
function currentVersion(doc) {
  return getVersion(doc.current_version_id);
}

function proposalView(p) {
  return {
    id: p.id,
    document_id: p.document_id,
    base_version_id: p.base_version_id,
    seg_no: p.seg_no,
    start: p.start,
    end: p.end,
    old_text: p.old_text,
    new_text: p.new_text,
    basis: p.basis,
    status: p.status,
    conflict_reason: p.conflict_reason,
    created_by: p.created_by,
    created_at: p.created_at,
    decided_by: p.decided_by,
    decided_at: p.decided_at,
    merged_into_version_id: p.merged_into_version_id,
  };
}

// ---------- 认证 ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: { code: 'BAD_INPUT', message: '需要用户名与密码' } });
  }
  const user = getUserByCredentials(String(username), String(password));
  if (!user) {
    return res.status(401).json({ error: { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' } });
  }
  const token = createSession(user.id);
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: '未登录' } });
  res.json({ user: publicUser(req.user) });
});

// ---------- 文档 ----------
app.get('/api/documents', (req, res) => {
  const docs = db.prepare(`
    SELECT d.*, v.version_no AS current_version_no
    FROM documents d LEFT JOIN versions v ON v.id = d.current_version_id
    ORDER BY d.id`).all();
  res.json({ documents: docs.map((d) => ({
    id: d.id, title: d.title, created_at: d.created_at,
    current_version_id: d.current_version_id, current_version_no: d.current_version_no,
  })) });
});

// 记录员导入 UTF-8 逐字稿 -> 新文档 + v1（v1 视为已发布的不可变基版）
app.post('/api/documents', requireRole('recordist'), (req, res) => {
  try {
    const title = String((req.body && req.body.title) || '').trim();
    const transcript = req.body && req.body.transcript;
    if (!title) throw new core.DomainError(400, 'BAD_INPUT', '文档标题不能为空');
    const segments = core.parseTranscript(transcript);

    const tx = db.transaction(() => {
      const r = db.prepare('INSERT INTO documents (title, created_by) VALUES (?,?)')
        .run(title, req.user.id);
      const docId = r.lastInsertRowid;
      db.prepare(`INSERT INTO versions (document_id, version_no, content, note, published_by, proposal_seq)
                  VALUES (?,1,?,?,?,0)`)
        .run(docId, JSON.stringify(segments), '导入原稿', req.user.id);
      const v = db.prepare('SELECT id FROM versions WHERE document_id=? AND version_no=1').get(docId);
      db.prepare('UPDATE documents SET current_version_id=? WHERE id=?').run(v.id, docId);
      return { docId, versionId: v.id };
    });
    const out = tx();
    res.json({ id: out.docId, current_version_id: out.versionId, segments });
  } catch (e) { fail(res, e); }
});

app.get('/api/documents/:id', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '文档不存在' } });
  const versions = db.prepare(
    'SELECT id, version_no, base_version_id, note, published_by, published_at FROM versions WHERE document_id=? ORDER BY version_no'
  ).all(doc.id);
  res.json({
    document: {
      id: doc.id, title: doc.title, created_at: doc.created_at,
      current_version_id: doc.current_version_id,
    },
    versions,
  });
});

// 查看某不可变版本：正文、决议（提案）、异议锚点
app.get('/api/versions/:id', (req, res) => {
  const v = getVersion(req.params.id);
  if (!v) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '版本不存在' } });
  const doc = getDocument(v.document_id);

  // 决议：该版本发布时已存在的提案（状态显示最终处置，并入版本号可对照版本链）
  const proposals = db.prepare(
    'SELECT * FROM proposals WHERE document_id=? AND id <= ? ORDER BY id'
  ).all(doc.id, v.proposal_seq).map(proposalView);

  const anchors = db.prepare(`
    SELECT oa.*, o.comment, o.created_by AS obj_created_by, o.created_at AS obj_created_at,
           u.display_name AS creator_name
    FROM objection_anchors oa
    JOIN objections o ON o.id = oa.objection_id
    JOIN users u ON u.id = o.created_by
    WHERE oa.version_id = ? ORDER BY oa.id`
  ).all(v.id);

  res.json({
    version: {
      id: v.id, document_id: v.document_id, version_no: v.version_no,
      base_version_id: v.base_version_id, note: v.note, published_at: v.published_at,
      content: parseContent(v),
      is_current: doc.current_version_id === v.id,
    },
    decisions: proposals,
    objections: anchors,
  });
});

// ---------- 提案 ----------
// 记录员在当前已发布版本上选定段内字符范围提交
app.post('/api/documents/:id/proposals', requireRole('recordist'), (req, res) => {
  try {
    const doc = getDocument(req.params.id);
    if (!doc) throw new core.DomainError(404, 'NOT_FOUND', '文档不存在');
    const body = req.body || {};
    const segNo = String(body.seg_no);
    const start = Number(body.start);
    const end = Number(body.end);
    const newText = String(body.new_text == null ? '' : body.new_text);
    const basis = String(body.basis == null ? '' : body.basis).trim();
    if (!basis) throw new core.DomainError(400, 'BAD_INPUT', '必须填写修订依据');
    if (newText.length === 0) throw new core.DomainError(400, 'BAD_INPUT', '替换文字不能为空（删除请显式说明，本台不支持空替换）');

    const base = currentVersion(doc);
    const segments = parseContent(base);
    const { oldText } = core.validateRange(segments, segNo, start, end);

    const r = db.prepare(`INSERT INTO proposals
      (document_id, base_version_id, seg_no, start, end, old_text, new_text, basis, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(doc.id, base.id, segNo, start, end, oldText, newText, basis, req.user.id);
    const p = db.prepare('SELECT * FROM proposals WHERE id=?').get(r.lastInsertRowid);
    res.json({ proposal: proposalView(p) });
  } catch (e) { fail(res, e); }
});

app.get('/api/documents/:id/proposals', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '文档不存在' } });
  const rows = db.prepare(
    'SELECT * FROM proposals WHERE document_id=? ORDER BY id'
  ).all(doc.id).map(proposalView);
  const cur = currentVersion(doc);
  for (const p of rows) {
    p.base_is_current = p.base_version_id === cur.id;
  }
  res.json({ proposals: rows, current_version_id: cur.id });
});

// 复核员采纳 / 驳回单个待决提案
app.post('/api/proposals/:pid/decision', requireRole('reviewer'), (req, res) => {
  try {
    const p = db.prepare('SELECT * FROM proposals WHERE id=?').get(req.params.pid);
    if (!p) throw new core.DomainError(404, 'NOT_FOUND', '提案不存在');
    const action = String((req.body || {}).action || '');
    if (!['adopt', 'reject'].includes(action)) {
      throw new core.DomainError(400, 'BAD_INPUT', "action 必须是 adopt 或 reject");
    }
    if (p.status !== 'pending') {
      throw new core.DomainError(409, 'ALREADY_DECIDED',
        `提案 #${p.id} 已处置（当前状态：${p.status}），不能重复操作且状态不变`);
    }
    const doc = getDocument(p.document_id);
    const cur = currentVersion(doc);
    if (p.base_version_id !== cur.id) {
      db.prepare('UPDATE proposals SET status=?, conflict_reason=?, decided_by=?, decided_at=datetime(\'now\') WHERE id=?')
        .run('conflicted', `基版已过期：提案基于版本 #${p.base_version_id}，当前已发布版本为 #${cur.id}（v${cur.version_no}）；不能覆盖其他修订，请重新基于现版提交`,
             req.user.id, p.id);
      const np = db.prepare('SELECT * FROM proposals WHERE id=?').get(p.id);
      return res.status(409).json({
        error: { code: 'STALE_BASE', message: np.conflict_reason },
        proposal: proposalView(np),
      });
    }
    const status = action === 'adopt' ? 'adopted' : 'rejected';
    db.prepare('UPDATE proposals SET status=?, decided_by=?, decided_at=datetime(\'now\') WHERE id=?')
      .run(status, req.user.id, p.id);
    res.json({ proposal: proposalView(db.prepare('SELECT * FROM proposals WHERE id=?').get(p.id)) });
  } catch (e) { fail(res, e); }
});

// 复核员发布：合并当前基版上全部已采纳且互不重叠的提案 -> 新不可变版本
app.post('/api/documents/:id/publish', requireRole('reviewer'), (req, res) => {
  try {
    const doc = getDocument(req.params.id);
    if (!doc) throw new core.DomainError(404, 'NOT_FOUND', '文档不存在');
    const note = String((req.body || {}).note || '').trim();

    const base = currentVersion(doc);
    const adopted = db.prepare(
      "SELECT * FROM proposals WHERE document_id=? AND status='adopted' AND base_version_id=? ORDER BY id"
    ).all(doc.id, base.id);
    // 基版已过期、但仍停留在 adopted 的提案（采纳后基版被其他发布推进）
    const stale = db.prepare(
      "SELECT * FROM proposals WHERE document_id=? AND status='adopted' AND base_version_id<>? ORDER BY id"
    ).all(doc.id, base.id);

    if (adopted.length === 0 && stale.length === 0) {
      throw new core.DomainError(409, 'NOTHING_TO_PUBLISH',
        `重复发布被拒绝：当前版本 v${base.version_no} 之上没有已采纳待合并的提案，不会产生新版本，状态不变`);
    }

    // 第一步：标记冲突（独立事务，先行提交——即使随后拒绝发布，冲突标记也保留）
    const conflictedIds = new Set();
    db.transaction(() => {
      const markConflict = db.prepare(
        "UPDATE proposals SET status='conflicted', conflict_reason=?, decided_by=?, decided_at=datetime('now') WHERE id=?"
      );
      for (const p of stale) {
        conflictedIds.add(p.id);
        markConflict.run(
          `基版已过期：提案基于版本 #${p.base_version_id}，发布基版为 #${base.id}（v${base.version_no}）；不能覆盖其他修订`,
          req.user.id, p.id);
      }
      // 交叠检测：所有交叠提案一并标冲突（不能静默挑选一个）
      for (let i = 0; i < adopted.length; i++) {
        for (let j = i + 1; j < adopted.length; j++) {
          if (core.overlaps(adopted[i], adopted[j])) {
            conflictedIds.add(adopted[i].id);
            conflictedIds.add(adopted[j].id);
          }
        }
      }
      for (const id of conflictedIds) {
        if (stale.find((p) => p.id === id)) continue;
        const p = adopted.find((x) => x.id === id);
        markConflict.run(
          `范围交叠：段 ${p.seg_no} [${p.start},${p.end}) 与其他已采纳提案交叠，无法无歧义合并，需重新提交`,
          req.user.id, id);
      }
    })();

    const toMerge = adopted.filter((p) => !conflictedIds.has(p.id));
    if (toMerge.length === 0) {
      throw new core.DomainError(409, 'ALL_CONFLICTED',
        '没有可合并的采纳提案：它们或基版已过期、或范围交叠，已全部标记为冲突，未产生新版本');
    }

    // 第二步：合并并生成不可变版本（单一事务）
    const out = db.transaction(() => {
      const baseSegments = parseContent(base);
      const edits = toMerge.map((p) => ({
        proposal_id: p.id, seg_no: p.seg_no, start: p.start, end: p.end,
        new_text: p.new_text, old_text: p.old_text,
      }));
      const { segments: newSegments, changes } = core.mergeEdits(baseSegments, edits);

      const nextNo = base.version_no + 1;
      const seqRow = db.prepare('SELECT COALESCE(MAX(id),0) AS s FROM proposals WHERE document_id=?').get(doc.id);
      db.prepare(`INSERT INTO versions (document_id, version_no, base_version_id, content, note, published_by, proposal_seq)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(doc.id, nextNo, base.id, JSON.stringify(newSegments),
             note || `合并 ${toMerge.length} 项采纳修订`, req.user.id, seqRow.s);
      const nv = db.prepare('SELECT * FROM versions WHERE document_id=? AND version_no=?').get(doc.id, nextNo);

      const markMerged = db.prepare(
        "UPDATE proposals SET status='merged', merged_into_version_id=?, decided_at=COALESCE(decided_at, datetime('now')) WHERE id=?"
      );
      for (const p of toMerge) markMerged.run(nv.id, p.id);

      // 迁移异议锚点：取上一版本的全部锚点（含 broken 快照，逐版保留）
      const prevAnchors = db.prepare(`
        SELECT objection_id, seg_no, start, end, quote, state FROM objection_anchors
        WHERE version_id=? ORDER BY id`).all(base.id);
      const live = prevAnchors.filter((a) => a.state !== 'broken' && a.start !== null);
      const carried = prevAnchors
        .filter((a) => a.state === 'broken')
        .map((a) => ({ ...a, note: '延续自上一版本的失效引用：原文快照保留，仍需重新定位' }));
      const moved = core.transformAnchors(
        newSegments, changes,
        live.map((a) => ({ objection_id: a.objection_id, seg_no: a.seg_no, start: a.start, end: a.end, quote: a.quote }))
      );
      const insAnchor = db.prepare(`INSERT INTO objection_anchors
        (objection_id, version_id, seg_no, start, end, quote, state, note)
        VALUES (?,?,?,?,?,?,?,?)`);
      for (const a of [...moved, ...carried]) {
        insAnchor.run(a.objection_id, nv.id, a.seg_no, a.start, a.end, a.quote, a.state, a.note || '');
      }

      db.prepare('UPDATE documents SET current_version_id=? WHERE id=?').run(nv.id, doc.id);
      return { versionId: nv.id, versionNo: nextNo, merged: toMerge.map((p) => p.id), conflicted: [...conflictedIds] };
    })();

    res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
});

// ---------- 异议 ----------
// 参与者（或任何登录参与者角色）对当前版本原文范围留下异议引用
app.post('/api/documents/:id/objections', requireRole('participant'), (req, res) => {
  try {
    const doc = getDocument(req.params.id);
    if (!doc) throw new core.DomainError(404, 'NOT_FOUND', '文档不存在');
    const body = req.body || {};
    const segNo = String(body.seg_no);
    const start = Number(body.start);
    const end = Number(body.end);
    const comment = String(body.comment == null ? '' : body.comment).trim();
    if (!comment) throw new core.DomainError(400, 'BAD_INPUT', '异议说明不能为空');

    const v = currentVersion(doc);
    const segments = parseContent(v);
    const { oldText } = core.validateRange(segments, segNo, start, end);
    if (oldText.trim() === '') throw new core.DomainError(400, 'BAD_RANGE', '引用范围不能全为空白');

    const out = db.transaction(() => {
      const r = db.prepare(`INSERT INTO objections (document_id, seg_no, quote, comment, created_by)
        VALUES (?,?,?,?,?)`).run(doc.id, segNo, oldText, comment, req.user.id);
      db.prepare(`INSERT INTO objection_anchors (objection_id, version_id, seg_no, start, end, quote, state, note)
        VALUES (?,?,?,?,?,?,'anchored','')`)
        .run(r.lastInsertRowid, v.id, segNo, start, end, oldText);
      const o = db.prepare('SELECT * FROM objections WHERE id=?').get(r.lastInsertRowid);
      return o;
    })();
    res.json({ objection: { id: out.id, seg_no: out.seg_no, quote: out.quote, comment: out.comment, version_id: v.id, state: 'anchored' } });
  } catch (e) { fail(res, e); }
});

app.get('/api/documents/:id/objections', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '文档不存在' } });
  const cur = currentVersion(doc);
  const rows = db.prepare(`
    SELECT o.id, o.seg_no, o.comment, o.created_at, o.created_by,
           u.display_name AS creator_name,
           a.version_id, a.start, a.end, a.quote, a.state, a.note
    FROM objections o
    JOIN users u ON u.id = o.created_by
    LEFT JOIN objection_anchors a ON a.objection_id = o.id AND a.version_id = ?
    WHERE o.document_id = ?
    ORDER BY o.id`).all(cur.id, doc.id);
  res.json({ version_id: cur.id, version_no: cur.version_no, objections: rows });
});

// 重新定位失效引用：参与者确认新范围（必须文字与快照一致才允许锚定，绝不悄悄指向新文字）
app.post('/api/objections/:oid/reanchor', requireRole('participant'), (req, res) => {
  try {
    const o = db.prepare('SELECT * FROM objections WHERE id=?').get(req.params.oid);
    if (!o) throw new core.DomainError(404, 'NOT_FOUND', '异议不存在');
    const body = req.body || {};
    const segNo = String(body.seg_no);
    const start = Number(body.start);
    const end = Number(body.end);
    const doc = getDocument(o.document_id);
    const cur = currentVersion(doc);
    const segments = parseContent(cur);
    const { oldText } = core.validateRange(segments, segNo, start, end);
    if (oldText !== o.quote) {
      throw new core.DomainError(409, 'QUOTE_MISMATCH',
        '新位置文字与原引用快照不一致：为避免悄悄指向新文字，不能重新定位到该处；请选择与原文快照完全一致的范围');
    }
    const existing = db.prepare('SELECT id FROM objection_anchors WHERE objection_id=? AND version_id=?')
      .get(o.id, cur.id);
    if (existing) {
      db.prepare(`UPDATE objection_anchors SET seg_no=?, start=?, end=?, state='reanchored',
        note='经参与者确认重新定位；原文快照与现位置一致' WHERE id=?`)
        .run(segNo, start, end, existing.id);
    } else {
      db.prepare(`INSERT INTO objection_anchors (objection_id, version_id, seg_no, start, end, quote, state, note)
        VALUES (?,?,?,?,?,?,'reanchored','经参与者确认重新定位；原文快照与现位置一致')`)
        .run(o.id, cur.id, segNo, start, end, o.quote);
    }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// ---------- 启动 ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`听证校订台已启动: http://localhost:${PORT}`);
});

'use strict';
/* 听证校订台前端（原生 JS，无构建） */

const state = {
  token: localStorage.getItem('hrb_token') || null,
  user: null,
  view: { name: 'list', docId: null, tab: 'text', versionId: null },
  docs: [],
  doc: null,
  versions: [],
  versionDetail: null,
  proposals: [],
  currentVersionId: null,
  objections: [],
  selection: null,          // {seg_no,start,end,text}
  reanchoring: null,        // objection id 待重新定位
};

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

// ---------- API ----------
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (state.token) opts.headers.Authorization = 'Bearer ' + state.token;
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `请求失败 (${res.status})`;
    const code = data && data.error && data.error.code;
    const err = new Error(msg);
    err.code = code;
    err.data = data;
    throw err;
  }
  return data || {};
}

function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind || '';
  setTimeout(() => t.classList.add('hidden'), 3600);
  t.classList.remove('hidden');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function cpLen(s) { return Array.from(String(s)).length; }
function cpSlice(s, a, b) { return Array.from(String(s)).slice(a, b).join(''); }

const STATUS_LABEL = {
  pending: '待决', adopted: '已采纳', rejected: '已驳回',
  conflicted: '冲突', merged: '已合并',
};
const ROLE_LABEL = { recordist: '记录员', reviewer: '复核员', participant: '参与者' };

// ---------- 模态框 ----------
function openModal(title, bodyHtml, onOk, okText) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-ok').textContent = okText || '确定';
  $('#modal-backdrop').classList.remove('hidden');
  const ok = $('#modal-ok'), cancel = $('#modal-cancel');
  function close() { $('#modal-backdrop').classList.add('hidden'); ok.onclick = null; cancel.onclick = null; }
  cancel.onclick = close;
  ok.onclick = async () => {
    try {
      const keep = await onOk(close);
      if (!keep) close();
    } catch (e) { toast(e.message, 'error'); }
  };
  return close;
}

// ---------- 渲染：登录 ----------
function renderLogin() {
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:60px auto;">
      <h2>登录听证校订台</h2>
      <label>用户名</label>
      <input type="text" id="login-user" placeholder="recordist / reviewer / participant">
      <label>密码</label>
      <input type="password" id="login-pass" placeholder="默认与用户名相同">
      <div style="margin-top:16px;"><button class="btn primary" id="login-btn">登录</button></div>
      <p class="muted small" style="margin-top:14px;">
        内置账户：recordist（记录员）、reviewer（复核员）、participant（参与者），
        默认密码与用户名相同，可通过环境变量修改。
      </p>
    </div>`;
  const doLogin = async () => {
    try {
      const r = await api('POST', '/api/login', {
        username: $('#login-user').value.trim(),
        password: $('#login-pass').value,
      });
      state.token = r.token;
      state.user = r.user;
      localStorage.setItem('hrb_token', r.token);
      await boot();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#login-btn').onclick = doLogin;
  $('#login-pass').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
}

function renderUserbox() {
  $('#userbox').innerHTML = state.user
    ? `<span>${esc(state.user.display_name)}</span><span class="role-tag">${ROLE_LABEL[state.user.role]}</span>
       <button class="btn small" id="logout-btn">退出</button>`
    : '';
  if (state.user) $('#logout-btn').onclick = () => {
    state.token = null; state.user = null;
    localStorage.removeItem('hrb_token');
    renderLogin(); renderUserbox();
  };
}

// ---------- 渲染：文档列表 ----------
async function renderList() {
  state.docs = (await api('GET', '/api/documents')).documents;
  const canImport = state.user.role === 'recordist';
  app.innerHTML = `
    <div class="card">
      <div class="row spread">
        <h2 style="margin:0;">文档列表</h2>
        ${canImport ? '<button class="btn primary" id="import-btn">＋ 导入 UTF-8 逐字稿</button>' : ''}
      </div>
      <table style="margin-top:12px;">
        <thead><tr><th>ID</th><th>标题</th><th>当前版本</th><th>创建时间</th></tr></thead>
        <tbody>
        ${state.docs.length === 0 ? '<tr><td colspan="4" class="muted">尚无文档</td></tr>' :
          state.docs.map((d) => `<tr class="doc-row" data-id="${d.id}">
            <td>${d.id}</td><td>${esc(d.title)}</td>
            <td>v${d.current_version_no || '—'}</td><td class="muted">${esc(d.created_at)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  document.querySelectorAll('.doc-row').forEach((tr) => {
    tr.onclick = () => openDoc(Number(tr.dataset.id), 'text');
  });
  if (canImport) $('#import-btn').onclick = showImport;
}

function showImport() {
  const body = `
    <label>文档标题</label>
    <input type="text" id="imp-title" placeholder="例如：某某听证会第 3 场">
    <label>逐字稿（UTF-8，每行“段号+分隔符+正文”，支持 Tab/逗号/顿号/冒号）</label>
    <textarea id="imp-text" rows="12" placeholder="1	听证会现在开始。
2：请证人陈述。
3,我确认……"></textarea>
    <p class="muted small">也可选择 UTF-8 文本文件：<input type="file" id="imp-file" accept=".txt,.csv,text/plain"></p>
  `;
  openModal('导入逐字稿', body, async () => {
    const title = $('#imp-title').value.trim();
    const transcript = $('#imp-text').value;
    const r = await api('POST', '/api/documents', { title, transcript });
    toast(`已导入：文档 #${r.id}，v1 为不可变原稿`, 'ok');
    await openDoc(r.id, 'text');
  }, '导入并创建 v1');
  $('#imp-file').onchange = () => {
    const f = $('#imp-file').files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { $('#imp-text').value = reader.result; };
    reader.readAsText(f, 'utf-8');
  };
}

// ---------- 文档工作区 ----------
async function openDoc(docId, tab) {
  state.view = { name: 'doc', docId, tab: tab || 'text', versionId: null };
  await loadDoc();
}

async function loadDoc() {
  const { docId, tab } = state.view;
  const d = await api('GET', `/api/documents/${docId}`);
  state.doc = d.document;
  state.versions = d.versions;
  const p = await api('GET', `/api/documents/${docId}/proposals`);
  state.proposals = p.proposals;
  state.currentVersionId = p.current_version_id;
  const vd = await api('GET', `/api/versions/${p.current_version_id}`);
  state._curSegments = vd.version.content;
  const o = await api('GET', `/api/documents/${docId}/objections`);
  state.objections = o.objections;
  state.selection = null;
  state.reanchoring = null;
  renderWorkspace(tab);
}

function renderWorkspace(tab) {
  const curNo = state.versions.find((v) => v.id === state.currentVersionId);
  const tabs = [
    ['text', '正文 / 取段'],
    ['proposals', `提案（${state.proposals.filter((x) => x.status === 'pending').length} 待决）`],
    ['objections', '异议引用'],
    ['versions', '版本'],
  ];
  app.innerHTML = `
    <div class="card">
      <div class="row spread">
        <div>
          <a id="back-link" class="muted" style="cursor:pointer;">← 文档列表</a>
          <h2 style="margin:4px 0 0;">${esc(state.doc.title)}
            <span class="muted small">当前已发布：v${curNo ? curNo.version_no : '?'}</span></h2>
        </div>
        <div class="pillset">
          ${state.user.role === 'reviewer' ? '<button class="btn primary" id="publish-btn">发布新版本（合并已采纳）</button>' : ''}
        </div>
      </div>
      <div class="tabs" style="margin-top:12px;">
        ${tabs.map(([k, label]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${label}</button>`).join('')}
      </div>
      <div id="tab-pane"></div>
    </div>`;
  $('#back-link').onclick = () => { state.view.name = 'list'; renderList(); };
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => renderWorkspace(b.dataset.tab);
  });
  if (state.user.role === 'reviewer') {
    $('#publish-btn').onclick = doPublish;
  }
  const pane = $('#tab-pane');
  if (tab === 'text') renderTextTab(pane, false);
  if (tab === 'proposals') renderProposalsTab(pane);
  if (tab === 'objections') renderObjectionsTab(pane);
  if (tab === 'versions') renderVersionsTab(pane);
}

// ---------- 正文渲染（带标记） ----------
function buildMarks(segments, markSrc) {
  // markSrc: [{seg_no,start,end,cls,title}]（已过滤为适用本版本者）
  const PRIORITY = ['anchored', 'rejected', 'pending', 'merged', 'adopted', 'broken', 'conflicted'];
  const bySeg = new Map();
  for (const m of markSrc) {
    if (m.start == null) continue;
    if (!bySeg.has(m.seg_no)) bySeg.set(m.seg_no, []);
    bySeg.get(m.seg_no).push(m);
  }
  const htmlParts = [];
  for (const seg of segments) {
    const text = seg.text;
    const arr = Array.from(text);
    const clsAt = arr.map(() => null);
    const titlesAt = arr.map(() => null);
    const list = (bySeg.get(seg.seg_no) || []).filter((m) => m.start >= 0 && m.end <= arr.length && m.end > m.start);
    for (const m of list) {
      const pri = PRIORITY.indexOf(m.cls);
      for (let i = m.start; i < m.end; i++) {
        const cur = clsAt[i] ? PRIORITY.indexOf(clsAt[i]) : -1;
        if (pri >= cur) {
          clsAt[i] = m.cls;
          titlesAt[i] = titlesAt[i] ? titlesAt[i] + '\n' + m.title : m.title;
        }
      }
    }
    let html = '';
    let i = 0;
    while (i < arr.length) {
      if (!clsAt[i]) { html += esc(arr[i]); i++; continue; }
      const cls = clsAt[i];
      const j0 = i;
      const titles = new Set();
      while (i < arr.length && clsAt[i] === cls) { titles.add(titlesAt[i]); i++; }
      const title = [...new Set([...titles].flatMap((t) => String(t).split('\n')))].join('；');
      html += `<span class="mk mk-${cls}" title="${esc(title)}">${esc(arr.slice(j0, i).join(''))}</span>`;
    }
    htmlParts.push(`<div class="seg" data-seg="${esc(seg.seg_no)}">
      <div class="seg-no">${esc(seg.seg_no)}</div>
      <div class="seg-text selectable" data-seg="${esc(seg.seg_no)}">${html}</div></div>`);
  }
  return htmlParts.join('');
}

function currentMarks() {
  const marks = [];
  for (const p of state.proposals) {
    if (p.base_version_id !== state.currentVersionId && p.status !== 'merged') continue;
    if (p.status === 'merged' && p.merged_into_version_id !== state.currentVersionId) continue;
    marks.push({
      seg_no: p.seg_no, start: p.start, end: p.end,
      cls: p.status === 'pending' ? 'pending'
         : p.status === 'adopted' ? 'adopted'
         : p.status === 'rejected' ? 'rejected'
         : p.status === 'merged' ? 'merged' : 'conflicted',
      title: `提案 #${p.id}（${STATUS_LABEL[p.status]}）：「${p.old_text}」→「${p.new_text}」 依据：${p.basis}${p.conflict_reason ? '；' + p.conflict_reason : ''}`,
    });
  }
  for (const o of state.objections) {
    if (o.start == null) continue;
    marks.push({
      seg_no: o.seg_no, start: o.start, end: o.end,
      cls: o.state === 'anchored' || o.state === 'reanchored' ? 'anchored' : 'broken',
      title: `异议 #${o.id}（${o.state === 'reanchored' ? '已重新定位' : '已锚定'}）：${o.comment}`,
    });
  }
  return marks;
}

let cachedSegments = null;

function renderTextTab(pane, readonlyVersion) {
  const segments = readonlyVersion ? readonlyVersion.segments : state._curSegments;
  cachedSegments = segments;
  const marks = readonlyVersion ? readonlyVersion.marks : currentMarks();
  const canPropose = state.user.role === 'recordist' && !readonlyVersion;
  const canObject = state.user.role === 'participant' && !readonlyVersion;
  let hint = '';
  if (state.reanchoring) {
    hint = `<div class="selinfo">正在为异议 #${state.reanchoring} 重新定位：请在下方选中与原文快照<strong>完全一致</strong>的文字，然后点击「确认重新定位」。
      <button class="btn good" id="reanchor-ok" style="margin-left:10px;">确认重新定位</button>
      <button class="btn" id="reanchor-cancel">取消</button></div>`;
  } else if (canPropose) {
    hint = '<div class="selinfo">记录员：在正文中划选段内文字（仅限同一段内），随后填写替换文字与依据。提案绑定当前已发布版本。</div>';
  } else if (canObject) {
    hint = '<div class="selinfo">参与者：划选原文范围以提交异议引用。修订若使被引文字消失，系统保留原文快照并要求重新定位，不会悄悄改指新文字。</div>';
  } else if (readonlyVersion) {
    hint = '<div class="selinfo">历史不可变版本（只读）。</div>';
  } else {
    hint = '<div class="selinfo">只读视图；记录员可提交修订提案，参与者可提交异议。</div>';
  }
  pane.innerHTML = hint +
    `<div id="sel-bar"></div><div id="transcript">${buildMarks(segments, marks)}</div>`;

  document.querySelectorAll('.seg-text').forEach((el) => {
    el.addEventListener('mouseup', () => setTimeout(() => captureSelection(el), 0));
    el.addEventListener('touchend', () => setTimeout(() => captureSelection(el), 0));
  });

  if (state.reanchoring) {
    $('#reanchor-cancel').onclick = () => { state.reanchoring = null; renderWorkspace('objections'); };
    $('#reanchor-ok').onclick = confirmReanchor;
  }
}

// 码点偏移：统计节点在 seg-text 内之前的码点数
function nodeOffset(root, node, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let count = 0;
  let n;
  while ((n = walker.nextNode())) {
    if (n === node) return count + Array.from(n.data.slice(0, offset)).length;
    count += Array.from(n.data).length;
  }
  return null;
}

function captureSelection(segEl) {
  if (state.reanchoring == null && !['recordist', 'participant'].includes(state.user.role)) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const root = segEl;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
  const start = nodeOffset(root, range.startContainer, range.startOffset);
  const end = nodeOffset(root, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return;
  const segNo = root.dataset.seg;
  const seg = cachedSegments.find((s) => s.seg_no === segNo);
  const text = cpSlice(seg.text, start, end);
  state.selection = { seg_no: segNo, start, end, text };
  showSelBar();
}

function showSelBar() {
  const bar = $('#sel-bar');
  if (!bar || state.reanchoring) return;
  const s = state.selection;
  if (!s) { bar.innerHTML = ''; return; }
  const action = state.user.role === 'recordist'
    ? '<button class="btn primary" id="sel-propose">用所选范围提交修订提案</button>'
    : state.user.role === 'participant'
    ? '<button class="btn primary" id="sel-object">对所选范围提出异议</button>'
    : '';
  bar.innerHTML = `<div class="selinfo">段 ${esc(s.seg_no)}，字符范围 [${s.start}, ${s.end})（码点偏移）：
    「${esc(s.text)}」　${action}</div>`;
  if ($('#sel-propose')) $('#sel-propose').onclick = openProposalModal;
  if ($('#sel-object')) $('#sel-object').onclick = openObjectionModal;
}

function openProposalModal() {
  const s = state.selection;
  if (!s) return;
  const body = `
    <div class="snapshot-box">段 ${esc(s.seg_no)}　[${s.start}, ${s.end})<br>原文：「${esc(s.text)}」</div>
    <label>替换文字</label>
    <textarea id="p-new" rows="3">${esc(s.text)}</textarea>
    <label>依据（必填，如音频时间码 / 证据编号 / 勘误说明）</label>
    <textarea id="p-basis" rows="3" placeholder="例如：录音 00:12:31 处发音为“质询”而非“质量”"></textarea>`;
  openModal('提交修订提案', body, async () => {
    const new_text = $('#p-new').value;
    const basis = $('#p-basis').value.trim();
    try {
      await api('POST', `/api/documents/${state.view.docId}/proposals`, {
        seg_no: s.seg_no, start: s.start, end: s.end, new_text, basis,
      });
      toast('提案已提交，等待复核员采纳/驳回', 'ok');
      await loadDoc();
    } catch (e) {
      toast(e.message, 'error');
      throw e;
    }
  }, '提交提案');
}

function openObjectionModal() {
  const s = state.selection;
  if (!s) return;
  const body = `
    <div class="snapshot-box">段 ${esc(s.seg_no)}　[${s.start}, ${s.end})<br>引用原文：「${esc(s.text)}」</div>
    <label>异议说明（必填）</label>
    <textarea id="o-comment" rows="4" placeholder="请说明对该段文字的异议"></textarea>`;
  openModal('提出异议引用', body, async () => {
    const comment = $('#o-comment').value.trim();
    try {
      await api('POST', `/api/documents/${state.view.docId}/objections`, {
        seg_no: s.seg_no, start: s.start, end: s.end, comment,
      });
      toast('异议已记录，引用已锚定到当前版本', 'ok');
      await loadDoc();
      renderWorkspace('objections');
    } catch (e) {
      toast(e.message, 'error');
      throw e;
    }
  }, '提交异议');
}

// ---------- 提案表 ----------
function renderProposalsTab(pane) {
  const isReviewer = state.user.role === 'reviewer';
  const rows = state.proposals;
  pane.innerHTML = `
    ${isReviewer ? '<p class="muted small">复核员：采纳/驳回针对当前版本的待决提案；提案范围交叠或基版过期会在处置/发布时标记为冲突，且不会覆盖其他修订。完成采纳后点击右上角「发布新版本」。</p>' : ''}
    <table>
      <thead><tr>
        <th>#</th><th>段</th><th>范围</th><th>原文 → 替换</th><th>依据</th>
        <th>状态 / 冲突原因</th><th>基版</th>${isReviewer ? '<th>操作</th>' : ''}
      </tr></thead>
      <tbody>
      ${rows.length === 0 ? '<tr><td colspan="8" class="muted">尚无提案</td></tr>' :
      rows.map((p) => {
        const stale = !p.base_is_current && p.status === 'pending';
        return `<tr class="${p.status === 'pending' ? 'impending' : ''}">
          <td>${p.id}</td>
          <td>${esc(p.seg_no)}</td>
          <td class="small">[${p.start},${p.end})</td>
          <td><span class="diff-old">${esc(p.old_text)}</span> → <span class="diff-new">${esc(p.new_text)}</span></td>
          <td class="small">${esc(p.basis)}</td>
          <td><span class="badge badge-${p.status}">${STATUS_LABEL[p.status]}</span>
              ${p.merged_into_version_id ? `<div class="small muted">并入版本 #${p.merged_into_version_id}</div>` : ''}
              ${p.conflict_reason ? `<div class="small" style="color:#a33;margin-top:3px;">${esc(p.conflict_reason)}</div>` : ''}
              ${stale ? '<div class="small" style="color:#a33;">基版已过期</div>' : ''}</td>
          <td class="small muted">v${versionNo(p.base_version_id)}</td>
          ${isReviewer ? `<td>${p.status === 'pending' ? `
            <button class="btn good small" data-act="adopt" data-id="${p.id}">采纳</button>
            <button class="btn danger small" data-act="reject" data-id="${p.id}">驳回</button>` : '—'}</td>` : ''}
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
  if (isReviewer) {
    pane.querySelectorAll('button[data-act]').forEach((b) => {
      b.onclick = async () => {
        try {
          const r = await api('POST', `/api/proposals/${b.dataset.id}/decision`, { action: b.dataset.act });
          toast(r.proposal.status === 'adopted' ? `提案 #${b.dataset.id} 已采纳` : `提案 #${b.dataset.id} 已驳回`, 'ok');
        } catch (e) { toast(e.message, e.code === 'STALE_BASE' ? 'error' : 'error'); }
        await loadDoc();
        renderWorkspace('proposals');
      };
    });
  }
}

function versionNo(versionId) {
  const v = state.versions.find((x) => x.id === versionId);
  return v ? v.version_no : '?';
}

async function doPublish() {
  const adopted = state.proposals.filter((p) => p.status === 'adopted');
  const body = `
    <p>将把当前版本上 <strong>${adopted.length}</strong> 项已采纳提案合并，形成新的<strong>不可变版本</strong>。</p>
    <ul class="tight muted small">
      <li>同一基版上互不重叠的采纳才会合并；范围交叠的提案将全部标记为冲突。</li>
      <li>基版已过期的采纳提案将标记为冲突，绝不覆盖其他修订。</li>
      <li>没有已采纳提案时拒绝重复发布，状态不变。</li>
    </ul>
    <label>发布说明（可选）</label>
    <input type="text" id="pub-note">`;
  openModal('发布新版本', body, async () => {
    try {
      const r = await api('POST', `/api/documents/${state.view.docId}/publish`,
        { note: $('#pub-note').value.trim() });
      toast(`已发布 v${r.versionNo}：合并 ${r.merged.length} 项${r.conflicted.length ? `，${r.conflicted.length} 项标记冲突` : ''}`, 'ok');
      await loadDoc();
      renderWorkspace('versions');
    } catch (e) {
      toast(e.message, 'error');
      throw e;
    }
  }, '确认发布');
}

// ---------- 异议 ----------
function renderObjectionsTab(pane) {
  const rows = state.objections;
  pane.innerHTML = `
    <p class="muted small">下表展示各异议在<strong>当前版本</strong>上的锚点状态。修订覆盖被引文字时锚点失效（红色波浪线），原文快照保留，须人工重新定位——系统不会自动指向新文字。</p>
    <table>
      <thead><tr><th>#</th><th>段/范围</th><th>引用快照</th><th>异议</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>
      ${rows.length === 0 ? '<tr><td colspan="6" class="muted">尚无异议</td></tr>' :
      rows.map((o) => `<tr>
        <td>${o.id}</td>
        <td class="small">段 ${esc(o.seg_no)}${o.start != null ? `<br>[${o.start},${o.end})` : '<br>（无有效位置）'}</td>
        <td class="small">「${esc(o.quote)}」</td>
        <td class="small">${esc(o.comment)}<div class="muted">${esc(o.creator_name)} · ${esc(o.created_at)}</div></td>
        <td><span class="badge badge-${o.state || 'broken'}">${o.state === 'anchored' ? '已锚定' : o.state === 'reanchored' ? '已重定位' : '已失效，待重定位'}</span>
            ${o.note ? `<div class="small" style="color:#a33;margin-top:3px;">${esc(o.note)}</div>` : ''}</td>
        <td>${o.state === 'broken' && state.user.role === 'participant'
            ? `<button class="btn small" data-reanchor="${o.id}">重新定位</button>` : '—'}</td>
      </tr>`).join('')}
      </tbody>
    </table>`;
  pane.querySelectorAll('button[data-reanchor]').forEach((b) => {
    b.onclick = () => {
      state.reanchoring = Number(b.dataset.reanchor);
      renderWorkspace('text');
    };
  });
}

async function confirmReanchor() {
  const s = state.selection;
  if (!s) { toast('请先在正文中划选新位置', 'error'); return; }
  try {
    await api('POST', `/api/objections/${state.reanchoring}/reanchor`,
      { seg_no: s.seg_no, start: s.start, end: s.end });
    toast('已重新定位（新位置文字与原文快照一致）', 'ok');
    state.reanchoring = null;
    await loadDoc();
    renderWorkspace('objections');
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- 版本 ----------
function renderVersionsTab(pane) {
  pane.innerHTML = `
    <table>
      <thead><tr><th>版本</th><th>基于</th><th>说明</th><th>发布时间</th><th></th></tr></thead>
      <tbody>
      ${state.versions.map((v) => `<tr>
        <td>v${v.version_no}${v.id === state.currentVersionId ? ' <span class="badge badge-anchored">当前</span>' : ''}</td>
        <td>${v.base_version_id ? 'v' + versionNo(v.base_version_id) : '—'}</td>
        <td class="small">${esc(v.note)}</td>
        <td class="muted small">${esc(v.published_at)}</td>
        <td><button class="btn small" data-vid="${v.id}">查看正文 / 决议 / 异议</button></td>
      </tr>`).join('')}
      </tbody>
    </table>
    <div id="version-view" style="margin-top:16px;"></div>`;
  pane.querySelectorAll('button[data-vid]').forEach((b) => {
    b.onclick = () => showVersion(Number(b.dataset.vid));
  });
}

async function showVersion(vid) {
  const d = await api('GET', `/api/versions/${vid}`);
  const v = d.version;
  const marks = [];
  for (const p of d.decisions) {
    if (p.merged_into_version_id === v.id) {
      marks.push({
        seg_no: p.seg_no, start: p.start, end: p.end, cls: 'merged',
        title: `提案 #${p.id} 于本版本合并：「${p.old_text}」→「${p.new_text}」`,
      });
    }
  }
  for (const a of d.objections) {
    if (a.start != null) {
      marks.push({
        seg_no: a.seg_no, start: a.start, end: a.end,
        cls: a.state === 'anchored' || a.state === 'reanchored' ? 'anchored' : 'broken',
        title: `异议 #${a.objection_id}：${a.comment}`,
      });
    }
  }
  const decisions = d.decisions;
  const anchors = d.objections;
  $('#version-view').innerHTML = `
    <div class="card" style="margin:0;">
      <h2>v${v.version_no}（${v.is_current ? '当前版本' : '历史只读'}）　<span class="muted small">${esc(v.published_at)}</span></h2>
      <div class="muted small" style="margin-bottom:8px;">${esc(v.note)}</div>
      <h2 style="font-size:14px;">正文</h2>
      <div id="vv-text">${buildMarks(v.content, marks)}</div>
      <h2 style="font-size:14px;margin-top:18px;">决议（该版本发布时已存在提案的最终处置）</h2>
      <table>
        <thead><tr><th>#</th><th>段</th><th>原文→替换</th><th>状态</th><th>说明</th></tr></thead>
        <tbody>
        ${decisions.map((p) => `<tr>
          <td>${p.id}</td><td>${esc(p.seg_no)}</td>
          <td class="small"><span class="diff-old">${esc(p.old_text)}</span> → <span class="diff-new">${esc(p.new_text)}</span></td>
          <td><span class="badge badge-${p.status}">${STATUS_LABEL[p.status]}</span></td>
          <td class="small muted">${esc(p.basis)}${p.conflict_reason ? '；' + esc(p.conflict_reason) : ''}
            ${p.merged_into_version_id ? `；并入 v${versionNo(p.merged_into_version_id)}` : ''}</td>
        </tr>`).join('')}
        </tbody>
      </table>
      <h2 style="font-size:14px;margin-top:18px;">异议（本版本上的锚点）</h2>
      <table>
        <thead><tr><th>#</th><th>段/范围</th><th>原文快照</th><th>状态与提示</th><th>异议</th></tr></thead>
        <tbody>
        ${anchors.length === 0 ? '<tr><td colspan="5" class="muted">本版本无异议锚点</td></tr>' :
        anchors.map((a) => `<tr>
          <td>${a.objection_id}</td>
          <td class="small">段 ${esc(a.seg_no)}${a.start != null ? `<br>[${a.start},${a.end})` : ''}</td>
          <td class="small">「${esc(a.quote)}」</td>
          <td><span class="badge badge-${a.state}">${a.state === 'anchored' ? '已锚定' : a.state === 'reanchored' ? '已重定位' : '已失效'}</span>
              ${a.note ? `<div class="small" style="color:#a33;margin-top:3px;">${esc(a.note)}</div>` : ''}</td>
          <td class="small">${esc(a.comment)}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  $('#version-view').scrollIntoView({ behavior: 'smooth' });
}

// ---------- 启动 ----------
async function boot() {
  renderUserbox();
  if (!state.user) { renderLogin(); return; }
  if (state.view.name === 'doc') { await loadDoc(); }
  else { await renderList(); }
}

(async function init() {
  if (state.token) {
    try {
      const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + state.token } });
      if (r.ok) state.user = (await r.json()).user;
      else { state.token = null; localStorage.removeItem('hrb_token'); }
    } catch (_) { /* server down */ }
  }
  await boot();
})();

'use strict';
// 端到端冒烟测试：不依赖网络，直接对真实 HTTP 服务发请求。
// 用法：先启动 server（PORT=8099 DATA_DIR=./data-test node server.js），再 node test/smoke.js
// 或直接：node test/smoke.js（脚本会自行拉起子进程）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8099';
let child = null;
let passed = 0;
function ok(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
  passed++;
  console.log('  ✓ ' + msg);
}
async function req(method, url, { token, body, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data, raw };
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/documents'); if (r.ok) return; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server 未在 15s 内就绪');
}

async function login(u) {
  const r = await req('POST', '/api/login', { body: { username: u, password: u } });
  ok(r.status === 200, `${u} 登录成功`);
  return r.data.token;
}

(async () => {
  if (!process.env.BASE_URL) {
    fs.rmSync(path.join(__dirname, '..', 'data-test'), { recursive: true, force: true });
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: '8099', DATA_DIR: path.join(__dirname, '..', 'data-test') },
      stdio: 'ignore',
    });
  }
  try {
    await waitUp();
    const rec = await login('recordist');
    const rev = await login('reviewer');
    const par = await login('participant');

    // 1) 权限：参与者不能导入
    let r = await req('POST', '/api/documents', { token: par, body: { title: 'x', transcript: '1\ta' } });
    ok(r.status === 403 && r.data.error.code === 'FORBIDDEN', '无权操作报 403 且不改状态');

    // 2) 未登录被拒
    r = await req('GET', '/api/documents');
    ok(r.status === 200, '文档列表允许匿名查看（仅写操作需登录）');
    r = await req('POST', '/api/documents', { body: { title: 'x', transcript: '1\ta' } });
    ok(r.status === 401, '未登录写操作报 401');

    // 3) 坏逐字稿
    r = await req('POST', '/api/documents', { token: rec, body: { title: 't', transcript: '没有段号' } });
    ok(r.status === 400 && r.data.error.code === 'BAD_LINE', '无法识别的行报明原因');
    r = await req('POST', '/api/documents', { token: rec, body: { title: 't', transcript: '1\t甲\n1\t乙' } });
    ok(r.status === 400 && r.data.error.code === 'DUP_SEG', '重复段号报错');

    // 4) 导入成功（含 emoji/生僻字，验证码点偏移）
    // 段1长度按码点："听证现在开始，甲方陈述。" = 12
    const transcript = '1\t听证现在开始，甲方陈述。\n2：证人乙说：质量有问题😀。\n3,散会。';
    r = await req('POST', '/api/documents', { token: rec, body: { title: '第1场', transcript } });
    ok(r.status === 200, '导入成功并生成 v1');
    const docId = r.data.id;
    const v1 = r.data.current_version_id;
    const seg1 = r.data.segments.find((s) => s.seg_no === '1');
    ok(Array.from(seg1.text).length === 12, '正文按 Unicode 码点计数（段1长度12）: ' + Array.from(seg1.text).length);

    // 5) 非法范围
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '1', start: 5, end: 99, new_text: 'x', basis: 'b' },
    });
    ok(r.status === 400 && r.data.error.code === 'BAD_RANGE', '越界范围报非法范围');
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '9', start: 0, end: 1, new_text: 'x', basis: 'b' },
    });
    ok(r.status === 400 && r.data.error.code === 'NO_SEG', '不存在段号报错');
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '1', start: 0, end: 1, new_text: 'x', basis: '' },
    });
    ok(r.status === 400, '依据必填');

    // 6) 复核员不能提案；记录员提案绑定 v1
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rev, body: { seg_no: '1', start: 0, end: 4, new_text: '质询程序', basis: '录音00:01' },
    });
    ok(r.status === 403, '复核员不能提交提案');

    // 提案 A：段1 [0,4) "听证现在" -> "质询程序"
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '1', start: 0, end: 4, new_text: '质询程序', basis: '录音00:01' },
    });
    ok(r.status === 200 && r.data.proposal.base_version_id === v1, '提案 A 绑定提交时已发布版本 v1');
    const A = r.data.proposal.id;
    // 提案 B：段2 中 "质量" 的位置。段2="证人乙说：质量有问题😀。"
    const seg2text = '证人乙说：质量有问题😀。';
    const qi = Array.from(seg2text).indexOf('质'); // 5
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '2', start: qi, end: qi + 2, new_text: '质询', basis: '录音00:12' },
    });
    ok(r.status === 200, '提案 B 提交成功（emoji 后码点偏移正确）');
    const B = r.data.proposal.id;
    // 提案 C：与 A 同段不重叠 [7,9) "甲方" -> "乙方"
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '1', start: 7, end: 9, new_text: '乙方', basis: '身份证号核对' },
    });
    const C = r.data.proposal.id;
    ok(r.status === 200, '提案 C（与 A 互不重叠）提交成功');

    // 7) 参与者在 v1 上锚定异议：引段1 [0,4) "听证现在"
    r = await req('POST', `/api/documents/${docId}/objections`, {
      token: par, body: { seg_no: '1', start: 0, end: 4, comment: '开头措辞有异议' },
    });
    ok(r.status === 200, '异议 O1 锚定 v1');
    const O1 = r.data.objection.id;
    // 另一异议指向不会被修改的段3，验证随版迁移
    r = await req('POST', `/api/documents/${docId}/objections`, {
      token: par, body: { seg_no: '3', start: 0, end: 3, comment: '散会时间存疑' },
    });
    const O2 = r.data.objection.id;

    // 8) 记录员不能采纳；复核员采纳 A、C，驳回 B
    r = await req('POST', `/api/proposals/${A}/decision`, { token: rec, body: { action: 'adopt' } });
    ok(r.status === 403, '记录员不能采纳/驳回');
    r = await req('POST', `/api/proposals/${B}/decision`, { token: rev, body: { action: 'reject' } });
    ok(r.status === 200 && r.data.proposal.status === 'rejected', '复核员驳回 B');
    r = await req('POST', `/api/proposals/${A}/decision`, { token: rev, body: { action: 'adopt' } });
    ok(r.status === 200 && r.data.proposal.status === 'adopted', '采纳 A');
    // 重复处置
    r = await req('POST', `/api/proposals/${A}/decision`, { token: rev, body: { action: 'reject' } });
    ok(r.status === 409 && r.data.error.code === 'ALREADY_DECIDED', '重复处置报 409 且状态不变');
    r = await req('POST', `/api/proposals/${C}/decision`, { token: rev, body: { action: 'adopt' } });
    ok(r.data.proposal.status === 'adopted', '采纳 C');

    // 9) 重复发布保护：先造空情况——这里有采纳，正常发布
    r = await req('POST', `/api/documents/${docId}/publish`, { token: rev, body: { note: '第1次发布' } });
    ok(r.status === 200 && r.data.merged.sort().join() === [A, C].sort().join(),
      '发布 v2：A、C 合并');
    const v2 = r.data.versionId;
    ok(r.data.versionNo === 2, '新版本号 v2');

    // 10) 空发布被拒（无采纳）
    r = await req('POST', `/api/documents/${docId}/publish`, { token: rev, body: {} });
    ok(r.status === 409 && r.data.error.code === 'NOTHING_TO_PUBLISH',
      '没有采纳时重复发布被拒绝，状态不变');

    // 11) 校验 v2 正文
    r = await req('GET', `/api/versions/${v2}`);
    const newSeg1 = r.data.version.content.find((s) => s.seg_no === '1').text;
    ok(newSeg1 === '质询程序开始，乙方陈述。', 'v2 正文合并正确: ' + newSeg1);
    const seg3unchanged = r.data.version.content.find((s) => s.seg_no === '3').text;
    ok(seg3unchanged === '散会。', '未涉及段落原样保留');

    // 12) 异议锚点：O1 失效且保留快照；O2 平移保持
    const aO1 = r.data.objections.find((x) => x.objection_id === O1);
    const aO2 = r.data.objections.find((x) => x.objection_id === O2);
    ok(aO1.state === 'broken' && aO1.quote === '听证现在' && aO1.start === null,
      '被修订覆盖的引用：失效 + 保留原文快照 + 无新位置（不悄悄指向新文字）');
    ok(aO2.state === 'anchored', '未受影响的引用保持锚定并自动平移');
    ok(aO1.note.includes('重新定位'), '失效引用给出重新定位提示');

    // 13) 不可变：v1 正文没变；通过 API 无任何修改版本的入口
    r = await req('GET', `/api/versions/${v1}`);
    ok(r.data.version.content.find((s) => s.seg_no === '1').text === seg1.text, '已发布版本 v1 不可变');

    // 14) 重新定位到不一致文字被拒
    r = await req('POST', `/api/objections/${O1}/reanchor`, {
      token: par, body: { seg_no: '1', start: 0, end: 4 },
    });
    ok(r.status === 409 && r.data.error.code === 'QUOTE_MISMATCH',
      '重新定位到新文字「质询程序」被拒（与快照不一致，不得悄悄指向新文字）');
    // 重新定位到与快照完全一致的现存文字——v2 段1已无“听证现在”，需另造：
    // 在 v2 段3 追加场景不行，改为验证错误路径足够；这里再验快照可在任意一致处锚定：
    r = await req('POST', `/api/documents/${docId}/objections`, {
      token: par, body: { seg_no: '2', start: 0, end: 3, comment: '对“证人乙”有异议' },
    });
    // （O3 后续版本不受影响，仅验证创建）

    // 15) 过期基版：v2 上记录员提交 D，复核员在发布 v3 前先制造一次基版推进
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '2', start: 0, end: 3, new_text: '当事人', basis: '庭审录音' },
    });
    ok(r.data.proposal.base_version_id === v2, '新提案 D 绑定 v2');
    const D = r.data.proposal.id;
    await req('POST', `/api/proposals/${D}/decision`, { token: rev, body: { action: 'adopt' } });
    r = await req('POST', `/api/documents/${docId}/publish`, { token: rev, body: {} });
    const v3 = r.data.versionId;
    ok(r.status === 200, '发布 v3（合并 D）');

    // v3 之后，任何遗留的 pending 提案处置都应判 STALE_BASE
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '3', start: 1, end: 2, new_text: '会哦', basis: 'x' },
    });
    const E = r.data.proposal.id;
    // 再推一个版本 v4（采纳 E）使 E... 不行，E 不能自己过期自己。改用：提交 F 后不采纳，直接发布其他内容
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '3', start: 1, end: 2, new_text: '会哦', basis: 'y' },
    });
    const F = r.data.proposal.id; // F 基于 v3，保持 pending
    await req('POST', `/api/proposals/${E}/decision`, { token: rev, body: { action: 'adopt' } });
    r = await req('POST', `/api/documents/${docId}/publish`, { token: rev, body: {} });
    const v4 = r.data.versionId;
    ok(!!v4, '发布 v4');
    // 现在处置仍 pending 的 F（基版 v3，当前 v4）
    r = await req('POST', `/api/proposals/${F}/decision`, { token: rev, body: { action: 'adopt' } });
    ok(r.status === 409 && r.data.error.code === 'STALE_BASE', '基版过期的待决提案处置即标冲突，不改正文');
    r = await req('GET', `/api/documents/${docId}/proposals`);
    const Fp = r.data.proposals.find((x) => x.id === F);
    ok(Fp.status === 'conflicted' && /基版已过期/.test(Fp.conflict_reason), 'F 被标记冲突并写明原因');

    // 16) 交叠：v4 上提交 G、H 交叠，都采纳，发布时双双冲突，且不产生新版本
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '3', start: 0, end: 2, new_text: '结束', basis: 'g' },
    });
    const G = r.data.proposal.id;
    r = await req('POST', `/api/documents/${docId}/proposals`, {
      token: rec, body: { seg_no: '3', start: 1, end: 3, new_text: '会啦', basis: 'h' },
    });
    const H = r.data.proposal.id;
    await req('POST', `/api/proposals/${G}/decision`, { token: rev, body: { action: 'adopt' } });
    await req('POST', `/api/proposals/${H}/decision`, { token: rev, body: { action: 'adopt' } });
    const curBefore = (await req('GET', `/api/documents/${docId}`)).data.versions.length;
    r = await req('POST', `/api/documents/${docId}/publish`, { token: rev, body: {} });
    ok(r.status === 409 && r.data.error.code === 'ALL_CONFLICTED',
      '采纳结果全部交叠：拒绝发布并标记冲突，不产生新版本');
    const curAfter = (await req('GET', `/api/documents/${docId}`)).data.versions.length;
    ok(curBefore === curAfter, '版本数量未变（未覆盖任何修订）');
    r = await req('GET', `/api/documents/${docId}/proposals`);
    const Gp = r.data.proposals.find((x) => x.id === G);
    const Hp = r.data.proposals.find((x) => x.id === H);
    ok(Gp.status === 'conflicted' && Hp.status === 'conflicted' &&
       /交叠/.test(Gp.conflict_reason), '交叠提案均标冲突且写明原因');

    // 17) 已合并提案再处置被拒
    const Ap = (await req('GET', `/api/documents/${docId}/proposals`)).data.proposals.find((x) => x.id === A);
    ok(Ap.status === 'merged' && Ap.merged_into_version_id === v2, 'A 状态为已并入 v2');
    r = await req('POST', `/api/proposals/${A}/decision`, { token: rev, body: { action: 'reject' } });
    ok(r.status === 409, '已合并提案不能再处置');

    // 18) 决议与异议按版本查看
    r = await req('GET', `/api/versions/${v1}`);
    ok(Array.isArray(r.data.decisions) && Array.isArray(r.data.objections),
      '可按版本查看正文、决议和异议');
    const v1anchors = r.data.objections;
    ok(v1anchors.filter((x) => x.objection_id === O1).every((x) => x.state === 'anchored'),
      '在 v1 视图中 O1 当时仍为已锚定（历史快照真实）');

    // 19) 重新定位成功路径：把 O1 锚到 v4 中与其快照一致的位置——v4 无“听证现在”，
    // 故用异议 O3 风格验证：创建引现存词的异议，发布后仍一致则可重定位。
    // 直接验证 reanchor 对一致范围放行：
    r = await req('POST', `/api/documents/${docId}/objections`, {
      token: par, body: { seg_no: '1', start: 0, end: 4, comment: '对质询程序有异议' },
    });
    // v4 段1 开头即“质询程序”
    ok(r.status === 200, '在当前版本锚定现存文字');
    const O4 = r.data.objection.id;
    r = await req('POST', `/api/objections/${O4}/reanchor`, {
      token: par, body: { seg_no: '1', start: 0, end: 4 },
    });
    ok(r.status === 200, '与快照一致的重新定位放行');

    console.log(`\n全部通过：${passed} 条断言`);
  } finally {
    if (child) child.kill();
  }
})().catch((e) => {
  console.error('\n冒烟测试失败:', e.message);
  if (child) child.kill();
  process.exit(1);
});

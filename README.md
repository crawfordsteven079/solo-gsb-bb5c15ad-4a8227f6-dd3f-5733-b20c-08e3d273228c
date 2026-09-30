# 听证校订台（Hearing Revision Bench）

供听证会**记录员**与**复核员**使用的网页校订台。记录员导入带段号的 UTF-8 逐字稿、
按段内字符范围提交替换文字与依据；复核员采纳/驳回提案并发布**不可变版本**；
**参与者**可对原文范围留下异议引用，修订使被引文字消失时保留原文快照并要求人工重新定位，
系统绝不悄悄改指新文字。

技术栈：Node.js（Express）+ SQLite（better-sqlite3，同步事务）+ 浏览器原生前端（无构建步骤）。

---

## 一键启动（Docker Compose）

```bash
docker compose up -d --build
```

启动后访问：

- 地址：**http://localhost:8080**
- 端口：宿主 `8080` → 容器 `8080`（可用环境变量 `HOST_PORT` 修改）

停止：

```bash
docker compose down          # 保留数据（命名卷 bench-data）
docker compose down -v       # 同时删除数据卷
```

查看日志：`docker compose logs -f`

## 本地直接运行（不用 Docker）

需要 Node.js ≥ 20。

```bash
npm install
# 可选：单独初始化数据库（建表 + 种子账户，幂等；不执行也会在启动时自动初始化）
DATA_DIR=./data node init.js
# 启动
DATA_DIR=./data PORT=8080 node server.js
```

访问 http://localhost:8080 。

冒烟测试（自动拉起临时服务、跑完整端到端用例后退出）：

```bash
node test/smoke.js
```

## 内置账户

首次初始化数据库时创建三个角色，**默认密码与用户名相同**：

| 用户名        | 角色   | 能做什么                                                       |
|---------------|--------|----------------------------------------------------------------|
| `recordist`   | 记录员 | 导入逐字稿（生成 v1）；在当前已发布版本上提交修订提案          |
| `reviewer`    | 复核员 | 采纳 / 驳回提案；发布新版本；查看全部版本                      |
| `participant` | 参与者 | 对原文范围提出异议引用；对失效引用进行人工重新定位             |

## 配置（环境变量）

| 变量                  | 默认值        | 说明                                             |
|-----------------------|---------------|--------------------------------------------------|
| `PORT`                | `8080`        | 容器/服务监听端口                                |
| `HOST_PORT`           | `8080`        | 仅 Compose：映射到宿主机的端口                   |
| `DATA_DIR`            | `/data`       | SQLite 数据库目录（容器内），本地运行可设 `./data` |
| `DB_FILE`             | `hearing.db`  | 数据库文件名（位于 `DATA_DIR` 内）                |
| `PASSWORD_RECORDIST`  | `recordist`   | 记录员初始密码（**仅首次建库时生效**）            |
| `PASSWORD_REVIEWER`   | `reviewer`    | 复核员初始密码（仅首次建库时生效）                |
| `PASSWORD_PARTICIPANT`| `participant` | 参与者初始密码（仅首次建库时生效）                |

Compose 下可在项目目录放 `.env`，例如：

```env
HOST_PORT=9090
PASSWORD_REVIEWER=s3cret
```

数据持久化：Compose 使用命名卷 `bench-data` 挂载到容器 `/data`。
本地运行把 `DATA_DIR` 指到任意目录即可。

## 逐字稿格式

- 编码：**UTF-8**（允许 BOM，自动去除）。
- 每行一段，格式：`段号 + 分隔符 + 正文`。
- 分隔符支持：制表符（Tab）、半角逗号 `,`、中文逗号 `，`、顿号 `、`、句点 `. / ．`、冒号 `: / ：`。
- 空行跳过；段号不可重复；无法识别的行、重复段号都会报明行号/段号且不创建文档。

示例见 [`examples/sample-transcript.txt`](examples/sample-transcript.txt)：

```
1	听证现在开始，甲方陈述。
2：证人乙说：质量有问题。
3,主持人宣布休会十分钟。
```

字符范围使用 **Unicode 码点偏移**（`[start, end)`，不含 end），对中文与 emoji 一致安全。

## 工作流与业务规则

### 提案（记录员 → 复核员）

1. 记录员在**当前已发布版本**的某一段内划选字符范围，填写替换文字与**依据**（必填）。
2. 提案**绑定提交时的已发布版本**（`base_version_id`），并保存服务端校验后的原文快照。
3. 复核员可**采纳**或**驳回**待决提案；重复处置返回 `409 ALREADY_DECIDED`，状态不变。
4. 处置时若提案基版已不是当前版本，返回 `409 STALE_BASE`，提案标记为**冲突**并写明原因。

### 发布（合并为不可变版本）

复核员点击「发布新版本」：

- 同一基版上**互不重叠**的已采纳提案被合并为新正文，生成下一不可变版本，
  提案状态变为「已合并」并记录所并入版本。
- **范围交叠**的已采纳提案**全部**标记为冲突（不静默挑选其一），写明冲突段号与范围。
- **基版已过期**的已采纳提案标记为冲突，**绝不覆盖其他修订**。
- 若所有采纳提案都冲突，返回 `409 ALL_CONFLICTED`，冲突标记保留，**不产生新版本**。
- 没有任何已采纳提案时返回 `409 NOTHING_TO_PUBLISH`，拒绝重复发布，状态不变。
- 每个版本一经发布即不可变：正文、发布说明、当时的决议与异议锚点均可按版本查看。

### 异议引用（参与者）

- 参与者对当前版本某段原文范围提交异议，系统校验范围并保存**原文快照**。
- 发布时锚点逐版迁移：未被修订触及的引用自动平移并再次校验文字；
  一旦修订覆盖被引范围，锚点状态变为「已失效，待重定位」，
  **保留原文快照**、清空位置并给出提示——不会悄悄指向新文字。
- 参与者可发起「重新定位」：只有新位置文字与**原文快照完全一致**才允许锚定
  （`409 QUOTE_MISMATCH` 拒绝不一致位置），状态记为「已重定位」。

### 错误处理（均不改状态）

| 场景           | 响应                              |
|----------------|-----------------------------------|
| 未登录         | `401 UNAUTHENTICATED`             |
| 角色无权       | `403 FORBIDDEN`（含所需角色说明） |
| 段号/范围非法  | `400 NO_SEG / BAD_RANGE`（含段长）|
| 依据/正文缺失  | `400 BAD_INPUT`                   |
| 重复采纳/驳回  | `409 ALREADY_DECIDED`             |
| 基版过期       | `409 STALE_BASE`                  |
| 范围交叠       | `409 ALL_CONFLICTED`（标冲突）    |
| 重复发布       | `409 NOTHING_TO_PUBLISH`          |
| 重定位文字不符 | `409 QUOTE_MISMATCH`              |

## HTTP API 摘要

- `POST /api/login`、`GET /api/me`
- `GET /api/documents`；`POST /api/documents`（记录员导入）
- `GET /api/documents/:id`；`GET /api/documents/:id/proposals`；`GET /api/documents/:id/objections`
- `POST /api/documents/:id/proposals`（记录员）
- `POST /api/proposals/:pid/decision`（复核员，`{"action":"adopt"|"reject"}`）
- `POST /api/documents/:id/publish`（复核员）
- `POST /api/documents/:id/objections`（参与者）；`POST /api/objections/:oid/reanchor`
- `GET /api/versions/:id`：版本正文 + 决议列表 + 该版本异议锚点

认证使用登录返回的 Bearer Token（前端保存在 localStorage）。

## 目录结构

```
server.js            Express 服务与全部 API/事务
core.js              解析、范围校验、合并、异议锚点迁移（纯函数）
db.js                SQLite 建表、会话、种子账户
init.js              独立初始化脚本（幂等）
public/              单页前端（index.html / app.js / style.css）
test/smoke.js        端到端冒烟测试（47 条断言）
examples/            示例逐字稿
Dockerfile           含依赖安装与初始化（启动即自动建库）
docker-compose.yml   一键启动 + 数据卷
```

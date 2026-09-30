# 听证校订台 —— Node.js + SQLite + 浏览器前端
FROM node:20-bookworm-slim

# better-sqlite3 使用预编译二进制；保留构建工具以防回退到源码编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 复制应用代码
COPY server.js db.js core.js init.js ./
COPY public ./public

# 数据库存放目录（可通过 volume 持久化）
RUN mkdir -p /data
ENV DATA_DIR=/data \
    PORT=8080 \
    NODE_ENV=production

EXPOSE 8080
VOLUME ["/data"]

# 初始化（建表 + 种子账户）与启动合一：server 启动时自动幂等初始化
CMD ["node", "server.js"]

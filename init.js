'use strict';
// 独立初始化脚本：建表 + 种子账户（幂等）。容器启动时 server.js 也会自动调用。
// 用法：DATA_DIR=./data node init.js
const { initDb, getDb } = require('./db');

const dataDir = process.env.DATA_DIR || './data';
const db = initDb(dataDir);
const users = db.prepare('SELECT username, display_name, role FROM users ORDER BY id').all();
console.log('初始化完成，数据库目录：', dataDir);
console.table(users);
getDb().close();

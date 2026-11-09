#!/usr/bin/env node
/**
 * 端到端验证：通过 PaperTodo 的本地 MCP 管道造一条带时间标记的 Todo，
 * 检查 NLTodo 是否真的把提醒写进了宿主。
 *
 * 前置：PaperTodo 正在运行且未关闭 MCP 接口。
 * 用法：node test/host-e2e.mjs [表达式] [等待秒数]
 */

import net from 'node:net';

const PIPE = '\\\\.\\pipe\\PaperTodo-Mcp-Api-v1';
const EXPRESSION = process.argv[2] || '@in2m';
const WAIT_SECONDS = Number(process.argv[3] || 3);

function call(socket, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      socket.off('data', onData);
      reject(new Error('管道响应超时'));
    }, timeoutMs);

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.off('data', onData);
      const line = buffer.slice(0, newline).trim();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`响应不是合法 JSON: ${line.slice(0, 200)}`));
      }
    }

    socket.on('data', onData);
    socket.write(JSON.stringify(payload) + '\n');
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PIPE);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const socket = await connect();
  socket.setEncoding('utf8');

  const binding = await call(socket, { method: 'get_workspace_binding', params: {} });
  const token = binding?.result?.token ?? binding?.token;
  if (!token) throw new Error(`拿不到 workspace token: ${JSON.stringify(binding)}`);

  const text = `NLTodo 验证 ${EXPRESSION}`;
  const created = await call(socket, {
    method: 'create_todo_paper',
    params: { title: 'NLTodo 验证', show: false, todos: [{ text }] },
    workspace_token: token
  });

  const paperId = created?.result?.paper_id ?? created?.result?.paperId;
  if (!paperId) throw new Error(`建纸片失败: ${JSON.stringify(created)}`);
  console.log(`[1] 已建测试纸片 ${paperId}，Todo 文本: ${text}`);

  await sleep(WAIT_SECONDS * 1000);

  const fetched = await call(socket, {
    method: 'get_paper',
    params: { paper_id: paperId },
    workspace_token: token
  });
  const todos = fetched?.result?.todos ?? fetched?.result?.paper?.todos ?? [];
  console.log('[2] 宿主侧 Todo 快照:');
  for (const todo of todos) {
    console.log(`    text=${JSON.stringify(todo.text)}`);
    console.log(`    reminder_at=${todo.reminder_at ?? todo.reminderAt ?? '(空)'}`);
    console.log(`    reminder_triggered=${todo.reminder_triggered ?? todo.reminderTriggered ?? false}`);
  }

  const cleaned = await call(socket, {
    method: 'delete_paper',
    params: { paper_id: paperId },
    workspace_token: token
  });
  console.log(`[3] 已清理测试纸片: ${JSON.stringify(cleaned?.result ?? cleaned)}`);

  socket.end();
}

main().catch((error) => {
  console.error('验证失败:', error.message);
  process.exitCode = 1;
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 载入 vendor 包（IIFE，模拟浏览器全局），再载入解析器
const vendorSource = fs.readFileSync(path.join(ROOT, 'web', 'vendor', 'chrono-zh-en.min.js'), 'utf8');
globalThis.NLTime = new Function(vendorSource + '; return NLTime;')();

const { parseText } = require(path.join(ROOT, 'web', 'parser.js'));

// 基准时间：2026-11-09（周一）19:43 本地时间
const NOW = new Date(2026, 10, 9, 19, 43, 0, 0);

function localOf(iso) {
  const ms = Date.parse(iso);
  assert.ok(Number.isFinite(ms), `无法解析 ISO: ${iso}`);
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
}

function expectAt(text, expected, options) {
  const result = parseText(text, NOW, options);
  assert.strictEqual(result.ok, true, `${text} 解析失败: ${result.reason}`);
  assert.deepStrictEqual(localOf(result.value.resolvedAt), expected, `${text} -> ${result.value.resolvedAt}`);
  return result;
}

function expectFail(text, reason, options) {
  const result = parseText(text, NOW, options);
  assert.strictEqual(result.ok, false, `${text} 本应失败，实际 ${result.ok ? result.value.resolvedAt : ''}`);
  assert.strictEqual(result.reason, reason, `${text} 的 reason`);
  return result;
}

// ------------------------------------------------------------ 主路径

test('明天下午三点交材料 -> 次日 15:00', () => {
  const r = expectAt('明天下午三点交材料', [2026, 11, 10, 15, 0]);
  assert.strictEqual(r.value.matchedText, '明天下午三点');
  assert.strictEqual(r.value.kind, 'datetime');
  assert.deepStrictEqual(r.value.span, [0, 6]);
});

test('周三上午10点 -> 未来的周三，不是上周', () => {
  expectAt('周三上午10点开会', [2026, 11, 11, 10, 0]);
});

test('11月12日17:00 -> 今年，不是去年', () => {
  expectAt('11月12日17:00发布', [2026, 11, 12, 17, 0]);
});

test('今晚8点 -> 今天 20:00', () => {
  expectAt('今晚8点', [2026, 11, 9, 20, 0]);
});

test('下周三15:00', () => {
  expectAt('下周三15:00 评审', [2026, 11, 18, 15, 0]);
});

test('相对时间：半小时后 / 两小时后 / 一个半小时后', () => {
  expectAt('半小时后提醒我', [2026, 11, 9, 20, 13]);
  expectAt('两小时后', [2026, 11, 9, 21, 43]);
  expectAt('一个半小时后', [2026, 11, 9, 21, 13]);
});

test('复合时长：一个小时十分钟后 = 70 分钟', () => {
  // chrono 只会匹配到最后一段「十分钟后」，必须由时长补丁接管
  const r = expectAt('一个小时十分钟后', [2026, 11, 9, 20, 53]);
  assert.strictEqual(r.value.matchedText, '一个小时十分钟后');
  assert.strictEqual(r.value.kind, 'relative');
  expectAt('一小时十分钟后', [2026, 11, 9, 20, 53]);
  expectAt('两个小时二十分钟后', [2026, 11, 9, 22, 3]);
  expectAt('两小时三十分钟后', [2026, 11, 9, 22, 13]);
});

test('刻钟与中文数字分钟', () => {
  expectAt('一刻钟后', [2026, 11, 9, 19, 58]);
  expectAt('三刻钟后', [2026, 11, 9, 20, 28]);
  expectAt('二十五分钟后', [2026, 11, 9, 20, 8]);
  expectAt('十分钟之内', [2026, 11, 9, 19, 53]);
});

test('后天 / 大后天（chrono 的盲区，P0 补丁）', () => {
  const r = expectAt('后天', [2026, 11, 11, 9, 0]);
  assert.strictEqual(r.value.kind, 'date');
  expectAt('大后天', [2026, 11, 12, 9, 0]);
});

// ------------------------------------------------------ 维度补全

test('只有日期：补 09:00', () => {
  expectAt('明天', [2026, 11, 10, 9, 0]);
  expectAt('3天后再说', [2026, 11, 12, 9, 0]);
  expectAt('下周一交报告', [2026, 11, 16, 9, 0]);
  expectAt('12月1日', [2026, 12, 1, 9, 0]);
});

test('时段词：用代表时刻而不是时段起点', () => {
  expectAt('明天上午', [2026, 11, 10, 9, 0]);
  expectAt('明天下午', [2026, 11, 10, 15, 0]);
  expectAt('明天晚上', [2026, 11, 10, 20, 0]);
  expectAt('后天下午', [2026, 11, 11, 15, 0]);
});

test('月份日期落到最近一次未来', () => {
  expectAt('11月1日', [2027, 11, 1, 9, 0]);
});

// ------------------------------------------------------ 裸时间策略

test('裸时间已过：默认判失败', () => {
  expectFail('17:00 开会', 'past_time');
  expectFail('三点开会', 'past_time');
});

test('裸时间已过：开启 rollover 后顺延到明天', () => {
  expectAt('17:00 开会', [2026, 11, 10, 17, 0], { rollover: true });
  expectAt('三点开会', [2026, 11, 10, 15, 0], { rollover: true });
});

test('裸时间未到：当天生效', () => {
  const morning = new Date(2026, 10, 9, 8, 0, 0, 0);
  const r = parseText('17:00 开会', morning, { rollover: false });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(localOf(r.value.resolvedAt), [2026, 11, 9, 17, 0]);
});

test('1-6 点按下午理解（D-06）', () => {
  const morning = new Date(2026, 10, 9, 8, 0, 0, 0);
  const r = parseText('三点开会', morning, { rollover: false });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(localOf(r.value.resolvedAt), [2026, 11, 9, 15, 0]);
});

// ------------------------------------------------------ 负向

test('没有时间表达', () => {
  expectFail('吃饭', 'no_expression');
  expectFail('', 'no_expression');
  expectFail('买牛奶和鸡蛋', 'no_expression');
});

test('过去的时间', () => {
  expectFail('昨天', 'past_time');
});

test('@ 语法已废弃', () => {
  expectFail('任务 @17tomorrow', 'no_expression');
  expectFail('任务 @in25m', 'no_expression');
});

// ------------------------------------------------------ 单段假设

test('多个时间表达只取第一段', () => {
  const r = expectAt('3天后再说，5点开会', [2026, 11, 12, 9, 0]);
  assert.strictEqual(r.value.matchedText, '3天后');
});

test('span 指向原文里的片段', () => {
  const text = '明天下午三点交材料';
  const r = parseText(text, NOW);
  const [start, end] = r.value.span;
  assert.strictEqual(text.slice(start, end), r.value.matchedText);
});

// ------------------------------------------------------ 英文

test('英文表达', () => {
  expectAt('remind me tomorrow at 5pm', [2026, 11, 10, 17, 0]);
  expectAt('in 25 minutes', [2026, 11, 9, 20, 8]);
  expectAt('next friday at 3pm', [2026, 11, 20, 15, 0]);
  expectAt('tomorrow morning', [2026, 11, 10, 8, 0]);
});

// ------------------------------------------------------ 内部工具

test('中文数字', () => {
  const { cnNumber } = require(path.join(ROOT, 'web', 'parser.js'))._internal;
  assert.strictEqual(cnNumber('一'), 1);
  assert.strictEqual(cnNumber('两'), 2);
  assert.strictEqual(cnNumber('十'), 10);
  assert.strictEqual(cnNumber('十二'), 12);
  assert.strictEqual(cnNumber('二十'), 20);
  assert.strictEqual(cnNumber('二十五'), 25);
  assert.strictEqual(cnNumber('7'), 7);
  assert.ok(Number.isNaN(cnNumber('半')));
});

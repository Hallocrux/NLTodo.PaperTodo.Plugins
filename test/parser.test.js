'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { parseText } = require(path.join(__dirname, '..', 'web', 'parser.js'));

// 固定基准时间：2026-11-09（周一）17:28 本地时间
const NOW = new Date(2026, 10, 9, 17, 28, 0, 0);

function localOf(iso) {
  const ms = Date.parse(iso);
  assert.ok(Number.isFinite(ms), `无法解析 ISO: ${iso}`);
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
}

function expectAt(result, [y, mo, d, h, mi]) {
  assert.strictEqual(result.ok, true, `解析失败: ${result.reason}`);
  assert.deepStrictEqual(localOf(result.value.resolvedAt), [y, mo, d, h, mi]);
}

test('@17tomorrow -> 次日 17:00', () => {
  const result = parseText('询问详细信息 @17tomorrow', NOW);
  expectAt(result, [2026, 11, 10, 17, 0]);
  assert.strictEqual(result.value.expression, '@17tomorrow');
  assert.strictEqual(result.value.kind, 'dayTime');
  assert.deepStrictEqual(result.value.span, [7, 18]);
});

test('@09:30tomorrow -> 次日 09:30', () => {
  expectAt(parseText('交材料 @09:30tomorrow', NOW), [2026, 11, 10, 9, 30]);
});

test('@17today 时间未到 -> 今天 17:00', () => {
  const morning = new Date(2026, 10, 9, 8, 0, 0, 0);
  expectAt(parseText('开会 @17today', morning), [2026, 11, 9, 17, 0]);
});

test('@17today 时间已过 -> past_time', () => {
  const result = parseText('开会 @17today', NOW);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'past_time');
});

test('相对时间 @in25m / @in2h / @in1d', () => {
  expectAt(parseText('喝水 @in25m', NOW), [2026, 11, 9, 17, 53]);
  expectAt(parseText('喝水 @in2h', NOW), [2026, 11, 9, 19, 28]);
  expectAt(parseText('喝水 @in1d', NOW), [2026, 11, 10, 17, 28]);
});

test('绝对时间 @2026-11-12T17:00', () => {
  const result = parseText('发布 @2026-11-12T17:00', NOW);
  expectAt(result, [2026, 11, 12, 17, 0]);
  assert.strictEqual(result.value.kind, 'absolute');
});

test('绝对时间已过 -> past_time', () => {
  const result = parseText('发布 @2026-01-01T09:00', NOW);
  assert.strictEqual(result.reason, 'past_time');
});

test('输出带本地时区偏移', () => {
  const result = parseText('x @17tomorrow', NOW);
  assert.match(result.value.resolvedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
});

test('前置边界：紧贴汉字不识别', () => {
  assert.strictEqual(parseText('问@17tomorrow', NOW).reason, 'no_expression');
});

test('前置边界：邮箱形态不识别', () => {
  assert.strictEqual(parseText('a@17tomorrow.com', NOW).reason, 'no_expression');
});

test('后置边界：域名形态不识别', () => {
  assert.strictEqual(parseText('@17tomorrow.com 是域名', NOW).reason, 'no_expression');
});

test('后置边界：句末句号仍识别', () => {
  expectAt(parseText('x @17tomorrow.', NOW), [2026, 11, 10, 17, 0]);
});

test('后置边界：中文逗号仍识别', () => {
  expectAt(parseText('x @17tomorrow，然后再说', NOW), [2026, 11, 10, 17, 0]);
});

test('普通 @提及 不进入候选', () => {
  assert.strictEqual(parseText('问问 @张三 的意见', NOW).reason, 'no_expression');
});

test('多个表达式 -> ambiguous', () => {
  const result = parseText('@17tomorrow @18tomorrow', NOW);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'ambiguous');
  assert.deepStrictEqual(result.candidates, ['@17tomorrow', '@18tomorrow']);
});

test('非法单位 -> invalid_unit', () => {
  assert.strictEqual(parseText('x @in25xz', NOW).reason, 'invalid_unit');
});

test('非法日期 -> invalid_date', () => {
  assert.strictEqual(parseText('x @2026-13-01T17:00', NOW).reason, 'invalid_date');
  assert.strictEqual(parseText('x @2026-02-30T17:00', NOW).reason, 'invalid_date');
});

test('非法时间 -> invalid_time', () => {
  assert.strictEqual(parseText('x @25:00tomorrow', NOW).reason, 'invalid_time');
});

test('缺少日期后缀不进入候选（待定决策 D-01 的默认实现）', () => {
  assert.strictEqual(parseText('x @17', NOW).reason, 'no_expression');
});

test('空文本与纯文本', () => {
  assert.strictEqual(parseText('', NOW).reason, 'no_expression');
  assert.strictEqual(parseText('买牛奶', NOW).reason, 'no_expression');
});

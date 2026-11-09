/**
 * NLTodo 时间表达式解析器
 *
 * 纯函数，不访问 papertodo API、不读写状态、不产生副作用。
 * 同时支持浏览器（window.NLTodoParser）与 Node（module.exports），便于单测。
 *
 * 入口：parseText(text, now)
 *   成功 -> { ok: true,  value: { expression, span, resolvedAt, date, kind } }
 *   失败 -> { ok: false, reason, expression? }
 *
 * reason 取值：
 *   no_expression  正文里没有任何时间表达式候选（调用方应静默忽略，不记诊断）
 *   ambiguous      出现多个形状合法的候选
 *   invalid_unit   形如 @in25x，单位不合法
 *   invalid_date   日期分量非法（如 2 月 30 日）
 *   invalid_time   时间分量非法（如 25 点、61 分）
 *   past_time      解析出的时间已经过去
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NLTodoParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // token 内允许的字符集
  const BODY_CHAR = /[0-9A-Za-z:+-]/;
  // 前置/后置边界允许的标点（含中文标点）
  const BOUNDARY_PUNCT = new Set([
    '，', '。', '！', '？', '、', '；', '：', '（', '）', '“', '”', '‘', '’', '《', '》', '…', '—',
    ',', '.', '!', '?', ';', ':', '(', ')', '"', "'", '[', ']', '{', '}', '@'
  ]);

  const RE_ABSOLUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/;
  const RE_RELATIVE = /^in(\d+)([mhd])$/;
  const RE_DAYTIME = /^(\d{1,2})(?::(\d{2}))?(today|tomorrow)$/;

  const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

  function isSpace(ch) {
    return ch !== undefined && /\s/.test(ch);
  }

  /**
   * 形状预筛：只有「看起来像时间」的 token 才进入候选集。
   * 这样 @17、@2026 这类纯数字提及会被静默忽略（见规范 3.2），
   * 而 @in25xz、@25:00tomorrow 仍会被判为候选并记诊断。
   */
  function looksTemporal(body) {
    if (!/[0-9]/.test(body)) return false;
    if (/^in/i.test(body)) return true;
    if (/[:]/.test(body)) return true;
    if (/-/.test(body)) return true;
    if (/today|tomorrow/i.test(body)) return true;
    return false;
  }

  function isBoundaryBefore(text, at) {
    if (at === 0) return true;
    const prev = text[at - 1];
    return isSpace(prev) || BOUNDARY_PUNCT.has(prev);
  }

  /**
   * 后置边界：token 结束后必须是行尾 / 空白 / 标点。
   * 例外：`.` 后面紧跟字母或数字时不算边界，避免把 @17tomorrow.com 读成表达式。
   */
  function isBoundaryAfter(text, end) {
    if (end >= text.length) return true;
    const next = text[end];
    if (isSpace(next) || BOUNDARY_PUNCT.has(next)) {
      if (next === '.' && end + 1 < text.length && /[0-9A-Za-z]/.test(text[end + 1])) return false;
      return true;
    }
    return false;
  }

  /**
   * 扫描所有 @ 候选。只返回满足边界、且 token 内含至少一个数字的片段。
   * 不含数字的 @xxx（例如 @张三）视为普通提及，直接忽略且不产生诊断。
   */
  function findCandidates(text) {
    const out = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== '@') continue;
      if (!isBoundaryBefore(text, i)) continue;

      let j = i + 1;
      while (j < text.length && BODY_CHAR.test(text[j])) j += 1;
      if (j === i + 1) continue;
      if (!isBoundaryAfter(text, j)) continue;

      const body = text.slice(i + 1, j);
      if (!looksTemporal(body)) continue;

      out.push({ index: i, end: j, body, expression: text.slice(i, j) });
    }
    return out;
  }

  function pad(value, width) {
    const w = width || 2;
    return String(value).padStart(w, '0');
  }

  /** 输出本地时区的 ISO 8601，例如 2026-11-10T17:00:00+08:00 */
  function toLocalIso(date) {
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
      sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
    );
  }

  function classifyFailure(body) {
    if (/^in/i.test(body)) return 'invalid_unit';
    if (/[-T]/.test(body)) return 'invalid_date';
    return 'invalid_time';
  }

  function parseAbsolute(body, now) {
    const m = RE_ABSOLUTE.exec(body);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);

    if (month < 1 || month > 12 || day < 1 || day > 31) return { reason: 'invalid_date' };
    if (hour > 23 || minute > 59) return { reason: 'invalid_time' };

    const date = new Date(year, month - 1, day, hour, minute, 0, 0);
    // 溢出检查：2 月 30 日会被 Date 自动进位到 3 月
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return { reason: 'invalid_date' };
    }
    if (date.getTime() <= now.getTime()) return { reason: 'past_time' };
    return { date, kind: 'absolute' };
  }

  function parseRelative(body, now) {
    const m = RE_RELATIVE.exec(body);
    if (!m) return null;
    const amount = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(amount) || amount <= 0) return { reason: 'invalid_unit' };
    const ms = amount * UNIT_MS[unit];
    if (!Number.isFinite(ms) || ms <= 0) return { reason: 'invalid_unit' };
    return { date: new Date(now.getTime() + ms), kind: 'relative' };
  }

  function parseDayTime(body, now) {
    const m = RE_DAYTIME.exec(body);
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    const day = m[3];

    if (hour > 23 || minute > 59) return { reason: 'invalid_time' };

    const offset = day === 'tomorrow' ? 1 : 0;
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, 0, 0);
    if (date.getTime() <= now.getTime()) return { reason: 'past_time' };
    return { date, kind: 'dayTime' };
  }

  /** 解析 token 体。返回 { date, kind } 或 { reason } 或 null（形状不匹配任何形式）。 */
  function parseBody(body, now) {
    return parseAbsolute(body, now) || parseRelative(body, now) || parseDayTime(body, now);
  }

  function parseText(text, now) {
    const source = typeof text === 'string' ? text : '';
    const at = now instanceof Date ? now : new Date();

    const candidates = findCandidates(source);
    if (candidates.length === 0) return { ok: false, reason: 'no_expression' };
    if (candidates.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        candidates: candidates.map(function (c) { return c.expression; })
      };
    }

    const candidate = candidates[0];
    const parsed = parseBody(candidate.body, at);
    if (!parsed) {
      return { ok: false, reason: classifyFailure(candidate.body), expression: candidate.expression };
    }
    if (parsed.reason) {
      return { ok: false, reason: parsed.reason, expression: candidate.expression };
    }

    return {
      ok: true,
      value: {
        expression: candidate.expression,
        span: [candidate.index, candidate.end],
        resolvedAt: toLocalIso(parsed.date),
        date: parsed.date,
        kind: parsed.kind
      }
    };
  }

  return {
    parseText: parseText,
    toLocalIso: toLocalIso,
    // 单测用
    _internal: {
      findCandidates: findCandidates,
      isBoundaryAfter: isBoundaryAfter,
      isBoundaryBefore: isBoundaryBefore
    }
  };
});

/**
 * NLTodo 自然语言时间解析器
 *
 * 纯函数：不访问 papertodo API、不读写状态、不产生副作用。
 * 识别引擎是 chrono-node（zh + en），通过全局 `NLTime` 注入，见 web/vendor/NOTICE.md。
 *
 * 入口：parseText(text, now, options)
 *   options.rollover  裸时间已过时是否顺延到明天（默认 false）
 *
 * 成功 -> { ok: true,  value: { span, matchedText, resolvedAt, kind, source } }
 * 失败 -> { ok: false, reason, expression? }
 *
 * reason：
 *   no_expression   正文里没有时间表达（调用方应静默忽略）
 *   engine_missing  识别引擎没加载
 *   past_time       解析出的时间已经过去
 *
 * 流水线（对应提案 P0-P5）：
 *   P0 前置补丁（后天 / 大后天 / N个半小时）
 *   P1 chrono 抽取（forwardDate）
 *   P2 只取第一段
 *   P3 isCertain 闸门
 *   P4 维度补全（默认时刻、裸时间策略、1-6 点补下午）
 *   P5 过去判定
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NLTodoParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_HOUR = 9;
  const PERIOD_RE = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜|morning|afternoon|evening|tonight|noon)/i;
  const RELATIVE_RE = /(后|以后|之后|之内|以内)\s*$/;
  const RELATIVE_EN_RE = /^in\s/i;
  const CJK_RE = /[\u4e00-\u9fff]/;

  /**
   * 时段词到代表时刻。只在「时段说了、但具体几点没说」时使用，
   * 否则会退化成 chrono 给的时段起点（"明天上午" → 06:00，太早）。
   * 英文用词边界，避免 afternoon 被 \bnoon\b 抢先匹配。
   */
  const PERIOD_HOURS = [
    [/凌晨|半夜/, 5],
    [/早上|早晨|\bmorning\b/i, 8],
    [/上午/, 9],
    [/中午|\bnoon\b/i, 12],
    [/下午|\bafternoon\b/i, 15],
    [/傍晚|\bevening\b/i, 18],
    [/晚上|夜里|\btonight\b/i, 20]
  ];

  const CN_DIGIT = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
  };

  const RE_DAY_AFTER = /(大后天|后天)\s*(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜)?/;
  const RE_HALF_HOUR = /(\d+|[零〇一二两三四五六七八九十]+)\s*个?\s*半\s*个?\s*(?:小时|钟头)\s*(?:以?后|之后)/;

  function getEngine() {
    const scope = typeof globalThis !== 'undefined' ? globalThis : {};
    return scope.NLTime || null;
  }

  /** 中文数字转整数，覆盖 0-99。失败返回 NaN。 */
  function cnNumber(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return NaN;
    if (/^\d+$/.test(text)) return Number(text);
    if (text.length === 1) {
      return Object.prototype.hasOwnProperty.call(CN_DIGIT, text) ? CN_DIGIT[text] : NaN;
    }

    const at = text.indexOf('十');
    if (at < 0) return NaN;
    const tens = at === 0 ? 1 : CN_DIGIT[text[at - 1]];
    const ones = at === text.length - 1 ? 0 : CN_DIGIT[text[at + 1]];
    if (tens === undefined || ones === undefined) return NaN;
    return tens * 10 + ones;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  /** 本地时区 ISO 8601，例如 2026-11-10T15:00:00+08:00 */
  function toLocalIso(date) {
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const abs = Math.abs(offset);
    return (
      date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
      sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
    );
  }

  function atHour(day, hour, minute) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute || 0, 0, 0);
  }

  // ---------------------------------------------------------------- P0

  /**
   * chrono 的两处中文盲区：后天/大后天、N个半小时。
   * 返回最早的补丁候选，或 null。与 chrono 结果按起始位置竞争（见 parseText）。
   */
  function findPatch(text, now) {
    let best = null;

    function consider(regexp, build) {
      const match = regexp.exec(text);
      if (!match) return;
      if (best && match.index >= best.index) return;
      const built = build(match);
      if (!built) return;
      best = {
        index: match.index,
        end: match.index + match[0].length,
        matchedText: match[0].trim(),
        date: built.date,
        kind: built.kind
      };
    }

    consider(RE_DAY_AFTER, function (match) {
      const offset = match[1] === '大后天' ? 3 : 2;
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return { date: atHour(day, DEFAULT_HOUR), kind: 'date' };
    });

    consider(RE_HALF_HOUR, function (match) {
      const count = cnNumber(match[1]);
      if (!isFinite(count) || count <= 0) return null;
      const minutes = count * 60 + 30;
      return { date: new Date(now.getTime() + minutes * 60 * 1000), kind: 'relative' };
    });

    return best;
  }

  // ---------------------------------------------------------------- P1

  function safeParse(engine, culture, text, now) {
    const parser = engine[culture];
    if (!parser || typeof parser.parse !== 'function') return [];
    try {
      const results = parser.parse(text, now, { forwardDate: true });
      return Array.isArray(results) ? results : [];
    } catch (error) {
      return [];
    }
  }

  // ---------------------------------------------------------------- P3

  function classify(result) {
    const comp = result.start;
    const hasHour = comp.isCertain('hour');
    const hasDate =
      comp.isCertain('day') || comp.isCertain('weekday') ||
      comp.isCertain('month') || comp.isCertain('year');
    if (hasDate && hasHour) return 'datetime';
    if (hasDate) return 'date';
    if (hasHour) return 'time';
    return 'date';
  }

  function spanOf(result) {
    const raw = String(result.text || '');
    const trimmed = raw.trim();
    const leading = raw.length - raw.replace(/^\s+/, '').length;
    const start = result.index + leading;
    return { start: start, end: start + trimmed.length, matchedText: trimmed };
  }

  // ------------------------------------------------------------ P4 / P5

  function finalize(date, kind, matchedText, chronoResult, now, options) {
    let resolved = new Date(date.getTime());

    const hourKnown =
      chronoResult && typeof chronoResult.start.isCertain === 'function'
        ? chronoResult.start.isCertain('hour')
        : kind === 'datetime' || kind === 'time';

    if (kind === 'date') {
      if (PERIOD_RE.test(matchedText)) {
        // 时段说了但没说几点：用时段代表时刻，而不是 chrono 的时段起点
        if (!hourKnown) {
          for (let i = 0; i < PERIOD_HOURS.length; i += 1) {
            if (PERIOD_HOURS[i][0].test(matchedText)) {
              resolved = atHour(resolved, PERIOD_HOURS[i][1], 0);
              break;
            }
          }
        }
        resolved.setSeconds(0, 0);
      } else {
        resolved = atHour(resolved, DEFAULT_HOUR, 0);
      }
    }

    if (kind === 'time') {
      const relative = RELATIVE_RE.test(matchedText) || RELATIVE_EN_RE.test(matchedText);
      if (!relative) {
        let hour = resolved.getHours();
        const meridiemKnown =
          chronoResult && typeof chronoResult.start.isCertain === 'function'
            ? chronoResult.start.isCertain('meridiem')
            : false;

        // 1-6 点、无时段词、无 meridiem：按下午理解（D-06）
        if (CJK_RE.test(matchedText) && hour >= 1 && hour <= 6 && !PERIOD_RE.test(matchedText) && !meridiemKnown) {
          hour += 12;
        }

        const minute = resolved.getMinutes();
        const today = atHour(now, hour, minute);
        if (today.getTime() > now.getTime()) {
          resolved = today;
        } else if (options.rollover) {
          const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
          resolved = atHour(tomorrow, hour, minute);
        } else {
          return { ok: false, reason: 'past_time', expression: matchedText };
        }
      } else {
        kind = 'relative';
      }
    }

    if (resolved.getTime() <= now.getTime()) {
      return { ok: false, reason: 'past_time', expression: matchedText };
    }

    return {
      ok: true,
      value: {
        span: [0, 0],
        matchedText: matchedText,
        resolvedAt: toLocalIso(resolved),
        kind: kind,
        source: 'nl'
      }
    };
  }

  // ------------------------------------------------------------- 入口

  function parseText(text, now, options) {
    const source = typeof text === 'string' ? text : '';
    const at = now instanceof Date ? now : new Date();
    const opts = options || {};

    const engine = getEngine();
    if (!engine) return { ok: false, reason: 'engine_missing' };

    const culture = CJK_RE.test(source) ? 'zh' : 'en';
    const results = safeParse(engine, culture, source, at);
    const chronoFirst = results.length ? results[0] : null;
    const patch = findPatch(source, at);

    const usePatch = patch && (!chronoFirst || patch.index <= chronoFirst.index);
    if (!usePatch && !chronoFirst) return { ok: false, reason: 'no_expression' };

    if (usePatch) {
      const outcome = finalize(patch.date, patch.kind, patch.matchedText, null, at, opts);
      if (outcome.ok) outcome.value.span = [patch.index, patch.end];
      return outcome;
    }

    const span = spanOf(chronoFirst);
    const kind = classify(chronoFirst);
    const outcome = finalize(chronoFirst.start.date(), kind, span.matchedText, chronoFirst, at, opts);
    if (outcome.ok) outcome.value.span = [span.start, span.end];
    return outcome;
  }

  return {
    parseText: parseText,
    toLocalIso: toLocalIso,
    _internal: {
      cnNumber: cnNumber,
      findPatch: findPatch,
      classify: classify,
      DEFAULT_HOUR: DEFAULT_HOUR
    }
  };
});

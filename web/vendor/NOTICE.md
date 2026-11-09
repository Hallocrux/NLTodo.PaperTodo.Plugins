# 第三方依赖说明

## chrono-node

- **文件：** `chrono-zh-en.min.js`
- **来源：** [wanasit/chrono](https://github.com/wanasit/chrono)（npm 包 `chrono-node`）
- **版本：** 2.10.3
- **许可证：** MIT
- **改动：** 仅打包，未修改源码。只导出 `zh`（简体中文）与 `en`（英文）两个 locale。

### 如何重新生成

只打中英双语是为了控制体积（全 locale 是 239 KB，这里 77 KB）：

```bash
npm i chrono-node@2.10.3
cat > entry.js <<'EOF'
import { zh, en } from 'chrono-node';
export { zh, en };
EOF
npx esbuild entry.js --bundle --minify --format=iife \
  --global-name=NLTime --outfile=web/vendor/chrono-zh-en.min.js
```

产物暴露全局变量 `NLTime`，形如 `{ zh, en }`，每个都是 chrono 的 `Chrono` 实例：

```js
NLTime.zh.parse(text, refDate, { forwardDate: true })
```

### 升级注意

解析行为依赖 chrono 的两点契约，升级前必须回归：

1. `forwardDate: true` 让"周三""11月12日"落在未来；
2. `result.start.isCertain('hour' | 'day' | 'meridiem')` 用于区分「只有日期」「只有时间」「完整时间点」。

这两点变了，`web/parser.js` 的 P3/P4 规则要跟着改。

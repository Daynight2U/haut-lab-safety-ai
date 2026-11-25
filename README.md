# HAUT-河南工业大学实验室安全知识大赛题库AI自刷

一个 Tampermonkey 用户脚本：给高校「实验室安全培训准入系统」的练习页做自动答题。核心是 **AI 作答 + 本地题库自学习**——第一次让大模型答，答过的题自动进本地题库，之后同题零请求、零成本。

支持 DeepSeek / Kimi / 通义千问 / 智谱 GLM / 腾讯混元 / 火山方舟 / 硅基流动 / MiniMax，以及任何 OpenAI 兼容接口。

> 📖 **第一次用？看 [USAGE.md](USAGE.md)** —— 从装扩展到买 DeepSeek API 额度、填 Key、跑起来、排查报错，一步步写全了。

> ⚠️ 仅供个人学习与浏览器自动化技术研究，**请勿用于正式考核**。使用者需自行承担遵守所在学校规章制度的责任。

---

## 特性

- **AI 答题**：强制模型输出 JSON（`{"answer":"B","confidence":0.9}`），解析后再映射到页面选项，不靠正则碰运气
- **本地题库**：每道答过的题写入 `localStorage`，下次同题直接命中，越用越省钱
- **题目识别不依赖 class**：按页面视觉行扫描定位「题干 + 选项」，系统改版后通常只需微调判定规则
- **悬浮面板**：右下角 ⚡，实时显示已答 / 题库命中 / AI 作答 / 靠猜数量，可调轮数（1–20）
- **8 家国产模型预置**：选服务商自动填接口地址和模型名，也可手动覆写
- **选项模糊匹配**：Levenshtein 相似度 ≥85，选项顺序被打乱也不会选错

界面长什么样？直接打开仓库里的 [`preview.html`](preview.html) 就能看到面板的静态预览。

## 安装

### 方式一：Tampermonkey（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 点扩展图标 → 管理面板 → `+` 新建脚本
3. 清空编辑器，粘贴 `HAUT-lab-safety-ai.user.js` 全部内容
4. `Ctrl+S` 保存
5. 打开练习页面，右下角出现紫色 ⚡

> AI 请求通过 `GM_xmlhttpRequest` 发出，绕开浏览器 CORS 限制，所以**必须**用 Tampermonkey，直接粘控制台无法调用 AI。

### 方式二：控制台

F12 → Console（首次需输入 `allow pasting`）→ 粘贴脚本 → 回车。此方式只能走内置题库和本地缓存。

## 配置 AI

点 ⚡ 展开面板，在「AI 答题」区填写：

| 服务商 | 接口地址 | 默认模型 | 备注 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 便宜，答题足够 |
| Kimi 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | |
| 阿里通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 有免费额度 |
| 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `hunyuan-turbos-latest` | |
| 火山方舟 豆包 | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-pro-32k` | 模型要填接入点 ID `ep-xxx` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` | 一个 key 通吃，性价比高 |
| MiniMax | `https://api.minimax.chat/v1` | `abab6.5s-chat` | |

填完点「测试」，会拿一道判断题试水，返回判定结果说明连通正常。

## 工作原理

**答题链路**（从左到右，命中即停）：

```
内置题库 → 学校题库 → 本地缓存 → AI → 猜
```

**每轮流程**：

1. 扫描页面文本行，定位「选项行」（`正确/错误` 或 `A. xxx`），上一行即题干
2. 求答案（按上面链路）
3. 归一化后匹配到具体选项，模拟完整鼠标事件序列点击（兼容 Vue / React 的合成事件）
4. 点「下一题」；最后一题点「提交」→「确定」
5. 交卷后如出现「错题查看」，顺带把官方答案学进本地题库

**丢给 AI 的提示词**：

```
你是高校「实验室安全」考试的答题助手。请判断下面这道题的正确答案。

题目：<题干>
选项：
A. xxx
B. xxx

严格只输出一个 JSON 对象，不要 markdown 代码块、不要解释、不要任何多余字符：
{"answer":"A","confidence":0.9}
```

## 命令

面板能点到的功能都能在控制台调用：

```js
__LQB__.start(5)          // 跑 5 轮（1–20）
__LQB__.stop()            // 停止，也支持 Esc
__LQB__.help()            // 命令列表
__LQB__.ask('题干', 'A. 选项1', 'B. 选项2')   // 单题测试链路
__LQB__.cache()           // 查看本地题库
__LQB__.dump()            // 导出没答上的题
__LQB__.downloadBank()    // 导出 JSON 题库
__LQB__.clearCache()      // 清空缓存
```

调试用（适配新系统时）：

```js
__LQB__.probe()     // 列出页面调过的接口
__LQB__.sniff()     // 打印页面真实请求头
__LQB__.diag()      // 查看 cookie / storage 概况（只打印名字和长度）
```

## 适配其他学校的系统

1. 改脚本头部 `@match` 为目标域名
2. 确认页面结构满足：
   - 题干独占一行
   - 选项为 `正确` / `错误`，或 `A. xxx` / `B. xxx`
   - 前进按钮文字为 `下一题`，交卷为 `提交`
3. 结构不符时，调 `isOptLine()`（选项行正则）和 `findQuestion()`（题干定位）
4. 不确定的话先跑 `__LQB__.probe()` 看接口，再用 `__LQB__.sniff()` 看请求头

## 隐私

- 脚本会 hook 页面的 `XMLHttpRequest` / `fetch`，读取**答题接口的响应**用于提取答案，解析全部在本地完成，不外发
- API Key 存在浏览器 `localStorage`，不会随脚本分发
- 只把「题干 + 选项」发给配置的 AI 服务商，不发送账号、Cookie 或页面其他内容
- 无任何自建服务器、无统计上报

## 已知限制

- 依赖 DOM 文本结构，系统大改版可能失效
- AI 有极小概率答错，正式场合请自行核对
- 「错题学习」依赖结果页有「错题查看」入口
- 学校管理端接口通常需要管理员权限，学生账号抓不到题库（脚本里 `crawlBank()` 属实验性功能）

## License

MIT

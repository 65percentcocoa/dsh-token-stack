# @deepseek-ai/dsh-token-stack

Cross-session memory + token-efficiency stack for DeepSeek Harness (DSH).

一个可挂载的 DSH cordis package,整合了三个开源项目的省钱思路
([claude-mem](https://github.com/thedotmack/claude-mem) 跨会话记忆、
[caveman](https://github.com/JuliusBrussee/caveman) terse 输出、
[rtk](https://github.com/rtk-ai/rtk) 工具输出去噪),并补上原生 `settings` 开关与跨重启自持。

## 三层

- **L1 记忆**:监听 `tools/result` 捕获项目证据,`fs` 落盘到 DSH 家目录(
  `~/.dsh/dsh-memory/memory.json`),`systemPrompt.section` **仅首步注入**一次;用 `token_stack_remember`
  工具让模型蒸馏出 `fact/preference/constraint` 精修条目;召回打分 = 精修优先 + 近因 + 标签。
- **L2 terse**:`systemPrompt.section` 注入任务感知的简洁风格(探索/脚手架 terse,评审/疑难保持详细)。
- **L3 输入过滤**:监听 `tools/post-execute`,> `textMaxChars` 的文本块截断+标记。

## 原生 settings

`ctx.settings.register('tokenStack', …)` 注册命名空间;运行时开关经 `ctx.settings.get` 读、
`token_stack_config` 工具经 `ctx.settings.update` 写。字段:`terse`/`memory`/`filter`/`recallLimit`。

## 挂载

作为 preset 的一行挂载(包不发布 service,无需 isolate realm):

```yaml
- id: token-stack
  name: '@deepseek-ai/dsh-token-stack'
  config:
    memoryFile: 'C:/Users/luerz/.dsh/dsh-memory/memory.json'
    terse: true
    memory: true
    filter: true
```

完整组合示例见 `docs/design.md` 的"十一、打包成可挂载 package"(含 `standard` 副本 + 该行)。

## 开发

- 源码在 `lib/index.js`(ESM,导出 `name`/`inject`/`Config`/`apply`)。
- 依赖:`@deepseek-ai/schemastery`;peer:`cordis`/`dsh-system-prompt`/`dsh-settings`/`dsh-tools`。
- 挂载验证:`agentPresets.standingKeyFor('<preset-id>')`;或在目标 preset 上开新会话。

## License

MIT

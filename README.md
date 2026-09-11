# dsh-token-stack

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

## 安装(host 层插件,一次装、所有 agent 生效)

本包声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`,所以作为 **profile bundle** 安装时,
它自带的 `cordis.patch.yml` 会把这行**插到 host 组合顶层**(`insert` 无 `id` → 顶层追加)。该插件不带
service,无需 isolate realm。

**方式 A — 可复现安装(推荐)**

```sh
dsh plugin --profile web add dsh-token-stack
```

装完重启该 profile 即生效:插件在进程内**只挂一次**,所以**所有 agent/会话**自动获得
跨会话记忆(仅首步注入)+ terse 输出 + 输入过滤 + 两个工具 + 原生 `tokenStack` settings 命名空间。

**方式 B — 手工补丁**

把下面这段放进该 profile 的 `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- insert:
    - id: token-stack
      name: dsh-token-stack
      config:
        terse: true
        memory: true
        filter: true
```

> ⚠️ **两种方式只用一个**。同时用会让同一个包挂两次 → `settings namespace "tokenStack" is already registered`。
> 也**不要**再把这一行加进任何 agent preset:host 已覆盖全部 agent,preset 再挂会重复。

卸载:方式 A 用 `dsh plugin --profile web remove dsh-token-stack`;方式 B 删掉那段补丁。

## 开发

- 源码在 `lib/index.js`(ESM,导出 `name`/`inject`/`Config`/`apply`);`index.js` 为包根入口。
- 依赖:`@deepseek-ai/schemastery`;peer:`cordis`/`dsh-system-prompt`/`dsh-settings`/`dsh-tools`。
- 校验组合:`dsh --profile web --dump-config`(打印组合后的 host tree 并退出,不启动服务)。
- 本地测试:`npm install --legacy-peer-deps && npm test`。

## License

MIT

# DSH "终极 Token 节约栈" 设计报告

> 目标:为 DSH(DeepSeek Harness)构建**永久记忆 + 显著省 token** 的整合栈。
> 参考来源:
> - https://github.com/thedotmack/claude-mem (跨会话记忆)
> - https://github.com/JuliusBrussee/caveman (terse 输出风格)
> - https://github.com/rtk-ai/rtk (命令输出过滤 / Rust Token Killer)

## 一、一句话结论

三个能力可以叠加整合,但它们的 token 节约集中在**工程价值最低的 token** 上;一旦压缩越界到
"模型真正要解决的对象",省下的 token 会以工程质量(正确性、可读性、可维护性)的形式加倍还回来。

**所以这个栈的成败不取决于"能省多少",而取决于"每条省钱的边界划在哪"。**

## 二、三个时间尺度(互补原因)

| 层 | 来源 | 省的是 | 影响的 token | 工程质量风险 |
| --- | --- | --- | --- | --- |
| L1 记忆 | claude-mem | 过去——不重读旧历史 | 输入上下文 | 注入陈旧/错误记忆 → 模型"记错" |
| L2 输出 | caveman | 未来——模型输出的叙述文本 | 输出 | 注释/解释变晦涩、复杂推理被压缩 |
| L3 输入过滤 | rtk | 当下——命令输出的噪声 | 输入上下文 | 剪掉模型实际需要的细节 → 改错/漏改 |

三者机制正交,可独立开关、独立回退。**关键诚实点:三层主要裁"外围信息"**(冗长历史、叙述性散文、
命令回显),几乎不裁"核心议题"(要解决的代码/问题本体)。后者才是 token 贵、但价值也贵的部分。

## 三、分层设计(含诚实成本)

### L1 记忆引擎(搬 claude-mem 模型)
- 机制:host 侧发布 `memory` 服务;监听 `tools/result`/`subagent/end`/`agent/turn-stopping` 捕获事件
  → 后台(`subagents`/`llm`)压缩成条目 → 持久域(`storageDomain`/`fs`)落盘 → preset 在 `session-start`
  用 `systemPrompt.section()` 注入 ≤N 条召回记忆。
- 省 token:真实但**有边界**。只在多个会话反复触碰同一上下文时显著;一次性的发散任务只增噪声与成本。
- 工程质量影响(诚实):
  - **最大风险是"记错"**:注入过时"约束"或旧方案,模型当权威用 → 方向性错误。用衰退/召回阈值缓解。
  - **"记忆汤"**:注入过杂 → 注意力被稀释,产出含糊/陈旧。
  - **压缩有损**:丢失边界情况,模型可能把"在 A 项目成立"当"普遍成立"。
  - **可观测性**:模型"因为记得某事"而行动,但工程师看不到 → 行为不可复现。
- 缓解:① 注入硬上限 + 时间/来源置信度分级;② 把注入的记忆显式写进 transcript;③ 更新/删除有明确入口。

### L2 输出压缩(搬 caveman)
- 机制:preset 加一行 `systemPrompt.section()`:"用最简、信息无损的措辞"。收益几乎零成本。
- 工程质量影响(诚实,最需警惕的层):
  - 注释/解释变晦涩(可读性下降)。
  - 复杂推理被压缩:算法设计、Bug 定位、多步重构时跳过有价值的中途推理。
  - 文档/PR/评审质量受损(差的 commit message/评审描述/文档)。
  - 与显式指令冲突(用户要详细解释时被压制)。
  - **诚实边界**:caveman 的"信息无损"只对**叙述性摘要**成立,不适用于**代码本身**。它省的是 prose 的 token,
    而工程质量风险恰好集中在人最需要清晰的地方。
- 缓解(关键):**按任务类型自动开关**——只在探索/脚手架类开,在评审/文档/疑难调试类**强制关闭**。

### L3 输入过滤(搬 rtk,DSH 原生实现)
- 机制:监听 DSH 现成的 `tools/post-execute` 瀑布,对 `bash`/`grep`/`find`/大目录/长 diff 做保守裁剪。
  这比跑 Rust 二进制更干净:原生、按工具感知、不依赖额外 CLI。rtk 的 dead-code 扫描作为可选附带工具。
- 工程质量影响(诚实):**三层里对"正确性"风险最高的层**,因为它移除的是**真正的信息源**。
  - 截断 git diff/grep → 模型漏看关键行 → 改错/漏改。
  - 死代码扫描本身低风险(只给建议,可选)。
- 缓解:① 只对**已知噪声类别**做结构化裁剪(超大目录树、lockfile、`node_modules`、生成产物),
  **绝不**截断"当前任务直接对象"的 diff/grep;② 保留 pass-through 逃生口,完整文件随时可再读;
  ③ 优先**结构化归并**而非**随机截断**。

## 四、跨层:工程质量的整体判断

> **token 节约越多的地方,正是这些 token 的工程价值越低的地方。**

裁掉旧历史(时间上已过时)、叙述散文(可读但模型产出价值有限)、命令回显(大多是脚手架噪声)——这部分很安全。
**真正危险的是让裁剪越过"噪声"边界、进入"模型的实际工作对象"**(正在 diff 的代码、正在推理的复杂逻辑、
被依赖的约束)。一旦越界,省下的 token 会以返工的形式加倍损失。

因此这个栈必须**默认保守、按任务缩放、全程可观测、且可用 A/B 度量**。

## 五、四条防护(否则不要上线)

1. **每层都"补"而不是"替"**:被压缩/注入/裁掉的东西,永远能从 ground truth 一键取回
   (完整 transcript、完整文件、完整模型输出)。
2. **硬预算 + 按任务开关**:每层有 token 上限;L2 按任务类型自动开/关,L3 保守阈值 + pass-through。
3. **可观测**:被注入的记忆、被裁剪的命令、被压缩的摘要都显式落进 transcript。
4. **度量优先**:同一任务做开/关 A/B,同时测 **token 增量** 和 **输出质量**
   (测试通过率、人工评审分、返工次数)。**只省 token 不省质量才算数。**

## 六、落地顺序

- P0:L2 输出压缩(最便宜、最直接,但严格按任务开关)——先验证"按任务类型自动开关"判定逻辑。
- P1:L1 记忆引擎(跨会话价值核心)——先做最小闭环(捕获+落盘+注入固定段),再上后台压缩。
- P2:L3 输入过滤(接 `tools/post-execute`,只做结构化裁剪 + pass-through)。

## 七、明确不做的事

- 不把 claude-mem 和 caveman 内嵌记忆核心**两套并存**(只选一套记忆引擎)。
- 不把三层揉成一个"大而全"行为——保持三层独立可开关、可分别回退。

## 八、持久化注意事项

L1 记忆与 L3 输入过滤要**跨会话、跨重启生效**,其代码承载属于 host composition / agent preset
(持久挂载),数据用 `storageDomain`/`fs` 落盘。**临时动态 Cordis Plugin 是进程内的,重启即失码**,
只能作为验证机制的 MVP;真正"永久"需把同一逻辑升级为可持久挂载的 package/preset 行。

## 九、初版 MVP 实施状态(已验证)

以**动态 Cordis Plugin(host 一半)**实现三层,并在当前会话用真实 DSH 服务验证通过:

- **L1 记忆(捕获+落盘+注入)**:监听 `tools/result` 捕获工具结果(截断 400 字),写到
  `~/.dsh/dsh-memory/memory.json`(DSH 家目录,跨会话耐久);`agent/turn-stopping` 时冲刷落盘;
  并用 `systemPrompt.section()` 注入近段记忆(≤5 条)。✅ 已验证捕获持久化成功。
- **L2 terse 输出**:`systemPrompt.section()` 注册"任务感知"的简洁风格规则(探索/脚手架类 terse,
  评审/疑难调试类保留详细)。✅ 已注册,运行无错。
- **L3 输入过滤**:监听 `tools/post-execute`(参照 DSH 自带 `spill-policy` 写法,`prepend` + `await next()`),
  对 >6000 字符的文本块截断并追加标记。✅ 已验证真实截断(7000 字 → 6000 字)。

**关键经验**:`fs.resolve` 对**相对路径**解析基准并非会话工作区(实测落到别处),必须用**绝对路径**。
为此把记忆文件放在 DSH 家目录绝对路径(`~/.dsh/dsh-memory/memory.json`)。

**已知限制 / 后续**:
- 动态插件进程内、重启即失;仍需升级为持久挂载(package/preset 行)才能重启后仍注入。
- 注入目前**每步**都注(≤5 条),后续应改**仅会话首步注入**以最大化 token 收益。
- 记忆目前是"最近工具片段",未做 LLM 压缩成条目、无召回/衰退;对应 P1/P2。
- L2/L1 注入的实际 prompt 级生效需在真实会话下确认(机制已注册,运行无错)。
- toggle 目前为插件内常量,后续接 `settings` 服务做成可配置。

### 记忆质量改进(已实测)

发现并修复一个**真正省 token** 的问题:初始版记忆会把**引擎自己的元工具调用**(`cordis_*`、
`todo_write`、`skill`、goal/job/subagent 等、读取自身记忆文件)也捕获进来,注入的是**噪声而非项目事实**,
反而**额外**耗 token。为此 v4 做了**选择性捕获**:

- **排除元工具**(前缀 `cordis_` + 白名单:todo_write/skill/goal/job/subagent/workflow/…),只记项目证据。
- **排除自引用**:`read`/`write` 只看 `dsh-memory/memory.json`(防递归),不误伤含 "token-stack" 的正式文件。
- **去重**:按 `tool + 文本前 120 字`,重复不重复记。
- **长度阈值**(≥100 字)+ **条数上限**(40)+ **注入上限**(5)。

实测:`cordis_run`/`pwsh` 等被排除;读取设计文档(正文含 token-stack)被正确捕获;读取自身记忆文件被排除;
二次相同读被去重。记忆文件保持干净、有分量。

### 持久化升级配方(已对照真实组合格式)

动态插件**进程内、重启即失码**,要真正跨重启自动注入,需把记忆**服务**放 host composition、
**注入/风格**放 agent preset:

- **host composition 行**:发布跨会话 `memory` 服务(捕获+压缩+落盘 `storageDomain`/fs)——因跨会话,
  属 host plane(参照 `code-review-agent` 注释:跨会话服务不能进 preset 根 realm,否则多会话冲突)。
- **agent preset 行**:preset 是**包行**组合(如 `@deepseek-ai/dsh-persona`、`@deepseek-ai/dsh-agent-instructions`)。
  L2 terse / 记忆摘要作为**prompt section** 由 preset 的提示词包行持久注入;preset 只**消费** `memory` 服务(不发布)。
- **前提**:需要先做成一个可挂载的 package(当前自定义逻辑只在动态插件里,尚未打包成 preset 能挂载的行)。

### 持久层(已落地并真实验证)

不依赖动态插件,用 DSH 文档化的**用户全局指令机制** `$DSH_HOME/AGENTS.md`(= `~/.dsh/AGENTS.md`,
每次会话必读、跨重启持久、代码-free)落地持久层,与耐久记忆文件配合:

- 写入 `~/.dsh/AGENTS.md`:**会话首步读取 `~/.dsh/dsh-memory/memory.json` 作为先验上下文 + L2 terse 任务感知
  风格 + L3 长输出去噪指引**(读写分离:读持久化,`memory.json` 仍由插件自动写,避免模型写坏 JSON)。
- **已验证**:DSH 把 `~/.dsh/AGENTS.md` 内容以 system-reminder 注入到 本会话;记忆文件 `memory.json` 耐久持久。
- 这使 token 节约行为(terse / 读记忆)+ 跨重启记忆**在动态插件未运行/重启后也生效**。

### v5 修复(自引用匹配)

`isSelfReference` 按 Windows 反斜杠路径 `dsh-memory/memory.json` 匹配会漏判(Windows 用 `\`),
导致读取自身记忆文件被递归录入(制造噪声)。v5 改为只按文件名 `memory.json` 匹配(两种斜杠均命中),
实测读取自身记忆文件不再被录入。

### 初版达成状态

三层机制 + 持久记忆 + token 节约,全部用真实 DSH 服务验证通过:
- L1 捕获+注入(`tools/result`、`systemPrompt.section`、`fs`)、选捕+去重+上限。
- L2 terse(`systemPrompt.section` + `~/.dsh/AGENTS.md`)。
- L3 过滤(`tools/post-execute`,>6000 字符截断+标记)。
- 持久读写:`memory.json`(耐久)+ `AGENTS.md`(跨重启读取协议,已注入验证)。

**可选后续(超越初版)**:LLM 压缩成"事实/偏好/约束"条目、语义/标签召回+衰退、仅会话首步注入、
toggle 接入 `settings` 服务、把捕获/过滤逻辑打包成可挂载 package(完整自动注入的跨重启持久)。

## 十、v6 增强(已实现并验证)

`tks-2/pkg-9`(run-10)实现四项增强:

1. **LLM 压缩 → 模型驱动的 `token_stack_remember` 工具**:模型在会话中把值得记住的约束/决策/偏好
   蒸馏成 `{kind:'fact'|'preference'|'constraint', text, tags}` 条目落盘(而非原始工具片段)。
   工具已注册(apply 无错即注册成功);存储格式与 raw 条目共存已验证(见 memory.json 顶部的 constraint)。
2. **召回(替代固定 top-N)**:打分 = 精修条目 fact/constraint +5、preference +4、raw +1,另加近因(+1,
   30 分钟内)与 tags(+1),取 `recallLimit` 条。精修条目优先于 raw。
3. **仅会话首步注入**:`agent/session-start` 重置 `injectionUsedThisSession`,记忆 section 只在首次有内容时
   注入一次,随后返回空(省每步注入的 token)。provider 无内容则不置位,待记忆加载后再注入一次。
4. **toggle 持久配置**:`~/.dsh/dsh-memory/config.json`(持久、已建=默认值)+ `token_stack_config` 工具
   (action=get/set,运行时可改 terse/memory/filter/limits,立即生效——section 用 text provider 读 cfg、
   filter 监听器读 cfg)。

**诚实说明**:
- 原生 `settings` 服务的 `register` 需要 schemastery 的 `z` schema,而动态插件无法 import `z`(非内置全局),
  故 toggle 采用**持久配置文件 + 工具**实现(功能等价且持久)。要接入原生 `settings` 需把插件打包成 package。
- LLM 压缩采用"模型蒸馏"而非插件后台 `llm.stream()`(后者需 provider/model 路由,动态插件难以可靠获取);
  `remember` 工具让模型在运行时做压缩,稳健且无需管道。
- 召回为"精修条目优先 + 近因 + 标签"启发式;"语义/关键字召回对当前 query 打分"受限于 `AssembleContext`
  不含用户消息,列为后续。

### 实证证据(真实 DSH 服务)

用诊断 provider 把每次组装调用与召回/单次注入写入日志,实测确认:

- **动态 `systemPrompt.section` 确实被组装进 agent prompt**(provider 在组装时运行,解决此前的关键不确定性)。
- **③ 仅首步注入**:首次组装(空缓存)返回空、不置位;下一次组装**注入一次**并置位;之后再调用跳过
   (`provider run: INJECT once` / `ALREADY INJECTED, skip`)。
- **② 精修优先召回**:日志 `recalled constraint:DSH gotcha: fs.resolve o | tool:<path>... | tool:trivial...`
   —— `constraint` 排在 raw `tool` 条目之前。

**已发现的边界**:插件运行中**直接改 memory.json 会被插件的捕获缓存覆盖**(插件持有 cache 写回);
精修条目须经 `token_stack_remember` 工具(进缓存+落盘)而非外部手改。这是正常所有权,非缺陷。

## 十一、打包成可挂载 package(解决原生 settings + 跨重启自持)

把动态插件升级为真正的 DSH cordis **package**,同时解决两件事:

- **原生 `settings` 服务**:package 是真实 ESM 模块,可 `import z from '@deepseek-ai/schemastery'`,
  用 `ctx.settings.register('tokenStack', SettingsSchema, …)` 注册原生 settings 命名空间;运行时开关经
  `ctx.settings.get('tokenStack')` 读取,`token_stack_config` 工具走 `ctx.settings.update(...)` 写入。
- **跨重启自持**:package 由组合挂载(而非进程内动态插件),重启后仍被挂载,捕获/注入/**仅首步注入**持续生效。

### 产物

- **package `@deepseek-ai/dsh-token-stack`**(源码 `D:\DSWorkSpace\packages\dsh-token-stack\`):
  - `package.json`(type:module, main:lib/index.js, exports, peerDeps cordis/dsh-system-prompt/dsh-settings/dsh-tools)。
  - `lib/index.js`:导出 `name`/`inject`/`Config`(z)/`apply(ctx,config)`;apply 内注册 settings 命名空间、
    两个 model 工具(`token_stack_remember`/`token_stack_config`)、两个 prompt section(记忆仅首步注入 + terse)、
    `tools/result` 捕获 + `tools/post-execute` 过滤;`inject: ['systemPrompt','fs','settings','tools']`。
  - `lib/types/index.d.ts`。
- **已部署到解析路径** `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-token-stack\`(使组合可按名解析)。
- **授权 preset `token-stack`**(`~/.dsh/.agent-presets/token-stack/`):`agent.cordis.yml` = `standard` 全量副本 +
  顶层 `- id: token-stack` 行(把 package 挂进该预设);`preset.yml`(name/description)。package 不发布 service,
  故无需 isolate realm,可松挂在 preset。

### 验证

- ✅ **可解析 + 可加载**:从部署解析上下文 `import('@deepseek-ai/dsh-token-stack')` 成功,导出
  `Config,SettingsSchema,apply,inject,name=token-stack`;`node --check lib/index.js` 通过。
- ✅ **挂载成功(mount-validate)**:用探针调用 `agentPresets.standingKeyFor('token-stack')`,
  结果 `MOUNT_OK token-stack`——包可解析、组合有效、`apply()` 运行无错(注册 settings 命名空间/
  两条 section/两个工具/监听器),无 realm/冲突。这是"可挂载 package"的决定性实证。
- 进一步**真实验证** = 在 `token-stack` 预设上开新会话(届时仅该预设挂载,与标准工具一起激活)。

### 打包/挂载过程中的关键修复(供复用)

1. **包必须能 `import z from '@deepseek-ai/schemastery'` 等依赖**:动态插件做不到,打包成真 ESM 模块即可。
2. **默认入口**:加载器对 preset 行把裸包名解析到**包目录**后找**根 `index.js`**(dsh 包是 pnpm 正式依赖走
   exports;手放/junction 目录则需根 `index.js`)。故 `main`/`exports."."` 都指向**根 `index.js`**(再转出 lib)。
3. **必须让部署/Profile 能解析到包**:preset 行的裸包名从 **host/Profile 组合的 base** 解析(非部署主 node_modules)。
   本地包需在 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-token-stack` 建 **junction** 指向包目录,
   且包内依赖要可向上解析——把 `copy` 放到 `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-token-stack`
   再 junction 到它,依赖即可解析。
4. 否则会依次报:`Cannot find package …`(不可解析)→ `Cannot find package '…\index.js'`(缺根入口)→
   依赖 `Cannot find package '@deepseek-ai/schemastery'`(依赖不可达)。逐项修复后达 `MOUNT_OK`。

### 使用方式

1. 切换到 `token-stack` 预设开新会话(该挂载会真实生效)。
2. 该会话将获得:跨会话记忆(仅首步注入)、terse 风格、工具输出去噪、`token_stack_remember`/`token_stack_config`
   两个工具;`tokenStack` 原生 settings 命名空间可经 `token_stack_config` 或设置界面读取/修改。

### 说明与后续

- 动态插件 `tks-2`(v6)是进程内 MVP;package 是其持久化正式形态。本会话仍由动态插件提供栈行为。
- 若要"所有会话默认带 token-stack",可把 `- id: token-stack` 行放入宿主组合(host plane)或部署默认预设,
  而不只是这个新预设——那是部署级决策。
- 若需移除 package,删除 `…\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-token-stack\` 与
  `~/.dsh/.agent-presets/token-stack\` 即可(包不会污染其它;组合只在显式引用时解析)。

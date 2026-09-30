# OnlineCAD

浏览器本地的 DWG/DXF 图纸查看与编辑应用，部署在 **Cloudflare Workers**（静态资源 + D1 + R2）。
图纸文件默认不上传：解析、渲染、编辑全部在浏览器中完成，服务端只保存一份可搜索的**图纸台账**（元数据）。
只有用户主动选择「分享」某张图纸时，原始文件才会上传到 R2，并生成一个只读分享链接。

```text
DWG ──acadrust(WASM)──▶ DXF ──@mlightcad/data-model──▶ AcDbDatabase ──three.js──▶ 画布
                     ◀──目录/图层/图元/标注统计──▶ Cloudflare D1（仅元数据，不含图纸内容）
（可选）分享 ──原始文件──▶ Cloudflare R2 ──/s/<token>──▶ 任何人只读预览
```

- 打开 `.dwg`：acadrust（Rust → WebAssembly）把 DWG 转成 DXF，再交给 `@mlightcad/data-model` 自己的 DXF 管线。
- 打开 `.dxf`：直接走 cad-viewer 原生路径，不经过 WASM。
- 编辑：使用 cad-viewer 自带的绘图/编辑命令（直线、圆、多段线、文字、标注、图层管理等），全部在浏览器内完成。
- 导出 DWG：把当前数据库序列化成 DXF，再由 acadrust 写成真正的二进制 `.dwg`。
- 图纸台账：浏览器算出文件名、大小、CAD 版本、图元/图层统计、备注，存入 D1；图纸内容默认不离开设备。
- 分享（可选）：用户主动确认后，原始文件写入 R2，`/s/<token>` 提供只读预览与下载；取消分享即删除。

---

## 为什么选这几个开源件

这是本项目最关键的一个决策，值得写清楚。

[`@mlightcad/cad-viewer`](https://github.com/mlightcad/cad-viewer)（MIT）本身 **不包含 DWG 解析器**。
它只提供 DXF 的读取，以及一个可插拔的转换器接口
（`AcDbDatabaseConverterManager.register(AcDbFileType.DWG, converter)`）。
官方的两个 DWG 选项各有一个硬性代价：

| 官方方案 | 问题 |
| --- | --- |
| `@mlightcad/libredwg-converter` | **GPL-3.0**（LibreDWG）。闭源产品无法直接分发；且受 WASM 堆上限约束，大图纸容易失败 |
| `@mlightcad/dwg-converter` | 闭源商业授权，官网标价 **一次性 3,000 美元**（首年后每年 1,500 美元升级费） |

[`acadrust`](https://github.com/hakanaktt/acadrust) 恰好补上这个位置：

- **MPL-2.0**：文件级 copyleft，作为依赖使用不影响本项目自身的许可（本项目不修改 acadrust 源码）。
- **纯 Rust**：已经是 `wasm32-unknown-unknown` 友好实现（`memmap2`/`rayon` 等异步/文件依赖已被 `cfg` 排除，时间源用 `web-time`）。
- **能读也能写 DWG**：覆盖 R13–R2018+。正因为可以*写出* DWG，「编辑后导出一份真正的 DWG」才成立 —— 只读解析器做不到这一点。

所以本项目的分工是：

| 组件 | 职责 | 许可 |
| --- | --- | --- |
| `@mlightcad/cad-viewer` + `cad-simple-viewer` + `data-model` | 渲染、编辑、DXF 解析、图纸数据库 | MIT |
| `acadrust`（Rust，经 `crates/acadrust-wasm` 编译为 WASM） | DWG 读写 | MPL-2.0 |
| three.js | WebGL 渲染 | MIT |
| Cloudflare Workers + D1 + R2 | 静态资源托管、图纸台账、分享文件存储 | — |

### 交接点：为什么是「WASM 转 DXF」而不是「WASM 直接建数据库」

`@mlightcad/data-model` 已经拥有完整的「字节 → 场景」管线：图层表、线型、块、代理图形、
渐进式渲染、MTEXT 排版等。重新实现一遍既困难又必然产生行为差异。

因此 `packages/cad-acadrust` 里注册的转换器只做一件小事：**把 DWG 变成 DXF 字节**，
然后调用 `AcDbNativeDxfConverter` —— 也就是 cad-viewer 打开 `.dxf` 时用的同一个转换器。
一条管线负责「字节 → 数据库」，与输入格式无关。

---

## 架构

```text
┌──────────────────────── 浏览器（唯一的计算场所）────────────────────────┐
│                                                                        │
│  Vue 3 外壳 (apps/web)                                                 │
│   ├─ MlCadViewer ←── @mlightcad/cad-viewer（Ribbon / 菜单 / 命令行）    │
│   ├─ 图纸台账面板 ──┐                                                  │
│   ├─ 分享面板       │ 仅在用户确认后上传原始文件                        │
│   └─ 文件选择 / 拖放 │                                                  │
│                     │                                                  │
│  @onlinecad/cad-acadrust (packages/cad-acadrust)                      │
│   ├─ AcDbAcadrustDwgConverter  ── 注册进 data-model 的 DWG 槽位         │
│   ├─ AcadrustDwgEngine         ── 打开 / 导出 / 统计的统一入口          │
│   └─ AcadrustDwgParserWorker   ── Web Worker（大图纸不卡 UI）           │
│                     │                                                  │
│   acadrust_wasm.wasm (5.3 MB, brotli ≈ 1.5 MB)                        │
└─────────────────────┼──────────────────────────────────────────────────┘
                      │ 仅元数据（JSON，≤ 64 KB）
┌─────────────────────▼──────────────────────────────────────────────────┐
│ Cloudflare Worker (apps/worker)                                        │
│   ├─ ASSETS       → apps/web/dist（含 /wasm/*.wasm）                   │
│   ├─ /api/*       → D1                                                 │
│   │     drawings（名称/大小/版本/图元数/图层数/备注/指纹/分享 token）  │
│   │     drawing_layers（规范化后的图层归属，用于 ?layer= 过滤与统计）   │
│   └─ /api/drawings/:id/share、/api/shares/:token → R2                  │
│         shares/<token>（原始图纸，仅在用户主动分享后存在）             │
└────────────────────────────────────────────────────────────────────────┘
```

### 四条数据通路

**打开 DWG**

1. `MlCadViewer` 收到本地 `File`。
2. `AcDbAcadrustDwgConverter.read()` 把字节交给 worker 里的 acadrust。
3. `dwgToDxf()` 返回 DXF 字节。
4. `AcDbNativeDxfConverter.read()` 把 DXF 灌入 `AcDbDatabase`。
5. three.js 渲染；进度条把 DWG 阶段映射到 0–25%，DXF 管线映射到 25–100%。

**导出 DWG**

1. `database.dxfOut(undefined, 6)` —— cad-viewer 自己的 DXF 序列化器，与它「导出 DXF」命令同源。
2. `dxfToDwg()` 把 DXF 写成二进制 DWG。
3. 浏览器直接下载。

**图纸台账**

1. `inspectLocalFile()` 用 acadrust 解析一次，并计算 SHA-256。
2. `POST /api/drawings`。同一份文件（相同指纹）再次保存会更新原记录，不会产生重复行。
3. 图层名同时写入 JSON 列（读取快）与规范化表（`?layer=` 过滤走索引）。

**分享（可选，唯一的出网通路）**

1. 存入台账后弹出确认框，说明「这一步会把原始文件上传到云端」，并选择有效期。
2. 用户确认后，前端把原始 `File` 作为请求体 `POST /api/drawings/:id/share`；Worker 直接把流写入 R2 的 `shares/<token>`，不经过内存缓冲。
3. token 是 256 位随机值，写回 D1 的 `share_token` 列；`/s/<token>` 提供只读页面。
4. `DELETE /api/drawings/:id/share` 或删除台账记录都会删除 R2 对象并让链接失效。

---

## 目录结构

```text
crates/acadrust-wasm/          Rust → WASM 桥接层
  src/lib.rs                   导出 dwgToDxf / dxfToDwg / inspect 等
  examples/gen_fixture.rs      生成测试用 DWG/DXF 样例
packages/cad-acadrust/         把 acadrust 接入 cad-viewer 的 TS 包
  src/wasm.ts                  加载器（含实例回收、ABI 校验）
  src/AcDbAcadrustDwgConverter.ts   注册进 data-model 的 DWG 转换器
  src/AcadrustDwgEngine.ts     引擎门面（worker / 主线程两种策略）
  src/dwgParserWorker.ts       Web Worker 入口
  wasm/                        wasm-bindgen 产物（构建生成，未纳入版本控制）
packages/api-contract/         Worker 与前端共享的 API 类型与客户端
apps/web/                      Vue 3 应用
  plugins/acadrustWasmAssets.ts  开发/构建期提供 /wasm/*
  src/components/ShareDialog.vue 分享前的确认与有效期选择
  src/components/ShareView.vue   /s/<token> 只读分享页
apps/worker/                   Cloudflare Worker
  src/index.ts                 路由；/api/* 由它处理，其余交给静态资源
  src/shares.ts                R2 对象读写、token 生成、分享有效性判断
  migrations/0001_init.sql     绘图台账表结构
  migrations/0002_drawing_shares.sql  分享列（token / 有效期 / 大小）
fixtures/                      由 gen_fixture 生成的样例图纸（供测试使用）
scripts/build-wasm.sh          两段式构建并校验 wasm-bindgen 版本
```

---

## 快速开始

### 依赖

- Node.js ≥ 20
- Rust（`rustup`）与 `wasm32-unknown-unknown` target
- `wasm-bindgen-cli`，**版本必须与 crate 一致**（当前 `0.2.129`）

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
```

`scripts/build-wasm.sh` 会校验版本，不匹配时直接报错而不是留下一个运行时才炸的产物。

### 安装与运行

```bash
npm install
npm run build:wasm          # 生成 packages/cad-acadrust/wasm/（1–2 分钟）
npm run db:migrate:local    # 建立本地 D1 表
```

两个终端：

```bash
npm run dev:worker          # 本地 D1 + API，监听 0.0.0.0:8787
npm run dev                 # 前端 http://localhost:5173，/api 自动代理到 8787
```

打开 <http://localhost:5173> 就是完整应用（含图纸台账）。
只想打开/编辑/导出图纸、不需要台账时，单独跑 `npm run dev` 也可以。

### 让局域网 / 其他设备访问

```bash
npm run dev:host            # 前端监听 0.0.0.0:5173
npm run dev:worker          # API 已监听 0.0.0.0:8787
```

然后访问 `http://<本机 IP>:5173`。这里有两个容易踩的坑，都已经在脚本里处理好了：

1. **`npm run dev --host 0.0.0.0` 是不生效的。** 根 `dev` 脚本内部还要再调用一次 `npm run`，
   `--host` 会被 npm 自己吃掉，Vite 实际收到的是裸的 `0.0.0.0` 位置参数 ——
   输出会显示 `vite 0.0.0.0` 且只监听 localhost。根脚本已经带上 `--`，
   因此请用 `npm run dev -- --host 0.0.0.0`，或直接 `npm run dev:host`。
2. **用域名访问会被 Vite 拒绝**，报 `Blocked request. This host is not allowed.`。
   这是 Vite 的 DNS-rebinding 防护，默认只放行 localhost 和 IP 字面量。
   经 Cloudflare Tunnel、反向代理或带域名的云主机访问时需要显式放行：

   ```bash
   VITE_ALLOWED_HOSTS=cad.example.com npm run dev:host
   VITE_ALLOWED_HOSTS=* npm run dev:host                 # 放行任意 Host
   ONLINECAD_API_TARGET=https://xxx.workers.dev npm run dev   # /api 指向已部署的 Worker
   ```

> ⚠️ **不要把 Vite dev server 直接暴露到公网。** 它按源码形式提供整个项目，
> 且 `/@fs/` 端点能读取本机文件。要给他人使用，走生产路径：
>
> ```bash
> npm run build         # 构建 SPA（含 WASM 产物）
> npm run dev:worker    # 单端口提供静态资源 + API：http://<IP>:8787
> # 或
> npm run deploy        # 部署到 Cloudflare
> ```

### 测试

```bash
npm test                              # 8 项：在 Node 中直接运行真实 WASM
cargo test --manifest-path crates/acadrust-wasm/Cargo.toml --lib   # 11 项
npm run typecheck                     # 全部 workspace
npm run build                         # 生产构建
```

两组测试的分工不重复：

- **Rust 单测**覆盖纯逻辑 —— 版本码映射、DWG/DXF 文件签名校验、JSON 摘要转义、
  以及 DXF→DWG→DXF 往返后图元数量是否守恒。
- **Node 集成测试**跑在编译产物上，验证真正的 wasm-bindgen ABI、真实的 DWG 读取、
  错误信息，以及「一次解析失败之后引擎仍然可用」。

样例图纸由 Rust 生成（8 个图元 / 4 个图层），已随仓库提交：

```bash
npm run fixtures    # 需要时重新生成
```

---

## 部署到 Cloudflare

```bash
npx wrangler login
npx wrangler d1 create onlinecad           # 记下输出的 database_id
npx wrangler r2 bucket create onlinecad-shares   # 分享文件桶
# 把 database_id 填进 apps/worker/wrangler.jsonc
npm run db:migrate:remote                  # 在远端 D1 建表
npm run build                              # 构建 SPA（含 WASM 产物）
npm run deploy                             # wrangler deploy
```

`apps/worker/wrangler.jsonc` 已经配置好：

- `assets.directory = ../web/dist`，`not_found_handling = single-page-application`，
  因此未知路径返回 `index.html`，前端路由（含 `/s/<token>` 分享页）可用。
- `r2_buckets` 绑定为 `BUCKET`（桶名 `onlinecad-shares`）；本地 `wrangler dev` 会模拟 R2，
  不需要预先创建桶。
- `/api/*` 由 Worker 处理，其余请求交给静态资源；`.wasm` 会以
  `Content-Type: application/wasm` 返回，浏览器可以走 `instantiateStreaming` 快速路径。

自定义域名、Access 鉴权等按需在 Cloudflare 控制台补充。

### 部署前需要注意

- `npm run build:wasm` 必须在 `npm run build` **之前**执行（CI 已按此顺序编排）。
  Vite 插件在产物缺失时会直接报错并提示，不会悄悄产出一个 404 的 WASM。
- 当前 API **没有鉴权**。生产环境请加上 Cloudflare Access 或在 Worker 里校验 API Key。
- 分享链接本身即是凭证（`/s/<token>` 无需登录即可访问），且**没有权限分级**：
  拿到链接的人可以查看和下载原始文件。请勿分享敏感图纸，或先给 `/api/shares/*` 加上访问控制。

---

## 隐私模型

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 图纸文件字节 | 默认仅浏览器内存 / 本地磁盘 | 仅在你主动分享该图纸时上传 |
| 渲染后的几何 | 仅浏览器 | three.js 场景 |
| 编辑历史（撤销/重做） | 仅浏览器内存 | 由 cad-viewer 管理 |
| 文件名、大小、CAD 版本 | D1 | 台账 |
| 图元/图层数量、图层名、图元类型直方图 | D1 | 用于搜索与统计 |
| 备注、标签 | D1 | 用户手动填写 |
| 文件 SHA-256 | D1 | 仅用于识别「同一份图纸」，无法还原内容 |
| 原始图纸文件 | R2（`shares/<token>`） | **仅在你主动分享该图纸时存在**；取消分享或删除记录即删除 |
| 分享链接 token、有效期 | D1 | 用于校验链接；token 为 256 位随机值 |

元数据接口有一道显式的防线：`POST /api/drawings` 等记账接口的请求体超过 64 KB 直接返回 413。
上传图纸字节只发生在显式的 `POST /api/drawings/:id/share`，该入口有 256 MB 上限，并且只在用户确认后由前端调用。

---

## 已知限制

- **DWG 写出是重新编码，不是字节级保留。** acadrust 会重新生成容器，
  自定义代理对象、部分专有实体可能丢失。用于交付/交换通常没问题，但不应当作无损往返工具。
- **首次加载成本。** WASM 模块 5.3 MB（brotli 后约 1.5 MB），只在第一次打开 DWG 时加载，
  打开 DXF 的流程完全不引入它。
- **未分享的图纸不能从云端重新打开。** 这是隐私设计的直接代价：云端没有图纸内容。
  界面上对此有明确说明，避免用户误以为可以跨设备打开。已分享的图纸例外，可通过链接只读查看。
- **分享链接是公开的。** 没有账号体系，token 就是全部权限；链接一旦泄露，任何人都能查看原文件。
  有效期与「取消分享」是仅有的两道控制。
- **编辑能力等于 cad-viewer 的命令集**（直线、圆、圆弧、多段线、矩形、文字、标注、填充、图层等），
  不是完整的 AutoCAD 替代品。
- **损坏图纸会被「尽力恢复」。** 这是刻意的：真实图纸经常有局部损坏。
  解析器报告恢复次数时，界面会提示用户「部分图元可能缺失」，而不是假装一切正常。
  若文件连 DWG/DXF 的签名都不对，则直接拒绝并给出明确原因（否则一张 `.jpg` 会显示为空白图纸）。

## 后续可做

- Durable Objects 做多人实时批注与光标。
- Cloudflare Access 保护写接口。
- 把渲染也放进 Worker（大图纸更流畅）。
- 台账加版本历史（同名图纸的多版本对比）。

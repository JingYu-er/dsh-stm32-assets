# dsh-stm32-assets

[`dsh-stm32`](../dsh-stm32) 插件的**配套资源仓库**：放那些「有用、但塞进 npm 包会变臃肿」的东西——
最小 .ioc、按芯片渲染的链接脚本、CubeMX 的 MCU 数据库、架构图，以及 stage A 新增的**设备事实层**。

插件按 manifest 里的 profile 决定下载哪一层：只建工程/烧录只取 core，要完整芯片库再取 full。

## 目录

| 路径 | 内容 | manifest profile |
| --- | --- | --- |
| `device/f1/chips.json` | 12 个代表型号的事实表（容量/启动文件/设备宏/链接脚本……） | core |
| `device/f1/memory.json` | 每颗芯片的 Flash/RAM 布局（与 `ld/f1` 逐字节同源） | core |
| `device/f1/svd-f1.json` | 外设 → 寄存器 → 位域（debug 寄存器视图 / 按位写寄存器用） | core |
| `ioc/minimal/` | 每条产品线各容量档的最小 .ioc（12 份） | core |
| `ld/f1/` | 每颗代表型号的 `<DeviceId>_FLASH.ld`（12 份，MEMORY 按 Flash/RAM 渲染） | core |
| `chipdb/f1/` | CubeMX `db/mcu` 里 F1 的 XML（58 份，引脚/复用/容量的事实源） | full |
| `diagrams/` | Archify 架构图（html + png，共 4 份） | full |
| `scripts/` | 生成脚本（不是资产，不在 manifest 里） | — |
| `manifest.json` | 资产清单 v2：版本、profiles、每个文件的 sha256 | — |
| `VERSION` | 资产版本号 `YYYY.MM.DD-N` | — |

**全部是生成物，不要手改。** 改了下次 `node scripts/build-assets.mjs --check` 就会红。

## device/f1 的三个事实文件

这三个文件是 stage A 加进来的：插件不再需要「把芯片表编译进 JS」，而是按 manifest 下载事实层再查。

### chips.json —— 12 个代表型号

字段（每条一颗芯片，按 `cpn` 码点排序）：

| 字段 | 含义 |
| --- | --- |
| `cpn` | 完整订货号（脚本里挑的代表型号，如 `STM32F103C8T6`） |
| `line` | 产品线编号（`100` / `101` / `102` / `103` / `105` / `107`） |
| `group` | 容量档（`x6` / `xb` / `xe` / `xg` / `xc`） |
| `packageName` | 封装（`LQFP48` 这类，由封装后缀 + 引脚数拼出） |
| `pinCount` | 封装总引脚数（**不是**可用 IO 数） |
| `flashBytes` / `ramBytes` | 字节数（不是 KiB） |
| `deviceId` | CMSIS 设备名（`STM32F103C8Tx`） |
| `mcuName` | 写进 .ioc 的 `Mcu.Name`（CubeMX 分组名，如 `STM32F103C(8-B)Tx`；不一定等于 deviceId） |
| `startup` | 上游启动文件名（`startup_stm32f103xb.s`） |
| `deviceDefine` | 编译器设备宏（`STM32F103xB`） |
| `deviceHeader` | CMSIS 设备头（`stm32f103xb.h`） |
| `linkerScript` | 链接脚本文件名（对应本仓库 `ld/f1/` 里的那份） |

来源：插件仓库 `lib/data/stm32f1.js` 的 `resolveF1Chip`（启动文件/设备宏/Flash/RAM）
与 `lib/engine/hal-chip.js` 的 `resolveHalChip`（deviceId/mcuName/封装/链接脚本），
型号集合与 `ioc/minimal`、`ld/f1` 完全同一批（每条产品线的每个容量档挑一颗最常见型号）。

生成时脚本会**逐字段对账**：两个解析器给出的 startup / deviceDefine / deviceHeader / flashBytes / ramBytes 必须一致，
不一致就拒绝生成（说明插件的两张表漂了）。没收录的代表型号（RAM 未收录）写进 `manifest.json` 的 `skipped`，原因带一条说明。

### memory.json —— Flash/RAM 布局

`devices[]` 每条：`deviceId`、`linkerScript`（本仓库相对路径）、
`regions`（固定 FLASH、RAM 两个区：`{ name, origin, sizeBytes }`）。

- `origin` 是十六进制字符串、补足 8 位：`0x08000000` / `0x20000000`。
- `sizeBytes` 是字节数，`sizeUnit` 写着 `bytes`。
- 数据不是另抄一份：脚本先把 `ld/f1/*.ld` 渲染成文本，再从 MEMORY 段解析（LENGTH 的 `K`/`M` 换算成字节），
  并自校验解析值等于 chips.json 的 flashBytes/ramBytes——对不上拒绝生成。所以这份表与 .ld 永远不会漂。

### svd-f1.json —— 外设 / 寄存器 / 位域

结构：

```
peripheral { name, baseAddress, registers[] }
register   { name, addressOffset, size, access?, fields[] }
field      { name, bitOffset, bitWidth }
```

三条读法（容易踩的点）：

1. `addressOffset` 是相对该外设 `baseAddress` 的**字节**偏移，统一写成大写十六进制、至少两位
   （`0x00` / `0x0C`）——ST 原件写的是 `0xC`，这里规范化过。
2. `size` 与 `bitWidth` 的单位是**位**（`0x20` → 32），顶层 `sizeUnit: "bits"` 写着。
3. `derivedFrom` 已经**展开**：SVD 里 GPIOB..G 只有基地址、寄存器继承 GPIOA，这份表里每个外设都是完整寄存器表，
   消费方不用再做继承。

来源：ST 发布的 **STM32F103xx** CMSIS-SVD（取 `cmsis-svd/cmsis-svd-data` 里的 ST 原件，按 commit 固定：
`c65f8551e57c770344d229dcaa0bf838fa29aff4` 的 `data/STMicro/STM32F103xx.svd`），
解析后只留名字/偏移/宽度/访问权限，丢掉 description、enumeratedValues、resetValue。
文件里的 `source.kind` 说明来源：

- `st-svd`：从 ST 原件解析（正常路径），`source` 里有 repo/commit/path/url/license。
- `handwritten`：**离线兜底**，脚本拿不到 ST 原件且仓库里又没有上次生成的文件时写的手写子集
  （只管 GPIOA..GPIOE、RCC、FLASH、USART1、TIM2，按 RM0008 手抄）。这时文件里的 notes 会明说「不是完整 SVD」，
  联网后重跑一次 `build-assets.mjs` 就会换回 ST 原件。

已知局限（写进文件 notes）：覆盖 F100/F101/F102/F103 的同名外设；**F105/F107 独有的 CAN2、USB OTG_FS、以太网不在这份表里**，
要支持就再解析一份 `STM32F107xx.svd` 合进来。

许可：STMicroelectronics End User License Agreement v1.0（`cmsis-svd-data` 的
`data/STMicro/License.html`，允许「generating derivative representations of the Deliverables to develop
and debug software」）。这份 JSON 是它的派生表示，不是 ST 官方发行物。

## 重新生成与校验

```bash
node scripts/build-assets.mjs                    # 生成 / 刷新全部资产 + manifest.json + VERSION（缺时新建）
node scripts/build-assets.mjs --check            # 只校验，不写盘：与生成结果不一致退 1
node scripts/build-assets.mjs --plugin <dir>     # 插件仓库不在同级时指过去
node scripts/build-assets.mjs --cube-mx <dir>    # CubeMX 根（默认 STM32_CUBEMX_ROOT 或 D:/app/STM32CubeMX）
node scripts/build-assets.mjs --svd <file>       # 手上已有 STM32F103xx.svd，直接用；不下载
```

退出码：`0` 成功/一致，`1` 有差异，`2` 参数或输入有问题（与插件 `scripts/gen-chip-table.mjs` 同一套约定）。

两条硬保证：

- **幂等**：产物文本里不写时间戳、不写本机绝对路径，重复跑逐字节不变——第二次 `--check` 必然 exit 0。
- **先算后写**：全部产物先在内存里生成完，再统一写盘或统一比对；中途失败（芯片表漂了、.ld 的 MEMORY 对不上）不会留下半套文件。

`--check` 还会扫 `device/`、`ioc/`、`ld/`、`chipdb/`、`diagrams/`
里**多出来的文件**（生成结果里没有的）——残留会让下载端拿到不在 manifest 里的东西。

离线时的降级链（SVD）：`--svd` → `.cache/svd/` → 按固定 URL 下载 → 仓库里已有的
`device/f1/svd-f1.json` 原样沿用 → 手写子集。`chipdb` / `diagrams` 的源目录不存在时，
脚本沿用仓库里已有的文件，不会把资产删空。

## manifest.json（v2）

```jsonc
{
  "name": "dsh-stm32-assets",
  "version": "2026.10.30-1",        // = VERSION 的内容，发布时手动抬
  "schema": 2,
  "generatedBy": "scripts/build-assets.mjs",
  "profiles": {
    "core": ["device/**", "ioc/**", "ld/**"],
    "full": ["device/**", "ioc/**", "ld/**", "chipdb/**", "diagrams/**"]
  },
  "counts": { "device": 3, "ioc": 12, "ld": 12, "chipdb": 58, "diagrams": 4 },
  "device": { "chips": {...}, "memory": {...}, "svd": { "kind": "st-svd", "counts": {...}, "source": {...} } },
  "skipped": ["STM32F100CET6：..."],
  "files": [
    { "path": "device/f1/chips.json", "bytes": 6114, "sha256": "...", "source": "...", "profile": "core" }
  ]
}
```

- `files[]` 按 `path` 码点排序；每个文件带 `profile`（`core` 或 `full`），
  下载端据此决定「建工程只拉 core」还是「要完整芯片库拉 full」。`core` 是 `full` 的子集。
- `device` 段给三个事实文件打招呼：路径、条数/统计、来源（SVD 还带 `kind` 便于判断是否手写兜底）。
- **v1 → v2 的变化**：加了 `version`、`schema`、`profiles`、`device`、每个文件的 `profile`；
  同时**去掉**了 v1 里的 `plugin` / `cubeMx` 两个本机绝对路径字段——它们让 manifest 换台机器就变，
  `--check` 在 CI 或别人机器上必红。来源信息改放在每个文件的 `source` 里，且不含绝对路径。

## 版本

`VERSION` 是 `YYYY.MM.DD-N`（同一天多次发布就抬 `-N`）。
脚本**不会**自动改它：首次生成时缺文件才按当天日期建一个 `-1`，之后要发版就手动抬。
`--check` 时 VERSION 缺失直接退 2，免得 CI 悄悄换版本。

## 许可与来源

- 本仓库的脚本（`scripts/*.mjs`）是插件的一部分，按插件的约定使用。
- `chipdb/f1/` 来自 ST 的 CubeMX `db/mcu`（随 CubeMX 分发，见 ST 的许可条款）。
- `device/f1/svd-f1.json` 是 ST SVD 的派生表示，见上文 ST EULA v1.0。
- 仓库本身还没有单独的 `LICENSE` 文件，由维护者后续确定。

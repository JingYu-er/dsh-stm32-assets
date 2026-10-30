# dsh-stm32-assets

[`dsh-stm32`](../dsh-stm32) 插件的**配套资源仓库**：放那些「有用、但塞进 npm 包会变臃肿」的东西——
最小 .ioc、按芯片渲染的链接脚本、CubeMX 的 MCU 数据库、启动文件与设备头、架构图，以及 stage A 加进来的**设备事实层**。

插件按 manifest 里的 profile 决定下载哪一层：

- **core = 建工程必需**：`device/f1` 的 `chips.json` / `memory.json`，加 `ioc/minimal` 与 `ld/f1`。
- **full = core 再加**：`device/f1/svd/`、`chipdb/f1`、`startup/f1`、`headers/f1`、`diagrams`。

`core` 是 `full` 的子集（manifest 的 `profileCounts` 直接给出两层的文件数）。

## 目录

| 路径 | 内容 | manifest profile |
| --- | --- | --- |
| `device/f1/chips.json` | 14 个代表型号的事实表（容量/启动文件/设备宏/链接脚本……） | core |
| `device/f1/memory.json` | 每颗芯片的 Flash/RAM 布局（与 `ld/f1` 逐字节同源） | core |
| `device/f1/svd/<line>.json` | 6 条产品线各一份：外设 → 寄存器 → 位域（`100`/`101`/`102`/`103`/`105`/`107`） | full |
| `ioc/minimal/` | 每条产品线各容量档的最小 .ioc（14 份） | core |
| `ld/f1/` | 每颗代表型号的 `<DeviceId>_FLASH.ld`（14 份，MEMORY 按 Flash/RAM 渲染） | core |
| `startup/f1/` | 14 个 gcc 启动文件 `startup_stm32f1*.s`（从 CubeMX 固件包复制，离线兜底用） | full |
| `headers/f1/` | 16 个 CMSIS 设备头（14 个 `stm32f1*.h` 设备头 + `stm32f1xx.h` + `system_stm32f1xx.h`） | full |
| `chipdb/f1/` | CubeMX `db/mcu` 里 F1 的 XML（58 份，引脚/复用/容量的事实源） | full |
| `diagrams/` | Archify 架构图（html + png，共 4 份） | full |
| `scripts/` | 生成脚本（不是资产，不在 manifest 里） | — |
| `manifest.json` | 资产清单 v2：版本、profiles、每个文件的 sha256 | — |
| `VERSION` | 资产版本号 `YYYY.MM.DD-N` | — |

**全部是生成物，不要手改。** 改了下次 `node scripts/build-assets.mjs --check` 就会红。

## device/f1 的事实文件

这些文件是 stage A 加进来的：插件不再需要「把芯片表编译进 JS」，而是按 manifest 下载事实层再查。

### chips.json —— 14 个代表型号

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
| `startup` | 上游启动文件名（`startup_stm32f103xb.s`，对应本仓库 `startup/f1/` 里那份） |
| `deviceDefine` | 编译器设备宏（`STM32F103xB`） |
| `deviceHeader` | CMSIS 设备头（`stm32f103xb.h`，对应 `headers/f1/` 里那份） |
| `linkerScript` | 链接脚本文件名（对应本仓库 `ld/f1/` 里的那份） |

来源：插件仓库 `lib/data/stm32f1.js` 的 `resolveF1Chip`（启动文件/设备宏/Flash/RAM）
与 `lib/engine/hal-chip.js` 的 `resolveHalChip`（deviceId/mcuName/封装/链接脚本），
型号集合与 `ioc/minimal`、`ld/f1` 完全同一批（每条产品线的每个容量档挑一颗最常见型号）。

生成时脚本会**逐字段对账**，任何一项对不上就拒绝生成：

1. 两个解析器给出的 `startup` / `deviceDefine` / `deviceHeader` / `flashBytes` / `ramBytes` 必须一致（否则插件的两张表漂了）；
2. `ramBytes` / `flashBytes` 必须等于刚渲染出来的 `.ld` 的 MEMORY；
3. 每颗芯片的 `startup` 与 `deviceHeader` 必须真的在 `startup/f1/`、`headers/f1/` 里（交叉校验，见下文）。

v2026.10.30-2 起 14 个代表型号全部收录（`STM32F100CET6` / `STM32F101CET6` 的 RAM 补齐后不再落进
`skipped`）；真出现未收录的型号会照样写进 `manifest.json` 的 `skipped` 并带原因。

### memory.json —— Flash/RAM 布局

`devices[]` 每条：`deviceId`、`linkerScript`（本仓库相对路径）、
`regions`（固定 FLASH、RAM 两个区：`{ name, origin, sizeBytes }`）。

- `origin` 是十六进制字符串、补足 8 位：`0x08000000` / `0x20000000`。
- `sizeBytes` 是字节数，`sizeUnit` 写着 `bytes`。
- 数据不是另抄一份：脚本先把 `ld/f1/*.ld` 渲染成文本，再从 MEMORY 段解析（LENGTH 的 `K`/`M` 换算成字节），
  并自校验解析值等于 chips.json 的 flashBytes/ramBytes——对不上拒绝生成。所以这份表与 .ld 永远不会漂。

### svd/<line>.json —— 外设 / 寄存器 / 位域（6 条产品线各一份）

F1 有 6 条产品线，上游 `cmsis-svd/cmsis-svd-data` 的 `data/STMicro` 下正好有 6 个对应的 SVD，
**一条 line 一个文件**：

| 文件 | 上游原件 | 外设 | 寄存器 | 位域 |
| --- | --- | --- | --- | --- |
| `device/f1/svd/100.json` | `STM32F100xx.svd` | 48 | 566 | 3220 |
| `device/f1/svd/101.json` | `STM32F101xx.svd` | 46 | 545 | 3087 |
| `device/f1/svd/102.json` | `STM32F102xx.svd` | 25 | 307 | 1741 |
| `device/f1/svd/103.json` | `STM32F103xx.svd` | 53 | 722 | 4833 |
| `device/f1/svd/105.json` | `STM32F105xx.svd` | 45 | 755 | 7409 |
| `device/f1/svd/107.json` | `STM32F107xx.svd` | 49 | 808 | 7591 |

（合计 266 外设 / 3703 寄存器 / 27881 位域。）

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
3. `derivedFrom` 已经**展开**：SVD 里 GPIOB..G 只有基地址、寄存器继承 GPIOA（DMA2 继承 DMA1，TIM3/4/5 继承 TIM2……），
   这份表里每个外设都是完整寄存器表，消费方不用再做继承。

**每个文件只覆盖自己那条 line**：跨 line 的同名外设（GPIOA、USART1……）布局相同，但独有外设只出现在对应文件里——
`CAN1` / `CAN2` / `USB_OTG_*` 在 105、107，`ETHERNET_*` 只在 107，`CEC` 与 `TIM15/16/17` 只在 100，
`SDIO` / `TIM8` / `ADC3` / `CAN`（bxCAN）/ `USB` 只在 103。查「这颗芯片有没有 CAN2」要看
对应 line 的文件，别拿 103 的表去查 107（103 的表里确实没有 CAN）。

来源：ST 发布的 CMSIS-SVD，取 `cmsis-svd/cmsis-svd-data` 里的 ST 原件、按 commit 固定
（`c65f8551e57c770344d229dcaa0bf838fa29aff4`），每个文件的 `source` 段自带
`kind/repo/commit/path/url/file/line/license`；解析后只留名字/偏移/宽度/访问权限，丢掉
description、enumeratedValues、resetValue。`source.kind` 现在只有 `st-svd` 一种（手写兜底已删除，见下）。

许可：STMicroelectronics End User License Agreement v1.0（`cmsis-svd-data` 的
`data/STMicro/License.html`，允许「generating derivative representations of the Deliverables to develop
and debug software」）。这份 JSON 是它的派生表示，不是 ST 官方发行物——**再分发授权不明确，所以只进 full**。

#### 为什么删掉了 `device/f1/svd-f1.json`

v2026.10.30-1 只有一份 F103 的 `device/f1/svd-f1.json`。v2026.10.30-2 拆成 6 个按 line 的文件后，
这份旧文件**直接删除、不留兼容副本**，理由三条：

1. 同一份 ST 派生数据不该有两份：`svd-f1.json` 是 `svd/103.json` 的逐字节前身（53 外设 / 722 寄存器 / 4833 位域 完全一致），
   留着就是约 320 KB 的重复，而且下次 ST 原件更新时必然只有一份被刷新、另一份悄悄漂掉。
2. 插件侧没有代码按这个路径读它：`dsh-stm32` 里只有注释、文档字符串和测试 fixture 里的路径串，
   真正决定「下载哪些文件」的是 `manifest.json` 的 `profiles` glob 与每个文件的 `profile` 字段。
3. `--check` 的「多余文件」规则本来就会把它揪出来（`device/` 下生成结果里没有的文件一律报错），
   留着兼容副本要么让规则失效、要么让 CI 永远红。

要做寄存器视图的人读 `svd/<line>.json`；按芯片查的话，芯片的 `line` 在 `chips.json` 里。

### startup/f1 与 headers/f1 —— 离线兜底

| 目录 | 文件数 | 内容 |
| --- | --- | --- |
| `startup/f1/` | 14 | `startup_stm32f100xb.s` … `startup_stm32f107xc.s`（每个容量档一个） |
| `headers/f1/` | 16 | 14 个设备头 `stm32f100xb.h` … `stm32f107xc.h` + `stm32f1xx.h` + `system_stm32f1xx.h` |

来源：本机 CubeMX 固件包 **STM32Cube_FW_F1_V1.8.7** 的
`Drivers/CMSIS/Device/ST/STM32F1xx/`（启动文件在 `Source/Templates/gcc/`，设备头在 `Include/`），
逐字节复制，不改一行；manifest 里每个文件的 `source` 与顶层的 `startup` / `headers` 段都写明
固件包版本与许可。

- 只进 **full**：建工程只需要 `chips.json` 里那几个文件名，这两批是「本机没装 CubeMX 时也能编译」的兜底。
- 脚本会断言 14 / 16 这两个数：ST 换版本导致文件增减时**直接报错**，逼人确认后改常量，而不是悄悄多收或少收。
- 交叉校验：`chips.json` 里每颗芯片的 `startup` 与 `deviceHeader` 必须都在刚复制的这批文件里，否则报错。
- 许可：**Apache License 2.0**（固件包根 `License.md` 的表格：CMSIS Device 部分 Apache-2.0，
  Copyright ARM Limited - STMicroelectronics；HAL 部分才是 BSD-3-Clause，本仓库不含 HAL）。

## 重新生成与校验

```bash
node scripts/build-assets.mjs                    # 生成 / 刷新全部资产 + manifest.json + VERSION（缺时新建）
node scripts/build-assets.mjs --check            # 只校验，不写盘：与生成结果不一致退 1
node scripts/build-assets.mjs --plugin <dir>     # 插件仓库不在同级时指过去
node scripts/build-assets.mjs --cube-mx <dir>    # CubeMX 根（默认 STM32_CUBEMX_ROOT 或 D:/app/STM32CubeMX）
node scripts/build-assets.mjs --firmware <dir>   # 固件包根（默认 STM32CUBE_FW_F1_ROOT 或
                                                 #   D:/app/STM32CubeMX/Repository/STM32Cube_FW_F1_V1.8.7）
node scripts/build-assets.mjs --svd <file>       # 本机已有某条 line 的 STM32F1<line>xx.svd（可重复）
node scripts/build-assets.mjs --svd-dir <dir>    # 6 个 SVD 都在这个目录（离线；必须 6 个齐全）
```

退出码：`0` 成功/一致，`1` 有差异，`2` 参数或输入有问题（与插件 `scripts/gen-chip-table.mjs` 同一套约定）。

三条硬保证：

- **幂等**：产物文本里不写时间戳、不写本机绝对路径，重复跑逐字节不变——第二次 `--check` 必然 exit 0。
- **先算后写**：全部产物先在内存里生成完，再统一写盘或统一比对；中途失败（芯片表漂了、.ld 的 MEMORY 对不上、
  固件包缺文件）不会留下半套文件。
- **不静默降级**：取不到 SVD、找不到固件包都**直接退 2**，绝不写半份资产。

`--check` 还会扫 `device/`、`ioc/`、`ld/`、`chipdb/`、`diagrams/`、`startup/`、`headers/`
里**多出来的文件**（生成结果里没有的）——残留会让下载端拿到不在 manifest 里的东西。

### 数据来源与降级

| 资产 | 来源顺序 | 都取不到时 |
| --- | --- | --- |
| `device/f1/svd/<line>.json` | `--svd` / `--svd-dir` → `.cache/svd/<file>` → 按固定 URL 下载并写入缓存 | **退 2**，报出缺哪条 line 与三种补法 |
| `startup/f1/`、`headers/f1/` | 本机固件包（`--firmware` / `STM32CUBE_FW_F1_ROOT` / 默认路径） | **退 2** |
| `ioc/`、`ld/`、`chips.json`、`memory.json` | 插件仓库的 `lib/`（`--plugin`） | **退 2** |
| `chipdb/f1/` | CubeMX 的 `db/mcu`（`--cube-mx`） | 沿用仓库里已有的文件，不删空 |
| `diagrams/` | 插件仓库的 `docs/diagrams` | 沿用仓库里已有的文件，不删空 |

**v2026.10.30-2 起删掉了两级旧兜底**：「沿用上次生成的 `svd-f1.json`」与「手写子集」
（`scripts/svd-handwritten-f1.mjs` 一并删除）。原因是它们让「资产是完整的」这件事变成假的——
手写子集只有 GPIOA..GPIOE / RCC / FLASH / USART1 / TIM2，却和完整 SVD 长得一样。
现在宁可构建失败，也不产出半份 SVD。离线要构建就先把 6 个 SVD 放进 `.cache/svd/`（`.gitignore` 忽略该目录，
不进仓库）或用 `--svd-dir` 指过去。

## manifest.json（v2）

```jsonc
{
  "name": "dsh-stm32-assets",
  "version": "2026.10.30-2",        // = VERSION 的内容，发布时手动抬
  "schema": 2,
  "generatedBy": "scripts/build-assets.mjs",
  "profiles": {
    "core": ["device/**", "ioc/**", "ld/**"],
    "full": ["device/**", "ioc/**", "ld/**", "chipdb/**", "diagrams/**", "startup/**", "headers/**"]
  },
  "profileCounts": { "core": 30, "full": 128 },
  "counts": { "device": 8, "ioc": 14, "ld": 14, "chipdb": 58, "diagrams": 4, "svd": 6, "startup": 14, "headers": 16 },
  "device": {
    "chips": { "path": "device/f1/chips.json", "count": 14, "source": "..." },
    "memory": { "path": "device/f1/memory.json", "count": 14, "source": "..." },
    "svd": {
      "dir": "device/f1/svd/", "count": 6, "kind": "st-svd",
      "counts": { "peripherals": 266, "registers": 3703, "fields": 27881 },
      "source": { "repo": "cmsis-svd/cmsis-svd-data", "commit": "c65f855…", "license": "…" },
      "lines": [ { "line": "103", "path": "device/f1/svd/103.json", "counts": {...}, "source": {...} } ]
    }
  },
  "startup": { "dir": "startup/f1/", "count": 14, "package": "STM32Cube_FW_F1_V1.8.7", "license": "Apache License 2.0（…）", "source": "ST 官方固件包 …/Source/Templates/gcc/startup_*.s" },
  "headers": { "dir": "headers/f1/", "count": 16, "package": "STM32Cube_FW_F1_V1.8.7", "license": "…", "source": "ST 官方固件包 …/Include/*.h" },
  "skipped": [],
  "files": [
    { "path": "device/f1/chips.json", "bytes": 6964, "sha256": "...", "source": "...", "profile": "core" }
  ]
}
```

- `files[]` 按 `path` 码点排序；每个文件带 `profile`（`core` 或 `full`），
  下载端据此决定「建工程只拉 core」还是「要完整芯片库拉 full」。
- `profileCounts` 是两层的文件数（`core` 30 / `full` 128），`full` 含 `core`；
  `counts` 是按顶层目录的细分，其中 `device` 含 `svd/` 里的 6 个（8 = chips + memory + 6 SVD）。
- `device.svd` 现在是「目录 + 6 条 line 的索引」：`lines[]` 每条带 `line`/`path`/`counts`/`source`，
  要按芯片找寄存器视图就先用 `chips.json` 的 `line` 定位到文件。
- `startup` / `headers` 段给出固件包版本与许可，省得消费方去猜这批文件是哪来的。
- **v1 → v2 的变化**：加了 `version`、`schema`、`profiles`、`device`、每个文件的 `profile`；
  同时**去掉**了 v1 里的 `plugin` / `cubeMx` 两个本机绝对路径字段——它们让 manifest 换台机器就变，
  `--check` 在 CI 或别人机器上必红。来源信息改放在每个文件的 `source` 里，且不含绝对路径。

## 版本

`VERSION` 是 `YYYY.MM.DD-N`（同一天多次发布就抬 `-N`）。
脚本**不会**自动改它：首次生成时缺文件才按当天日期建一个 `-1`，之后要发版就手动抬。
`--check` 时 VERSION 缺失直接退 2，免得 CI 悄悄换版本。

| 版本 | 变化 |
| --- | --- |
| 2026.10.30-1 | manifest v2；device 事实层（chips / memory / svd-f1.json）；ioc 12 / ld 12 |
| 2026.10.30-2 | SVD 拆成 6 条 line（`device/f1/svd/<line>.json`，删 `svd-f1.json`）；新增 `startup/f1`（14）与 `headers/f1`（16）；ioc/ld 补到 14（F100xE/F101xE 的 RAM 补齐）；删手写 SVD 兜底 |

## 许可与来源

- 本仓库的脚本（`scripts/*.mjs`）是插件的一部分，按插件的约定使用。
- `chipdb/f1/` 来自 ST 的 CubeMX `db/mcu`（随 CubeMX 分发，见 ST 的许可条款）。
- `startup/f1/`、`headers/f1/` 来自 ST 的 STM32Cube_FW_F1_V1.8.7，CMSIS Device 部分 **Apache License 2.0**
  （Copyright ARM Limited - STMicroelectronics）。
- `device/f1/svd/<line>.json` 是 ST SVD 的派生表示，见上文 ST EULA v1.0。
- 仓库本身还没有单独的 `LICENSE` 文件，由维护者后续确定。

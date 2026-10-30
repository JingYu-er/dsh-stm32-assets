#!/usr/bin/env node
/**
 * dsh-stm32-assets 生成脚本：把「随包会变臃肿、但可以按需下载」的资产集中生成到这里。
 *
 * 分六类（manifest 的 profiles 分成 core / full 两层）：
 *   device/f1/   事实层：chips.json（F1 的全部 CPN）、memory.json（每颗 CPN 的 Flash/RAM 布局）、
 *                svd/<line>.json（6 条产品线各一份：外设 → 寄存器 → 位域，来自 ST 官方 SVD）
 *   ioc/minimal/ F1 每种容量档的最小 .ioc（从 dsh-stm32 的模板渲染，不是从网上下载的）
 *   ld/f1/       每个容量档一份 <DeviceId>_FLASH.ld（MEMORY 按 Flash/RAM 渲染，共 14 份）
 *   startup/f1/  14 个 gcc 启动文件 startup_stm32f1*.s（从本机 CubeMX 固件包复制，离线兜底用）
 *   headers/f1/  16 个 CMSIS 设备头（14 个 stm32f1xx 设备头 + stm32f1xx.h + system_stm32f1xx.h）
 *   chipdb/f1/   CubeMX 的 db/mcu 里 F1 的 XML（引脚/复用/容量的事实源）
 *   diagrams/    Archify 架构图（不再进 npm 包，放这里分享）
 *
 * 用法：
 *   node scripts/build-assets.mjs                         # 生成 / 刷新全部资产 + manifest.json
 *   node scripts/build-assets.mjs --check                 # 只校验（CI）：与生成结果不一致就退 1
 *   node scripts/build-assets.mjs --plugin <dsh-stm32>    # 插件仓库在哪（默认同级 dsh-stm32）
 *   node scripts/build-assets.mjs --cube-mx <CubeMX 根>   # CubeMX 装在哪（默认 D:/app/STM32CubeMX）
 *   node scripts/build-assets.mjs --firmware <固件包根>    # CubeMX 固件包在哪（startup/设备头的来源）
 *   node scripts/build-assets.mjs --svd <本机 SVD 文件>   # 手上已有某条 line 的 STM32F1xx.svd 时直接用
 *   node scripts/build-assets.mjs --svd-dir <目录>        # 6 个 SVD 都在本机时一次性指定（离线）
 *
 * 三条设计约束（别破坏，否则 --check 在 CI 上没法用）：
 *   1. 幂等：产物文本里**不写时间戳、不写本机绝对路径**，重复跑逐字节不变。
 *   2. 先算后写：全部产物先在内存里生成完（Map<相对路径, bytes>），再统一写盘或统一比对；
 *      中途失败不会留下半套文件。
 *   3. 可离线：SVD 依次试 --svd / --svd-dir → .cache/svd/ → 下载并写缓存；都没有就**明确报错退 2**
 *      （v2026.10.30-2 起没有手写兜底了：半份 SVD 比没有更容易误导人）。startup / 设备头必须来自
 *      本机固件包，缺了同样报错退 2；chipdb / diagrams 的源目录不存在时沿用上次生成的文件，
 *      不让一台没装 CubeMX 的机器把资产删空。
 *
 * 产物是生成物，不要手改：改了下次 --check 就会红。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    SVD_COMMIT,
    SVD_LICENSE,
    SVD_LINES,
    SVD_REPO,
    buildSvdDoc,
    lineFromFileName,
    normalizeAddress,
    parseSvd,
    renderSvdDoc,
    svdCounts,
    svdFileName,
    svdNotes,
    svdSource,
} from "./svd-f1.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const assetsRoot = resolve(here, "..");

/** manifest 的两层 profile：core 是建工程/烧录必需，full 再加上 CubeMX 的 db 与架构图。 */
const PROFILE_CORE = ["device/**", "ioc/**", "ld/**"];
const PROFILE_FULL = ["device/**", "ioc/**", "ld/**", "chipdb/**", "diagrams/**", "startup/**", "headers/**"];

/** 这些目录里的文件全部由本脚本托管：多出来的文件说明有残留，--check 要报出来。 */
const MANAGED_DIRS = ["device", "ioc", "ld", "chipdb", "diagrams", "startup", "headers"];

/** startup 与设备头来自本机 CubeMX 固件包：14 个 gcc 启动文件、16 个头。 */
const DEFAULT_FIRMWARE_ROOT = "D:/app/STM32CubeMX/Repository/STM32Cube_FW_F1_V1.8.7";
const FIRMWARE_CMSIS_DIR = "Drivers/CMSIS/Device/ST/STM32F1xx";
const FIRMWARE_STARTUP_SUBDIR = "Source/Templates/gcc";
const FIRMWARE_HEADER_SUBDIR = "Include";
const STARTUP_COUNT = 14;
const HEADER_COUNT = 16;
/** 固件包的许可：CMSIS Device 部分是 Apache-2.0（Copyright ARM Limited - STMicroelectronics，见固件包根 License.md）。 */
const FIRMWARE_LICENSE = "Apache License 2.0";

/** 版本号写在仓库根的 VERSION 里（YYYY.MM.DD-N）：跑脚本不会改它，发布时才手动抬。 */
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/u;

/**
 * 每个容量档挑一个常见型号当代表：ioc/minimal 与 ld/f1 只按容量档渲染（各 14 份），
 * 模板由 group 决定。chips.json / memory.json 覆盖的是全部 CPN，不止这 14 颗。
 */
const REPRESENTATIVES = [
    "STM32F100C8T6", "STM32F100CET6",
    "STM32F101C6T6", "STM32F101C8T6", "STM32F101CET6", "STM32F101CGT6",
    "STM32F102C6T6", "STM32F102C8T6",
    "STM32F103C6T6", "STM32F103C8T6", "STM32F103VET6", "STM32F103VGT6",
    "STM32F105VCT6", "STM32F107VCT6",
];

/**
 * CubeMX 的 db/mcu 里一个 XML 是「一条 line × 一个封装 × 一段容量字母」的分组，**不是一颗芯片**：
 * STM32F103R(C-D-E)Tx 展开是 RCT6 / RDT6 / RET6 三颗，所以 CPN 数远多于 XML 数（58 个 XML → 一百多颗）。
 * 文件名去掉 .xml 就是 .ioc 里的 Mcu.RefName，写法只有两种：带括号的容量字母范围、不带括号的单档。
 */
const MCU_REF_PATTERN = /^STM32F1(\d{2})([A-Z])(?:\(([0-9A-G]+(?:-[0-9A-G]+)*)\)|([0-9A-G]))([A-Z])x$/u;

/** 订货号的结尾：db 的 RefName 用 x 表示「封装/温度码待定」，实际订货号是 6（T 封装，-40..85℃）。 */
const CPN_SUFFIX = "6";

/**
 * 拆 db/mcu 的文件名：STM32F103R(C-D-E)Tx → line 103 / 封装 R / 容量字母 C,D,E / 后缀 T。
 * 认不出就返回 null（不猜）。
 */
function parseMcuRef(name) {
    const match = MCU_REF_PATTERN.exec(name);
    if (match === null) return null;
    const letters = match[3] === undefined ? [match[4]] : match[3].split("-");
    return { line: match[1], packageLetter: match[2], letters, suffix: match[5] };
}

/**
 * 枚举 F1 的候选 CPN：db/mcu 的每个分组按容量字母展开。
 * 返回的 unparsed 是文件名本身认不出的项（会写进 manifest.skipped，不静默丢掉）。
 */
function enumerateCpns(dir) {
    const cpns = [];
    const unparsed = [];
    for (const name of readdirSync(dir).sort()) {
        if (!/\.xml$/iu.test(name) || !/^STM32F10/iu.test(name)) continue;
        const ref = parseMcuRef(name.slice(0, -4));
        if (ref === null) {
            unparsed.push(name + "：文件名认不出 CubeMX 的分组写法（STM32F1xx<封装>(<容量字母>)<后缀>x）");
            continue;
        }
        for (const letter of ref.letters) {
            cpns.push("STM32F1" + ref.line + ref.packageLetter + letter + ref.suffix + CPN_SUFFIX);
        }
    }
    return { cpns, unparsed };
}

/**
 * CPN 枚举的事实源：CubeMX 的 db/mcu。
 * 机器上没装 CubeMX 就退回仓库里的 chipdb/f1 —— 那是上次生成时复制过来的同一批文件，
 * 这样一台没装 CubeMX 的机器跑 --check 也不会把 chips.json 缩回一小撮。
 */
function cpnSourceDir(options) {
    const installed = join(cubeMxRootOf(options), "db/mcu");
    if (existsSync(installed)) return { dir: installed };
    const bundled = join(assetsRoot, "chipdb/f1");
    if (existsSync(bundled)) return { dir: bundled };
    return fail(
        "找不到 F1 的 CubeMX MCU 数据库：" + slashed(installed) + " 与 " + slashed(bundled) + " 都不存在" +
        "（用 --cube-mx 指到 CubeMX 安装根：chips.json 要从 db/mcu 的分组名枚举全部 CPN）",
    );
}

/** 命令行/环境/数据不对时抛它：main 打印 ✗ 并以退出码 2 结束（与 gen-chip-table.mjs 一致）。 */
class UserError extends Error {}

function fail(message) {
    throw new UserError(message);
}

function parseArgs(argv) {
    const options = {
        check: false,
        help: false,
        pluginRoot: resolve(assetsRoot, "..", "dsh-stm32"),
        cubeMxRoot: "",
        firmwareRoot: "",
        svdPaths: [],
        svdDir: "",
    };
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith("--")) fail(arg + " 后面要跟一个值");
            index += 1;
            return value;
        };
        switch (arg) {
            case "--check":
                options.check = true;
                break;
            case "--help":
            case "-h":
                options.help = true;
                break;
            case "--plugin":
                options.pluginRoot = resolve(next());
                break;
            case "--cube-mx":
                options.cubeMxRoot = next();
                break;
            case "--svd":
                options.svdPaths.push(resolve(next()));
                break;
            case "--svd-dir":
                options.svdDir = resolve(next());
                break;
            case "--firmware":
                options.firmwareRoot = resolve(next());
                break;
            default:
                fail(
                    "不认识的参数：" + arg +
                    "（可用：--check / --plugin <dir> / --cube-mx <dir> / --firmware <dir> / --svd <file> / --svd-dir <dir> / --help）",
                );
        }
    }
    return options;
}

/** CubeMX 根：--cube-mx > STM32_CUBEMX_ROOT / STM32CUBEMX_ROOT > 内置默认值。 */
function cubeMxRootOf(options) {
    if (options.cubeMxRoot !== "") return options.cubeMxRoot;
    const fromEnv = (process.env.STM32_CUBEMX_ROOT ?? process.env.STM32CUBEMX_ROOT ?? "").trim();
    if (fromEnv !== "") return fromEnv;
    return "D:/app/STM32CubeMX";
}

/** 固件包根：--firmware > STM32CUBE_FW_F1_ROOT / STM32_FW_F1_ROOT > 内置默认值（CubeMX 默认仓库位置）。 */
function firmwareRootOf(options) {
    if (options.firmwareRoot !== "") return options.firmwareRoot;
    const fromEnv = (process.env.STM32CUBE_FW_F1_ROOT ?? process.env.STM32_FW_F1_ROOT ?? "").trim();
    if (fromEnv !== "") return fromEnv;
    return DEFAULT_FIRMWARE_ROOT;
}

/** 固件包版本号（…_V1.8.7 → 1.8.7）；目录名不合这个格式就把目录名当版本记下来。 */
function firmwareVersionOf(root) {
    const name = basename(resolve(root));
    const match = /V(\d+\.\d+\.\d+)$/u.exec(name);
    return match === null ? name : match[1];
}

/** 单个 startup / 设备头在 manifest 里的 source：写清固件包版本、包内相对路径与许可。 */
function firmwareSource(kind, relPath, version) {
    const label = kind === "startup" ? "gcc 启动文件" : "CMSIS 设备头";
    return "ST 官方固件包 STM32Cube_FW_F1_V" + version + " / " + FIRMWARE_CMSIS_DIR + "/" + relPath +
        "（" + label + "，" + FIRMWARE_LICENSE + "）";
}

/** 路径统一成正斜杠：manifest 与日志里不混用 \ 和 /（也不随平台漂）。 */
function slashed(path) {
    return path.replace(/\\/g, "/");
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function todayVersion() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return now.getFullYear() + "." + pad(now.getMonth() + 1) + "." + pad(now.getDate()) + "-1";
}

/**
 * 读 VERSION：缺了就按当天日期建一个（写模式）/ 报错（--check，免得 CI 静默换版本号）。
 * 版本号是发布语义，不能每次跑脚本都变，所以绝不按 mtime 自动改。
 */
function resolveVersion(options) {
    const file = join(assetsRoot, "VERSION");
    if (!existsSync(file)) {
        if (options.check) fail("VERSION 不存在：先跑一次 node scripts/build-assets.mjs");
        return { version: todayVersion(), created: true };
    }
    const text = readFileSync(file, "utf8").trim();
    if (text === "") fail("VERSION 是空的");
    if (!VERSION_PATTERN.test(text)) fail("VERSION 的格式不对（期望 YYYY.MM.DD-N，例如 2026.10.30-1）：" + text);
    return { version: text, created: false };
}

/** 递归列文件，返回相对 <root> 的 POSIX 路径（排序固定，--check 的报错顺序才稳定）。 */
function listFiles(dir, prefix) {
    const out = [];
    let names;
    try {
        names = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of names.sort()) {
        const abs = join(dir, name);
        const rel = prefix === "" ? name : prefix + "/" + name;
        let stat;
        try {
            stat = statSync(abs);
        } catch {
            continue;
        }
        if (stat.isDirectory()) out.push(...listFiles(abs, rel));
        else out.push(rel);
    }
    return out;
}

/**
 * 从渲染好的 .ld 文本里抓 MEMORY 段。
 *
 * 只认 RAM / FLASH 两行的写法（模板渲染出来就是这两种）：
 *   RAM (xrw)      : ORIGIN = 0x20000000, LENGTH = 64K
 *   FLASH (rx)      : ORIGIN = 0x8000000, LENGTH = 512K
 * 注释行（以 * 或 / 开头的）先剔掉，免得注释里提到 MEMORY 时误抓。
 */
function parseLinkerMemory(text) {
    const start = text.indexOf("MEMORY");
    if (start < 0) throw new Error("链接脚本里没有 MEMORY 段");
    const open = text.indexOf("{", start);
    const close = text.indexOf("}", open);
    if (open < 0 || close < 0) throw new Error("链接脚本的 MEMORY 段没有大括号");
    const body = text
        .slice(open + 1, close)
        .split("\n")
        .filter((line) => !/^\s*(?:\*|\/\*|\/\/)/u.test(line))
        .join("\n");
    const regions = new Map();
    const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:\s*ORIGIN\s*=\s*(0x[0-9A-Fa-f]+|\d+)\s*,\s*LENGTH\s*=\s*(\d+)\s*([KMGkmg]?)\b/gu;
    for (const match of body.matchAll(pattern)) {
        const name = match[1].toUpperCase();
        const origin = normalizeAddress(match[2]);
        if (origin === null) throw new Error("MEMORY 里 " + name + " 的 ORIGIN 解析失败：" + match[2]);
        const unit = (match[4] ?? "").toUpperCase();
        const scale = unit === "K" ? 1024 : unit === "M" ? 1024 * 1024 : unit === "G" ? 1024 * 1024 * 1024 : 1;
        const sizeBytes = Number.parseInt(match[3], 10) * scale;
        regions.set(name, { name, origin, sizeBytes });
    }
    for (const name of ["FLASH", "RAM"]) {
        if (!regions.has(name)) throw new Error("链接脚本的 MEMORY 里没有 " + name + " 区");
    }
    return [regions.get("FLASH"), regions.get("RAM")];
}

/** 产物先在内存里攒着：rel（POSIX 相对路径）→ { bytes, source, profile, kind }。 */
function createOutputs() {
    const map = new Map();
    const add = (rel, bytesOrText, source, profile, kind) => {
        const bytes = Buffer.isBuffer(bytesOrText) ? bytesOrText : Buffer.from(bytesOrText, "utf8");
        map.set(rel, { bytes, source, profile, kind: kind ?? "asset" });
        return bytes;
    };
    return { map, add };
}

/** 把一段 SVD 原文变成「已渲染的产物 + source + counts」：解析失败就直接报错。 */
function svdEntryFromText(text, line, origin) {
    const file = svdFileName(line);
    let parsed;
    try {
        parsed = parseSvd(text);
    } catch (error) {
        fail("解析 " + file + " 失败（来源：" + origin + "）：" + error.message);
    }
    const source = { ...svdSource(line), device: parsed.deviceName, version: parsed.deviceVersion };
    const doc = buildSvdDoc({
        line,
        source,
        notes: svdNotes(line),
        peripherals: parsed.peripherals,
        deviceName: parsed.deviceName,
        deviceVersion: parsed.deviceVersion,
        addressUnitBits: parsed.addressUnitBits,
    });
    const counts = svdCounts(doc.peripherals);
    if (counts.peripherals === 0) fail(file + " 解析出 0 个外设（来源：" + origin + "）");
    return { text: renderSvdDoc(doc), source, counts, origin };
}

/**
 * --svd / --svd-dir 解析成一张「line → 本机文件」的表（--svd 优先；--svd-dir 必须 6 个齐全）。
 * 文件名认不出 line 就报错：不做「猜一个用着」这种静默降级。
 */
function explicitSvdFiles(options) {
    const byLine = new Map();
    for (const path of options.svdPaths) {
        if (!existsSync(path)) fail("--svd 指向的文件不存在：" + slashed(path));
        const line = lineFromFileName(basename(path));
        if (line === null || !SVD_LINES.includes(line)) {
            fail(
                "--svd 的文件名认不出属于哪条 line：" + basename(path) +
                "（期望 STM32F1<line>xx.svd，line ∈ " + SVD_LINES.join("/") + "）",
            );
        }
        byLine.set(line, path);
    }
    if (options.svdDir !== "") {
        if (!existsSync(options.svdDir)) fail("--svd-dir 指向的目录不存在：" + slashed(options.svdDir));
        const missing = SVD_LINES.filter((line) => !existsSync(join(options.svdDir, svdFileName(line))));
        if (missing.length > 0) {
            fail(
                "--svd-dir 里缺 " + missing.length + " 个文件：" + missing.map(svdFileName).join("、") +
                "（给了 --svd-dir 就要求 6 个齐全，免得一半走本机一半走网络）",
            );
        }
        for (const line of SVD_LINES) {
            if (!byLine.has(line)) byLine.set(line, join(options.svdDir, svdFileName(line)));
        }
    }
    return byLine;
}

/**
 * 取某条 line 的 SVD：--svd / --svd-dir → .cache/svd/ → 下载并写缓存 → **报错退 2**。
 * 刻意没有「沿用上次生成的 json」和「手写子集」两级兜底：那两级会让人以为资产是完整的。
 */
async function resolveSvdLine(line, explicit, options) {
    const file = svdFileName(line);
    const local = explicit.get(line);
    if (local !== undefined) {
        return svdEntryFromText(readFileSync(local, "utf8"), line, "--svd/--svd-dir " + basename(local));
    }
    const cacheFile = join(assetsRoot, ".cache/svd", file);
    if (existsSync(cacheFile)) {
        return svdEntryFromText(readFileSync(cacheFile, "utf8"), line, "缓存 .cache/svd/" + file);
    }
    const source = svdSource(line);
    let reason = "";
    try {
        const response = await fetch(source.url, {
            headers: { "user-agent": "dsh-stm32-assets build-assets.mjs" },
            signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const raw = await response.text();
        if (!raw.includes("<device") || !raw.includes("<peripherals")) throw new Error("下载到的内容不像 SVD");
        if (!options.check) {
            mkdirSync(dirname(cacheFile), { recursive: true });
            writeFileSync(cacheFile, raw, "utf8");
        }
        return svdEntryFromText(raw, line, "下载 " + source.url);
    } catch (error) {
        reason = error.message;
    }
    return fail(
        "取不到 ST 官方 SVD " + file + "（第 " + line + " 条 line，来源 " + source.url + "）：下载失败（" + reason + "）" +
        "，本地缓存 .cache/svd/" + file + " 也不存在。构建需要 6 条 line 的 SVD 才能产出完整的 device/f1/svd/，" +
        "不做静默降级：先联网跑一次 node scripts/build-assets.mjs 让缓存落盘，或把原件放进 .cache/svd/，" +
        "或用 --svd <file> / --svd-dir <dir> 指定本机已有的文件。",
    );
}

function renderJson(value) {
    return JSON.stringify(value, null, 2) + "\n";
}

const HELP = [
    "用法：node scripts/build-assets.mjs [选项]",
    "",
    "  （无选项）            生成 / 刷新全部资产与 manifest.json",
    "  --check               只校验磁盘上的资产是否与生成结果一致，不一致退 1，不写盘",
    "  --plugin <dir>        dsh-stm32 插件仓库（默认同级目录 dsh-stm32）",
    "  --cube-mx <dir>       CubeMX 安装根（默认 STM32_CUBEMX_ROOT 或 D:/app/STM32CubeMX）",
    "  --firmware <dir>     CubeMX 固件包根（startup / 设备头的来源，默认 STM32CUBE_FW_F1_ROOT",
    "                      或 D:/app/STM32CubeMX/Repository/STM32Cube_FW_F1_V1.8.7）",
    "  --svd <file>          直接用本机这份 STM32F1<line>xx.svd（可重复，按文件名认 line）",
    "  --svd-dir <dir>       6 条 line 的 SVD 都在这个目录里（离线构建，必须 6 个齐全）",
    "  --help                这份说明",
    "",
    "退出码：0 成功一致 / 1 有差异 / 2 参数或输入有问题",
].join("\n");

async function run(options) {
    const version = resolveVersion(options);

    // 1) 插件侧的事实源（只读；不写插件仓库任何文件）
    const pluginRoot = options.pluginRoot;
    const dataFile = join(pluginRoot, "lib/data/stm32f1.js");
    const halFile = join(pluginRoot, "lib/engine/hal-chip.js");
    const iocTemplateFile = join(pluginRoot, "templates/scaffold/demo.ioc");
    const ldTemplateFile = join(pluginRoot, "templates/scaffold/STM32F103XX_FLASH.ld");
    for (const file of [dataFile, halFile, iocTemplateFile, ldTemplateFile]) {
        if (!existsSync(file)) fail("找不到插件文件：" + slashed(file) + "（用 --plugin 指到 dsh-stm32 仓库根）");
    }
    const F1 = await import(pathToFileURL(dataFile).href);
    const HAL = await import(pathToFileURL(halFile).href);
    const IOC_TEMPLATE = readFileSync(iocTemplateFile, "utf8");
    const LD_TEMPLATE = readFileSync(ldTemplateFile, "utf8");

    const { map: outputs, add } = createOutputs();
    const skipped = [];
    const chips = [];
    const memoryDevices = [];
    const ldTexts = new Map();

    // 2) 14 个代表型号 → ioc/minimal + ld/f1（按容量档），随后 F1 全部 CPN → chips.json / memory.json
    const compareCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

    /**
     * 一颗 CPN 的事实：两个解析器各算一遍，再逐字段对账。
     * 不一致就是插件里两张表漂了，宁可不生成。
     */
    const resolveOne = (mcu) => {
        const hal = HAL.resolveHalChip(mcu);
        const resolved = F1.resolveF1Chip(mcu);
        if (hal.facts === null || resolved.chip === null) {
            // 两条路线都给了理由时留更短更具体的那条（HAL 的理由后面还会补一段用法提示，不适合塞进 skipped）。
            const reasons = [hal.reason, resolved.reason].filter((reason) => typeof reason === "string" && reason !== "");
            reasons.sort((a, b) => a.length - b.length);
            return { reason: reasons.length > 0 ? reasons[0] : mcu + " 解析不出事实" };
        }
        const facts = hal.facts;
        const chip = resolved.chip;
        for (const key of ["startup", "deviceDefine", "deviceHeader", "flashBytes", "ramBytes", "pinCount"]) {
            if (facts[key] !== chip[key]) {
                fail(
                    mcu + " 的 " + key + " 在 resolveHalChip（" + String(facts[key]) + "）与 resolveF1Chip（" +
                    String(chip[key]) + "）里不一致：先修插件的芯片表",
                );
            }
        }
        const lineEntry = F1.F1_LINES.find((item) => mcu.startsWith(item.prefix));
        if (lineEntry === undefined) fail("认不出 " + mcu + " 属于哪条 line（F1_LINES 里没有对应前缀）");
        return { facts, chip, lineEntry };
    };

    /** 解析不出来的型号写进 manifest.skipped（同一原因的同一行只留一条）。 */
    const skip = (what, reason) => {
        const line = what + "：" + reason;
        if (!skipped.includes(line)) skipped.push(line);
    };

    /** F1 的内存只有 FLASH / RAM 两个固定区：两个尺寸就定死了 memory.json 的内容。 */
    const memoryRegions = (flashBytes, ramBytes) => [
        { name: "FLASH", origin: "0x08000000", sizeBytes: flashBytes },
        { name: "RAM", origin: "0x20000000", sizeBytes: ramBytes },
    ];

    const regionKey = (regions) =>
        regions.map((region) => region.name + ":" + region.origin + ":" + region.sizeBytes).join("|");

    // 2a) 代表型号（每个容量档一颗）→ ioc/minimal + ld/f1
    const ldByDevice = new Map(); // deviceId → { file, text, regions }：代表型号自己那份 .ld
    for (const mcu of REPRESENTATIVES) {
        const found = resolveOne(mcu);
        if (found.reason !== undefined) {
            skip(mcu, found.reason);
            continue;
        }
        const { facts } = found;
        add(
            "ioc/minimal/" + facts.deviceId + ".ioc",
            HAL.renderIoc(IOC_TEMPLATE, facts),
            "renderIoc(dsh-stm32 templates/scaffold/demo.ioc, " + mcu + ")",
            "core",
        );

        const ldText = HAL.renderLinkerScript(LD_TEMPLATE, facts);
        add("ld/f1/" + facts.linkerScript, ldText, "renderLinkerScript(templates/scaffold/STM32F103XX_FLASH.ld, " + mcu + ")", "core");
        // memory.json 的数值与这份 .ld 同源：先解析 MEMORY，再自校验等于芯片表的 Flash/RAM。
        const regions = parseLinkerMemory(ldText);
        for (const expected of memoryRegions(facts.flashBytes, facts.ramBytes)) {
            const actual = regions.find((region) => region.name === expected.name);
            if (actual === undefined || actual.sizeBytes !== expected.sizeBytes || actual.origin !== expected.origin) {
                fail(
                    facts.deviceId + " 的 .ld MEMORY 里 " + expected.name + "=" +
                    (actual === undefined ? "（缺）" : actual.origin + "/" + actual.sizeBytes) +
                    "，但芯片表写 " + expected.origin + "/" + expected.sizeBytes,
                );
            }
        }
        ldByDevice.set(facts.deviceId, { file: facts.linkerScript, text: ldText, regions });
    }

    // 2b) F1 的全部 CPN → chips.json / memory.json
    //     ioc/minimal 与 ld/f1 仍是按容量档的 14 份（模板由 group / 尺寸决定），多出来的 CPN 复用同一套。
    const cpnSource = cpnSourceDir(options);
    const enumerated = enumerateCpns(cpnSource.dir);
    for (const line of enumerated.unparsed) skipped.push(line);
    const cpnList = [...new Set([...enumerated.cpns, ...REPRESENTATIVES])].sort(compareCodepoint);

    /**
     * Flash/RAM 完全相同的 CPN 共用一份 .ld：MEMORY 段只由这两个数决定
     * （渲染出来的 .ld 里唯一的型号差异是文件头注释那行 "Linker script for <DeviceId> series"，
     *  MEMORY 与各段内容不受影响）。取文件名字典序最小的一份，产物才稳定。
     */
    const ldByRegions = new Map();
    for (const entry of [...ldByDevice.values()].sort((a, b) => compareCodepoint(a.file, b.file))) {
        const key = regionKey(entry.regions);
        if (!ldByRegions.has(key)) ldByRegions.set(key, entry);
    }

    const seenDeviceIds = new Set();
    for (const cpn of cpnList) {
        const found = resolveOne(cpn);
        if (found.reason !== undefined) {
            skip(cpn, found.reason);
            continue;
        }
        const { facts, chip, lineEntry } = found;
        if (seenDeviceIds.has(facts.deviceId)) fail("两颗 CPN 解析出同一个 deviceId：" + facts.deviceId + "（" + cpn + "）");
        seenDeviceIds.add(facts.deviceId);

        chips.push({
            cpn: facts.mcu,
            line: lineEntry.code,
            group: chip.group,
            packageName: facts.packageName,
            pinCount: facts.pinCount,
            flashBytes: facts.flashBytes,
            ramBytes: facts.ramBytes,
            deviceId: facts.deviceId,
            mcuName: facts.mcuName,
            startup: facts.startup,
            deviceDefine: facts.deviceDefine,
            deviceHeader: facts.deviceHeader,
            linkerScript: facts.linkerScript,
        });

        const regions = memoryRegions(facts.flashBytes, facts.ramBytes);
        // 只有尺寸与某份随包 .ld 逐项相同的 CPN 才挂得上去（ld/f1 不按 CPN 渲染，按容量档）。
        const reusable = ldByDevice.get(facts.deviceId) ?? ldByRegions.get(regionKey(regions));
        memoryDevices.push({
            deviceId: facts.deviceId,
            cpn: facts.mcu,
            line: lineEntry.code,
            group: chip.group,
            linkerScript: reusable === undefined ? null : "ld/f1/" + reusable.file,
            regions,
        });
    }

    chips.sort((a, b) => compareCodepoint(a.cpn, b.cpn));
    memoryDevices.sort((a, b) => compareCodepoint(a.deviceId, b.deviceId));

    add(
        "device/f1/chips.json",
        renderJson({
            schema: 1,
            family: "STM32F1",
            generatedBy: "scripts/build-assets.mjs",
            source: "dsh-stm32 的 lib/data/stm32f1.js::resolveF1Chip + lib/engine/hal-chip.js::resolveHalChip",
            count: chips.length,
            notes: [
                "生成物，不要手改：改芯片表跑 node scripts/build-assets.mjs（--check 只校验不写盘）。",
                "覆盖范围：F1 的全部 CPN —— CubeMX db/mcu 的 58 个分组按容量字母范围展开（一个 XML 可能含 RCT6/RDT6/RET6 三颗），再并上 14 个代表型号（每个容量档一颗，ioc/minimal 与 ld/f1 就是这 14 份）；解析不出来的型号（封装 H/I、RAM 未收录、该 line 没这个容量档）见 manifest.json 的 skipped。",
                "ioc/minimal 与 ld/f1 按容量档各 14 份：多出来的 CPN 按 group 复用同一份 .ioc 模板，按 Flash/RAM 尺寸复用同一份 .ld。",
                "flashBytes / ramBytes 是字节数（不是 KiB）；pinCount 是封装总引脚数（HAL 的 pinCount），不是可用 IO 数。",
                "startup / deviceDefine / deviceHeader 与插件 resolveF1Chip 逐字段一致，脚本生成时会逐项对账，对不上就拒绝生成。",
                "mcuName 是写进 .ioc 的 Mcu.Name（CubeMX 的分组名，例如 STM32F103C(8-B)Tx），不一定等于 deviceId。",
            ],
            chips,
        }),
        "dsh-stm32 resolveF1Chip + resolveHalChip（F1 全部 CPN：CubeMX db/mcu 分组展开 + 14 个代表型号）",
        "core",
    );

    add(
        "device/f1/memory.json",
        renderJson({
            schema: 1,
            family: "STM32F1",
            sizeUnit: "bytes",
            generatedBy: "scripts/build-assets.mjs",
            source: "chips.json 的 flashBytes / ramBytes（同一次生成解析出来的同一份数；代表型号的 .ld MEMORY 会逐项对账）",
            count: memoryDevices.length,
            notes: [
                "生成物，不要手改：改数据跑 node scripts/build-assets.mjs（--check 只校验不写盘）。",
                "origin 是十六进制字符串、补足 8 位（0x08000000 / 0x20000000）；sizeBytes 是字节数。",
                "regions 固定按 FLASH、RAM 两区给出；顺序与 .ld 里的书写顺序无关。",
                "sizeBytes 就是 chips.json 的 flashBytes / ramBytes；生成时代表型号的 .ld MEMORY 会逐项对账，对不上就拒绝生成。",
                "每条带 cpn / line / group：line 用来找 device/f1/svd/<line>.json，group 用来复用 ioc/minimal 里的模板。",
                "linkerScript 指向随包的 ld/f1/<文件>：只有那份 .ld 的 MEMORY 与这颗芯片逐项相同时才给，否则为 null（ld/f1 按容量档 14 份，不按 CPN 渲染）。",
            ],
            devices: memoryDevices,
        }),
        "chips.json 的 flashBytes / ramBytes + ld/f1 的 MEMORY 段（生成时对账）",
        "core",
    );

    // 3) SVD → device/f1/svd/<line>.json：F1 的 6 条产品线各一份，每份只覆盖自己那条 line
    const explicitSvd = explicitSvdFiles(options);
    const svdLines = [];
    const svdTotals = { peripherals: 0, registers: 0, fields: 0 };
    // SVD 的原始文件是 ST 的 EULA（cmsis-svd-data 的 data/STMicro/License.html），再分发授权不明确，
    // 所以只放进 full：默认的 core 下载不含它；要做寄存器视图的人再显式拉 full。
    for (const line of SVD_LINES) {
        const entry = await resolveSvdLine(line, explicitSvd, options);
        add(
            "device/f1/svd/" + line + ".json",
            entry.text,
            "ST SVD " + svdFileName(line) + " → 精简事实表（见文件内 source 字段）",
            "full",
        );
        svdLines.push({ line, path: "device/f1/svd/" + line + ".json", counts: entry.counts, source: entry.source });
        svdTotals.peripherals += entry.counts.peripherals;
        svdTotals.registers += entry.counts.registers;
        svdTotals.fields += entry.counts.fields;
    }

    // 4) startup 与设备头：从本机 CubeMX 固件包复制（离线兜底：没有 CubeMX 也能编译）
    const firmwareRoot = firmwareRootOf(options);
    const cmsisRoot = join(firmwareRoot, FIRMWARE_CMSIS_DIR);
    if (!existsSync(cmsisRoot)) {
        fail(
            "找不到本机 CubeMX 固件包的 CMSIS 目录：" + slashed(cmsisRoot) +
            "（用 --firmware 指到 STM32Cube_FW_F1_Vx.y.z 根目录，或用环境变量 STM32CUBE_FW_F1_ROOT）",
        );
    }
    const firmwareVersion = firmwareVersionOf(firmwareRoot);
    const startupDir = join(cmsisRoot, FIRMWARE_STARTUP_SUBDIR);
    const headerDir = join(cmsisRoot, FIRMWARE_HEADER_SUBDIR);
    for (const [dir, what] of [[startupDir, "启动文件"], [headerDir, "设备头"]]) {
        if (!existsSync(dir)) fail("固件包结构不对：缺 " + slashed(dir) + "（" + what + "目录）");
    }
    const startupNames = readdirSync(startupDir).filter((name) => /^startup_stm32f1\w*\.s$/u.test(name)).sort();
    const headerNames = readdirSync(headerDir).filter((name) => /^[\w.-]+\.h$/u.test(name)).sort();
    if (startupNames.length !== STARTUP_COUNT) {
        fail(
            "固件包里的 startup 有 " + startupNames.length + " 个，期望 " + STARTUP_COUNT + " 个：" + startupNames.join("、") +
            "（ST 换了新版本就先确认是多了还是少了，再改 STARTUP_COUNT）",
        );
    }
    if (headerNames.length !== HEADER_COUNT) {
        fail(
            "固件包里的设备头有 " + headerNames.length + " 个，期望 " + HEADER_COUNT + " 个：" + headerNames.join("、") +
            "（ST 换了新版本就先确认是多了还是少了，再改 HEADER_COUNT）",
        );
    }
    for (const name of startupNames) {
        add(
            "startup/f1/" + name,
            readFileSync(join(startupDir, name)),
            firmwareSource("startup", FIRMWARE_STARTUP_SUBDIR + "/" + name, firmwareVersion),
            "full",
        );
    }
    for (const name of headerNames) {
        add(
            "headers/f1/" + name,
            readFileSync(join(headerDir, name)),
            firmwareSource("header", FIRMWARE_HEADER_SUBDIR + "/" + name, firmwareVersion),
            "full",
        );
    }
    // 交叉校验：chips.json 每颗芯片指名的启动文件与设备头，必须都在刚复制的这批文件里
    for (const chip of chips) {
        for (const [rel, what] of [["startup/f1/" + chip.startup, "启动文件"], ["headers/f1/" + chip.deviceHeader, "设备头"]]) {
            if (!outputs.has(rel)) fail(chip.cpn + " 指名的" + what + " " + rel + " 不在固件包里（" + FIRMWARE_CMSIS_DIR + "）");
        }
    }

    // 5) CubeMX 的 F1 db XML：源目录不在就沿用上次生成的文件（不删空）
    const dbDir = join(cubeMxRootOf(options), "db/mcu");
    let chipdbCount = 0;
    if (existsSync(dbDir)) {
        const names = readdirSync(dbDir).sort();
        for (const name of names) {
            if (!/^STM32F10.*\.xml$/iu.test(name)) continue;
            const bytes = readFileSync(join(dbDir, name));
            add("chipdb/f1/" + name, bytes, "CubeMX db/mcu/" + name + "（ST 官方 MCU 数据库，随 CubeMX 分发）", "full");
            chipdbCount += 1;
        }
        if (chipdbCount === 0) console.warn("⚠ " + slashed(dbDir) + " 里没有 STM32F10*.xml（CubeMX 没装全？）");
    } else {
        const previous = readPreviousManifest();
        const reused = (previous?.files ?? []).filter((entry) => typeof entry.path === "string" && entry.path.startsWith("chipdb/"));
        for (const entry of reused) {
            const abs = join(assetsRoot, entry.path);
            if (!existsSync(abs)) continue;
            add(entry.path, readFileSync(abs), entry.source ?? "CubeMX db/mcu（沿用上次生成结果）", "full");
            chipdbCount += 1;
        }
        console.log("· chipdb：" + slashed(dbDir) + " 不存在，沿用已有 " + chipdbCount + " 个文件");
    }

    // 6) 架构图：同上，源目录不在就沿用
    const diagramSrc = join(pluginRoot, "docs/diagrams");
    let diagramCount = 0;
    if (existsSync(diagramSrc)) {
        for (const name of listFiles(diagramSrc, "").sort()) {
            add("diagrams/" + name, readFileSync(join(diagramSrc, name)), "dsh-stm32 docs/diagrams/" + name, "full");
            diagramCount += 1;
        }
    } else {
        const previous = readPreviousManifest();
        const reused = (previous?.files ?? []).filter((entry) => typeof entry.path === "string" && entry.path.startsWith("diagrams/"));
        for (const entry of reused) {
            const abs = join(assetsRoot, entry.path);
            if (!existsSync(abs)) continue;
            add(entry.path, readFileSync(abs), entry.source ?? "dsh-stm32 docs/diagrams（沿用上次生成结果）", "full");
            diagramCount += 1;
        }
        console.log("· diagrams：" + slashed(diagramSrc) + " 不存在，沿用已有 " + diagramCount + " 个文件");
    }

    // 7) manifest v2：profiles 分层 + 每个文件带 profile；不写时间戳与本机路径，保证幂等
    const assets = [...outputs.values()].filter((output) => output.kind === "asset");
    const files = [...outputs.entries()]
        .filter(([, output]) => output.kind === "asset")
        .map(([rel, output]) => ({
            path: rel,
            bytes: output.bytes.length,
            sha256: sha256(output.bytes),
            source: output.source,
            profile: output.profile,
        }))
        .sort((a, b) => compareCodepoint(a.path, b.path));
    const counts = {
        device: files.filter((entry) => entry.path.startsWith("device/")).length,
        ioc: files.filter((entry) => entry.path.startsWith("ioc/")).length,
        ld: files.filter((entry) => entry.path.startsWith("ld/")).length,
        chipdb: files.filter((entry) => entry.path.startsWith("chipdb/")).length,
        diagrams: files.filter((entry) => entry.path.startsWith("diagrams/")).length,
        svd: files.filter((entry) => entry.path.startsWith("device/f1/svd/")).length,
        startup: files.filter((entry) => entry.path.startsWith("startup/")).length,
        headers: files.filter((entry) => entry.path.startsWith("headers/")).length,
    };
    // full 的 glob 是 core 的超集，所以「full 文件数」就是全部资产数；两者都写进 manifest，消费方不用自己算。
    const profileCounts = { core: files.filter((entry) => entry.profile === "core").length, full: files.length };
    const manifest = {
        name: "dsh-stm32-assets",
        version: version.version,
        schema: 2,
        generatedBy: "scripts/build-assets.mjs",
        profiles: { core: PROFILE_CORE, full: PROFILE_FULL },
        profileCounts,
        counts,
        device: {
            chips: {
                path: "device/f1/chips.json",
                count: chips.length,
                coverage: "F1 全部 CPN",
                source: "dsh-stm32 resolveF1Chip + resolveHalChip（CubeMX db/mcu 的 " +
                    "58 个分组按容量字母展开 + 14 个代表型号）",
            },
            memory: {
                path: "device/f1/memory.json",
                count: memoryDevices.length,
                coverage: "F1 全部 CPN",
                source: "chips.json 的 flashBytes / ramBytes（与 ld/f1 的 MEMORY 段对账）",
            },
            svd: {
                dir: "device/f1/svd/",
                count: svdLines.length,
                kind: "st-svd",
                counts: svdTotals,
                source: {
                    repo: SVD_REPO,
                    commit: SVD_COMMIT,
                    license: SVD_LICENSE,
                    path: "data/STMicro/STM32F1<line>xx.svd",
                },
                lines: svdLines,
            },
        },
        startup: {
            dir: "startup/f1/",
            count: counts.startup,
            package: "STM32Cube_FW_F1_V" + firmwareVersion,
            license: FIRMWARE_LICENSE + "（CMSIS Device 部分，Copyright ARM Limited - STMicroelectronics）",
            source: "ST 官方固件包 " + FIRMWARE_CMSIS_DIR + "/" + FIRMWARE_STARTUP_SUBDIR + "/startup_*.s",
        },
        headers: {
            dir: "headers/f1/",
            count: counts.headers,
            package: "STM32Cube_FW_F1_V" + firmwareVersion,
            license: FIRMWARE_LICENSE + "（CMSIS Device 部分，Copyright ARM Limited - STMicroelectronics）",
            source: "ST 官方固件包 " + FIRMWARE_CMSIS_DIR + "/" + FIRMWARE_HEADER_SUBDIR + "/*.h",
        },
        skipped,
        files,
    };
    add("manifest.json", renderJson(manifest), "manifest v2：profiles + 每个文件的 profile/sha256", null, "manifest");
    add("VERSION", version.version + "\n", "资产版本号（YYYY.MM.DD-N，发布时手动抬）", null, "version");

    // 8) 统一写盘 / 统一比对
    const problems = [];
    if (!options.check) {
        for (const [rel, output] of outputs) {
            const abs = join(assetsRoot, rel);
            mkdirSync(dirname(abs), { recursive: true });
            const before = existsSync(abs) ? readFileSync(abs) : null;
            if (before !== null && before.equals(output.bytes)) continue;
            writeFileSync(abs, output.bytes);
        }
    } else {
        for (const [rel, output] of outputs) {
            const abs = join(assetsRoot, rel);
            if (!existsSync(abs)) {
                problems.push("缺少文件 " + rel);
                continue;
            }
            const actual = readFileSync(abs);
            if (!actual.equals(output.bytes)) problems.push("内容不一致 " + rel);
        }
        for (const dir of MANAGED_DIRS) {
            const abs = join(assetsRoot, dir);
            for (const rel of listFiles(abs, dir)) {
                if (!outputs.has(rel)) problems.push("多余文件 " + rel + "（生成结果里没有它）");
            }
        }
        if (problems.length > 0) {
            console.error("✗ 资产与生成结果不一致（共 " + problems.length + " 项）：");
            for (const problem of problems.slice(0, 20)) console.error("  - " + problem);
            if (problems.length > 20) console.error("  … 其余 " + (problems.length - 20) + " 项略");
            console.error("  重跑 node scripts/build-assets.mjs 更新（改的是插件侧数据就一并确认）");
            return 1;
        }
    }

    const totalBytes = assets.reduce((sum, output) => sum + output.bytes.length, 0);
    const header = "manifest v" + version.version + "：资产 " + files.length + " 个（core " + profileCounts.core + " / full " +
        profileCounts.full + "），另加 manifest.json 与 VERSION 共 " + outputs.size + " 个文件，共 " + totalBytes + " 字节（" +
        (totalBytes / 1024 / 1024).toFixed(2) + " MB）";
    console.log(
        "device/f1：chips " + chips.length + " 颗（F1 全部 CPN，CubeMX db/mcu 分组展开 + 代表型号）、memory " +
        memoryDevices.length + " 颗、" + "svd " + svdLines.length + " 条 line（" + svdTotals.peripherals + " 外设 / " +
        svdTotals.registers + " 寄存器 / " + svdTotals.fields + " 位域）",
    );
    console.log(
        "ioc/minimal：" + counts.ioc + " 个；ld/f1：" + counts.ld + " 个；svd：" + counts.svd + " 条；" +
        "startup/f1：" + counts.startup + " 个；headers/f1：" + counts.headers + " 个；" +
        "chipdb/f1：" + counts.chipdb + " 个；diagrams：" + counts.diagrams + " 个",
    );
    if (skipped.length > 0) {
        console.log("跳过 " + skipped.length + " 个型号（写进 manifest.skipped，带原因）：");
        for (const reason of skipped) console.log("  skip " + reason);
    }
    if (version.created) console.log("· 新建 VERSION=" + version.version + "（发布前按需抬版本）");
    console.log(options.check ? "✓ 资产与生成结果一致：" + header : "✓ 已生成：" + header);
    return 0;
}

/** 读上次的 manifest（只用于「源目录不在时沿用已有文件」；坏了当没有）。 */
function readPreviousManifest() {
    const file = join(assetsRoot, "manifest.json");
    if (!existsSync(file)) return null;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return parsed !== null && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

async function main(argv) {
    let options;
    try {
        options = parseArgs(argv);
        if (options.help) {
            console.log(HELP);
            return 0;
        }
        return await run(options);
    } catch (error) {
        if (error instanceof UserError) {
            console.error("✗ " + error.message);
            return 2;
        }
        throw error;
    }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    process.exitCode = await main(process.argv);
}

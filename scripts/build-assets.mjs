#!/usr/bin/env node
/**
 * dsh-stm32-assets 生成脚本：把「随包会变臃肿、但可以按需下载」的资产集中生成到这里。
 *
 * 分五类（manifest 的 profiles 分成 core / full 两层）：
 *   device/f1/   事实层：chips.json（12 个代表型号）、memory.json（Flash/RAM 布局）、
 *                svd-f1.json（外设 → 寄存器 → 位域，来自 ST 官方 SVD）
 *   ioc/minimal/ F1 每种容量档的最小 .ioc（从 dsh-stm32 的模板渲染，不是从网上下载的）
 *   ld/f1/       每颗代表型号的 <DeviceId>_FLASH.ld（MEMORY 按 Flash/RAM 渲染）
 *   chipdb/f1/   CubeMX 的 db/mcu 里 F1 的 XML（引脚/复用/容量的事实源）
 *   diagrams/    Archify 架构图（不再进 npm 包，放这里分享）
 *
 * 用法：
 *   node scripts/build-assets.mjs                         # 生成 / 刷新全部资产 + manifest.json
 *   node scripts/build-assets.mjs --check                 # 只校验（CI）：与生成结果不一致就退 1
 *   node scripts/build-assets.mjs --plugin <dsh-stm32>    # 插件仓库在哪（默认同级 dsh-stm32）
 *   node scripts/build-assets.mjs --cube-mx <CubeMX 根>   # CubeMX 装在哪（默认 D:/app/STM32CubeMX）
 *   node scripts/build-assets.mjs --svd <本机 SVD 文件>   # 手上已有 STM32F103xx.svd 时直接用
 *
 * 三条设计约束（别破坏，否则 --check 在 CI 上没法用）：
 *   1. 幂等：产物文本里**不写时间戳、不写本机绝对路径**，重复跑逐字节不变。
 *   2. 先算后写：全部产物先在内存里生成完（Map<相对路径, bytes>），再统一写盘或统一比对；
 *      中途失败不会留下半套文件。
 *   3. 可离线：SVD 依次试 --svd → 本地缓存 → 下载 → 沿用上次生成的 svd-f1.json →
 *      手写子集（catch 不到就明说，不假装完整）。chipdb / diagrams 的源目录不存在时
 *      沿用上次生成的文件，不让一台没装 CubeMX 的机器把资产删空。
 *
 * 产物是生成物，不要手改：改了下次 --check 就会红。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
    SVD_NOTES_HANDWRITTEN,
    SVD_NOTES_ST,
    SVD_SOURCE,
    buildSvdF1,
    normalizeAddress,
    parseSvd,
    renderSvdF1,
    svdCounts,
} from "./svd-f1.mjs";
import { HANDWRITTEN_SOURCE, handwrittenPeripherals } from "./svd-handwritten-f1.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const assetsRoot = resolve(here, "..");

/** manifest 的两层 profile：core 是建工程/烧录必需，full 再加上 CubeMX 的 db 与架构图。 */
const PROFILE_CORE = ["device/**", "ioc/**", "ld/**"];
const PROFILE_FULL = ["device/**", "ioc/**", "ld/**", "chipdb/**", "diagrams/**"];

/** 这些目录里的文件全部由本脚本托管：多出来的文件说明有残留，--check 要报出来。 */
const MANAGED_DIRS = ["device", "ioc", "ld", "chipdb", "diagrams"];

/** 版本号写在仓库根的 VERSION 里（YYYY.MM.DD-N）：跑脚本不会改它，发布时才手动抬。 */
const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-\d+$/u;

/** 每个容量档挑一个常见型号当代表（HAL 需要完整型号才能定封装与 .ioc 名字）。 */
const REPRESENTATIVES = [
    "STM32F100C8T6", "STM32F100CET6",
    "STM32F101C6T6", "STM32F101C8T6", "STM32F101CET6", "STM32F101CGT6",
    "STM32F102C6T6", "STM32F102C8T6",
    "STM32F103C6T6", "STM32F103C8T6", "STM32F103VET6", "STM32F103VGT6",
    "STM32F105VCT6", "STM32F107VCT6",
];

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
        svdPath: "",
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
                options.svdPath = resolve(next());
                break;
            default:
                fail("不认识的参数：" + arg + "（可用：--check / --plugin <dir> / --cube-mx <dir> / --svd <file> / --help）");
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

/**
 * SVD 取数：按「离线优先、可疑就降级但仍诚实」的顺序找。
 * 返回 { text, source, counts, origin }，origin 只用于终端提示（不进产物）。
 */
async function resolveSvd(options) {
    const attempts = [];

    const fromParsed = (parsed, source, origin) => {
        const doc = buildSvdF1({
            peripherals: parsed.peripherals,
            addressUnitBits: parsed.addressUnitBits,
            deviceName: parsed.deviceName,
            deviceVersion: parsed.deviceVersion,
            source,
            notes: SVD_NOTES_ST,
        });
        const counts = svdCounts(doc.peripherals);
        if (counts.peripherals === 0) throw new Error("解析出 0 个外设");
        return { text: renderSvdF1(doc), source, counts, origin };
    };

    if (options.svdPath !== "") {
        if (!existsSync(options.svdPath)) fail("--svd 指向的文件不存在：" + options.svdPath);
        const parsed = parseSvd(readFileSync(options.svdPath, "utf8"));
        return fromParsed(
            parsed,
            {
                kind: "st-svd",
                file: basename(options.svdPath),
                device: parsed.deviceName,
                version: parsed.deviceVersion,
                note: "由 --svd 指定的本机 ST SVD 文件（同一份内容任意机器上解析结果相同）",
            },
            "--svd " + basename(options.svdPath),
        );
    }

    const cacheFile = join(assetsRoot, ".cache/svd", SVD_SOURCE.file);
    let raw = null;
    if (existsSync(cacheFile)) {
        raw = readFileSync(cacheFile, "utf8");
        attempts.push("缓存 " + slashed(".cache/svd/" + SVD_SOURCE.file));
    } else {
        try {
            const response = await fetch(SVD_SOURCE.url, {
                headers: { "user-agent": "dsh-stm32-assets build-assets.mjs" },
                signal: AbortSignal.timeout(30000),
            });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const text = await response.text();
            if (!text.includes("<device") || !text.includes("<peripherals")) throw new Error("下载到的内容不像 SVD");
            raw = text;
            if (!options.check) {
                mkdirSync(dirname(cacheFile), { recursive: true });
                writeFileSync(cacheFile, text, "utf8");
            }
            attempts.push("下载 " + SVD_SOURCE.url);
        } catch (error) {
            attempts.push("下载失败（" + error.message + "）");
        }
    }

    if (raw !== null) {
        try {
            const parsed = parseSvd(raw);
            return fromParsed(
                parsed,
                {
                    kind: "st-svd",
                    repo: SVD_SOURCE.repo,
                    commit: SVD_SOURCE.commit,
                    path: SVD_SOURCE.path,
                    url: SVD_SOURCE.url,
                    device: parsed.deviceName,
                    version: parsed.deviceVersion,
                    license: SVD_SOURCE.license,
                },
                attempts[attempts.length - 1],
            );
        } catch (error) {
            attempts.push("缓存/下载的 SVD 解析失败（" + error.message + "）");
        }
    }

    // 离线兜底第一层：仓库里已经有上次生成的 svd-f1.json 就原样沿用（不重写、不改 source）。
    const existing = join(assetsRoot, "device/f1/svd-f1.json");
    if (existsSync(existing)) {
        try {
            const parsed = JSON.parse(readFileSync(existing, "utf8"));
            if (Array.isArray(parsed.peripherals) && parsed.peripherals.length > 0) {
                const counts = svdCounts(parsed.peripherals);
                return {
                    text: readFileSync(existing),
                    source: parsed.source,
                    counts,
                    origin: "沿用已有 device/f1/svd-f1.json（取不到 ST 原件）",
                };
            }
        } catch {
            attempts.push("已有 device/f1/svd-f1.json 也读不动");
        }
    }

    // 离线兜底第二层：手写子集。写完在终端明说「这不是完整 SVD」。
    const handwritten = buildSvdF1({
        peripherals: handwrittenPeripherals(),
        addressUnitBits: 8,
        source: HANDWRITTEN_SOURCE,
        notes: SVD_NOTES_HANDWRITTEN,
    });
    console.warn("⚠ 拿不到 ST 官方 STM32F103xx.svd（" + attempts.join("；") + "），改用**手写子集**（不是完整 SVD）");
    return {
        text: renderSvdF1(handwritten),
        source: HANDWRITTEN_SOURCE,
        counts: svdCounts(handwritten.peripherals),
        origin: "手写子集（离线兜底）",
    };
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
    "  --svd <file>          直接用本机这份 STM32F103xx.svd（不下载）",
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

    // 2) 12 个代表型号 → .ioc / .ld / chips.json / memory.json
    for (const mcu of REPRESENTATIVES) {
        const hal = HAL.resolveHalChip(mcu);
        if (hal.facts === null) {
            skipped.push(mcu + "：" + hal.reason);
            continue;
        }
        const facts = hal.facts;
        const resolved = F1.resolveF1Chip(mcu);
        if (resolved.chip === null) {
            skipped.push(mcu + "：" + resolved.reason);
            continue;
        }
        const chip = resolved.chip;
        // 两个解析器必须说同一件事：不一致就是插件里两张表漂了，宁可不生成。
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

        const iocText = HAL.renderIoc(IOC_TEMPLATE, facts);
        add("ioc/minimal/" + facts.deviceId + ".ioc", iocText, "renderIoc(dsh-stm32 templates/scaffold/demo.ioc, " + mcu + ")", "core");

        const ldText = HAL.renderLinkerScript(LD_TEMPLATE, facts);
        add("ld/f1/" + facts.linkerScript, ldText, "renderLinkerScript(templates/scaffold/STM32F103XX_FLASH.ld, " + mcu + ")", "core");
        ldTexts.set(facts.deviceId, ldText);

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

        // memory.json 的数值直接从刚渲染出来的 .ld 文本里解析，保证和 ld/f1 逐字节同源。
        const regions = parseLinkerMemory(ldText);
        const flash = regions.find((region) => region.name === "FLASH");
        const ram = regions.find((region) => region.name === "RAM");
        if (flash.sizeBytes !== facts.flashBytes) {
            fail(facts.deviceId + " 的 .ld MEMORY 里 FLASH=" + flash.sizeBytes + "，但芯片表写 " + facts.flashBytes);
        }
        if (ram.sizeBytes !== facts.ramBytes) {
            fail(facts.deviceId + " 的 .ld MEMORY 里 RAM=" + ram.sizeBytes + "，但芯片表写 " + facts.ramBytes);
        }
        memoryDevices.push({
            deviceId: facts.deviceId,
            linkerScript: "ld/f1/" + facts.linkerScript,
            regions,
        });
    }

    const compareCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
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
                "代表型号策略：每条产品线的每个容量档挑一颗最常见型号，与 ioc/minimal、ld/f1 是同一批；没收录的型号（RAM 未收录等）见 manifest.json 的 skipped。",
                "flashBytes / ramBytes 是字节数（不是 KiB）；pinCount 是封装总引脚数（HAL 的 pinCount），不是可用 IO 数。",
                "startup / deviceDefine / deviceHeader 与插件 resolveF1Chip 逐字段一致，脚本生成时会逐项对账，对不上就拒绝生成。",
                "mcuName 是写进 .ioc 的 Mcu.Name（CubeMX 的分组名，例如 STM32F103C(8-B)Tx），不一定等于 deviceId。",
            ],
            chips,
        }),
        "dsh-stm32 resolveF1Chip + resolveHalChip（12 个代表型号）",
        "core",
    );

    add(
        "device/f1/memory.json",
        renderJson({
            schema: 1,
            family: "STM32F1",
            sizeUnit: "bytes",
            generatedBy: "scripts/build-assets.mjs",
            source: "ld/f1/<DeviceId>_FLASH.ld 的 MEMORY 段（本脚本先渲染再解析，与 .ld 逐字节同源）",
            count: memoryDevices.length,
            notes: [
                "生成物，不要手改：改数据跑 node scripts/build-assets.mjs（--check 只校验不写盘）。",
                "origin 是十六进制字符串、补足 8 位（0x08000000 / 0x20000000）；sizeBytes 是字节数。",
                "regions 固定按 FLASH、RAM 两区给出；顺序与 .ld 里的书写顺序无关。",
                "解析时会自校验 sizeBytes 等于 chips.json 里的 flashBytes / ramBytes，对不上就拒绝生成。",
            ],
            devices: memoryDevices,
        }),
        "ld/f1 的 MEMORY 段（渲染后解析）",
        "core",
    );

    // 3) SVD → svd-f1.json
    const svd = await resolveSvd(options);
    // SVD 的原始文件是 ST 的 EULA（cmsis-svd-data 的 data/STMicro/License.html），再分发授权不明确，
  // 所以只放进 full：默认的 core 下载不含它；要用寄存器命名的人再显式拉 full。
  add("device/f1/svd-f1.json", svd.text, "ST 官方 SVD → 精简事实表（见文件内 source 字段）", "full");

    // 4) CubeMX 的 F1 db XML：源目录不在就沿用上次生成的文件（不删空）
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

    // 5) 架构图：同上，源目录不在就沿用
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

    // 6) manifest v2：profiles 分层 + 每个文件带 profile；不写时间戳与本机路径，保证幂等
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
    };
    const manifest = {
        name: "dsh-stm32-assets",
        version: version.version,
        schema: 2,
        generatedBy: "scripts/build-assets.mjs",
        profiles: { core: PROFILE_CORE, full: PROFILE_FULL },
        counts,
        device: {
            chips: {
                path: "device/f1/chips.json",
                count: chips.length,
                source: "dsh-stm32 resolveF1Chip + resolveHalChip",
            },
            memory: {
                path: "device/f1/memory.json",
                count: memoryDevices.length,
                source: "ld/f1 的 MEMORY 段",
            },
            svd: {
                path: "device/f1/svd-f1.json",
                kind: svd.source?.kind ?? "unknown",
                counts: svd.counts,
                source: svd.source,
            },
        },
        skipped,
        files,
    };
    add("manifest.json", renderJson(manifest), "manifest v2：profiles + 每个文件的 profile/sha256", null, "manifest");
    add("VERSION", version.version + "\n", "资产版本号（YYYY.MM.DD-N，发布时手动抬）", null, "version");

    // 7) 统一写盘 / 统一比对
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
    const coreCount = files.filter((entry) => entry.profile === "core").length;
    const header = "manifest v" + version.version + "：资产 " + files.length + " 个（core " + coreCount + " / full " +
        files.length + "），另加 manifest.json 与 VERSION 共 " + outputs.size + " 个文件，" +
        (totalBytes / 1024).toFixed(0) + " KB";
    console.log(
        "device/f1：chips " + chips.length + " 颗、memory " + memoryDevices.length + " 颗、svd " + svd.counts.peripherals +
        " 外设 / " + svd.counts.registers + " 寄存器 / " + svd.counts.fields + " 位域（" + svd.origin + "）",
    );
    console.log("ioc/minimal：" + counts.ioc + " 个；ld/f1：" + counts.ld + " 个；chipdb/f1：" + counts.chipdb + " 个；diagrams：" + counts.diagrams + " 个");
    if (skipped.length > 0) {
        console.log("跳过 " + skipped.length + " 个型号：");
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

#!/usr/bin/env node
/**
 * dsh-stm32-assets 生成脚本：把「随包会变臃肿、但可以按需下载」的资产集中生成到这里。
 *
 * 分四类（对应 docs 里的三分法）：
 *   ioc/minimal/  F1 每种容量档的最小 .ioc（从 dsh-stm32 的模板渲染，不是从网上下载的）
 *   ld/f1/        每颗代表型号的 <DeviceId>_FLASH.ld（MEMORY 按 Flash/RAM 渲染）
 *   chipdb/f1/    CubeMX 的 db/mcu 里 F1 的 73 个 XML（引脚/复用/容量的事实源）
 *   diagrams/     Archify 架构图（不再进 npm 包，放这里分享）
 *
 * 这是「可重建」的：改模板或改芯片表后重跑本脚本即可，manifest.json 记录 sha256。
 *   node scripts/build-assets.mjs [--plugin <dsh-stm32 路径>] [--cube-mx <CubeMX 路径>]
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assetsRoot = resolve(here, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const pluginRoot = resolve(arg("--plugin", resolve(assetsRoot, "..", "dsh-stm32")));
const cubeMxRoot = arg("--cube-mx", "D:/app/STM32CubeMX");

const HAL = await import(pathToFileURL(join(pluginRoot, "lib/engine/hal-chip.js")).href);
const IOC_TEMPLATE = readFileSync(join(pluginRoot, "templates/scaffold/demo.ioc"), "utf8");
const LD_TEMPLATE = readFileSync(join(pluginRoot, "templates/scaffold/STM32F103XX_FLASH.ld"), "utf8");

/** 每个容量档挑一个常见型号当代表（HAL 需要完整型号才能定封装与 .ioc 名字）。 */
const REPRESENTATIVES = [
  "STM32F100C8T6", "STM32F100CET6",
  "STM32F101C6T6", "STM32F101C8T6", "STM32F101CET6", "STM32F101CGT6",
  "STM32F102C6T6", "STM32F102C8T6",
  "STM32F103C6T6", "STM32F103C8T6", "STM32F103VET6", "STM32F103VGT6",
  "STM32F105VCT6", "STM32F107VCT6",
];

const entries = [];
const skipped = [];

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensure(dir) {
  mkdirSync(dir, { recursive: true });
}

function record(path, source) {
  const rel = path.slice(assetsRoot.length + 1).replace(/\\/g, "/");
  entries.push({ path: rel, bytes: readFileSync(path).length, sha256: sha256(path), source });
}

// 1) 最小 .ioc 与 .ld
ensure(join(assetsRoot, "ioc/minimal"));
ensure(join(assetsRoot, "ld/f1"));
for (const mcu of REPRESENTATIVES) {
  const { facts, reason } = HAL.resolveHalChip(mcu);
  if (facts === null) {
    skipped.push(mcu + "：" + reason);
    continue;
  }
  const iocPath = join(assetsRoot, "ioc/minimal", facts.deviceId + ".ioc");
  writeFileSync(iocPath, HAL.renderIoc(IOC_TEMPLATE, facts), "utf8");
  record(iocPath, "renderIoc(dsh-stm32 templates/scaffold/demo.ioc, " + mcu + ")");

  const ldPath = join(assetsRoot, "ld/f1", facts.linkerScript);
  writeFileSync(ldPath, HAL.renderLinkerScript(LD_TEMPLATE, facts), "utf8");
  record(ldPath, "renderLinkerScript(STM32F103XX_FLASH.ld, " + mcu + ")");
}

// 2) CubeMX 的 F1 db XML
const dbDir = join(cubeMxRoot, "db/mcu");
ensure(join(assetsRoot, "chipdb/f1"));
if (existsSync(dbDir)) {
  let copied = 0;
  for (const name of readdirSync(dbDir)) {
    if (!/^STM32F10.*\.xml$/i.test(name)) continue;
    const target = join(assetsRoot, "chipdb/f1", name);
    copyFileSync(join(dbDir, name), target);
    record(target, "CubeMX " + cubeMxRoot + "/db/mcu/" + name);
    copied += 1;
  }
  console.log("chipdb/f1：" + copied + " 个 XML");
} else {
  console.log("跳过 chipdb：" + dbDir + " 不存在");
}

// 3) 架构图
const diagramSrc = join(pluginRoot, "docs/diagrams");
ensure(join(assetsRoot, "diagrams"));
if (existsSync(diagramSrc)) {
  for (const name of readdirSync(diagramSrc)) {
    const target = join(assetsRoot, "diagrams", name);
    copyFileSync(join(diagramSrc, name), target);
    record(target, "dsh-stm32 docs/diagrams/" + name);
  }
}

// 4) manifest
const manifest = {
  name: "dsh-stm32-assets",
  generatedBy: "scripts/build-assets.mjs",
  plugin: pluginRoot,
  cubeMx: cubeMxRoot,
  counts: {
    ioc: entries.filter((e) => e.path.startsWith("ioc/")).length,
    ld: entries.filter((e) => e.path.startsWith("ld/")).length,
    chipdb: entries.filter((e) => e.path.startsWith("chipdb/")).length,
    diagrams: entries.filter((e) => e.path.startsWith("diagrams/")).length,
  },
  skipped,
  files: entries.sort((a, b) => a.path.localeCompare(b.path)),
};
writeFileSync(join(assetsRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
console.log("ioc=" + manifest.counts.ioc + " ld=" + manifest.counts.ld + " chipdb=" + manifest.counts.chipdb + " diagrams=" + manifest.counts.diagrams);
console.log("合计 " + (totalBytes / 1024).toFixed(0) + " KB，" + entries.length + " 个文件，跳过 " + skipped.length + " 个型号");
for (const s of skipped) console.log("  skip " + s);

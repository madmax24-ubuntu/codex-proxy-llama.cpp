#!/usr/bin/env node
/**
 * Automated Context Size & Vision Configurator for Codex + llama.cpp Proxy
 *
 * Automatically recalculates and synchronizes:
 *   - model_context_window (configured context in config.toml & model_catalog.json)
 *   - model_auto_compact_token_limit (safe compaction threshold, default ~90% of effective context)
 *   - CODEX_POST_COMPACT_PRUNE_TRIGGER_TOKENS (emergency prune threshold in .bat & proxy)
 *   - effective_context_window_percent (95% standard)
 *   - CODEX_VISION_ENABLED (toggle multimodal vision support on/off)
 *
 * Usage:
 *   node set_context_size.js 120064
 *   node set_context_size.js 128k
 *   node set_context_size.js 64k vision off
 *   node set_context_size.js vision on
 *   node set_context_size.js vision off
 *   node set_context_size.js --status
 *   node set_context_size.js (interactive menu if run with no args)
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

function parseTokens(arg) {
  if (!arg) return null;
  const str = String(arg).trim().toLowerCase();
  const kMatch = str.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kMatch) {
    const val = parseFloat(kMatch[1]);
    return Math.round(val * 1024);
  }
  const num = parseInt(str, 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function resolveDirectories() {
  const candidates = [
    process.env.CODEX_HOME,
    path.resolve(__dirname, "../codex-home"),
    path.resolve(__dirname, "codex-home"),
    path.resolve(__dirname)
  ].filter(Boolean);

  let codexHome = null;
  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand, "config.toml")) || fs.existsSync(path.join(cand, "model_catalog.json"))) {
      codexHome = cand;
      break;
    }
  }

  const vscodeRoot = codexHome ? path.resolve(codexHome, "..") : path.resolve(__dirname, "..");
  return { codexHome, vscodeRoot };
}

function calculateContextParameters(liveContext, compactPct = 90, effectivePct = 95) {
  let configured = Math.ceil(liveContext / (effectivePct / 100));
  while (Math.floor(configured * (effectivePct / 100)) > liveContext) {
    configured--;
  }
  const effective = Math.floor(configured * (effectivePct / 100));
  const autoCompact = Math.floor(effective * (compactPct / 100));
  const pruneTrigger = Math.floor(effective * 0.933);

  return {
    liveContext,
    configuredContext: configured,
    effectiveContext: effective,
    effectivePercent: effectivePct,
    autoCompactTokenLimit: autoCompact,
    pruneTriggerTokens: pruneTrigger
  };
}

function updateFile(filePath, regex, replacement) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, "utf8");
  if (!regex.test(content)) return false;
  const updated = content.replace(regex, replacement);
  if (updated !== content) {
    fs.writeFileSync(filePath, updated, "utf8");
    return true;
  }
  return false;
}

function getCurrentConfig(codexHome, vscodeRoot) {
  const configTomlPath = path.join(codexHome, "config.toml");
  const batPath = path.join(vscodeRoot, "Start-Codex-Qwen-v16.bat");
  const catalogPath = path.join(codexHome, "model_catalog.json");

  let contextWindow = null;
  let autoCompact = null;
  let pruneTokens = null;
  let visionEnabled = true;

  if (fs.existsSync(configTomlPath)) {
    const text = fs.readFileSync(configTomlPath, "utf8");
    const m1 = text.match(/model_context_window\s*=\s*(\d+)/);
    if (m1) contextWindow = parseInt(m1[1], 10);
    const m2 = text.match(/model_auto_compact_token_limit\s*=\s*(\d+)/);
    if (m2) autoCompact = parseInt(m2[1], 10);
  }

  if (fs.existsSync(batPath)) {
    const text = fs.readFileSync(batPath, "utf8");
    const m3 = text.match(/set\s+"CODEX_POST_COMPACT_PRUNE_TRIGGER_TOKENS=(\d+)"/i);
    if (m3) pruneTokens = parseInt(m3[1], 10);
    const m4 = text.match(/set\s+"CODEX_VISION_ENABLED=([01])"/i);
    if (m4) visionEnabled = m4[1] === "1";
  }

  if (fs.existsSync(catalogPath)) {
    try {
      const cat = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      const m = (cat.models || []).find(x => x.slug === "llm" || x.id === "llm");
      if (m && Array.isArray(m.supported_media_types)) {
        visionEnabled = m.supported_media_types.includes("image");
      }
    } catch {}
  }

  return { contextWindow, autoCompact, pruneTokens, visionEnabled };
}

function applyConfiguration(codexHome, vscodeRoot, requestedTokens, visionToggle, dryRun = false) {
  const configTomlPath = path.join(codexHome, "config.toml");
  const catalogPath = path.join(codexHome, "model_catalog.json");
  const prepareConfigPath = path.join(codexHome, "prepare_config.js");
  const batPath = path.join(vscodeRoot, "Start-Codex-Qwen-v16.bat");

  const current = getCurrentConfig(codexHome, vscodeRoot);
  const targetLive = requestedTokens || Math.floor((current.contextWindow || 126383) * 0.95);
  const params = calculateContextParameters(targetLive);

  console.log("\n========================================================");
  console.log("  Calculated Configuration Thresholds");
  console.log("========================================================");
  if (requestedTokens != null) {
    console.log(`Target Live Context (n_ctx):       ${params.liveContext.toLocaleString()} tokens`);
    console.log(`Configured Context Window:         ${params.configuredContext.toLocaleString()} tokens`);
    console.log(`Effective Window (${params.effectivePercent}%):             ${params.effectiveContext.toLocaleString()} tokens`);
    console.log(`Auto-Compact Trigger (90%):        ${params.autoCompactTokenLimit.toLocaleString()} tokens`);
    console.log(`Post-Compact Prune Trigger (93%):  ${params.pruneTriggerTokens.toLocaleString()} tokens`);
    console.log(`Safety Response Cushion:           ${(params.liveContext - params.autoCompactTokenLimit).toLocaleString()} tokens`);
  } else {
    console.log(`Context Window:                    Unchanged (${(current.contextWindow || 126383).toLocaleString()} tokens)`);
  }

  if (visionToggle !== null) {
    console.log(`Multimodal Vision Support:         ${visionToggle ? "ENABLED (image_url enabled for Vision models)" : "DISABLED (graceful text replacement for text-only models)"}`);
  } else {
    console.log(`Multimodal Vision Support:         ${current.visionEnabled ? "ENABLED" : "DISABLED"}`);
  }
  console.log("========================================================");

  if (dryRun) {
    console.log("[Dry-run mode] No files were modified.\n");
    return;
  }

  const modified = [];

  // 1. Update config.toml
  if (requestedTokens != null) {
    if (updateFile(configTomlPath, /model_context_window\s*=\s*\d+/, `model_context_window = ${params.configuredContext}`)) {
      modified.push("config.toml (model_context_window)");
    }
    if (updateFile(configTomlPath, /model_auto_compact_token_limit\s*=\s*\d+/, `model_auto_compact_token_limit = ${params.autoCompactTokenLimit}`)) {
      modified.push("config.toml (model_auto_compact_token_limit)");
    }
  }

  // 2. Update model_catalog.json
  if (fs.existsSync(catalogPath)) {
    try {
      const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
      let changed = false;
      for (const m of catalog.models || []) {
        if (m.slug === "llm" || m.id === "llm") {
          if (requestedTokens != null) {
            m.context_window = params.configuredContext;
            m.max_context_window = params.configuredContext;
            m.auto_compact_token_limit = params.autoCompactTokenLimit;
            m.effective_context_window_percent = params.effectivePercent;
            changed = true;
          }
          if (visionToggle !== null) {
            if (visionToggle) {
              if (!Array.isArray(m.supported_media_types)) m.supported_media_types = [];
              if (!m.supported_media_types.includes("image")) m.supported_media_types.push("image");
            } else {
              if (Array.isArray(m.supported_media_types)) {
                m.supported_media_types = m.supported_media_types.filter(x => x !== "image");
              }
            }
            changed = true;
          }
        }
      }
      if (changed) {
        fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
        modified.push("model_catalog.json");
      }
    } catch (e) {
      console.warn("Warning: unable to update model_catalog.json:", e.message);
    }
  }

  // 3. Update prepare_config.js
  if (requestedTokens != null && fs.existsSync(prepareConfigPath)) {
    let prepChanged = false;
    if (updateFile(prepareConfigPath, /replaceToml\("model_context_window",\s*"\d+"\)/, `replaceToml("model_context_window", "${params.configuredContext}")`)) prepChanged = true;
    if (updateFile(prepareConfigPath, /replaceToml\("model_auto_compact_token_limit",\s*"\d+"\)/, `replaceToml("model_auto_compact_token_limit", "${params.autoCompactTokenLimit}")`)) prepChanged = true;
    if (updateFile(prepareConfigPath, /model\.context_window\s*=\s*\d+/, `model.context_window = ${params.configuredContext}`)) prepChanged = true;
    if (updateFile(prepareConfigPath, /model\.max_context_window\s*=\s*\d+/, `model.max_context_window = ${params.configuredContext}`)) prepChanged = true;
    if (updateFile(prepareConfigPath, /model\.auto_compact_token_limit\s*=\s*\d+/, `model.auto_compact_token_limit = ${params.autoCompactTokenLimit}`)) prepChanged = true;
    if (prepChanged) modified.push("prepare_config.js");
  }

  // 4. Update Start-Codex-Qwen-v16.bat
  if (fs.existsSync(batPath)) {
    let batChanged = false;
    if (requestedTokens != null) {
      if (updateFile(batPath, /set\s+"CODEX_POST_COMPACT_PRUNE_TRIGGER_TOKENS=\d+"/, `set "CODEX_POST_COMPACT_PRUNE_TRIGGER_TOKENS=${params.pruneTriggerTokens}"`)) {
        batChanged = true;
      }
      if (/set\s+"CODEX_CONTEXT_WINDOW=\d+"/i.test(fs.readFileSync(batPath, "utf8"))) {
        if (updateFile(batPath, /set\s+"CODEX_CONTEXT_WINDOW=\d+"/i, `set "CODEX_CONTEXT_WINDOW=${params.configuredContext}"`)) batChanged = true;
      }
      if (/set\s+"CODEX_AUTO_COMPACT_LIMIT=\d+"/i.test(fs.readFileSync(batPath, "utf8"))) {
        if (updateFile(batPath, /set\s+"CODEX_AUTO_COMPACT_LIMIT=\d+"/i, `set "CODEX_AUTO_COMPACT_LIMIT=${params.autoCompactTokenLimit}"`)) batChanged = true;
      }
    }
    if (visionToggle !== null) {
      const visionVal = visionToggle ? "1" : "0";
      if (/set\s+"CODEX_VISION_ENABLED=[01]"/i.test(fs.readFileSync(batPath, "utf8"))) {
        if (updateFile(batPath, /set\s+"CODEX_VISION_ENABLED=[01]"/i, `set "CODEX_VISION_ENABLED=${visionVal}"`)) batChanged = true;
      } else {
        const content = fs.readFileSync(batPath, "utf8");
        const target = 'set "CODEX_POST_COMPACT_TOOL_OUTPUT_KEEP_RECENT=2"';
        if (content.includes(target)) {
          fs.writeFileSync(batPath, content.replace(target, `${target}\r\nset "CODEX_VISION_ENABLED=${visionVal}"`), "utf8");
          batChanged = true;
        }
      }
    }
    if (batChanged) modified.push("Start-Codex-Qwen-v16.bat");
  }

  console.log("\nSuccess! The following files have been synchronized:");
  for (const f of modified) {
    console.log(`  + ${f}`);
  }
  console.log("\nAll context parameters and thresholds are now cleanly aligned.\n");
}

function promptInteractive(codexHome, vscodeRoot) {
  const current = getCurrentConfig(codexHome, vscodeRoot);
  console.log("========================================================");
  console.log("    Codex Context & Vision Configuration Manager");
  console.log("========================================================");
  console.log("Current Configuration:");
  console.log(`  - Context Window:      ${(current.contextWindow || 126383).toLocaleString()} tokens (effective: ${Math.floor((current.contextWindow || 126383)*0.95).toLocaleString()})`);
  console.log(`  - Auto-Compact Limit:  ${(current.autoCompact || 108000).toLocaleString()} tokens`);
  console.log(`  - Prune Trigger:       ${(current.pruneTokens || 112000).toLocaleString()} tokens`);
  console.log(`  - Multimodal Vision:   ${current.visionEnabled ? "ENABLED (image_url for Vision models)" : "DISABLED (text replacement for text-only models)"}`);
  console.log("========================================================");
  console.log("Select an option:");
  console.log("  [1] Change Context Size (e.g. 120064, 128k, 64k, 32k)");
  console.log("  [2] Turn Vision OFF (for text-only models, prevents screenshot errors)");
  console.log("  [3] Turn Vision ON  (for Qwen-VL & multimodal models)");
  console.log("  [4] Quick Presets: 120k Qwen-VL (Full)");
  console.log("  [5] Quick Presets: 64k Text-Only (No Vision)");
  console.log("  [6] Quick Presets: 32k Fast Text (No Vision)");
  console.log("  [0] Exit without changes");
  console.log("--------------------------------------------------------");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question("Enter choice [0-6]: ", answer => {
    const choice = answer.trim();
    if (choice === "1") {
      rl.question("Enter new context tokens (e.g. 120064, 128k, 64k, 32k): ", ctxStr => {
        const tokens = parseTokens(ctxStr);
        if (!tokens) {
          console.log("Invalid token count entered.");
          rl.close();
          return;
        }
        applyConfiguration(codexHome, vscodeRoot, tokens, null);
        rl.close();
      });
    } else if (choice === "2") {
      applyConfiguration(codexHome, vscodeRoot, null, false);
      rl.close();
    } else if (choice === "3") {
      applyConfiguration(codexHome, vscodeRoot, null, true);
      rl.close();
    } else if (choice === "4") {
      applyConfiguration(codexHome, vscodeRoot, 120064, true);
      rl.close();
    } else if (choice === "5") {
      applyConfiguration(codexHome, vscodeRoot, 65536, false);
      rl.close();
    } else if (choice === "6") {
      applyConfiguration(codexHome, vscodeRoot, 32768, false);
      rl.close();
    } else {
      console.log("Exited without changes.");
      rl.close();
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  let requestedTokens = null;
  let visionToggle = null;
  let dryRun = false;
  let showStatus = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    if (arg === "--status" || arg === "-s" || arg === "status") {
      showStatus = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "vision" && args[i + 1]) {
      const next = args[++i].toLowerCase();
      if (next === "on" || next === "1" || next === "enable") visionToggle = true;
      else if (next === "off" || next === "0" || next === "disable") visionToggle = false;
    } else if (arg === "--vision=on" || arg === "--vision" || arg === "--enable-vision" || arg === "vision-on") {
      visionToggle = true;
    } else if (arg === "--vision=off" || arg === "--no-vision" || arg === "--disable-vision" || arg === "vision-off") {
      visionToggle = false;
    } else if (!arg.startsWith("-")) {
      const parsed = parseTokens(arg);
      if (parsed != null && requestedTokens == null) {
        requestedTokens = parsed;
      }
    }
  }

  const { codexHome, vscodeRoot } = resolveDirectories();
  if (!codexHome) {
    console.error("Error: could not find codex-home directory");
    process.exit(1);
  }

  if (showStatus) {
    const current = getCurrentConfig(codexHome, vscodeRoot);
    console.log("========================================================");
    console.log("    Codex Context & Vision Current Status");
    console.log("========================================================");
    console.log(`Context Window:      ${(current.contextWindow || 126383).toLocaleString()} tokens (effective: ${Math.floor((current.contextWindow || 126383)*0.95).toLocaleString()})`);
    console.log(`Auto-Compact Limit:  ${(current.autoCompact || 108000).toLocaleString()} tokens`);
    console.log(`Prune Trigger:       ${(current.pruneTokens || 112000).toLocaleString()} tokens`);
    console.log(`Multimodal Vision:   ${current.visionEnabled ? "ENABLED" : "DISABLED"}`);
    console.log("========================================================");
    process.exit(0);
  }

  // Interactive menu if run with no args
  if (requestedTokens == null && visionToggle == null) {
    if (process.stdin.isTTY) {
      promptInteractive(codexHome, vscodeRoot);
      return;
    } else {
      console.log("Usage: node set_context_size.js <tokens> [vision on|off] [--dry-run]");
      process.exit(0);
    }
  }

  applyConfiguration(codexHome, vscodeRoot, requestedTokens, visionToggle, dryRun);
}

if (require.main === module) {
  main();
}

module.exports = { calculateContextParameters, parseTokens, applyConfiguration };

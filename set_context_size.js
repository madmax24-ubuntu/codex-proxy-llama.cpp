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
 *   node set_context_size.js 64k --vision=off
 *   node set_context_size.js 32000 --vision=on
 *   node set_context_size.js --status
 */

const fs = require("fs");
const path = require("path");

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

function main() {
  const args = process.argv.slice(2);
  let requestedTokens = null;
  let visionToggle = null; // null: unchanged, true: on, false: off
  let dryRun = false;
  let showStatus = false;

  for (const arg of args) {
    if (arg === "--status" || arg === "-s") {
      showStatus = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--vision=on" || arg === "--vision" || arg === "--enable-vision") {
      visionToggle = true;
    } else if (arg === "--vision=off" || arg === "--no-vision" || arg === "--disable-vision") {
      visionToggle = false;
    } else if (!arg.startsWith("-") && requestedTokens == null) {
      requestedTokens = parseTokens(arg);
    }
  }

  const { codexHome, vscodeRoot } = resolveDirectories();
  if (!codexHome) {
    console.error("Error: could not find codex-home directory (config.toml / model_catalog.json)");
    process.exit(1);
  }

  const configTomlPath = path.join(codexHome, "config.toml");
  const catalogPath = path.join(codexHome, "model_catalog.json");
  const prepareConfigPath = path.join(codexHome, "prepare_config.js");
  const batPath = path.join(vscodeRoot, "Start-Codex-Qwen-v16.bat");

  // Read current values
  let currentConfigContext = null;
  let currentConfigAutoCompact = null;
  if (fs.existsSync(configTomlPath)) {
    const text = fs.readFileSync(configTomlPath, "utf8");
    const m1 = text.match(/model_context_window\s*=\s*(\d+)/);
    if (m1) currentConfigContext = parseInt(m1[1], 10);
    const m2 = text.match(/model_auto_compact_token_limit\s*=\s*(\d+)/);
    if (m2) currentConfigAutoCompact = parseInt(m2[1], 10);
  }

  if (showStatus || (requestedTokens == null && visionToggle == null)) {
    console.log("========================================================");
    console.log("  Codex + llama.cpp Context & Vision Configuration");
    console.log("========================================================");
    console.log(`Codex Home:     ${codexHome}`);
    console.log(`VS Code Root:   ${vscodeRoot}`);
    console.log(`Current Config:`);
    console.log(`  model_context_window:           ${currentConfigContext || "unknown"}`);
    console.log(`  model_auto_compact_token_limit: ${currentConfigAutoCompact || "unknown"}`);
    console.log("\nUsage:");
    console.log("  node set_context_size.js <tokens> [--vision=on|off] [--dry-run]");
    console.log("\nExamples:");
    console.log("  node set_context_size.js 120064");
    console.log("  node set_context_size.js 128k");
    console.log("  node set_context_size.js 64000 --vision=off");
    console.log("  node set_context_size.js 32k");
    console.log("  node set_context_size.js --vision=off");
    process.exit(0);
  }

  const targetLive = requestedTokens || Math.floor((currentConfigContext || 126383) * 0.95);
  const params = calculateContextParameters(targetLive);

  console.log("========================================================");
  console.log("  Calculated Context & Compaction Parameters");
  console.log("========================================================");
  console.log(`Target Live Context (n_ctx):       ${params.liveContext.toLocaleString()} tokens`);
  console.log(`Configured Context Window:         ${params.configuredContext.toLocaleString()} tokens`);
  console.log(`Effective Window (${params.effectivePercent}%):             ${params.effectiveContext.toLocaleString()} tokens`);
  console.log(`Auto-Compact Trigger (90%):        ${params.autoCompactTokenLimit.toLocaleString()} tokens`);
  console.log(`Post-Compact Prune Trigger (93%):  ${params.pruneTriggerTokens.toLocaleString()} tokens`);
  console.log(`Guaranteed Response Safety Margin: ${(params.liveContext - params.autoCompactTokenLimit).toLocaleString()} tokens`);
  if (visionToggle !== null) {
    console.log(`Multimodal Vision:                 ${visionToggle ? "ENABLED (image_url enabled)" : "DISABLED (graceful text replacement)"}`);
  }
  console.log("========================================================");

  if (dryRun) {
    console.log("[Dry-run] No files modified.");
    process.exit(0);
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
    }
    if (visionToggle !== null) {
      const visionVal = visionToggle ? "1" : "0";
      if (/set\s+"CODEX_VISION_ENABLED=[01]"/i.test(fs.readFileSync(batPath, "utf8"))) {
        if (updateFile(batPath, /set\s+"CODEX_VISION_ENABLED=[01]"/i, `set "CODEX_VISION_ENABLED=${visionVal}"`)) batChanged = true;
      } else {
        const content = fs.readFileSync(batPath, "utf8");
        const target = 'set "CODEX_PROXY_DEBUG=0"';
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
  console.log("\nAll thresholds and context parameters are now perfectly aligned.");
}

if (require.main === module) {
  main();
}

module.exports = { calculateContextParameters, parseTokens };

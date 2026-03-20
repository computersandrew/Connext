#!/usr/bin/env node
// connext-ingestion/scripts/validate-adapters.js
// ─────────────────────────────────────────────────────────────────────────────
// Validates that all adapters:
//   1. Export a class extending BaseAdapter
//   2. Implement parseFeed() and normalize()
//   3. Have a matching config entry in systems.js
//   4. Have required env vars documented
// ─────────────────────────────────────────────────────────────────────────────

import { readdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SYSTEMS } from "../config/systems.js";
import { BaseAdapter } from "../src/core/BaseAdapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "src", "adapters");

async function validate() {
  console.log("\n🔍 Validating Connext adapters...\n");

  const files = await readdir(ADAPTERS_DIR);
  const adapterFiles = files.filter((f) => f.endsWith(".js") && !f.startsWith("_"));

  let errors = 0;
  let warnings = 0;

  for (const file of adapterFiles) {
    const id = file.replace(".js", "");
    const prefix = `  [${id}]`;

    try {
      const mod = await import(`file://${join(ADAPTERS_DIR, file)}`);
      const AdapterClass = mod.default || mod.Adapter;

      if (!AdapterClass) {
        console.log(`${prefix} ❌ No default export or Adapter class`);
        errors++;
        continue;
      }

      // Check it extends BaseAdapter
      if (!(AdapterClass.prototype instanceof BaseAdapter)) {
        console.log(`${prefix} ❌ Does not extend BaseAdapter`);
        errors++;
        continue;
      }

      // Check required methods exist and are overridden
      const requiredMethods = ["parseFeed", "normalize"];
      for (const method of requiredMethods) {
        if (AdapterClass.prototype[method] === BaseAdapter.prototype[method]) {
          console.log(`${prefix} ❌ Does not override ${method}()`);
          errors++;
        }
      }

      // Check for matching config
      const configEntry = Object.values(SYSTEMS).find((s) => s.adapter === id);
      if (!configEntry) {
        console.log(`${prefix} ⚠️  No config entry in systems.js (adapter="${id}")`);
        warnings++;
      } else {
        // Check auth env var
        if (configEntry.auth.type !== "none" && configEntry.auth.envVar) {
          if (!process.env[configEntry.auth.envVar]) {
            console.log(`${prefix} ⚠️  Missing env var: ${configEntry.auth.envVar}`);
            warnings++;
          }
        }
        console.log(`${prefix} ✅ Valid — config: ${configEntry.name} (${configEntry.city})`);
      }

    } catch (err) {
      console.log(`${prefix} ❌ Failed to load: ${err.message}`);
      errors++;
    }
  }

  // Check for configs without adapters
  for (const [sysId, config] of Object.entries(SYSTEMS)) {
    if (!adapterFiles.includes(`${config.adapter}.js`)) {
      console.log(`  [config:${sysId}] ⚠️  References adapter "${config.adapter}" but no file found`);
      warnings++;
    }
  }

  console.log(`\n  📊 Results: ${adapterFiles.length} adapters, ${errors} errors, ${warnings} warnings\n`);

  if (errors > 0) {
    console.log("  ❌ Validation failed.\n");
    process.exit(1);
  } else {
    console.log("  ✅ All adapters valid.\n");
  }
}

validate().catch((err) => {
  console.error("Validation script error:", err);
  process.exit(1);
});

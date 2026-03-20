// connext-ingestion/src/core/Orchestrator.js
// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATOR
// Dynamically loads adapter modules, starts/stops them, tracks health,
// and provides a control interface for the API layer.
// ─────────────────────────────────────────────────────────────────────────────

import { readdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "adapters");

export class Orchestrator {
  /**
   * @param {object} systems - The SYSTEMS config object
   * @param {object} deps - { redis, pg, logger, fetcher }
   */
  constructor(systems, deps) {
    this.systems = systems;
    this.deps = deps;
    this.logger = deps.logger.child({ component: "orchestrator" });
    this.adapters = new Map();   // id -> adapter instance
    this._registry = new Map();  // id -> adapter class
  }

  /**
   * Discover and load all adapter modules from src/adapters/
   * Each module must export a class that extends BaseAdapter
   */
  async loadAdapters() {
    const files = await readdir(ADAPTERS_DIR);
    const adapterFiles = files.filter((f) => f.endsWith(".js") && !f.startsWith("_"));

    this.logger.info(`Discovered ${adapterFiles.length} adapter file(s)`);

    for (const file of adapterFiles) {
      try {
        const modulePath = join(ADAPTERS_DIR, file);
        const mod = await import(`file://${modulePath}`);

        // Each module exports a default class or a named 'Adapter' class
        const AdapterClass = mod.default || mod.Adapter;
        if (!AdapterClass) {
          this.logger.warn(`${file}: No default export or Adapter class found, skipping`);
          continue;
        }

        // The adapter's static id property or the filename (without .js)
        const adapterId = AdapterClass.adapterId || file.replace(".js", "");
        this._registry.set(adapterId, AdapterClass);
        this.logger.info(`  → Loaded adapter: ${adapterId} (${file})`);

      } catch (err) {
        this.logger.error({ err, file }, `Failed to load adapter: ${file}`);
      }
    }
  }

  /**
   * Start all enabled systems that have a matching adapter
   */
  async startAll() {
    const enabled = Object.values(this.systems).filter((s) => s.enabled);
    this.logger.info(`Starting ${enabled.length} enabled system(s)...`);

    for (const systemConfig of enabled) {
      await this.startSystem(systemConfig.id);
    }
  }

  /**
   * Start a single system by id
   */
  async startSystem(systemId) {
    const systemConfig = this.systems[systemId];
    if (!systemConfig) {
      this.logger.error(`System not found in config: ${systemId}`);
      return false;
    }

    const AdapterClass = this._registry.get(systemConfig.adapter);
    if (!AdapterClass) {
      this.logger.error(`No adapter registered for: ${systemConfig.adapter} (system: ${systemId})`);
      return false;
    }

    // Check for required auth
    if (systemConfig.auth.type !== "none" && systemConfig.auth.envVar) {
      if (!process.env[systemConfig.auth.envVar]) {
        this.logger.warn(
          `⚠ ${systemId}: Missing env var ${systemConfig.auth.envVar} — feeds may fail`
        );
      }
    }

    try {
      const adapter = new AdapterClass(systemConfig, this.deps);
      await adapter.start();
      this.adapters.set(systemId, adapter);
      return true;
    } catch (err) {
      this.logger.error({ err, systemId }, `Failed to start system: ${systemId}`);
      return false;
    }
  }

  /**
   * Stop a single system
   */
  async stopSystem(systemId) {
    const adapter = this.adapters.get(systemId);
    if (!adapter) return;
    await adapter.stop();
    this.adapters.delete(systemId);
  }

  /**
   * Stop all running systems
   */
  async stopAll() {
    this.logger.info("Stopping all adapters...");
    for (const [id] of this.adapters) {
      await this.stopSystem(id);
    }
  }

  /**
   * Get health status for all systems
   */
  getHealth() {
    const systems = {};
    for (const [id, config] of Object.entries(this.systems)) {
      const adapter = this.adapters.get(id);
      systems[id] = {
        config: {
          name: config.name,
          city: config.city,
          enabled: config.enabled,
        },
        status: adapter ? "running" : config.enabled ? "stopped" : "disabled",
        stats: adapter ? adapter.getStats() : null,
      };
    }

    return {
      timestamp: new Date().toISOString(),
      totalSystems: Object.keys(this.systems).length,
      runningSystems: this.adapters.size,
      systems,
    };
  }

  /**
   * List all registered adapter IDs (available adapters, not just running ones)
   */
  getRegisteredAdapters() {
    return Array.from(this._registry.keys());
  }
}

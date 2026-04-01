/**
 * src/http/startupChecks.js
 *
 * Runs at server startup and logs actionable warnings for common
 * misconfigurations that are fine locally but risky when exposed.
 *
 * Called once from index.js before app.listen().
 */

import os   from "os";
import { config } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { isOllamaAvailable } from "../agent/ollamaClient.js";

const log = createLogger("startup");

/**
 * Resolve the primary non-loopback IPv4 address of this machine.
 * Returns null if only loopback is available.
 */
function getNetworkIp() {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
        for (const iface of list) {
            if (iface.family === "IPv4" && !iface.internal) return iface.address;
        }
    }
    return null;
}

export async function runStartupChecks() {
    const networkIp = getNetworkIp();
    const isExposed = networkIp !== null;  // machine has at least one non-loopback interface

    // ── CORS wildcard warning ────────────────────────────────────────────────────────
    if (config.CORS_ORIGIN === "*" && isExposed) {
        log.warn("CORS_ORIGIN=* — any browser origin can call this server.");
        log.warn(`  Network IP: ${networkIp}  Port: ${config.PORT}`);
        log.warn("  Set CORS_ORIGIN=https://your-ide-url in .env to restrict access.");
    }

    // ── No API keys warning ───────────────────────────────────────────────────────────────
    const hasKeys = Object.keys(config.API_KEY_MAP).length > 0;
    if (!hasKeys && isExposed) {
        log.warn("No API_KEYS configured — /run and other endpoints are UNPROTECTED.");
        log.warn("  Add API_KEYS=user:secret to .env to require authentication.");
    }

    // ── Remote registration warning
    if (!config.DISABLE_REMOTE_REGISTER && isExposed) {
        if (config.ALLOWED_ROOTS.length > 0) {
            log.warn("project_register is enabled but restricted to:");
            config.ALLOWED_ROOTS.forEach(r => log.warn(`  ${r}`));
        } else {
            log.warn("SECURITY: DISABLE_REMOTE_REGISTER=false and no ALLOWED_ROOTS set.");
            log.warn("  Any API-key holder can register and operate on ANY path on this machine.");
            log.warn("  Set DISABLE_REMOTE_REGISTER=true in .env (recommended for public servers).");
        }
    }

    // ── Training collection status ───────────────────────────────────────────────────────
    const collectEnabled = process.env.COLLECT_TRAINING_DATA === "1";
    if (collectEnabled) {
        log.info("Training data collection ENABLED — successful runs will be logged to data/training/runs.jsonl");
    }

    // ── Ollama liveness probe (async, non-blocking) ──────────────────────────────────
    isOllamaAvailable().then(({ available, models, error }) => {
        if (available) {
            log.info(`Ollama reachable at ${config.OLLAMA_HOST}`);
            if (models.length > 0) {
                log.info(`  Available models: ${models.join(", ")}`);
            } else {
                log.warn(`  No models found. Run: ollama pull qwen2.5-coder:7b`);
            }
        } else {
            log.warn(`Ollama NOT reachable at ${config.OLLAMA_HOST} — agent will fail when LLM is needed.`);
            if (error) log.warn(`  Error: ${error}`);
            log.warn(`  Make sure Ollama is running: ollama serve`);
        }
    }).catch(err => log.warn(`Ollama probe failed: ${err.message}`));

    // ── Summary line ───────────────────────────────────────────────────────────────────────────────────
    log.info(`AI Dev MCP server started | transport=${config.TRANSPORT} | port=${config.PORT} | cors=${config.CORS_ORIGIN} | auth=${hasKeys ? "enabled" : "disabled"}`);
    if (networkIp) log.info(`  Network address: http://${networkIp}:${config.PORT}`);
}

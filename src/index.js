/**
 * immich-cross-account-proxy
 *
 * Sits in front of Immich and transparently routes mutating operations
 * (delete, metadata update) to the correct account's API key based on
 * asset ownership and a configurable permission map.
 *
 * All other requests (reads, uploads, auth, WebSocket) are proxied
 * untouched to the upstream Immich server.
 */

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { loadConfig } = require('./config');
const { OwnershipResolver } = require('./ownership');
const {
  makeDeleteAssetsHandler,
  makeUpdateAssetHandler,
  makeBulkUpdateAssetsHandler,
} = require('./handlers');
const logger = require('./logger');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error(`Failed to load config: ${err.message}`);
    process.exit(1);
  }

  const immichUrl = config.immich_url.replace(/\/$/, '');
  const port = config.proxy_port ?? 2284;

  logger.info(`Starting immich-cross-account-proxy`);
  logger.info(`Upstream Immich: ${immichUrl}`);
  logger.info(`Accounts: ${config.accounts.map(a => a.name).join(', ')}`);

  const resolver = new OwnershipResolver(config);

  const app = express();

  // Parse JSON bodies for intercepted routes
  app.use(express.json());

  // ─── Intercepted routes ────────────────────────────────────────────────────

  // DELETE /api/assets  (bulk delete — most common cross-account need)
  app.delete('/api/assets', makeDeleteAssetsHandler(resolver, immichUrl));

  // PUT /api/assets/:id  (single asset metadata update)
  app.put('/api/assets/:id', makeUpdateAssetHandler(resolver, immichUrl));

  // PUT /api/assets  (bulk metadata update — isFavorite, isArchived, etc.)
  // Note: Immich uses DELETE for delete and PUT for bulk metadata,
  // but the path is the same. We differentiate by HTTP method above.
  // This handler covers bulk PUT (not DELETE).
  // (Already covered above via put('/api/assets/:id') for single,
  //  and the bulk case below for body.ids arrays)
  app.put('/api/assets', makeBulkUpdateAssetsHandler(resolver, immichUrl));

  // ─── Transparent proxy for everything else ─────────────────────────────────
  // This includes:
  //   GET  (all reads, timeline, search, thumbnails, video streaming)
  //   POST (auth, uploads, album creation, shared links, sync)
  //   WebSocket upgrades (/api/socket.io/)
  //   Any future endpoints we haven't intercepted

  const proxy = createProxyMiddleware({
    target: immichUrl,
    changeOrigin: true,
    // Stream large files (video uploads) without buffering
    selfHandleResponse: false,
    on: {
      error: (err, req, res) => {
        logger.error(`Proxy error on ${req.method} ${req.path}: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).json({ error: 'proxy error', message: err.message });
        }
      },
    },
  });

  app.use(proxy);

  // ─── Start ─────────────────────────────────────────────────────────────────

  app.listen(port, () => {
    logger.info(`Proxy listening on port ${port}`);
    logger.info(`Point your Immich clients to http://your-server:${port}`);
    logger.info(``);
    logger.info(`Permission summary:`);
    for (const perm of (config.permissions || [])) {
      logger.info(`  ${perm.account} can act as: ${(perm.can_act_as || []).join(', ')}`);
    }
  });
}

main();

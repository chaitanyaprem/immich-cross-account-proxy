/**
 * Cross-account route handlers.
 *
 * These intercept specific mutating endpoints and fan out to the correct
 * account's API key based on asset ownership + permissions.
 *
 * All other requests are forwarded untouched by the main proxy middleware.
 */

const logger = require('./logger');

/**
 * Extract the caller's API key from the request.
 * Immich accepts it in x-api-key header or as ?key= query param.
 */
function extractCallerKey(req) {
  return (
    req.headers['x-api-key'] ||
    req.query.key ||
    null
  );
}

/**
 * Forward a request to Immich with a substituted API key.
 * Returns the parsed JSON response.
 */
async function forwardToImmich(immichUrl, method, path, apiKey, body, contentType) {
  const url = `${immichUrl}${path}`;
  const headers = {
    'x-api-key': apiKey,
    'accept': 'application/json',
  };
  if (body !== undefined) {
    headers['content-type'] = contentType || 'application/json';
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  return { status: resp.status, body: json };
}

/**
 * DELETE /api/assets
 * Body: { ids: string[] }
 *
 * Fan out by owner: split IDs into groups, issue one DELETE per group
 * with the correct API key, merge the results.
 */
function makeDeleteAssetsHandler(resolver, immichUrl) {
  return async (req, res) => {
    const callerKey = extractCallerKey(req);
    const callerAccount = callerKey ? resolver.getCallerAccount(callerKey) : null;

    // If caller is unknown to us, pass through unchanged
    if (!callerAccount) {
      return passThrough(req, res, immichUrl, callerKey);
    }

    const { ids, force } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return passThrough(req, res, immichUrl, callerKey);
    }

    logger.info(`DELETE /api/assets: ${ids.length} assets by ${callerAccount.name}`);

    const groups = await resolver.groupByEffectiveKey(ids, callerAccount);

    // Invalidate cache for deleted assets
    resolver.invalidateAssets(ids);

    // Fan out deletes
    const results = await Promise.all(
      [...groups.entries()].map(([apiKey, groupIds]) =>
        forwardToImmich(
          immichUrl,
          'DELETE',
          '/api/assets',
          apiKey,
          { ids: groupIds, force: force ?? false }
        )
      )
    );

    // Merge: if any group succeeded (2xx), return 200; otherwise return first error
    const allOk = results.every(r => r.status >= 200 && r.status < 300);
    const status = allOk ? 200 : (results.find(r => r.status >= 400)?.status ?? 400);

    // No response body on success (Immich returns 204 for DELETE)
    if (allOk) {
      return res.status(204).end();
    }
    const errorResult = results.find(r => r.status >= 400);
    return res.status(status).json(errorResult?.body);
  };
}

/**
 * PUT /api/assets/:id
 * Metadata update (description, date, GPS, isFavorite, isArchived, etc.)
 */
function makeUpdateAssetHandler(resolver, immichUrl) {
  return async (req, res) => {
    const callerKey = extractCallerKey(req);
    const callerAccount = callerKey ? resolver.getCallerAccount(callerKey) : null;
    const assetId = req.params.id;

    if (!callerAccount) {
      return passThrough(req, res, immichUrl, callerKey);
    }

    const ownerAccount = await resolver.resolveOwner(assetId);

    let effectiveKey = callerKey;
    if (ownerAccount && resolver.canActAs(callerAccount.user_id, ownerAccount.user_id)) {
      effectiveKey = ownerAccount.api_key;
      if (ownerAccount.user_id !== callerAccount.user_id) {
        logger.info(`PUT /api/assets/${assetId}: ${callerAccount.name} acting as ${ownerAccount.name}`);
      }
    }

    const result = await forwardToImmich(
      immichUrl, 'PUT', `/api/assets/${assetId}`, effectiveKey, req.body
    );
    return res.status(result.status).json(result.body);
  };
}

/**
 * PUT /api/assets (bulk update — metadata on multiple assets)
 * Body: { ids: string[], ...updateFields }
 */
function makeBulkUpdateAssetsHandler(resolver, immichUrl) {
  return async (req, res) => {
    const callerKey = extractCallerKey(req);
    const callerAccount = callerKey ? resolver.getCallerAccount(callerKey) : null;

    if (!callerAccount) {
      return passThrough(req, res, immichUrl, callerKey);
    }

    const { ids, ...updateFields } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return passThrough(req, res, immichUrl, callerKey);
    }

    logger.info(`PUT /api/assets (bulk): ${ids.length} assets by ${callerAccount.name}`);

    const groups = await resolver.groupByEffectiveKey(ids, callerAccount);

    const results = await Promise.all(
      [...groups.entries()].map(([apiKey, groupIds]) =>
        forwardToImmich(
          immichUrl, 'PUT', '/api/assets', apiKey, { ids: groupIds, ...updateFields }
        )
      )
    );

    const allOk = results.every(r => r.status >= 200 && r.status < 300);
    if (allOk) return res.status(200).json({ updated: ids.length });
    const err = results.find(r => r.status >= 400);
    return res.status(err?.status ?? 400).json(err?.body);
  };
}

/**
 * Simple pass-through: re-issues the request to Immich as-is.
 * Used when the caller is unknown or no cross-account logic is needed.
 */
async function passThrough(req, res, immichUrl, callerKey) {
  const url = `${immichUrl}${req.originalUrl}`;
  const headers = { ...req.headers, host: undefined };
  if (callerKey) headers['x-api-key'] = callerKey;

  try {
    const resp = await fetch(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const text = await resp.text();
    res.status(resp.status);
    resp.headers.forEach((val, key) => {
      if (!['content-encoding', 'transfer-encoding'].includes(key)) {
        res.setHeader(key, val);
      }
    });
    res.send(text);
  } catch (err) {
    logger.error(`passThrough failed: ${err.message}`);
    res.status(502).json({ error: 'proxy error', message: err.message });
  }
}

module.exports = {
  makeDeleteAssetsHandler,
  makeUpdateAssetHandler,
  makeBulkUpdateAssetsHandler,
  extractCallerKey,
};

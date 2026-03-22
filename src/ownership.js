/**
 * Ownership resolver.
 *
 * Given an asset ID, fetches the ownerId from Immich using any account's
 * API key (read access is sufficient). Results are cached with a TTL
 * to avoid hammering the API on bulk operations.
 */

const logger = require('./logger');

class OwnershipCache {
  constructor(ttlSeconds) {
    this.ttl = ttlSeconds * 1000;
    this.cache = new Map(); // assetId -> { ownerId, expiresAt }
  }

  get(assetId) {
    const entry = this.cache.get(assetId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(assetId);
      return null;
    }
    return entry.ownerId;
  }

  set(assetId, ownerId) {
    if (this.ttl === 0) return;
    this.cache.set(assetId, {
      ownerId,
      expiresAt: Date.now() + this.ttl,
    });
  }

  invalidate(assetId) {
    this.cache.delete(assetId);
  }
}

class OwnershipResolver {
  constructor(config) {
    this.immichUrl = config.immich_url.replace(/\/$/, '');
    this.ttl = config.cache_ttl ?? 300;
    this.cache = new OwnershipCache(this.ttl);

    // Build a map of userId -> account for quick lookup
    this.accountsByUserId = new Map();
    this.accountsByName = new Map();
    for (const acct of config.accounts) {
      this.accountsByUserId.set(acct.user_id, acct);
      this.accountsByName.set(acct.name, acct);
    }

    // Use first account's key for ownership lookups (any key works for reads)
    this.readKey = config.accounts[0].api_key;

    // Build permission map: userId -> Set of userIds they can act as
    this.permissions = new Map(); // actorUserId -> Set<targetUserId>
    for (const perm of (config.permissions || [])) {
      const actor = this.accountsByName.get(perm.account);
      if (!actor) {
        logger.warn(`permissions: unknown account "${perm.account}"`);
        continue;
      }
      const targets = new Set();
      for (const targetName of (perm.can_act_as || [])) {
        const target = this.accountsByName.get(targetName);
        if (!target) {
          logger.warn(`permissions: unknown can_act_as target "${targetName}"`);
          continue;
        }
        targets.add(target.user_id);
      }
      this.permissions.set(actor.user_id, targets);
    }
  }

  /**
   * Resolve a single asset ID to its owner's account object.
   * Returns null if the asset is not found or not owned by a known account.
   */
  async resolveOwner(assetId) {
    const cached = this.cache.get(assetId);
    if (cached) {
      return this.accountsByUserId.get(cached) ?? null;
    }

    try {
      const url = `${this.immichUrl}/api/assets/${assetId}`;
      const resp = await fetch(url, {
        headers: { 'x-api-key': this.readKey },
      });

      if (!resp.ok) {
        logger.warn(`resolveOwner: GET ${url} returned ${resp.status}`);
        return null;
      }

      const asset = await resp.json();
      const ownerId = asset.ownerId;
      if (!ownerId) return null;

      this.cache.set(assetId, ownerId);
      return this.accountsByUserId.get(ownerId) ?? null;
    } catch (err) {
      logger.error(`resolveOwner: fetch failed for asset ${assetId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Resolve multiple asset IDs in parallel (bounded concurrency).
   * Returns Map<assetId, ownerAccount|null>
   */
  async resolveOwners(assetIds, concurrency = 8) {
    const result = new Map();
    const queue = [...assetIds];

    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        result.set(id, await this.resolveOwner(id));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, assetIds.length) }, worker)
    );

    return result;
  }

  /**
   * Given the caller's API key, find which userId they are.
   */
  getCallerAccount(apiKey) {
    for (const acct of this.accountsByUserId.values()) {
      if (acct.api_key === apiKey) return acct;
    }
    return null;
  }

  /**
   * Can actorUserId perform mutations on assets owned by targetUserId?
   * An account can always act on its own assets.
   */
  canActAs(actorUserId, targetUserId) {
    if (actorUserId === targetUserId) return true;
    const allowed = this.permissions.get(actorUserId);
    return allowed ? allowed.has(targetUserId) : false;
  }

  /**
   * Group asset IDs by the effective API key to use for the operation.
   * Returns Map<apiKey, assetId[]>
   *
   * If actor is not permitted to act on an asset, that asset is returned
   * under the actor's own key (Immich will reject it with 403 naturally).
   */
  async groupByEffectiveKey(assetIds, callerAccount) {
    const ownerMap = await this.resolveOwners(assetIds);
    const groups = new Map();

    for (const assetId of assetIds) {
      const ownerAccount = ownerMap.get(assetId);

      let effectiveKey;
      if (!ownerAccount) {
        // Unknown asset — use caller's key; Immich handles the 404
        effectiveKey = callerAccount.api_key;
      } else if (this.canActAs(callerAccount.user_id, ownerAccount.user_id)) {
        effectiveKey = ownerAccount.api_key;
        if (ownerAccount.user_id !== callerAccount.user_id) {
          logger.info(
            `cross-account: ${callerAccount.name} acting as ${ownerAccount.name} for asset ${assetId}`
          );
        }
      } else {
        // No permission — use caller's key; will get a natural 403
        effectiveKey = callerAccount.api_key;
        logger.warn(
          `no permission: ${callerAccount.name} cannot act as ${ownerAccount.name} for asset ${assetId}`
        );
      }

      if (!groups.has(effectiveKey)) groups.set(effectiveKey, []);
      groups.get(effectiveKey).push(assetId);
    }

    return groups;
  }

  invalidateAssets(assetIds) {
    for (const id of assetIds) this.cache.invalidate(id);
  }
}

module.exports = { OwnershipResolver };

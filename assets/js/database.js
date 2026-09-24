/* assets/js/database.js - High Performance Supabase Bridge & Query Cache */

const supabaseUrl = 'https://jtbettizhwwqmuyofapm.supabase.co';
const supabaseKey = 'sb_publishable_kSf8e6RD96lT40di2YqxxQ_gJ3WS6ve';

// In a non-module environment using the CDN, supabase is available on window.supabase
if (window.supabase) {
  const url = (typeof import_meta !== 'undefined' && import_meta.env) ? import_meta.env.VITE_SUPABASE_URL : supabaseUrl;
  const key = (typeof import_meta !== 'undefined' && import_meta.env) ? import_meta.env.VITE_SUPABASE_PUBLISHABLE_KEY : supabaseKey;
  
  const rawClient = window.supabase.createClient(url, key, {
    auth: {
      storage: window.localStorage
    }
  });

  // High-performance intelligent caching layer for Supabase queries
  // Caches SELECT results in memory + sessionStorage for instant UI rendering across navigation
  const MEM_CACHE = new Map();
  const CACHE_TTL_MS = 60 * 1000; // 60 seconds fresh data window

  // Helper to clear cache for specific tables or all
  function invalidateCache(table) {
    if (table) {
      for (const k of MEM_CACHE.keys()) {
        if (k.startsWith(table + ':') || k === table) {
          MEM_CACHE.delete(k);
        }
      }
      try {
        const prefix = `sb_cache_${table}:`;
        Object.keys(sessionStorage).forEach(key => {
          if (key.startsWith(prefix) || key === `sb_cache_${table}`) {
            sessionStorage.removeItem(key);
          }
        });
      } catch (_) {}
    } else {
      MEM_CACHE.clear();
      try {
        Object.keys(sessionStorage).forEach(key => {
          if (key.startsWith('sb_cache_')) {
            sessionStorage.removeItem(key);
          }
        });
      } catch (_) {}
    }
  }

  // Related tables map for multi-table cache invalidation on mutations
  const RELATED_TABLES = {
    'orders': ['orders', 'order_items', 'stock_batches', 'inventory_items', 'stock_movements'],
    'order_items': ['orders', 'order_items', 'stock_batches', 'inventory_items'],
    'purchases': ['purchases', 'purchase_items', 'stock_batches', 'inventory_items', 'suppliers'],
    'purchase_items': ['purchases', 'purchase_items', 'stock_batches', 'inventory_items'],
    'products': ['products', 'product_packaging', 'inventory_items'],
    'product_packaging': ['products', 'product_packaging'],
    'inventory_items': ['inventory_items', 'stock_batches', 'products'],
    'stock_batches': ['stock_batches', 'inventory_items', 'products', 'daily_transactions', 'orders'],
    'daily_transactions': ['daily_transactions', 'daily_transaction_materials', 'stock_batches', 'inventory_items'],
    'daily_transaction_materials': ['daily_transactions', 'daily_transaction_materials', 'stock_batches', 'inventory_items'],
    'clients': ['clients', 'orders'],
    'suppliers': ['suppliers', 'purchases'],
    'expenses': ['expenses'],
    'transactions': ['transactions'],
    'formulations': ['formulations', 'formulation_ingredients'],
    'formulation_ingredients': ['formulations', 'formulation_ingredients'],
    'master_options': ['master_options']
  };

  function triggerInvalidation(table) {
    const targets = RELATED_TABLES[table] || [table];
    targets.forEach(t => invalidateCache(t));
  }

  // Proxy wrapper around supabase.from(table)
  const proxyFrom = function(table) {
    const builder = rawClient.from(table);
    let isSelect = false;
    let queryArgs = [];
    let isMutation = false;

    // Intercept methods to track mutations and cacheable selects
    const handler = {
      get(target, prop, receiver) {
        const orig = target[prop];
        if (typeof orig === 'function') {
          return function(...args) {
            if (prop === 'select') {
              isSelect = true;
              queryArgs.push(['select', args]);
            } else if (['insert', 'update', 'delete', 'upsert'].includes(prop)) {
              isMutation = true;
              triggerInvalidation(table);
            } else if (isSelect) {
              queryArgs.push([prop, args]);
            }
            const res = orig.apply(target, args);
            // If the method returns the builder itself (or a sub-builder), keep proxying
            if (res && typeof res === 'object' && typeof res.then === 'function') {
              return wrapPromise(res);
            }
            return new Proxy(res, handler);
          };
        }
        return orig;
      }
    };

    function wrapPromise(promise) {
      // Build unique cache key from table + queryArgs
      const cacheKey = `${table}:${JSON.stringify(queryArgs)}`;

      const customThen = function(onFulfilled, onRejected) {
        if (isSelect && !isMutation) {
          const now = Date.now();
          // Check in-memory cache
          const mem = MEM_CACHE.get(cacheKey);
          if (mem && (now - mem.timestamp < CACHE_TTL_MS)) {
            // Instant resolution from cache!
            return Promise.resolve(mem.value).then(onFulfilled, onRejected);
          }

          // Check sessionStorage cache (fast fallback)
          try {
            const rawStored = sessionStorage.getItem(`sb_cache_${cacheKey}`);
            if (rawStored) {
              const parsed = JSON.parse(rawStored);
              if (now - parsed.timestamp < CACHE_TTL_MS) {
                MEM_CACHE.set(cacheKey, parsed);
                return Promise.resolve(parsed.value).then(onFulfilled, onRejected);
              }
            }
          } catch (_) {}

          // Execute real query, cache result, and return
          return promise.then(result => {
            if (!result.error) {
              const entry = { timestamp: Date.now(), value: result };
              MEM_CACHE.set(cacheKey, entry);
              try {
                // Don't blow up sessionStorage if data is large
                const str = JSON.stringify(entry);
                if (str.length < 500000) {
                  sessionStorage.setItem(`sb_cache_${cacheKey}`, str);
                }
              } catch (_) {}
            }
            return onFulfilled ? onFulfilled(result) : result;
          }, onRejected);
        }

        // Mutations or non-select queries: execute and invalidate
        return promise.then(result => {
          if (isMutation) {
            triggerInvalidation(table);
          }
          return onFulfilled ? onFulfilled(result) : result;
        }, onRejected);
      };

      return {
        then: customThen,
        catch(onRejected) {
          return customThen(null, onRejected);
        }
      };
    }

    return new Proxy(builder, handler);
  };

  // Expose enhanced dbClient with transparent caching
  window.dbClient = new Proxy(rawClient, {
    get(target, prop) {
      if (prop === 'from') {
        return proxyFrom;
      }
      return target[prop];
    }
  });

  window.dbClient._invalidateCache = triggerInvalidation;
} else {
  console.error("Supabase CDN script not loaded!");
}

window.DB = {
  initDB: async () => {
    return true;
  },
  invalidate: (table) => {
    if (window.dbClient && window.dbClient._invalidateCache) {
      window.dbClient._invalidateCache(table);
    }
  }
};

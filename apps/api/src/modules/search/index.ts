/**
 * Public surface of the search module (ADR-0011 rule 1).
 *
 * The engine client and indexer live in `@bozorlar/search`, shared with the worker, because
 * indexing is driven by relayed events. This module is the query surface over it.
 */
export { createSearchController, type SearchController } from './http/search.controller.js';
export { createSearchRouter, createSearchAdminRouter } from './http/search.routes.js';

/**
 * Public surface of the wallet module (ADR-0011 rule 1).
 *
 * The ledger itself lives in `@bozorlar/ledger`, shared with the worker, because charging
 * commission happens on an event the worker relays. This module owns the administrative
 * surface over it: manual movements, thresholds, rules and reconciliation.
 */
export { createWalletService, type WalletService } from './services/wallet.service.js';
export { createWalletController, type WalletController } from './http/wallet.controller.js';
export { createSellerWalletRouter, createWalletAdminRouter } from './http/wallet.routes.js';
export { createApiEventPublisher, createApiAuditRecorder } from './services/ledgerPorts.js';

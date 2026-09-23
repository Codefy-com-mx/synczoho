import type { FunctionHandler } from "./runtime.js";
import categoryMappings from "./functions/category-mappings/index.js";
import customersHistory from "./functions/customers-history/index.js";
import dashboardMetrics from "./functions/dashboard-metrics/index.js";
import sendAlertEmail from "./functions/send-alert-email/index.js";
import syncAutoRun from "./functions/sync-auto-run/index.js";
import syncCustomersBulk from "./functions/sync-customers-bulk/index.js";
import syncLogsList from "./functions/sync-logs-list/index.js";
import syncOrdersBulk from "./functions/sync-orders-bulk/index.js";
import syncOrdersList from "./functions/sync-orders-list/index.js";
import syncPricesRun from "./functions/sync-prices-run/index.js";
import syncSettings from "./functions/sync-settings/index.js";
import syncStockRun from "./functions/sync-stock-run/index.js";
import syncUnmatchedList from "./functions/sync-unmatched-list/index.js";
import tiendanubeAuth from "./functions/tiendanube-auth/index.js";
import tiendanubeDisconnect from "./functions/tiendanube-disconnect/index.js";
import tiendanubeWebhook from "./functions/tiendanube-webhook/index.js";
import tiendanubeWebhooksManage from "./functions/tiendanube-webhooks-manage/index.js";
import tnSendTracking from "./functions/tn-send-tracking/index.js";
import zohoAuthCallback from "./functions/zoho-auth-callback/index.js";
import zohoAuthStart from "./functions/zoho-auth-start/index.js";
import zohoConnectionStatus from "./functions/zoho-connection-status/index.js";
import zohoCreateSalesorder from "./functions/zoho-create-salesorder/index.js";
import zohoDisconnect from "./functions/zoho-disconnect/index.js";
import zohoListItems from "./functions/zoho-list-items/index.js";
import zohoSyncImport from "./functions/zoho-sync-import/index.js";

export const handlers: Record<string, FunctionHandler> = {
  "category-mappings": categoryMappings,
  "customers-history": customersHistory,
  "dashboard-metrics": dashboardMetrics,
  "send-alert-email": sendAlertEmail,
  "sync-auto-run": syncAutoRun,
  "sync-customers-bulk": syncCustomersBulk,
  "sync-logs-list": syncLogsList,
  "sync-orders-bulk": syncOrdersBulk,
  "sync-orders-list": syncOrdersList,
  "sync-prices-run": syncPricesRun,
  "sync-settings": syncSettings,
  "sync-stock-run": syncStockRun,
  "sync-unmatched-list": syncUnmatchedList,
  "tiendanube-auth": tiendanubeAuth,
  "tiendanube-disconnect": tiendanubeDisconnect,
  "tiendanube-webhook": tiendanubeWebhook,
  "privacy-store-redact": tiendanubeWebhook,
  "privacy-customer-redact": tiendanubeWebhook,
  "privacy-data-request": tiendanubeWebhook,
  "tiendanube-webhooks-manage": tiendanubeWebhooksManage,
  "tn-send-tracking": tnSendTracking,
  "zoho-auth-callback": zohoAuthCallback,
  "zoho-auth-start": zohoAuthStart,
  "zoho-connection-status": zohoConnectionStatus,
  "zoho-create-salesorder": zohoCreateSalesorder,
  "zoho-disconnect": zohoDisconnect,
  "zoho-list-items": zohoListItems,
  "zoho-sync-import": zohoSyncImport,
};

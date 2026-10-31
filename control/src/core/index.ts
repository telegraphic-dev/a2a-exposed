// Source entry for `@a2a-exposed/control-core`. `prepare` compiles this file to
// JavaScript and declarations on `npm pack` and on a `file:` install. An app
// imports tenants, the Cloudflare provisioning calls, routing, the environment
// type, redaction, and the D1 migrations from that published module.

export {
	accountAgentLimit,
	configuredFreeAgentLimit,
	createTenant,
	listTenants,
	newOwnerToken,
} from "../tenants/create.ts";
export type { CreateResult, CreatedTenant } from "../tenants/create.ts";
export { deleteTenant } from "../tenants/delete.ts";
export type { DeleteResult } from "../tenants/delete.ts";
export { rotateOwnerToken } from "../tenants/rotate.ts";
export type { RotateResult } from "../tenants/rotate.ts";
export {
	WAKE_PRESETS,
	configFields,
	saveWakeSettings,
	tenantForAccount,
	wakeHeaderProblem,
	wakeSettingsOf,
	wakeUrlProblem,
} from "../tenants/wake.ts";
export type { WakeSave, WakeSaveInput, WakeSettings } from "../tenants/wake.ts";
export {
	MAX_WAKE_PLAIN,
	MAX_WAKE_SEALED,
	MAX_WAKE_VALUE,
	WAKE_SECRET_KEYS,
	openWakeSecrets,
	sealWakeSecrets,
} from "../tenants/wake-secrets.ts";
export type { WakeSecretKey, WakeSecrets } from "../tenants/wake-secrets.ts";
export { RESERVED_NAMES, TENANT_NAME, tenantNameProblem } from "../tenants/reserved.ts";
export { httpsOrigin, newApprovalClient } from "../tenants/approval.ts";
export type { ApprovalClient } from "../tenants/approval.ts";
export {
	dataPlaneFromEnv,
	deliverOutbox,
	flushOutbox,
	pushFromRow,
	withOutboxLock,
} from "../tenants/push.ts";
export type {
	DataPlane,
	DirectoryEntry,
	OutboxRow,
	OwnerCall,
	PlaneEnv,
	TenantPush,
} from "../tenants/push.ts";

export type { ControlEnv } from "../env.ts";
export type { Sql, SqlStatement } from "./sql.ts";

export { RUN_WORKER_FIRST } from "../routing.ts";
export { routes } from "./routes.ts";
export type { CoreRoutes } from "./routes.ts";

export * from "../provision/grant.ts";
export * from "../provision/setup.ts";
export * from "../provision/cloudflare-api.ts";
export * from "../provision/names.ts";
export * from "../provision/statements.ts";
export * from "../provision/permission-wait.ts";
export * from "../provision/inbox-row.ts";
export * from "../provision/remove.ts";
export {
	INBOX_COMPATIBILITY_DATE,
	PERMISSION_DELAYS_MS,
	PERMISSION_TRIES,
	WIZARD_STEPS,
	createCloudflareAgent,
	dashboardLinks,
	fieldsFromForm,
	permissionRetryDue,
	inboxApprovalBindings,
	inboxEventBindings,
	resumeFields,
	runInboxStep,
	viewInboxWizard,
} from "../provision/inbox.ts";
export {
	EVENT_REPLAY_WINDOW_S,
	eventSecretText,
	httpsEventUrl,
	pairingEventConfig,
	verifyEventSignature,
} from "../tenants/events.ts";
export type {
	ApprovalOidcInput,
	InboxMigration,
	InboxWizard,
	ProvisionFields,
	WizardControl,
	WizardState,
	WizardStepId,
	WizardStepView,
} from "../provision/inbox.ts";
export { INBOX_MIGRATIONS } from "../provision/inbox-migrations.ts";

export { CONTROL_MIGRATIONS, CONTROL_MIGRATIONS_DIR } from "./migrations.ts";
export type { ControlMigration } from "./migrations.ts";

export { redact, sanitized } from "./redact.ts";

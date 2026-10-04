import type { Tenant } from "./tenant.server";

/** Merchant review settings. Enforced server-side (storefront submission, moderation); mirrored to the theme for display. */
export const SETTING_KEYS = ["moderationEnabled", "reviewSubmissionEnabled"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export async function updateSettings({ db, shopId }: Tenant, patch: Partial<Record<SettingKey, boolean>>, actor: string) {
  const data = Object.fromEntries(SETTING_KEYS.filter((k) => typeof patch[k] === "boolean").map((k) => [k, patch[k]]));
  const before = await db.shopSettings.findUniqueOrThrow({ where: { shopId } });
  const changed = Object.fromEntries(Object.entries(data).filter(([k, v]) => before[k as SettingKey] !== v));
  if (!Object.keys(changed).length) return before;
  const after = await db.shopSettings.update({ where: { shopId }, data: changed });
  await db.auditLog.create({ data: { shopId, actor, action: "settings.updated", entity: "shop", entityId: shopId, details: changed } });
  return after;
}

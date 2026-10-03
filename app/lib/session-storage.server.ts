import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import type { PrismaClient } from "@prisma/client";
import { decryptSecret, encryptSecret } from "./crypto.server";

/** Shopify session storage that keeps access and refresh tokens encrypted at rest (AES-256-GCM). */
export class EncryptedSessionStorage implements SessionStorage {
  private inner: PrismaSessionStorage<PrismaClient>;
  constructor(prisma: PrismaClient) {
    this.inner = new PrismaSessionStorage(prisma);
  }
  private seal(s: Session) {
    const o = s.toObject();
    return new Session({
      ...o,
      accessToken: o.accessToken ? encryptSecret(o.accessToken) : o.accessToken,
      ...(s.refreshToken ? { refreshToken: encryptSecret(s.refreshToken), refreshTokenExpires: s.refreshTokenExpires } : {}),
    });
  }
  private open(s: Session | undefined) {
    if (!s) return s;
    const o = s.toObject();
    return new Session({
      ...o,
      accessToken: o.accessToken ? decryptSecret(o.accessToken) : o.accessToken,
      ...(s.refreshToken ? { refreshToken: decryptSecret(s.refreshToken), refreshTokenExpires: s.refreshTokenExpires } : {}),
    });
  }
  storeSession(session: Session) { return this.inner.storeSession(this.seal(session)); }
  async loadSession(id: string) { return this.open(await this.inner.loadSession(id)); }
  deleteSession(id: string) { return this.inner.deleteSession(id); }
  deleteSessions(ids: string[]) { return this.inner.deleteSessions(ids); }
  async findSessionsByShop(shop: string) { return (await this.inner.findSessionsByShop(shop)).map((s) => this.open(s)!); }
  isReady() { return this.inner.isReady(); }
}

import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { MAX_DRAFT_BYTES, fail } from "./model";

export interface ObjectStore {
  deletePrefix?(prefix: string): Promise<void>;
  put(path: string, value: Buffer, contentType: string): Promise<void>;
  get(path: string, generation?: string): Promise<Buffer>;
}
/** Immutable objects: retries may reuse a path, but can never replace its contents. */
export class CloudObjects implements ObjectStore {
  private bucket = getStorage().bucket(
    process.env.PROJECT_STORAGE_BUCKET ||
      `${process.env.GCLOUD_PROJECT || "draftbranch"}.firebasestorage.app`,
  );
  async deletePrefix(prefix: string) {
    if (!/^projects\/[A-Za-z0-9_-]+\/$/.test(prefix))
      fail("invalid-argument", "Invalid cleanup prefix.");
    await this.bucket.deleteFiles({ prefix });
  }
  async put(path: string, value: Buffer, contentType: string) {
    const pid = /^projects\/([A-Za-z0-9_-]+)\//.exec(path)?.[1];
    const deleted = async () =>
      pid && (await getFirestore().doc(`projectDeletions/${pid}`).get()).exists;
    if (await deleted()) fail("not-found", "Project was deleted.");
    const file = this.bucket.file(path);
    try {
      await file.save(value, {
        resumable: false,
        contentType,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { cacheControl: "private, no-store" },
      });
    } catch (error) {
      if (Number((error as { code?: number }).code) !== 412) throw error;
      const old = await this.get(path);
      if (!old.equals(value))
        fail("data-loss", "An immutable object has different content.");
    }
    // An in-flight save may finish after cleanup; remove its own late object.
    if (await deleted()) {
      await file.delete({ ignoreNotFound: true });
      fail("not-found", "Project was deleted.");
    }
  }
  async get(path: string, generation?: string): Promise<Buffer> {
    const file = this.bucket.file(
      path,
      generation ? { generation } : undefined,
    );
    const [metadata] = await file.getMetadata();
    // JSON pretty-printing and Git object headers need modest headroom.
    if (Number(metadata.size) > MAX_DRAFT_BYTES * 3)
      fail("invalid-argument", "Object exceeds the size limit.");
    const [bytes] = await file.download({ validation: "crc32c" });
    if (bytes.length > MAX_DRAFT_BYTES * 3)
      fail("invalid-argument", "Object exceeds the size limit.");
    return bytes;
  }
}

/**
 * Cloudflare R2 `ObjectStorageClient` (VWAP_STORAGE_MIGRATION_PLAN.md,
 * decision: R2 is the production backend — see
 * VWAP_R2_ARCHIVE_READINESS_REPORT.md). R2 is S3-compatible, so this uses
 * the standard AWS S3 SDK pointed at R2's endpoint; nothing here is
 * R2-specific beyond the endpoint URL shape and env var names.
 *
 * This is ONE implementation of `ObjectStorageClient`
 * (../data/barArchiveStore.ts) — the archive store, Parquet codec, and
 * partitioning scheme are all unchanged by which client is plugged in.
 *
 * Never hardcode credentials. All four required values come from the
 * environment; if any are missing, `createR2ObjectStorage` throws
 * immediately (fail closed) rather than silently degrading.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  NotFound,
} from '@aws-sdk/client-s3';
import fs from 'node:fs';
import type { ObjectStorageClient } from '../data/barArchiveStore.ts';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

/** Reads and validates the required R2 env vars. Throws (fails closed) if any are missing — callers must not catch this and fall back to local filesystem. */
export function readR2ConfigFromEnv(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;

  const missing = [
    !accountId && 'R2_ACCOUNT_ID',
    !accessKeyId && 'R2_ACCESS_KEY_ID',
    !secretAccessKey && 'R2_SECRET_ACCESS_KEY',
    !bucketName && 'R2_BUCKET_NAME',
  ].filter((v): v is string => Boolean(v));

  if (missing.length > 0) {
    throw new Error(`R2 backend selected but missing required environment variable(s): ${missing.join(', ')}`);
  }

  return { accountId: accountId!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, bucketName: bucketName! };
}

function contentTypeFor(objectPath: string): string {
  return objectPath.endsWith('.parquet') ? 'application/vnd.apache.parquet' : 'application/octet-stream';
}

/** Builds an `ObjectStorageClient` backed by Cloudflare R2. `config` must come from `readR2ConfigFromEnv()` (or equivalent explicit values) — never construct one with hardcoded credentials. */
export function createR2ObjectStorage(config: R2Config): ObjectStorageClient {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  async function putObject(key: string, body: Buffer, contentType: string): Promise<{ ok: true } | { error: string }> {
    try {
      await client.send(new PutObjectCommand({ Bucket: config.bucketName, Key: key, Body: body, ContentType: contentType }));
      return { ok: true };
    } catch (err: any) {
      return { error: err.message ?? String(err) };
    }
  }

  async function getObject(key: string): Promise<{ ok: true; body: Buffer } | { error: string; notFound?: boolean }> {
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucketName, Key: key }));
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
      return { ok: true, body: Buffer.concat(chunks) };
    } catch (err: any) {
      if (err instanceof NotFound || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return { error: 'not found', notFound: true };
      }
      return { error: err.message ?? String(err) };
    }
  }

  async function headObject(key: string): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
      return true;
    } catch (err: any) {
      if (err instanceof NotFound || err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  async function listObjects(prefix: string): Promise<{ ok: true; keys: string[] } | { error: string }> {
    try {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const result = await client.send(
          new ListObjectsV2Command({ Bucket: config.bucketName, Prefix: prefix, ContinuationToken: continuationToken }),
        );
        for (const obj of result.Contents ?? []) if (obj.Key) keys.push(obj.Key);
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
      } while (continuationToken);
      return { ok: true, keys };
    } catch (err: any) {
      return { error: err.message ?? String(err) };
    }
  }

  return {
    async upload(objectPath, localFilePath) {
      const body = fs.readFileSync(localFilePath);
      return putObject(objectPath, body, contentTypeFor(objectPath));
    },
    async download(objectPath, localFilePath) {
      const result = await getObject(objectPath);
      if ('error' in result) return result;
      fs.mkdirSync(localFilePath.substring(0, localFilePath.lastIndexOf('/')) || '.', { recursive: true });
      fs.writeFileSync(localFilePath, result.body);
      return { ok: true };
    },
    async list(prefix) {
      const result = await listObjects(prefix);
      if ('error' in result) return result;
      return { ok: true, paths: result.keys };
    },
    async exists(objectPath) {
      return headObject(objectPath);
    },
  };
}

/**
 * Delete is not part of `ObjectStorageClient` (the archive never deletes a
 * partition in normal operation — it overwrites). This is exposed
 * separately, only for the synthetic connectivity-test object (task 12)
 * and any future manual reconciliation tooling.
 */
export function createR2AdminOps(config: R2Config): { deleteObject(key: string): Promise<{ ok: true } | { error: string }> } {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async deleteObject(key: string) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }));
        return { ok: true };
      } catch (err: any) {
        return { error: err.message ?? String(err) };
      }
    },
  };
}

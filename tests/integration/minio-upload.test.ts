// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { S3ObjectStore, s3ClientConfig } from "@/lib/storage/s3";

const endpoint = process.env.TEST_STORAGE_ENDPOINT;
const bucket = process.env.TEST_STORAGE_BUCKET ?? "humans-private";
const accessKeyId = process.env.TEST_STORAGE_ACCESS_KEY_ID;
const secretAccessKey = process.env.TEST_STORAGE_SECRET_ACCESS_KEY;
const liveDescribe =
  endpoint && accessKeyId && secretAccessKey ? describe : describe.skip;

liveDescribe("real MinIO upload and download", () => {
  const client = new S3Client({
    ...s3ClientConfig({ endpoint: endpoint!, provider: "minio" }),
    region: process.env.TEST_STORAGE_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
    },
  });
  const store = new S3ObjectStore(client, bucket);

  beforeAll(async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    }
  });
  afterAll(() => client.destroy());

  it("round-trips a checksum-bound private object through signed grants", async () => {
    const workspaceId = `minio-${randomUUID()}`;
    const key = `imports/${randomUUID()}.csv`;
    const body = new TextEncoder().encode(
      "external_id,name\np-minio,MinIO Person\n",
    );
    const checksum = createHash("sha256").update(body).digest("hex");

    const upload = await store.createUpload({
      workspaceId,
      key,
      contentType: "text/csv",
      bytes: body.byteLength,
      checksumSha256: checksum,
    });
    const uploaded = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body,
    });
    expect(uploaded.status).toBe(200);

    await expect(store.exists({ workspaceId, key })).resolves.toBe(true);
    await expect(
      store.exists({ workspaceId: `${workspaceId}-other`, key }),
    ).resolves.toBe(false);
    const opened = await store.openRead(
      { workspaceId, key },
      { maxBytes: body.byteLength },
    );
    expect(opened?.bytes).toBe(body.byteLength);
    const chunks: Uint8Array[] = [];
    for await (const chunk of opened?.body ?? []) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      Buffer.from(body).toString("utf8"),
    );

    const download = await store.createDownload({
      workspaceId,
      key,
      fileName: "minio-people.csv",
    });
    const downloaded = await fetch(download.url, {
      method: download.method,
      headers: download.headers,
    });
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(body);

    await store.delete({ workspaceId, key });
    await expect(store.exists({ workspaceId, key })).resolves.toBe(false);
  });
});

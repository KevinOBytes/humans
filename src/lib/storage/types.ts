export interface UploadRequest {
  actorId: string;
  workspaceId: string;
  uploadSessionId: string;
  sessionExpiresAt: Date;
  key: string;
  contentType: string;
  bytes: number;
  checksumSha256: string;
}

export interface DownloadRequest {
  workspaceId: string;
  key: string;
  fileName: string;
}

export interface OpenReadOptions {
  maxBytes: number;
  signal?: AbortSignal;
}

export interface ObjectRead {
  body: AsyncIterable<Uint8Array>;
  bytes?: number;
  contentType?: string;
}

/** Raised by an object-store stream when the caller's byte budget is exceeded. */
export class ObjectReadLimitError extends Error {
  constructor() {
    super("Object read limit exceeded");
    this.name = "ObjectReadLimitError";
  }
}

export interface SignedObjectRequest {
  method: "GET" | "PUT";
  url: string;
  expiresAt: Date;
  headers: Readonly<Record<string, string>>;
  contentLength?: number;
}

export interface ObjectReference {
  workspaceId: string;
  key: string;
}

export interface ObjectMetadata {
  bytes?: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
  custom: Readonly<Record<string, string>>;
}

export interface ObjectStore {
  createUpload(input: UploadRequest): Promise<SignedObjectRequest>;
  createDownload(input: DownloadRequest): Promise<SignedObjectRequest>;
  checkReachability(): Promise<void>;
  getMetadata(input: ObjectReference): Promise<ObjectMetadata | null>;
  openRead(
    input: ObjectReference,
    options: OpenReadOptions,
  ): Promise<ObjectRead | null>;
  exists(input: ObjectReference): Promise<boolean>;
  delete(input: ObjectReference): Promise<void>;
}

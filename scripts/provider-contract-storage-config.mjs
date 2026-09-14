const EXTERNAL_STORAGE_PROVIDERS = new Set(["r2", "s3"]);
const ISOLATED_CONTRACT_BUCKET =
  /^humans-contract-[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const RESERVED_APPLICATION_BUCKET_MARKER =
  /(?:^|[.-])(?:application|private)(?:$|[.-])/u;

/**
 * Validate the non-secret bucket identifiers used by provider-contract runs.
 *
 * External lifecycle tests can create and delete objects, so their bucket must
 * be both visibly dedicated to the contract suite and distinct from the
 * application's configured data bucket. This check intentionally returns only
 * stable diagnostics: operator bucket names and endpoints must not appear in
 * failure output.
 *
 * @param {{
 *   bucket?: string,
 *   provider?: string,
 *   storageBucket?: string,
 * }} input
 * @returns {string | undefined}
 */
export function validateExternalStorageContractBucket({
  bucket,
  provider,
  storageBucket,
}) {
  if (!EXTERNAL_STORAGE_PROVIDERS.has(provider)) return bucket;

  const validContractBucket =
    typeof bucket === "string" &&
    ISOLATED_CONTRACT_BUCKET.test(bucket) &&
    !RESERVED_APPLICATION_BUCKET_MARKER.test(bucket);
  const distinctApplicationBucket =
    typeof storageBucket === "string" &&
    storageBucket.length > 0 &&
    bucket !== storageBucket;

  if (!validContractBucket || !distinctApplicationBucket)
    throw new Error(
      "external storage provider contract requires an isolated contract-test bucket",
    );
  return bucket;
}

#!/bin/sh
set -eu

mc alias set humans "${MINIO_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"
mc mb --ignore-existing "humans/${STORAGE_BUCKET}"
mc anonymous set none "humans/${STORAGE_BUCKET}"
cors_config="$(mc admin config get humans api)"
case "${cors_config}" in
  *"MINIO_API_CORS_ALLOW_ORIGIN=${MINIO_CORS_ALLOW_ORIGIN}"*) ;;
  *)
    echo "MinIO CORS origin is not active" >&2
    exit 1
    ;;
esac

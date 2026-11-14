"""
SgSL Avatar — Storage adapter.

Two backends share a common interface:
- LocalFSStorage: JSON files under data/signs/ (default, dev, self-hosted).
- S3Storage:      DigitalOcean Spaces / any S3-compatible bucket.

Selected via STORAGE_BACKEND env var ("local" or "s3"). S3 reads DO Spaces
credentials from DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET,
DO_SPACES_REGION, DO_SPACES_ENDPOINT. Keeping a thin interface lets us
swap storage without touching routes, and lets ML pipelines consume the
same read API from a batch job.
"""

from __future__ import annotations

import json
import os
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any


class Storage(ABC):
    @abstractmethod
    def save_sign(self, label: str, data: dict[str, Any]) -> None: ...

    @abstractmethod
    def load_sign(self, label: str) -> dict[str, Any] | None: ...

    @abstractmethod
    def delete_sign(self, label: str) -> bool: ...

    @abstractmethod
    def list_signs(self) -> list[dict[str, Any]]: ...


class LocalFSStorage(Storage):
    def __init__(self, signs_dir: Path):
        self.signs_dir = signs_dir
        self.signs_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, label: str) -> Path:
        return self.signs_dir / f"{label}.json"

    def save_sign(self, label: str, data: dict[str, Any]) -> None:
        with open(self._path(label), "w") as f:
            json.dump(data, f)

    def load_sign(self, label: str) -> dict[str, Any] | None:
        p = self._path(label)
        if not p.exists():
            return None
        with open(p) as f:
            return json.load(f)

    def delete_sign(self, label: str) -> bool:
        p = self._path(label)
        if not p.exists():
            return False
        p.unlink()
        return True

    def list_signs(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for fp in sorted(self.signs_dir.glob("*.json")):
            if fp.name.startswith("_"):
                continue
            with open(fp) as f:
                data = json.load(f)
            out.append(_summarize(data))
        return out


class S3Storage(Storage):
    """
    DigitalOcean Spaces / S3-compatible storage. Lazily imports boto3 so
    the local dev path doesn't require it. Fail-loud on missing creds so
    we never silently fall back to no-op behavior in production.
    """

    def __init__(self):
        try:
            import boto3  # noqa: F401
        except ImportError as e:
            raise RuntimeError("STORAGE_BACKEND=s3 requires boto3 — pip install boto3") from e
        import boto3

        key = os.environ.get("DO_SPACES_KEY")
        secret = os.environ.get("DO_SPACES_SECRET")
        bucket = os.environ.get("DO_SPACES_BUCKET")
        region = os.environ.get("DO_SPACES_REGION", "sgp1")
        endpoint = os.environ.get(
            "DO_SPACES_ENDPOINT",
            f"https://{region}.digitaloceanspaces.com",
        )
        if not all([key, secret, bucket]):
            raise RuntimeError(
                "STORAGE_BACKEND=s3 requires DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET"
            )
        self.bucket = bucket
        self.prefix = os.environ.get("DO_SPACES_PREFIX", "signs/")
        self.client = boto3.client(
            "s3",
            region_name=region,
            endpoint_url=endpoint,
            aws_access_key_id=key,
            aws_secret_access_key=secret,
        )

    def _key(self, label: str) -> str:
        return f"{self.prefix}{label}.json"

    def save_sign(self, label: str, data: dict[str, Any]) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=self._key(label),
            Body=json.dumps(data).encode("utf-8"),
            ContentType="application/json",
        )

    def load_sign(self, label: str) -> dict[str, Any] | None:
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=self._key(label))
        except self.client.exceptions.NoSuchKey:
            return None
        return json.loads(obj["Body"].read())

    def delete_sign(self, label: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._key(label))
        except self.client.exceptions.ClientError:
            return False
        self.client.delete_object(Bucket=self.bucket, Key=self._key(label))
        return True

    def list_signs(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=self.prefix):
            for item in page.get("Contents", []) or []:
                key = item["Key"]
                if not key.endswith(".json") or key[len(self.prefix):].startswith("_"):
                    continue
                obj = self.client.get_object(Bucket=self.bucket, Key=key)
                data = json.loads(obj["Body"].read())
                out.append(_summarize(data))
        return sorted(out, key=lambda s: s["label"])


def _summarize(data: dict[str, Any]) -> dict[str, Any]:
    """Backend-agnostic list-row shape returned to the viewer.

    Recorded signs report `frames`. Curated signs report `keyframes` and
    `duration_ms`. Both carry `schema_version` and `type` so the UI can
    badge them appropriately.
    """
    schema = data.get("schema_version", 1)
    sign_type = data.get("type") or ("curated" if schema >= 3 else "recorded")
    row: dict[str, Any] = {
        "label": data["label"],
        "schema_version": schema,
        "type": sign_type,
    }
    if sign_type == "curated":
        row["keyframes"] = len(data.get("keyframes", []))
        row["duration_ms"] = data.get("duration_ms", 0)
    else:
        row["frames"] = len(data.get("landmarks", []))
    return row


def make_storage(local_signs_dir: Path) -> Storage:
    backend = os.environ.get("STORAGE_BACKEND", "local").lower()
    if backend == "s3":
        return S3Storage()
    if backend == "local":
        return LocalFSStorage(local_signs_dir)
    raise RuntimeError(f"Unknown STORAGE_BACKEND: {backend!r}")

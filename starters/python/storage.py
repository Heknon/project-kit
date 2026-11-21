"""S3 the project-kit way (docs/contract.md in the kit): no access keys on Vercel.

On Vercel the function assumes S3_ROLE_ARN with its OIDC token, which arrives in each request's
x-vercel-oidc-token header. Locally, without S3_ROLE_ARN, boto3's default credential chain
applies, or S3_ENDPOINT with S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY for MinIO and the like.

A function file outside api/ is imported after putting the project root on sys.path:

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import storage
"""

import os
from typing import Any, Protocol

import boto3


class Headers(Protocol):
    def get(self, name: str, /) -> str | None: ...


def enabled() -> bool:
    return bool(os.environ.get("S3_BUCKET"))


def bucket() -> str:
    name = os.environ.get("S3_BUCKET")
    if not name:
        raise RuntimeError("S3_BUCKET is not set: turn on the s3 feature, or set it in .env.local.")
    return name


def key(*parts: str) -> str:
    """The object key for parts, under S3_PREFIX (empty in production)."""
    for part in parts:
        if part in ("", ".", "..") or "/" in part:
            raise ValueError(f"Invalid key part {part!r}")
    return os.environ.get("S3_PREFIX", "") + "/".join(parts)


def oidc_token(headers: Headers | None) -> str | None:
    """The Vercel OIDC token: the request header on Vercel, VERCEL_OIDC_TOKEN in builds."""
    token = headers.get("x-vercel-oidc-token") if headers is not None else None
    return token or os.environ.get("VERCEL_OIDC_TOKEN")


def client(headers: Headers | None = None, sts: Any = None) -> Any:
    """An S3 client for this request. Pass the request's headers on Vercel."""
    region = os.environ.get("S3_REGION") or "us-east-1"
    role = os.environ.get("S3_ROLE_ARN")
    if role:
        token = oidc_token(headers)
        if not token:
            raise RuntimeError(
                "S3_ROLE_ARN is set but there's no Vercel OIDC token; pass the request headers."
            )
        sts = sts or boto3.client("sts", region_name=region)
        credentials = sts.assume_role_with_web_identity(
            RoleArn=role,
            RoleSessionName=os.environ.get("VERCEL_DEPLOYMENT_ID") or "app",
            WebIdentityToken=token,
        )["Credentials"]
        return boto3.client(
            "s3",
            region_name=region,
            aws_access_key_id=credentials["AccessKeyId"],
            aws_secret_access_key=credentials["SecretAccessKey"],
            aws_session_token=credentials["SessionToken"],
        )
    endpoint = os.environ.get("S3_ENDPOINT")
    if endpoint:
        return boto3.client(
            "s3",
            region_name=region,
            endpoint_url=endpoint,
            aws_access_key_id=os.environ.get("S3_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("S3_SECRET_ACCESS_KEY"),
        )
    return boto3.client("s3", region_name=region)

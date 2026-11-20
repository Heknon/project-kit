terraform {
  required_providers {
    aws    = { source = "hashicorp/aws" }
    random = { source = "hashicorp/random" }
  }
}

variable "name" {
  type = string
}

variable "vercel_team_slug" {
  type = string
}

variable "vercel_project_name" {
  type = string
}

variable "app_origins" {
  type        = list(string)
  description = "Origins allowed to use presigned URLs from the browser (production and dev)."
}

variable "existing_buckets" {
  type = object({
    production = string
    dev        = string
  })
  default     = null
  description = "Adopt these buckets instead of creating new ones. They must be imported first."
}

variable "versioning" {
  type    = bool
  default = false
}

variable "permissions_boundary_arn" {
  type        = string
  default     = null
  description = "Boundary on the roles this module creates (standard projects: project-kit-app-boundary)."
}

variable "preview_expiry_days" {
  type    = number
  default = 14
}

data "aws_region" "current" {}

data "aws_iam_openid_connect_provider" "vercel" {
  url = "https://oidc.vercel.com/${var.vercel_team_slug}"
}

resource "random_id" "suffix" {
  count       = var.existing_buckets == null ? 1 : 0
  byte_length = 3
}

locals {
  buckets = var.existing_buckets != null ? var.existing_buckets : {
    production = "kit-${var.name}-${random_id.suffix[0].hex}"
    dev        = "kit-${var.name}-dev-${random_id.suffix[0].hex}"
  }

  cors_origins = concat(var.app_origins, [
    "https://*-${var.vercel_team_slug}.vercel.app",
    "http://localhost:*",
  ])

  environments = {
    production = { bucket = local.buckets.production, vercel = "production" }
    dev        = { bucket = local.buckets.dev, vercel = "preview" }
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.environments
  bucket   = each.value.bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "production" {
  bucket = aws_s3_bucket.this["production"].id
  versioning_configuration {
    status = var.versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_cors_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  cors_rule {
    allowed_methods = ["GET", "HEAD", "PUT", "POST"]
    allowed_origins = local.cors_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "dev" {
  bucket = aws_s3_bucket.this["dev"].id

  rule {
    id     = "expire-previews"
    status = "Enabled"
    filter {
      prefix = "preview/"
    }
    expiration {
      days = var.preview_expiry_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "trust" {
  for_each = local.environments

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.vercel.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "oidc.vercel.com/${var.vercel_team_slug}:aud"
      values   = ["https://vercel.com/${var.vercel_team_slug}"]
    }
    condition {
      test     = "StringEquals"
      variable = "oidc.vercel.com/${var.vercel_team_slug}:sub"
      values   = ["owner:${var.vercel_team_slug}:project:${var.vercel_project_name}:environment:${each.value.vercel}"]
    }
  }
}

data "aws_iam_policy_document" "access" {
  for_each = local.environments

  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this[each.key].arn]
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.this[each.key].arn}/*"]
  }
}

resource "aws_iam_role" "vercel" {
  for_each             = local.environments
  name                 = "${var.name}-vercel-${each.key}"
  path                 = "/project-kit/"
  permissions_boundary = var.permissions_boundary_arn
  assume_role_policy   = data.aws_iam_policy_document.trust[each.key].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "access" {
  for_each = local.environments
  name     = "s3"
  role     = aws_iam_role.vercel[each.key].id
  policy   = data.aws_iam_policy_document.access[each.key].json
}

output "production" {
  value = {
    bucket   = aws_s3_bucket.this["production"].bucket
    region   = data.aws_region.current.region
    role_arn = aws_iam_role.vercel["production"].arn
  }
}

output "nonproduction" {
  value = {
    bucket   = aws_s3_bucket.this["dev"].bucket
    region   = data.aws_region.current.region
    role_arn = aws_iam_role.vercel["dev"].arn
  }
}

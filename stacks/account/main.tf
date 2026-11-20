terraform {
  required_version = ">= 1.10"

  backend "s3" {
    key          = "account/tofu.tfstate"
    use_lockfile = true
    encrypt      = true
  }

  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.73" }
  }
}

variable "region" {
  type = string
}

variable "vercel_team_slugs" {
  type        = list(string)
  default     = []
  description = "Vercel teams whose functions may assume roles in this account."
}

variable "existing_github_provider_arn" {
  type        = string
  default     = null
  description = "The account's GitHub OIDC provider, when one exists already; it is imported, not created."
}

variable "existing_vercel_provider_arns" {
  type        = map(string)
  default     = {}
  description = "Existing Vercel OIDC providers by team slug; imported, not created."
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { managed-by = "project-kit" }
  }
}

import {
  for_each = var.existing_github_provider_arn == null ? toset([]) : toset([var.existing_github_provider_arn])
  to       = aws_iam_openid_connect_provider.github
  id       = each.value
}

import {
  for_each = var.existing_vercel_provider_arns
  to       = aws_iam_openid_connect_provider.vercel[each.key]
  id       = each.value
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_openid_connect_provider" "vercel" {
  for_each       = toset(var.vercel_team_slugs)
  url            = "https://oidc.vercel.com/${each.value}"
  client_id_list = ["https://vercel.com/${each.value}"]
}

variable "state_bucket" {
  type        = string
  description = "The kit's state bucket."
}

variable "control_repository" {
  type        = string
  default     = null
  description = "owner/name of the private control repository whose workflows run the kit for standard projects. Null: no control role."
}

data "aws_caller_identity" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
}

# Every role the kit creates for an app carries this boundary: whatever its own policy says,
# it can do no more than use kit buckets and assume the CDK bootstrap roles.
data "aws_iam_policy_document" "app_boundary" {
  statement {
    actions   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["arn:aws:s3:::kit-*", "arn:aws:s3:::kit-*/*"]
  }
  statement {
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::${local.account}:role/cdk-*"]
  }
}

resource "aws_iam_policy" "app_boundary" {
  name   = "project-kit-app-boundary"
  path   = "/project-kit/"
  policy = data.aws_iam_policy_document.app_boundary.json
}

data "aws_iam_policy_document" "control_trust" {
  count = var.control_repository == null ? 0 : 1
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.control_repository}:environment:apps"]
    }
  }
}

# What the control repository may do: standard projects' settings and state (never isolated/),
# kit buckets, and roles under /project-kit/ that carry the app boundary.
data "aws_iam_policy_document" "control" {
  count = var.control_repository == null ? 0 : 1

  statement {
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.state_bucket}"]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["projects/*"]
    }
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:GetObjectVersion", "s3:ListBucketVersions"]
    resources = ["arn:aws:s3:::${var.state_bucket}/projects/*"]
  }
  statement {
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::kit-*", "arn:aws:s3:::kit-*/*"]
  }
  statement {
    actions = [
      "iam:CreateRole",
      "iam:PutRolePolicy",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = ["arn:aws:iam::${local.account}:role/project-kit/*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.app_boundary.arn]
    }
  }
  statement {
    actions = [
      "iam:GetRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:aws:iam::${local.account}:role/project-kit/*"]
  }
  statement {
    actions   = ["iam:GetOpenIDConnectProvider", "iam:ListOpenIDConnectProviders", "iam:GetPolicy", "iam:GetPolicyVersion", "sts:GetCallerIdentity"]
    resources = ["*"]
  }
  statement {
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "control" {
  count              = var.control_repository == null ? 0 : 1
  name               = "project-kit-control"
  path               = "/project-kit-admin/"
  assume_role_policy = data.aws_iam_policy_document.control_trust[0].json
}

resource "aws_iam_role_policy" "control" {
  count  = var.control_repository == null ? 0 : 1
  name   = "project-kit"
  role   = aws_iam_role.control[0].id
  policy = data.aws_iam_policy_document.control[0].json
}

output "control_role_arn" {
  value = try(aws_iam_role.control[0].arn, null)
}

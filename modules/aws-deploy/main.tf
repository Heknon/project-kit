terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}

variable "name" {
  type = string
}

variable "repository" {
  type        = string
  description = "owner/name"
}

variable "subject_prefix" {
  type        = string
  default     = null
  description = "The OIDC sub before :environment:. Defaults to repo:<owner>/<name>."
}

variable "policy_arns" {
  type        = list(string)
  default     = []
  description = "Managed policies for the deploy role, on top of assuming the CDK bootstrap roles."
}

data "aws_caller_identity" "current" {}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  subject_prefix = coalesce(var.subject_prefix, "repo:${var.repository}")
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "${local.subject_prefix}:environment:dev",
        "${local.subject_prefix}:environment:production",
      ]
    }
  }
}

data "aws_iam_policy_document" "cdk" {
  statement {
    actions   = ["sts:AssumeRole"]
    resources = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cdk-*"]
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_iam_role_policy" "cdk" {
  name   = "assume-cdk-roles"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.cdk.json
}

resource "aws_iam_role_policy_attachment" "extra" {
  for_each   = toset(var.policy_arns)
  role       = aws_iam_role.deploy.name
  policy_arn = each.value
}

output "role_arn" {
  value = aws_iam_role.deploy.arn
}

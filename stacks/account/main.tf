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

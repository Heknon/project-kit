terraform {
  required_providers {
    neon = { source = "kislerdm/neon" }
  }
}

variable "name" {
  type        = string
  description = "Project name; also the database and the role that owns it."
}

variable "org_id" {
  type = string
}

variable "region" {
  type        = string
  description = "Neon region id, for example aws-eu-central-1."
}

variable "pg_version" {
  type    = number
  default = 17
}

variable "history_retention_seconds" {
  type        = number
  default     = 21600
  description = "Point-in-time restore window. Six hours fits the free plan."
}

locals {
  database = replace(var.name, "-", "_")
  role     = replace(var.name, "-", "_")
}

resource "neon_project" "this" {
  name                      = var.name
  org_id                    = var.org_id
  region_id                 = var.region
  pg_version                = var.pg_version
  history_retention_seconds = var.history_retention_seconds
  default_branch_protected  = true

  branch {
    name          = "main"
    database_name = local.database
    role_name     = local.role
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "neon_branch" "dev" {
  project_id = neon_project.this.id
  parent_id  = neon_project.this.default_branch_id
  name       = "dev"
}

resource "neon_endpoint" "dev" {
  project_id = neon_project.this.id
  branch_id  = neon_branch.dev.id
  type       = "read_write"
}

resource "neon_org_api_key" "previews" {
  org_id     = var.org_id
  project_id = neon_project.this.id
  name       = "${var.name}-previews"
}

# The production branch is protected, and Neon gives a branch made from a protected one new
# role passwords: dev has its own, not the project's.
data "neon_branch_role_password" "dev" {
  project_id = neon_project.this.id
  branch_id  = neon_branch.dev.id
  role_name  = local.role
}

locals {
  dev_password = data.neon_branch_role_password.dev.password

  dev_pooler_host = join("", [
    split(".", neon_endpoint.dev.host)[0],
    "-pooler.",
    join(".", slice(split(".", neon_endpoint.dev.host), 1, length(split(".", neon_endpoint.dev.host)))),
  ])

  dev_url          = "postgresql://${local.role}:${local.dev_password}@${local.dev_pooler_host}/${local.database}?sslmode=require"
  dev_url_unpooled = "postgresql://${local.role}:${local.dev_password}@${neon_endpoint.dev.host}/${local.database}?sslmode=require"
}

output "project_id" {
  value = neon_project.this.id
}

output "database" {
  value = local.database
}

output "role" {
  value = local.role
}

output "preview_parent_branch" {
  value = neon_branch.dev.name
}

output "preview_api_key" {
  value     = neon_org_api_key.previews.key
  sensitive = true
}

output "production" {
  value = {
    url          = neon_project.this.connection_uri_pooler
    url_unpooled = neon_project.this.connection_uri
  }
  sensitive = true
}

output "dev" {
  value = {
    url          = local.dev_url
    url_unpooled = local.dev_url_unpooled
  }
  sensitive = true
}

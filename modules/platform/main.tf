terraform {
  required_providers {
    vercel = { source = "vercel/vercel" }
    github = { source = "integrations/github" }
    random = { source = "hashicorp/random" }
  }
}

locals {
  repository_name = split("/", var.repository)[1]
  has_database    = var.database != null
  has_neon        = local.has_database && try(var.database.neon != null, false)
  has_storage     = var.storage != null
  has_google      = var.google != null
  auth_secret     = local.has_google || contains(var.generated, "AUTH_SECRET")
  generated       = toset([for name in var.generated : name if name != "AUTH_SECRET"])
}

resource "random_password" "auth_secret" {
  for_each = local.auth_secret ? toset(["production", "nonproduction"]) : toset([])
  length   = 48
  special  = false
}

resource "random_password" "cron_secret" {
  count   = var.cron ? 1 : 0
  length  = 48
  special = false
}

resource "random_password" "generated" {
  for_each = { for pair in setproduct(local.generated, ["production", "nonproduction"]) : "${pair[0]}/${pair[1]}" => pair }
  length   = 48
  special  = false
}

resource "vercel_project" "this" {
  name    = var.name
  team_id = var.vercel_team_id

  automatically_expose_system_environment_variables = true

  resource_config = {
    function_default_regions = [var.function_region]
  }

  oidc_token_config = {
    issuer_mode = "team"
  }

  vercel_authentication = {
    deployment_type = "standard_protection_new"
  }
}

resource "vercel_project_domain" "production" {
  project_id = vercel_project.this.id
  team_id    = var.vercel_team_id
  domain     = var.domains.production
}

resource "vercel_project_domain" "dev" {
  project_id = vercel_project.this.id
  team_id    = var.vercel_team_id
  domain     = var.domains.dev
  git_branch = var.dev_branch
}

locals {
  production_origin = "https://${var.domains.production}"
  dev_origin        = "https://${var.domains.dev}"

  secret = {
    production = merge(
      local.has_database ? {
        DATABASE_URL          = var.database.production.url
        DATABASE_URL_UNPOOLED = var.database.production.url_unpooled
      } : {},
      local.auth_secret ? { AUTH_SECRET = random_password.auth_secret["production"].result } : {},
      var.cron ? { CRON_SECRET = random_password.cron_secret[0].result } : {},
      { for name in local.generated : name => random_password.generated["${name}/production"].result },
    )
    preview = merge(
      local.auth_secret ? { AUTH_SECRET = random_password.auth_secret["nonproduction"].result } : {},
      { for name in local.generated : name => random_password.generated["${name}/nonproduction"].result },
    )
    dev = local.has_database ? {
      DATABASE_URL          = var.database.dev.url
      DATABASE_URL_UNPOOLED = var.database.dev.url_unpooled
    } : {}
  }

  plain = {
    production = merge(
      { APP_ENV = "production", APP_URL = local.production_origin },
      local.has_storage ? {
        S3_BUCKET   = var.storage.production.bucket
        S3_REGION   = var.storage.production.region
        S3_ROLE_ARN = var.storage.production.role_arn
      } : {},
      local.has_google ? {
        AUTH_URL       = local.production_origin
        AUTH_GOOGLE_ID = var.google.production_client_id
      } : {},
      var.env.production,
    )
    preview = merge(
      { APP_ENV = "preview" },
      local.has_storage ? {
        S3_BUCKET   = var.storage.nonproduction.bucket
        S3_REGION   = var.storage.nonproduction.region
        S3_ROLE_ARN = var.storage.nonproduction.role_arn
      } : {},
      local.has_google ? {
        AUTH_GOOGLE_ID          = var.google.nonproduction_client_id
        AUTH_REDIRECT_PROXY_URL = "${local.dev_origin}/api/auth"
      } : {},
      var.env.preview,
    )
    dev = merge(
      { APP_ENV = "dev", APP_URL = local.dev_origin },
      local.has_storage ? { S3_PREFIX = "dev/" } : {},
      local.has_google ? { AUTH_URL = local.dev_origin } : {},
      var.env.dev,
    )
  }

  scopes = {
    production = { target = ["production"], git_branch = null }
    preview    = { target = ["preview"], git_branch = null }
    dev        = { target = ["preview"], git_branch = var.dev_branch }
  }

  variables = concat(
    flatten([
      for scope, settings in local.scopes : [
        for key in keys(local.secret[scope]) : {
          key        = key
          value      = local.secret[scope][key]
          sensitive  = true
          target     = settings.target
          git_branch = settings.git_branch
        }
      ]
    ]),
    flatten([
      for scope, settings in local.scopes : [
        for key, value in local.plain[scope] : {
          key        = key
          value      = value
          sensitive  = false
          target     = settings.target
          git_branch = settings.git_branch
        }
      ]
    ]),
  )
}

resource "vercel_project_environment_variables" "this" {
  project_id = vercel_project.this.id
  team_id    = var.vercel_team_id
  variables  = local.variables
}

resource "github_branch" "dev" {
  repository    = local.repository_name
  branch        = var.dev_branch
  source_branch = var.production_branch

  lifecycle {
    ignore_changes = [source_branch, source_sha]
  }
}

locals {
  environments = {
    preview    = null
    dev        = var.dev_branch
    production = var.production_branch
  }
}

resource "github_repository_environment" "this" {
  for_each    = local.environments
  repository  = local.repository_name
  environment = each.key

  dynamic "deployment_branch_policy" {
    for_each = each.value == null ? [] : [each.value]
    content {
      protected_branches     = false
      custom_branch_policies = true
    }
  }
}

resource "github_repository_environment_deployment_policy" "this" {
  for_each       = { for name, branch in local.environments : name => branch if branch != null }
  repository     = local.repository_name
  environment    = github_repository_environment.this[each.key].environment
  branch_pattern = each.value
}

locals {
  vercel_secrets = {
    VERCEL_TOKEN      = var.vercel_deploy_token
    VERCEL_ORG_ID     = var.vercel_team_id
    VERCEL_PROJECT_ID = vercel_project.this.id
    VERCEL_TEAM_SLUG  = var.vercel_team_slug
  }

  deploy_secrets = var.aws_deploy == null ? {} : {
    AWS_DEPLOY_ROLE_ARN = var.aws_deploy.role_arn
    AWS_REGION          = var.aws_deploy.region
  }

  github_secrets = {
    preview = merge(local.vercel_secrets, local.has_neon ? {
      NEON_API_KEY       = var.database.neon.preview_api_key
      NEON_PROJECT_ID    = var.database.neon.project_id
      NEON_DATABASE      = var.database.neon.database
      NEON_ROLE          = var.database.neon.role
      NEON_PARENT_BRANCH = var.database.neon.parent_branch
    } : {})
    dev = merge(local.vercel_secrets, local.deploy_secrets, { DEV_DOMAIN = var.domains.dev }, local.has_database ? {
      DATABASE_URL          = var.database.dev.url
      DATABASE_URL_UNPOOLED = var.database.dev.url_unpooled
    } : {})
    production = merge(local.vercel_secrets, local.deploy_secrets, local.has_database ? {
      DATABASE_URL          = var.database.production.url
      DATABASE_URL_UNPOOLED = var.database.production.url_unpooled
    } : {})
  }

  github_secret_entries = merge([
    for environment, secrets in local.github_secrets : {
      for name in keys(secrets) : "${environment}/${name}" => {
        environment = environment
        name        = name
        value       = secrets[name]
      }
    }
  ]...)
}

resource "github_actions_environment_secret" "this" {
  for_each    = local.github_secret_entries
  repository  = local.repository_name
  environment = github_repository_environment.this[each.value.environment].environment
  secret_name = each.value.name
  value       = each.value.value
}

resource "github_repository_ruleset" "production" {
  count       = var.protect_production_branch ? 1 : 0
  name        = "production branch"
  repository  = local.repository_name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["refs/heads/${var.production_branch}", "refs/heads/${var.dev_branch}"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true
  }
}

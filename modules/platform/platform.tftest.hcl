mock_provider "vercel" {
  mock_resource "vercel_project" {
    defaults = { id = "prj_test" }
  }
}
mock_provider "github" {}
mock_provider "random" {}

variables {
  name                = "app"
  repository          = "owner/app"
  production_branch   = "main"
  vercel_team_id      = "team_test"
  vercel_team_slug    = "team-slug"
  vercel_deploy_token = "token"
  domains             = { production = "app.example.com", dev = "dev.app.example.com" }
}

run "minimal" {
  command = plan

  assert {
    condition     = length([for v in vercel_project_environment_variables.this.variables : v if v.key == "APP_ENV"]) == 3
    error_message = "APP_ENV is set for production, preview and dev"
  }

  assert {
    condition     = length([for v in vercel_project_environment_variables.this.variables : v if v.key == "APP_URL" && v.git_branch == null && contains(v.target, "preview")]) == 0
    error_message = "previews use their own URL"
  }

  assert {
    condition     = length(github_actions_environment_secret.this) == 13
    error_message = "4 Vercel secrets per environment plus DEV_DOMAIN"
  }

  assert {
    condition     = !contains(keys(github_actions_environment_secret.this), "preview/NEON_API_KEY")
    error_message = "no Neon secrets without a database"
  }
}

run "everything" {
  command = plan

  variables {
    database = {
      production = { url = "postgresql://prod", url_unpooled = "postgresql://prod-direct" }
      dev        = { url = "postgresql://dev", url_unpooled = "postgresql://dev-direct" }
      neon = {
        project_id      = "neon-project"
        database        = "app"
        role            = "app"
        parent_branch   = "dev"
        preview_api_key = "neon-key"
      }
    }
    storage = {
      production    = { bucket = "app-prod", region = "eu-central-1", role_arn = "arn:aws:iam::1:role/p" }
      nonproduction = { bucket = "app-dev", region = "eu-central-1", role_arn = "arn:aws:iam::1:role/d" }
    }
    google    = { production_client_id = "prod-client", nonproduction_client_id = "dev-client" }
    cron      = true
    generated = ["COOKIE_SECRET"]
    env       = { production = { VITE_RUNTIME = "server" }, preview = { VITE_RUNTIME = "server" } }
  }

  assert {
    condition = alltrue([
      for key in ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "AUTH_SECRET", "CRON_SECRET", "COOKIE_SECRET", "AUTH_URL", "AUTH_GOOGLE_ID", "S3_BUCKET", "S3_ROLE_ARN", "VITE_RUNTIME"] :
      length([for v in vercel_project_environment_variables.this.variables : v if v.key == key && contains(v.target, "production")]) == 1
    ])
    error_message = "production receives every contract variable"
  }

  assert {
    condition     = length([for v in vercel_project_environment_variables.this.variables : v if v.key == "AUTH_URL" && v.git_branch == null && contains(v.target, "preview")]) == 0
    error_message = "previews must not set AUTH_URL"
  }

  assert {
    condition     = length([for v in vercel_project_environment_variables.this.variables : v if v.key == "AUTH_REDIRECT_PROXY_URL" && v.value == "https://dev.app.example.com/api/auth"]) == 1
    error_message = "previews and dev sign in through the dev deployment"
  }

  assert {
    condition     = length([for v in vercel_project_environment_variables.this.variables : v if v.key == "CRON_SECRET" && !contains(v.target, "production")]) == 0
    error_message = "CRON_SECRET is production only"
  }

  assert {
    condition     = random_password.auth_secret["production"].length == 48 && length(random_password.auth_secret) == 2
    error_message = "production and non-production auth secrets are separate"
  }

  assert {
    condition     = contains(keys(github_actions_environment_secret.this), "preview/NEON_API_KEY") && contains(keys(github_actions_environment_secret.this), "production/DATABASE_URL_UNPOOLED")
    error_message = "previews get Neon access, production gets its migration URL"
  }

  assert {
    condition     = length([for v in vercel_project_environment_variables.this.variables : v if v.sensitive && v.key == "S3_BUCKET"]) == 0
    error_message = "identifiers are plain, secrets are sensitive"
  }
}

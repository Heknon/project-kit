# The platform module with database values marked sensitive, as the neon module's outputs are.
# Test variables can't carry that marking, so this wrapper adds it.
terraform {
  required_providers {
    vercel = { source = "vercel/vercel" }
    github = { source = "integrations/github" }
    random = { source = "hashicorp/random" }
  }
}

module "platform" {
  source              = "../.."
  name                = "app"
  repository          = "owner/app"
  production_branch   = "main"
  vercel_team_id      = "team_test"
  vercel_team_slug    = "team-slug"
  vercel_deploy_token = "token"
  domains             = { production = "app.example.com", dev = "dev.app.example.com" }
  database = {
    production = sensitive({ url = "postgresql://prod", url_unpooled = "postgresql://prod-direct" })
    dev        = sensitive({ url = "postgresql://dev", url_unpooled = "postgresql://dev-direct" })
    neon = {
      project_id      = "neon-project"
      database        = "app"
      role            = "app"
      parent_branch   = "dev"
      preview_api_key = sensitive("neon-key")
    }
  }
}

variable "name" {
  type        = string
  description = "Vercel project name."
}

variable "repository" {
  type        = string
  description = "GitHub repository, owner/name."
}

variable "production_branch" {
  type = string
}

variable "dev_branch" {
  type    = string
  default = "dev"
}

variable "protect_production_branch" {
  type    = bool
  default = true
}

variable "vercel_team_id" {
  type = string
}

variable "vercel_team_slug" {
  type = string
}

variable "vercel_deploy_token" {
  type        = string
  sensitive   = true
  description = "The token the workflows deploy with (GitHub secret VERCEL_TOKEN)."
}

variable "function_region" {
  type    = string
  default = "fra1"
}

variable "domains" {
  type = object({
    production = string
    dev        = string
  })
}

variable "database" {
  type = object({
    production = object({ url = string, url_unpooled = string })
    dev        = object({ url = string, url_unpooled = string })
    neon = optional(object({
      project_id      = string
      database        = string
      role            = string
      parent_branch   = string
      preview_api_key = string
    }))
  })
  default     = null
  description = "Kit-managed database. Null when there is none or when its URLs are supplied secrets."
}

variable "storage" {
  type = object({
    production    = object({ bucket = string, region = string, role_arn = string })
    nonproduction = object({ bucket = string, region = string, role_arn = string })
  })
  default = null
}

variable "google" {
  type = object({
    production_client_id    = string
    nonproduction_client_id = string
  })
  default = null
}

variable "cron" {
  type    = bool
  default = false
}

variable "generated" {
  type        = list(string)
  default     = []
  description = "Names of random secrets, separate values for production and non-production."
}

variable "env" {
  type = object({
    production = optional(map(string), {})
    dev        = optional(map(string), {})
    preview    = optional(map(string), {})
  })
  default     = {}
  description = "Plain values. Preview values also apply to dev unless dev sets the same name."
}

variable "aws_deploy" {
  type = object({
    role_arn = string
    region   = string
  })
  default = null
}

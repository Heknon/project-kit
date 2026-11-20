output "vercel_project_id" {
  value = vercel_project.this.id
}

output "identifiers" {
  description = "Values that identify the project's accounts; `kit check` makes sure none appear in the app repository."
  value = compact([
    var.vercel_team_id,
    var.vercel_team_slug,
    vercel_project.this.id,
    var.domains.production,
    var.domains.dev,
    try(var.storage.production.bucket, ""),
    try(var.storage.nonproduction.bucket, ""),
    try(var.storage.production.role_arn, ""),
    try(var.storage.nonproduction.role_arn, ""),
    try(var.aws_deploy.role_arn, ""),
    try(var.google.production_client_id, ""),
    try(var.google.nonproduction_client_id, ""),
  ])
}

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = { region = "eu-central-1" }
  }
  mock_data "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/oidc.vercel.com/team" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::bucket" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/app" }
  }
}
mock_provider "random" {}

variables {
  name                = "app"
  vercel_team_slug    = "team"
  vercel_project_name = "app"
  app_origins         = ["https://app.example.com", "https://dev.app.example.com"]
}

run "new_buckets" {
  command = plan

  assert {
    condition     = startswith(aws_s3_bucket.this["dev"].bucket, "kit-app-dev-")
    error_message = "new buckets get a random suffix"
  }

  assert {
    condition     = aws_iam_role.vercel["production"].name == "app-vercel-production" && aws_iam_role.vercel["dev"].name == "app-vercel-dev"
    error_message = "one role per environment"
  }

  assert {
    condition     = contains(tolist(aws_s3_bucket_cors_configuration.this["dev"].cors_rule)[0].allowed_origins, "https://*-team.vercel.app")
    error_message = "previews of the team may use presigned URLs"
  }

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.dev.rule[0].expiration[0].days == 14
    error_message = "preview objects expire"
  }
}

run "existing_buckets" {
  command = plan

  variables {
    existing_buckets = { production = "old-prod", dev = "old-dev" }
  }

  assert {
    condition     = aws_s3_bucket.this["production"].bucket == "old-prod" && length(random_id.suffix) == 0
    error_message = "adopted buckets keep their names"
  }
}

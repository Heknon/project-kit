terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare" }
  }
}

variable "zone_id" {
  type = string
}

variable "domains" {
  type        = list(string)
  description = "Domains served by the Vercel project, all inside the zone."
}

data "cloudflare_zone" "this" {
  zone_id = var.zone_id
}

locals {
  records = {
    for domain in var.domains : domain => (
      domain == data.cloudflare_zone.this.name
      ? { type = "A", content = "76.76.21.21" }
      : { type = "CNAME", content = "cname.vercel-dns.com" }
    )
  }
}

resource "cloudflare_dns_record" "vercel" {
  for_each = local.records
  zone_id  = var.zone_id
  name     = each.key
  type     = each.value.type
  content  = each.value.content
  proxied  = false
  ttl      = 1
}

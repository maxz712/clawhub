terraform {
  required_version = ">= 1.5"
  required_providers {
    helm = { source = "hashicorp/helm", version = "~> 2.13" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "namespace" { default = "clawhub" }
variable "public_url" { default = "https://clawhub.local" }
variable "database_url" { description = "Postgres connection string" }
variable "image_api" { default = "ghcr.io/clawhub/api:latest" }
variable "image_dashboard" { default = "ghcr.io/clawhub/dashboard:latest" }

resource "random_password" "jwt_secret" { length = 48 special = false }
resource "random_password" "secrets_key_raw" { length = 32 special = false }

resource "kubernetes_namespace" "ns" {
  metadata { name = var.namespace }
}

resource "helm_release" "clawhub" {
  name       = "clawhub"
  chart      = "${path.module}/../helm/clawhub"
  namespace  = kubernetes_namespace.ns.metadata[0].name

  set_sensitive {
    name  = "env.JWT_SECRET"
    value = random_password.jwt_secret.result
  }
  set_sensitive {
    name  = "env.CLAWHUB_SECRETS_KEY"
    value = base64encode(random_password.secrets_key_raw.result)
  }
  set_sensitive {
    name  = "env.DATABASE_URL"
    value = var.database_url
  }
  set { name = "env.CLAWHUB_PUBLIC_URL" value = var.public_url }
  set { name = "image.api"               value = var.image_api }
  set { name = "image.dashboard"         value = var.image_dashboard }
}

output "url" { value = var.public_url }

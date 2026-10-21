# Managed data tier on AWS (ap-south-1). The app runs on EKS (see infra/k8s).
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
}

variable "region" { default = "ap-south-1" }
variable "db_subnet_ids" { type = list(string) }
variable "vpc_security_group_ids" { type = list(string) }

resource "aws_kms_key" "data" {
  description         = "Amrutam data-at-rest key"
  enable_key_rotation = true # automatic yearly rotation
}

resource "aws_db_subnet_group" "main" {
  name       = "amrutam-db"
  subnet_ids = var.db_subnet_ids
}

# Primary PostgreSQL: Multi-AZ (sync standby) for 99.95%, encrypted, PITR via 14-day backups.
resource "aws_db_instance" "primary" {
  identifier                   = "amrutam-pg"
  engine                       = "postgres"
  engine_version               = "16"
  instance_class               = "db.r6g.xlarge"
  allocated_storage            = 200
  max_allocated_storage        = 2000
  storage_encrypted            = true
  kms_key_id                   = aws_kms_key.data.arn
  multi_az                     = true
  db_name                      = "amrutam"
  username                     = "amrutam_admin"
  manage_master_user_password  = true # stored + rotated in Secrets Manager
  db_subnet_group_name         = aws_db_subnet_group.main.name
  vpc_security_group_ids       = var.vpc_security_group_ids
  backup_retention_period      = 14
  deletion_protection          = true
  performance_insights_enabled = true
  publicly_accessible          = false
  copy_tags_to_snapshot        = true
}

# Read replica for search/analytics reads.
resource "aws_db_instance" "replica" {
  identifier             = "amrutam-pg-replica"
  replicate_source_db    = aws_db_instance.primary.identifier
  instance_class         = "db.r6g.large"
  storage_encrypted      = true
  kms_key_id             = aws_kms_key.data.arn
  vpc_security_group_ids = var.vpc_security_group_ids
  publicly_accessible    = false
}

# Redis for shared cache + distributed rate limiting.
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "amrutam-redis"
  description                = "cache and rate limiting"
  engine                     = "redis"
  node_type                  = "cache.r6g.large"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
}

output "db_endpoint" { value = aws_db_instance.primary.endpoint }

resource "aws_vpc" "main" {
  cidr_block           = "10.70.0.0/16"
  instance_tenancy     = "default"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "main-vpc"
  }
}

resource "aws_vpc" "previewkit" {
  cidr_block           = "10.71.0.0/16"
  instance_tenancy     = "default"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "previewkit-vpc"
  }
}

# Security group IDs are literal for now - those security groups aren't
# imported yet (next layer).
#
# The aps-workspaces (AMP) interface endpoints originally imported here have
# since been deleted along with their security groups - AMP itself was
# retired, so nothing used them.

resource "aws_vpc_endpoint" "main_s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.us-east-1.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = [
    aws_route_table.main_private_1a.id,
    aws_route_table.main_private_1b.id,
    aws_route_table.main_private_1c.id,
  ]

  tags = {
    Name = "main-vpce-s3"
  }
}

resource "aws_vpc_endpoint" "main_ecr_api" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.us-east-1.ecr.api"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  subnet_ids = [
    aws_subnet.main_private4_1a.id,
    aws_subnet.main_private5_1b.id,
    aws_subnet.main_private6_1c.id,
  ]

  security_group_ids = ["sg-0d8d3027fdf36f2e7"]

  tags = {
    Name = "ECR API"
  }
}

resource "aws_vpc_endpoint" "main_ecr_dkr" {
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.us-east-1.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  subnet_ids = [
    aws_subnet.main_private4_1a.id,
    aws_subnet.main_private5_1b.id,
    aws_subnet.main_private6_1c.id,
  ]

  security_group_ids = ["sg-0d8d3027fdf36f2e7"]

  tags = {
    Name = "ECR DKR"
  }
}

resource "aws_vpc_endpoint" "previewkit_s3" {
  vpc_id            = aws_vpc.previewkit.id
  service_name      = "com.amazonaws.us-east-1.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = [
    aws_route_table.previewkit_public.id,
    aws_route_table.previewkit_private.id,
  ]

  tags = {
    Name = "previewkit-s3-endpoint"
  }
}

resource "aws_vpc_endpoint" "previewkit_ecr_api" {
  vpc_id              = aws_vpc.previewkit.id
  service_name        = "com.amazonaws.us-east-1.ecr.api"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  subnet_ids = [
    aws_subnet.previewkit_private1_1a.id,
    aws_subnet.previewkit_private2_1b.id,
    aws_subnet.previewkit_private3_1c.id,
  ]

  security_group_ids = ["sg-03b342be4cfb08c21"]

  tags = {
    Name = "ECR API"
  }
}

resource "aws_vpc_endpoint" "previewkit_ecr_dkr" {
  vpc_id              = aws_vpc.previewkit.id
  service_name        = "com.amazonaws.us-east-1.ecr.dkr"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true

  subnet_ids = [
    aws_subnet.previewkit_private1_1a.id,
    aws_subnet.previewkit_private2_1b.id,
    aws_subnet.previewkit_private3_1c.id,
  ]

  security_group_ids = ["sg-03b342be4cfb08c21"]

  tags = {
    Name = "ECR DKR"
  }
}


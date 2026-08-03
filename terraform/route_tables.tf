# The 0.0.0.0/0 routes for the main-vpc private route tables point at
# self-managed NAT EC2 instances (one per AZ, named "nat-gateway"), not a
# managed NAT gateway - main-vpc's aws_nat_gateway was unused and has since
# been deleted (see gateways.tf).
#
# VPC-endpoint (S3 gateway) prefix-list routes are intentionally omitted here
# - they're owned by the aws_vpc_endpoint resource's route_table_ids instead,
# to avoid two resources fighting over the same route.
#
# Peering-connection route targets are literal IDs rather than resource
# references for now; the peering connections themselves aren't imported yet.
# IGW/NAT-gateway targets reference aws_internet_gateway/aws_nat_gateway
# resources in gateways.tf.

resource "aws_route_table" "main_public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  route {
    cidr_block                = "172.31.0.0/16"
    vpc_peering_connection_id = "pcx-0a2a32d5f75757256"
  }

  route {
    cidr_block                = "10.71.0.0/16"
    vpc_peering_connection_id = "pcx-03a7a29c1b9873fdf"
  }

  tags = {
    Name = "main-public-rtb"
  }
}

resource "aws_route_table" "main_private_1a" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block           = "0.0.0.0/0"
    network_interface_id = "eni-058ff8644bca36451"
  }

  route {
    cidr_block                = "172.31.0.0/16"
    vpc_peering_connection_id = "pcx-0a2a32d5f75757256"
  }

  route {
    cidr_block                = "10.71.0.0/16"
    vpc_peering_connection_id = "pcx-03a7a29c1b9873fdf"
  }

  tags = {
    Name = "main-private-rtb-1a"
  }
}

resource "aws_route_table" "main_private_1b" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block           = "0.0.0.0/0"
    network_interface_id = "eni-0d4350e5b854d78d9"
  }

  route {
    cidr_block                = "172.31.0.0/16"
    vpc_peering_connection_id = "pcx-0a2a32d5f75757256"
  }

  route {
    cidr_block                = "10.71.0.0/16"
    vpc_peering_connection_id = "pcx-03a7a29c1b9873fdf"
  }

  tags = {
    Name = "main-private-rtb-1b"
  }
}

resource "aws_route_table" "main_private_1c" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block           = "0.0.0.0/0"
    network_interface_id = "eni-098f9865f4cb9184b"
  }

  route {
    cidr_block                = "172.31.0.0/16"
    vpc_peering_connection_id = "pcx-0a2a32d5f75757256"
  }

  route {
    cidr_block                = "10.71.0.0/16"
    vpc_peering_connection_id = "pcx-03a7a29c1b9873fdf"
  }

  tags = {
    Name = "main-private-rtb-1c"
  }
}

resource "aws_route_table" "previewkit_public" {
  vpc_id = aws_vpc.previewkit.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.previewkit.id
  }

  route {
    cidr_block                = "10.70.0.0/16"
    vpc_peering_connection_id = "pcx-03a7a29c1b9873fdf"
  }

  tags = {
    Name = "previewkit-rtb-public"
  }
}

resource "aws_route_table" "previewkit_private" {
  vpc_id = aws_vpc.previewkit.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.previewkit.id
  }

  route {
    cidr_block                = "10.70.0.0/16"
    vpc_peering_connection_id = "pcx-03a7a29c1b9873fdf"
  }

  tags = {
    Name = "previewkit-rtb-private"
  }
}

resource "aws_route_table_association" "main_public1_1a" {
  subnet_id      = aws_subnet.main_public1_1a.id
  route_table_id = aws_route_table.main_public.id
}

resource "aws_route_table_association" "main_public2_1b" {
  subnet_id      = aws_subnet.main_public2_1b.id
  route_table_id = aws_route_table.main_public.id
}

resource "aws_route_table_association" "main_public3_1c" {
  subnet_id      = aws_subnet.main_public3_1c.id
  route_table_id = aws_route_table.main_public.id
}

resource "aws_route_table_association" "main_utility1_1a" {
  subnet_id      = aws_subnet.main_utility1_1a.id
  route_table_id = aws_route_table.main_private_1a.id
}

resource "aws_route_table_association" "main_private1_1a" {
  subnet_id      = aws_subnet.main_private1_1a.id
  route_table_id = aws_route_table.main_private_1a.id
}

resource "aws_route_table_association" "main_private4_1a" {
  subnet_id      = aws_subnet.main_private4_1a.id
  route_table_id = aws_route_table.main_private_1a.id
}

resource "aws_route_table_association" "main_utility2_1b" {
  subnet_id      = aws_subnet.main_utility2_1b.id
  route_table_id = aws_route_table.main_private_1b.id
}

resource "aws_route_table_association" "main_private2_1b" {
  subnet_id      = aws_subnet.main_private2_1b.id
  route_table_id = aws_route_table.main_private_1b.id
}

resource "aws_route_table_association" "main_private5_1b" {
  subnet_id      = aws_subnet.main_private5_1b.id
  route_table_id = aws_route_table.main_private_1b.id
}

resource "aws_route_table_association" "main_utility3_1c" {
  subnet_id      = aws_subnet.main_utility3_1c.id
  route_table_id = aws_route_table.main_private_1c.id
}

resource "aws_route_table_association" "main_private3_1c" {
  subnet_id      = aws_subnet.main_private3_1c.id
  route_table_id = aws_route_table.main_private_1c.id
}

resource "aws_route_table_association" "main_private6_1c" {
  subnet_id      = aws_subnet.main_private6_1c.id
  route_table_id = aws_route_table.main_private_1c.id
}

resource "aws_route_table_association" "previewkit_public1_1a" {
  subnet_id      = aws_subnet.previewkit_public1_1a.id
  route_table_id = aws_route_table.previewkit_public.id
}

resource "aws_route_table_association" "previewkit_public2_1b" {
  subnet_id      = aws_subnet.previewkit_public2_1b.id
  route_table_id = aws_route_table.previewkit_public.id
}

resource "aws_route_table_association" "previewkit_public3_1c" {
  subnet_id      = aws_subnet.previewkit_public3_1c.id
  route_table_id = aws_route_table.previewkit_public.id
}

resource "aws_route_table_association" "previewkit_private1_1a" {
  subnet_id      = aws_subnet.previewkit_private1_1a.id
  route_table_id = aws_route_table.previewkit_private.id
}

resource "aws_route_table_association" "previewkit_private2_1b" {
  subnet_id      = aws_subnet.previewkit_private2_1b.id
  route_table_id = aws_route_table.previewkit_private.id
}

resource "aws_route_table_association" "previewkit_private3_1c" {
  subnet_id      = aws_subnet.previewkit_private3_1c.id
  route_table_id = aws_route_table.previewkit_private.id
}

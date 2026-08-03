resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "main-igw"
  }
}

resource "aws_internet_gateway" "previewkit" {
  vpc_id = aws_vpc.previewkit.id

  tags = {
    Name = "previewkit-igw"
  }
}

resource "aws_eip" "previewkit_nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "previewkit" {
  allocation_id = aws_eip.previewkit_nat.id
  subnet_id     = aws_subnet.previewkit_public1_1a.id

  tags = {
    Name = "previewkit-nat"
  }
}

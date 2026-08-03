resource "aws_subnet" "main_public1_1a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.0.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-public1-us-east-1a"
  }
}

resource "aws_subnet" "main_public2_1b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.1.0/24"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-public2-us-east-1b"
  }
}

resource "aws_subnet" "main_public3_1c" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.2.0/24"
  availability_zone       = "us-east-1c"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-public3-us-east-1c"
  }
}

resource "aws_subnet" "main_utility1_1a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.4.0/24"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-utility1-us-east-1a"
  }
}

resource "aws_subnet" "main_utility2_1b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.5.0/24"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-utility2-us-east-1b"
  }
}

resource "aws_subnet" "main_utility3_1c" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.6.0/24"
  availability_zone       = "us-east-1c"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-utility3-us-east-1c"
  }
}

resource "aws_subnet" "main_private1_1a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.64.0/22"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-private1-us-east-1a"
  }
}

resource "aws_subnet" "main_private2_1b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.68.0/22"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-private2-us-east-1b"
  }
}

resource "aws_subnet" "main_private3_1c" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.72.0/22"
  availability_zone       = "us-east-1c"
  map_public_ip_on_launch = false

  tags = {
    Name = "main-subnet-private3-us-east-1c"
  }
}

resource "aws_subnet" "main_private4_1a" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.96.0/19"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = false

  tags = {
    Name                     = "main-subnet-private4-us-east-1a"
    "karpenter.sh/discovery" = "production"
  }
}

resource "aws_subnet" "main_private5_1b" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.128.0/19"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = false

  tags = {
    Name                     = "main-subnet-private5-us-east-1b"
    "karpenter.sh/discovery" = "production"
  }
}

resource "aws_subnet" "main_private6_1c" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.70.160.0/19"
  availability_zone       = "us-east-1c"
  map_public_ip_on_launch = false

  tags = {
    Name                     = "main-subnet-private6-us-east-1c"
    "karpenter.sh/discovery" = "production"
  }
}

resource "aws_subnet" "previewkit_public1_1a" {
  vpc_id                  = aws_vpc.previewkit.id
  cidr_block              = "10.71.0.0/20"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = true

  tags = {
    Name                               = "previewkit-subnet-public1-us-east-1a"
    "kubernetes.io/cluster/previewkit" = "shared"
    "kubernetes.io/role/elb"           = "1"
  }
}

resource "aws_subnet" "previewkit_public2_1b" {
  vpc_id                  = aws_vpc.previewkit.id
  cidr_block              = "10.71.16.0/20"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = true

  tags = {
    Name                               = "previewkit-subnet-public2-us-east-1b"
    "kubernetes.io/cluster/previewkit" = "shared"
    "kubernetes.io/role/elb"           = "1"
  }
}

resource "aws_subnet" "previewkit_public3_1c" {
  vpc_id                  = aws_vpc.previewkit.id
  cidr_block              = "10.71.32.0/20"
  availability_zone       = "us-east-1c"
  map_public_ip_on_launch = true

  tags = {
    Name                               = "previewkit-subnet-public3-us-east-1c"
    "kubernetes.io/cluster/previewkit" = "shared"
    "kubernetes.io/role/elb"           = "1"
  }
}

resource "aws_subnet" "previewkit_private1_1a" {
  vpc_id                  = aws_vpc.previewkit.id
  cidr_block              = "10.71.128.0/20"
  availability_zone       = "us-east-1a"
  map_public_ip_on_launch = false

  tags = {
    Name                               = "previewkit-subnet-private1-us-east-1a"
    "kubernetes.io/cluster/previewkit" = "shared"
    "kubernetes.io/role/internal-elb"  = "1"
    "karpenter.sh/discovery"           = "previewkit"
  }
}

resource "aws_subnet" "previewkit_private2_1b" {
  vpc_id                  = aws_vpc.previewkit.id
  cidr_block              = "10.71.144.0/20"
  availability_zone       = "us-east-1b"
  map_public_ip_on_launch = false

  tags = {
    Name                               = "previewkit-subnet-private2-us-east-1b"
    "kubernetes.io/cluster/previewkit" = "shared"
    "kubernetes.io/role/internal-elb"  = "1"
    "karpenter.sh/discovery"           = "previewkit"
  }
}

resource "aws_subnet" "previewkit_private3_1c" {
  vpc_id                  = aws_vpc.previewkit.id
  cidr_block              = "10.71.160.0/20"
  availability_zone       = "us-east-1c"
  map_public_ip_on_launch = false

  tags = {
    Name                               = "previewkit-subnet-private3-us-east-1c"
    "kubernetes.io/cluster/previewkit" = "shared"
    "kubernetes.io/role/internal-elb"  = "1"
    "karpenter.sh/discovery"           = "previewkit"
  }
}

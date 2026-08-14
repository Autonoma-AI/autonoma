-- CreateTable
CREATE TABLE "compute_pricing_reference" (
    "pool" TEXT NOT NULL,
    "usd_per_vcpu_hour" DOUBLE PRECISION NOT NULL,
    "usd_per_gb_hour" DOUBLE PRECISION NOT NULL,
    "spot_fraction" DOUBLE PRECISION,
    "sample_size" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_pricing_reference_pkey" PRIMARY KEY ("pool")
);

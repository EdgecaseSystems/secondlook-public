ALTER TABLE commercial_payment_exposures ADD COLUMN public_commercial_policy_version TEXT;
ALTER TABLE commercial_payment_exposures ADD COLUMN geography_policy_version TEXT;
ALTER TABLE commercial_payment_exposures ADD COLUMN terms_version TEXT;
ALTER TABLE commercial_payment_exposures ADD COLUMN privacy_version TEXT;
ALTER TABLE commercial_payment_exposures ADD COLUMN service_use_country TEXT;
ALTER TABLE commercial_payment_exposures ADD COLUMN service_use_region TEXT;
ALTER TABLE commercial_payment_exposures ADD COLUMN edge_country TEXT;
ALTER TABLE commercial_payment_exposures ADD COLUMN edge_region TEXT;

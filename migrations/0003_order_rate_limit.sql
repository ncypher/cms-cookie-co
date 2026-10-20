-- Salted SHA-256 of the customer's IP (never the raw IP), used to cap orders per device.
ALTER TABLE orders ADD COLUMN client_hash TEXT;
CREATE INDEX orders_client_recent ON orders (client_hash, created_at);

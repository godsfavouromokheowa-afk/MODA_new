ALTER TABLE payments
ADD COLUMN confirmed_by_user_id BIGINT REFERENCES users(id),
ADD COLUMN confirmed_at TIMESTAMPTZ;
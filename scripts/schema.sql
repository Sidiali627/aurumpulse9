-- ============================================================================
-- AurumPulse ICT — PostgreSQL Schema for Persistent Production Licensing
-- Idempotent DDL: Creates and safely updates tables without data loss.
-- ============================================================================

-- 1. Licenses & Subscriptions Table
CREATE TABLE IF NOT EXISTS aurumpulse_licenses (
    key VARCHAR(64) PRIMARY KEY,
    key_hash VARCHAR(64),
    plan VARCHAR(64) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    days INT NOT NULL DEFAULT 30,
    created_at DATE NOT NULL DEFAULT CURRENT_DATE,
    expires_at DATE NOT NULL,
    telegram_chat_id VARCHAR(64),
    installation_id VARCHAR(128),
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Idempotent Column Additions for Upgrades
ALTER TABLE aurumpulse_licenses ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64);
ALTER TABLE aurumpulse_licenses ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'active';
ALTER TABLE aurumpulse_licenses ADD COLUMN IF NOT EXISTS installation_id VARCHAR(128);

-- Indexes for fast query lookup
CREATE INDEX IF NOT EXISTS idx_licenses_chat_id ON aurumpulse_licenses(telegram_chat_id);
CREATE INDEX IF NOT EXISTS idx_licenses_key_hash ON aurumpulse_licenses(key_hash);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON aurumpulse_licenses(status);

-- 2. Configuration & State Table (adminChatId, sessionTrades, activeTrades)
CREATE TABLE IF NOT EXISTS aurumpulse_config (
    key VARCHAR(64) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Verified Performance Statistics Table
CREATE TABLE IF NOT EXISTS aurumpulse_stats (
    id INT PRIMARY KEY DEFAULT 1,
    total_signals INT NOT NULL DEFAULT 0,
    wins INT NOT NULL DEFAULT 0,
    losses INT NOT NULL DEFAULT 0,
    breakevens INT NOT NULL DEFAULT 0,
    net_r NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    history JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

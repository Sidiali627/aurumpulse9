-- ============================================================================
-- AurumPulse ICT — PostgreSQL Schema for Persistent Render Deployment
-- Idempotent DDL: Creates tables only if they do not already exist.
-- ============================================================================

-- 1. Licenses & Subscriptions Table
CREATE TABLE IF NOT EXISTS aurumpulse_licenses (
    key VARCHAR(64) PRIMARY KEY,
    plan VARCHAR(64) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    days INT NOT NULL DEFAULT 30,
    created_at DATE NOT NULL DEFAULT CURRENT_DATE,
    expires_at DATE NOT NULL,
    telegram_chat_id VARCHAR(64),
    active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Index for fast lookup by Telegram chat ID
CREATE INDEX IF NOT EXISTS idx_licenses_chat_id ON aurumpulse_licenses(telegram_chat_id);

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

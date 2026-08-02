ALTER TABLE idx_signal_history 
  ADD COLUMN f10_macd float DEFAULT NULL,
  ADD COLUMN f11_bollinger float DEFAULT NULL,
  ADD COLUMN f12_ema_trend float DEFAULT NULL,
  ADD COLUMN f13_support_resistance float DEFAULT NULL,
  ADD COLUMN f14_atr float DEFAULT NULL;

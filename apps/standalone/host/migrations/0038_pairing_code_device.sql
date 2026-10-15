-- A one-time code made for ONE device (plan ТСД-Х, task Х6, spec 6.6): the office re-pairs a
-- handheld whose key was lost, or whose app was installed anew, with the same `deviceId`, so the
-- queue the old key left stays the device's own (`not_entered` otherwise: a new device never
-- entered the shifts the old one did). NULL: an ordinary code, which pairs a new device.
ALTER TABLE pairing_codes ADD COLUMN device_id TEXT REFERENCES devices (id);
